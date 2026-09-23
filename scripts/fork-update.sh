#!/usr/bin/env bash
# Move this fork onto an upstream omp release. Replaces `omp update`, which
# refuses to touch the source-checkout launcher (~/.local/bin/omp -> src/cli.ts).
#
#   scripts/fork-update.sh [X.Y.Z]    default: latest @oh-my-pi/pi-coding-agent on npm
#
# 1. Fetches tag vX.Y.Z from upstream (`origin`) and rebases the fork commits
#    (everything after the current release tag) onto it, on a new branch fork/X.Y.Z.
# 2. `bun install` for the release's dependencies.
# 3. Installs the release's prebuilt native addon from npm (no Rust toolchain needed).
#
# Idempotent: on a rebase conflict, resolve it, `git rebase --continue`, and rerun
# with the same version to finish the remaining steps.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

version="${1:-$(npm view @oh-my-pi/pi-coding-agent version)}"
tag="v${version}"

if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
	echo "A rebase is in progress: resolve it and run 'git rebase --continue' first." >&2
	exit 1
fi

base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)"
if [ "$base" != "$tag" ]; then
	if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
		echo "Working tree has uncommitted changes; commit or stash them first." >&2
		exit 1
	fi
	git fetch --no-tags origin tag "$tag"
	echo "Rebasing $(git rev-list --count "$base"..HEAD) fork commit(s) from $base onto $tag"
	git switch -c "fork/${version}"
	git rebase --onto "$tag" "$base"
fi

bun install

platform="$(bun -e 'console.log(`${process.platform}-${process.arch}`)')"
native_dir="packages/natives/native"
sentinel="__piNativesV${version//[^A-Za-z0-9]/_}"
if ! grep -qaw "$sentinel" "$native_dir"/pi_natives."$platform"-*.node 2>/dev/null; then
	tmp="$(mktemp -d)"
	trap 'rm -rf "$tmp"' EXIT
	(cd "$tmp" && npm pack --silent "@oh-my-pi/pi-natives-${platform}@${version}" >/dev/null && tar -xzf ./*.tgz)
	rm -f "$native_dir"/pi_natives."$platform"-*.node
	cp "$tmp"/package/*.node "$native_dir"/
	echo "Installed prebuilt natives ${platform}@${version}"
fi

bun packages/coding-agent/src/cli.ts --version
