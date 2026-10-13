#!/usr/bin/env bash
# Merge an upstream omp release into the current branch.
#
#   scripts/fork/merge-upstream.sh [X.Y.Z]    default: latest @oh-my-pi/pi-coding-agent on npm
#
# Merges instead of rebasing, so the branch is never force-pushed and every
# machine can keep using a plain `git pull`. Only releases whose natives are on
# npm are merged, because scripts/fork/install.sh installs them from there.
#
# Conflicts in catalog files upstream regenerates (models.json, rules.json,
# the login-order list) are resolved automatically: upstream's copy plus
# scripts/fork/reapply-catalog.ts. Any other conflict leaves the merge in
# progress: resolve it, `git commit`, then run scripts/fork/install.sh
# --no-launcher and scripts/fork/verify.sh.
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
	exit 0
fi

generated="packages/catalog/src/models.json packages/catalog/src/compat/rules.json packages/catalog/src/compat/rules/auth/_order.kdl"
conflicted="$(git diff --name-only --diff-filter=U)"
regenerate=0
for file in $generated; do
	if printf '%s\n' "$conflicted" | grep -qxF "$file"; then
		git checkout --theirs -- "$file"
		regenerate=1
	fi
done
# Regenerating needs the merged tree's dependencies and natives. Paths stay
# unmerged in the index until regeneration succeeds.
if [ "$regenerate" = 1 ] && scripts/fork/install.sh --no-launcher >/dev/null && bun scripts/fork/reapply-catalog.ts; then
	# shellcheck disable=SC2086 # fixed repo paths without whitespace
	git add -- $generated
	echo "Regenerated catalog files from upstream's copies"
fi

remaining="$(git diff --name-only --diff-filter=U)"
if [ -n "$remaining" ]; then
	echo "Conflicts merging $tag into $current-based fork:" >&2
	echo "$remaining" >&2
	exit 2
fi
git commit --no-edit
echo "Merged $tag (was $current)"
