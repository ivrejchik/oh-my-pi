#!/usr/bin/env bash
# Merge an upstream omp release into the current branch.
#
#   scripts/fork/merge-upstream.sh [X.Y.Z]    default: latest @oh-my-pi/pi-coding-agent on npm
#
# Merges instead of rebasing, so the branch is never force-pushed and every
# machine can keep using a plain `git pull`. Only releases whose natives are on
# npm are merged, because scripts/fork/install.sh installs them from there.
#
# On conflict the merge is left in progress: resolve it, `git commit`, then run
# scripts/fork/install.sh and scripts/fork/verify.sh.
#
# Exit codes: 0 merged or already up to date, 1 error, 2 conflict.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

upstream_url="https://github.com/can1357/oh-my-pi.git"
version="${1:-$(npm view @oh-my-pi/pi-coding-agent version)}"
tag="v${version}"

if ! npm view "@oh-my-pi/pi-natives@${version}" version >/dev/null 2>&1; then
	echo "@oh-my-pi/pi-natives@${version} is not on npm; not merging $tag" >&2
	exit 1
fi
if [ -f "$(git rev-parse --git-path MERGE_HEAD)" ]; then
	echo "A merge is in progress: resolve it and commit first." >&2
	exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	echo "Working tree has uncommitted changes; commit or stash them first." >&2
	exit 1
fi

git fetch --no-tags "$upstream_url" "+refs/tags/${tag}:refs/tags/${tag}"
if git merge-base --is-ancestor "$tag" HEAD; then
	echo "Already contains $tag"
	exit 0
fi

current="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)"
if git merge --no-edit -m "chore(fork): merge upstream $tag" "$tag"; then
	echo "Merged $tag (was $current)"
else
	echo "Conflicts merging $tag into $current-based fork:" >&2
	git diff --name-only --diff-filter=U >&2
	exit 2
fi
