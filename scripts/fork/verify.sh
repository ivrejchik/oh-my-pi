#!/usr/bin/env bash
# Check that the fork still works on top of its upstream release.
#
#   scripts/fork/verify.sh
#
# Typechecks coding-agent and runs every test file the fork changed relative to
# the nearest upstream release tag, so the list follows the fork's commits.
# Expects scripts/fork/install.sh to have run.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

base="$(git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD)"
echo "Verifying fork changes since $base"

(cd packages/coding-agent && bun run check:types)

mapfile -t tests < <(git diff --name-only --diff-filter=d "$base" HEAD -- 'packages/*/test/**.test.ts')
if [ "${#tests[@]}" -eq 0 ]; then
	echo "No fork-changed tests"
else
	for pkg in $(printf '%s\n' "${tests[@]}" | cut -d/ -f2 | sort -u); do
		mapfile -t pkg_tests < <(printf '%s\n' "${tests[@]}" | grep "^packages/$pkg/" | sed "s#^packages/$pkg/##")
		(cd "packages/$pkg" && bun test "${pkg_tests[@]}")
	done
fi

# Bundled agents parse with level "fatal"; a broken one breaks all task discovery.
agents_dir="$(mktemp -d)"
trap 'rm -rf "$agents_dir"' EXIT
bun packages/coding-agent/src/cli.ts agents unpack --dir "$agents_dir" --json >/dev/null
echo "Bundled agents: $(cd "$agents_dir" && ls | sed 's/\.md$//' | paste -sd, -)"

bun packages/coding-agent/src/cli.ts --version
