/**
 * claude-mem project naming.
 *
 * Mirrors the plugin's `getProjectContext(cwd)`: the project is the basename
 * of the repository checkout root (or the cwd outside a repository). A linked
 * worktree additionally reports its primary checkout so context injection can
 * pull both the shared project history and the worktree-specific one; the
 * composite `<primary>/<worktree>` name is what observations are written to.
 */

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
