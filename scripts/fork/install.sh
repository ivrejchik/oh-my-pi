#!/usr/bin/env bash
# Install the fork's committed HEAD as an omp release and point `omp` at it.
#
#   scripts/fork/install.sh                 release HEAD and switch the `omp` launcher to it
#   scripts/fork/install.sh --no-launcher   prepare the current checkout in place (CI, verify.sh, development)
#
# A running omp session imports modules lazily from its source tree and
# re-spawns its workers from it, so updating that tree under it mixes versions.
# Each commit therefore becomes its own release: a detached worktree under
# ${OMP_RELEASES_DIR:-~/.local/share/omp-fork/releases}/<sha12> with its own
# dependencies and prebuilt native addon (no Rust toolchain needed). Switching
# versions rewrites only the ~/.local/bin/omp wrapper: sessions keep running on
# the release they started from, and a release is deleted once no process runs
# from it.
#
# Uncommitted changes are not released; try them with
# `bun packages/coding-agent/src/cli.ts` inside the checkout.
#
# Idempotent and quick when HEAD is already installed. Runs from omp-sync and
# from the post-merge hook.
set -euo pipefail

main="$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd -P)"
releases="${OMP_RELEASES_DIR:-$HOME/.local/share/omp-fork/releases}"
platform="$(bun -e 'console.log(`${process.platform}-${process.arch}`)')"

# natives_current <tree> <native-dir> <version>: the tree's loader helpers know
# every stamp format (stamp slot and legacy export).
natives_current() {
	bun -e '
		const [tree, dir, platform, version] = process.argv.slice(1);
		const { containsVersionStamp, containsLegacyVersionSentinel } = await import(`${tree}/packages/natives/native/version-sentinel.js`);
		const name = (await Array.fromAsync(new Bun.Glob(`pi_natives.${platform}*.node`).scan(dir)))[0];
		const bytes = name ? await Bun.file(`${dir}/${name}`).bytes() : new Uint8Array();
		process.exit(containsVersionStamp(bytes, version) || containsLegacyVersionSentinel(bytes, version) ? 0 : 1);
	' "$1" "$2" "$platform" "$3"
}

# prepare_tree <dir>: workspace dependencies plus the release's native addon.
prepare_tree() {
	local dir="$1" native_dir="$1/packages/natives/native" version candidate addon tmp
	(cd "$dir" && bun install --frozen-lockfile)
	version="$(bun -e 'console.log(require(process.argv[1]).version)' "$dir/packages/natives/package.json")"
	if natives_current "$dir" "$native_dir" "$version"; then
		return 0
	fi
	# Addons are replaced, never edited in place, so a matching one is hardlinked.
	for candidate in "$main/packages/natives/native" "$releases"/*/packages/natives/native; do
		if [ "$candidate" = "$native_dir" ] || [ ! -d "$candidate" ]; then
			continue
		fi
		if natives_current "$dir" "$candidate" "$version"; then
			addon="$(ls "$candidate"/pi_natives."$platform"*.node | head -n 1)"
			rm -f "$native_dir"/pi_natives."$platform"*.node
			ln "$addon" "$native_dir/" 2>/dev/null || cp "$addon" "$native_dir/"
			echo "Reused natives ${platform}@${version}"
			return 0
		fi
	done
	tmp="$(mktemp -d)"
	curl -fsSL "https://registry.npmjs.org/@oh-my-pi/pi-natives-${platform}/-/pi-natives-${platform}-${version}.tgz" |
		tar -xzf - -C "$tmp"
	rm -f "$native_dir"/pi_natives."$platform"*.node
	cp "$tmp"/package/*.node "$native_dir"/
	rm -rf "$tmp"
	echo "Installed prebuilt natives ${platform}@${version}"
}

if [ "${1:-}" = "--no-launcher" ]; then
	tree="$(git rev-parse --show-toplevel)"
	prepare_tree "$tree"
	bun "$tree/packages/coding-agent/src/cli.ts" --version
	exit 0
fi

mkdir -p "$releases"
releases="$(cd "$releases" && pwd -P)"
sha="$(git -C "$main" rev-parse HEAD)"
release="$releases/${sha:0:12}"
if [ ! -e "$release.ready" ]; then
	# Leftover of an interrupted install.
	if [ -e "$release" ]; then
		git -C "$main" worktree remove --force "$release" 2>/dev/null || rm -rf "$release"
	fi
	git -C "$main" worktree prune
	git -C "$main" worktree add --quiet --detach "$release" "$sha"
	prepare_tree "$release"
	bun "$release/packages/coding-agent/src/cli.ts" --version >/dev/null
	touch "$release.ready"
fi

cli="$release/packages/coding-agent/src/cli.ts"
launcher="$HOME/.local/bin/omp"
mkdir -p "$(dirname "$launcher")"
if [ -L "$launcher" ] || ! grep -qF "\"$cli\"" "$launcher" 2>/dev/null; then
	version="$(bun -e 'console.log(require(process.argv[1]).version)' "$release/packages/coding-agent/package.json")"
	tmp="$launcher.tmp.$$"
	printf '#!/bin/sh\n# omp %s (fork %s), written by scripts/fork/install.sh\nexec "%s" "%s" "$@"\n' \
		"$version" "${sha:0:12}" "$(command -v bun)" "$cli" >"$tmp"
	chmod +x "$tmp"
	mv -f "$tmp" "$launcher"
	echo "Switched omp to $version (fork ${sha:0:12})"
fi

# A bun-global `omp` earlier on PATH would shadow the launcher.
bun_global_omp="$HOME/.bun/bin/omp"
if [ -L "$bun_global_omp" ] && [ "$(readlink "$bun_global_omp")" != "$launcher" ]; then
	case "$(readlink "$bun_global_omp")" in
	*/@oh-my-pi/pi-coding-agent/* | */packages/coding-agent/src/cli.ts)
		ln -sfn "$launcher" "$bun_global_omp"
		echo "Re-pointed $bun_global_omp to $launcher"
		;;
	esac
fi
resolved="$(command -v omp || true)"
if [ -z "$resolved" ]; then
	echo "warning: ~/.local/bin is not on PATH; add it to use omp" >&2
elif [ "$(realpath "$resolved")" != "$(realpath "$launcher")" ]; then
	echo "warning: omp on PATH is $resolved, which shadows $launcher" >&2
fi

# A release stays while any session or worker runs from it.
running="$(ps axww -o command=)"
for dir in "$releases"/*/; do
	dir="${dir%/}"
	if [ ! -d "$dir" ] || [ "$dir" = "$release" ]; then
		continue
	fi
	case "$running" in
	*"$dir/"*) continue ;;
	esac
	git -C "$main" worktree remove --force "$dir" 2>/dev/null || rm -rf "$dir"
	rm -f "$dir.ready"
	echo "Removed unused release $(basename "$dir")"
done
git -C "$main" worktree prune

bun "$cli" --version
