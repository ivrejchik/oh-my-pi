#!/usr/bin/env bash
# Make this checkout runnable from source and point `omp` at it.
#
#   scripts/fork/install.sh [--no-launcher]
#
# 1. `bun install --frozen-lockfile` for the workspace dependencies.
# 2. Installs the prebuilt native addon for the checked-out release from npm
#    (no Rust toolchain needed); skipped when the right version is present.
# 3. Links ~/.local/bin/omp -> packages/coding-agent/src/cli.ts and re-points a
#    bun-global `omp` that would shadow it. `omp update` refuses to touch a
#    source-checkout launcher, so upstream updates cannot replace the fork.
#
# Idempotent. Runs from the post-merge hook after every `git pull`.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

link_launcher=1
if [ "${1:-}" = "--no-launcher" ]; then
	link_launcher=0
fi

bun install --frozen-lockfile

version="$(bun -e 'console.log(require("./packages/natives/package.json").version)')"
platform="$(bun -e 'console.log(`${process.platform}-${process.arch}`)')"
native_dir="packages/natives/native"
sentinel="__piNativesV${version//[^A-Za-z0-9]/_}"
if ! grep -qaw "$sentinel" "$native_dir"/pi_natives."$platform"*.node 2>/dev/null; then
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	leaf="pi-natives-${platform}"
	curl -fsSL "https://registry.npmjs.org/@oh-my-pi/${leaf}/-/${leaf}-${version}.tgz" | tar -xzf - -C "$tmp"
	rm -f "$native_dir"/pi_natives."$platform"*.node
	cp "$tmp"/package/*.node "$native_dir"/
	echo "Installed prebuilt natives ${platform}@${version}"
fi

cli="$PWD/packages/coding-agent/src/cli.ts"
if [ "$link_launcher" = 1 ]; then
	mkdir -p "$HOME/.local/bin"
	ln -sfn "$cli" "$HOME/.local/bin/omp"
	bun_global_omp="$HOME/.bun/bin/omp"
	if [ -L "$bun_global_omp" ] && [[ "$(readlink "$bun_global_omp")" == *"/@oh-my-pi/pi-coding-agent/"* ]]; then
		ln -sfn "$cli" "$bun_global_omp"
		echo "Re-pointed $bun_global_omp to the source checkout"
	fi
	resolved="$(command -v omp || true)"
	if [ -z "$resolved" ]; then
		echo "warning: ~/.local/bin is not on PATH; add it to use omp" >&2
	elif [ "$(realpath "$resolved")" != "$(realpath "$cli")" ]; then
		echo "warning: omp on PATH is $resolved, which shadows the source checkout" >&2
	fi
fi

bun "$cli" --version
