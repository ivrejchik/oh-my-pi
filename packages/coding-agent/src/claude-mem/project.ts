/**
 * claude-mem project naming.
 *
 * Mirrors the plugin's `getProjectContext(cwd)`: the project is the basename
 * of the repository checkout root (or the cwd outside a repository). A linked
 * worktree additionally reports its primary checkout so context injection can
 * pull both the shared project history and the worktree-specific one; the
 * composite `<primary>/<worktree>` name is what observations are written to.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

export const UNKNOWN_PROJECT = "unknown-project";

export interface ClaudeMemProjectContext {
	/** Project name observations and prompts are written under. */
	primary: string;
	/** Every project name whose context should be injected; `primary` is last. */
	allProjects: string[];
}

export function resolveClaudeMemProject(cwd: string): ClaudeMemProjectContext {
	const directory = cwd.trim();
	if (!directory) return { primary: UNKNOWN_PROJECT, allProjects: [UNKNOWN_PROJECT] };

	let root: string | undefined;
	let primaryRoot: string | undefined;
	try {
		const repository = vcs.repo(directory);
		if (repository) {
			root = repository.root();
			primaryRoot = repository.primaryRoot();
		}
	} catch {
		// Native discovery failure → treat as a plain directory.
	}

	const checkout = root ?? directory;
	const name = path.basename(checkout) || UNKNOWN_PROJECT;
	if (primaryRoot && path.resolve(primaryRoot) !== path.resolve(checkout)) {
		const parent = path.basename(primaryRoot) || UNKNOWN_PROJECT;
		const composite = `${parent}/${name}`;
		return { primary: composite, allProjects: [parent, composite] };
	}
	return { primary: name, allProjects: [name] };
}

/** `*`, `**`, `?` and a leading `~`, as the plugin's `globToRegex` (utils/project-filter.ts). */
function globToRegex(pattern: string): RegExp {
	let expanded = pattern.replace(/\\/g, "/");
	if (expanded === "~") expanded = os.homedir();
	else if (expanded.startsWith("~/")) expanded = path.join(os.homedir(), expanded.slice(2));
	expanded = expanded.replace(/\\/g, "/");
	const regex = expanded
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		// A complete `**/` segment also matches no directory.
		.replace(/(^|\/)\*\*(?=\/)/g, "$1<<<GLOBSTAR_DIR>>>")
		.replace(/\*\*/g, "<<<GLOBSTAR>>>")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/<<<GLOBSTAR>>>/g, ".*")
		.replace(/<<<GLOBSTAR_DIR>>>\//g, "(?:.*/)?");
	return new RegExp(`^${regex}$`);
}

/**
 * Mirrors the plugin's `isProjectExcluded(cwd, CLAUDE_MEM_EXCLUDED_PROJECTS)`:
 * comma-separated globs matched against the full path and its basename;
 * `dir/**` also covers `dir` itself. An invalid pattern is skipped.
 */
export function isClaudeMemProjectExcluded(cwd: string, patterns: string): boolean {
	if (!patterns.trim()) return false;
	const normalized = cwd.replace(/\\/g, "/");
	const base = path.posix.basename(normalized);
	for (const pattern of patterns
		.split(",")
		.map(p => p.trim())
		.filter(Boolean)) {
		try {
			const regex = globToRegex(pattern);
			if (regex.test(normalized) || regex.test(base)) return true;
			if (
				pattern.replace(/\\/g, "/").endsWith("/**") &&
				globToRegex(pattern.slice(0, -3)).test(normalized.replace(/\/+$/, ""))
			) {
				return true;
			}
		} catch {
			// Invalid pattern: the plugin logs and skips it.
		}
	}
	return false;
}
