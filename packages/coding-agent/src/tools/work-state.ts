import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { loadClaudeMemConfig } from "../claude-mem/config";
import type { ClaudeMemSessionState } from "../claude-mem/state";
import { cfgMemoryBackend } from "../memory-backend/settings";
import workStateReadDescription from "../prompts/tools/work-state-read.md" with { type: "text" };
import workStateWriteDescription from "../prompts/tools/work-state-write.md" with { type: "text" };
import type { ToolSession } from ".";

const workStateWriteSchema = type({
	list: type("string").describe('to-do list or tracked thing, e.g. "release"'),
	fields: type({ "[string]": "string | number | boolean | null" }).describe(
		'keys to set; include "task" for a to-do item; null clears a key',
	),
});

const workStateReadSchema = type({
	"list?": type("string").describe("read only this list"),
	"includeClosed?": type("boolean").describe("also show done and dropped items and closed lists"),
});

export type WorkStateWriteParams = typeof workStateWriteSchema.infer;
export type WorkStateReadParams = typeof workStateReadSchema.infer;

/** Offered with the claude-mem backend unless `CLAUDE_MEM_WORK_STATE_ENABLED` is false. */
function workStateAvailable(session: ToolSession): boolean {
	if (cfgMemoryBackend.get(session.settings) !== "claude-mem") return false;
	return loadClaudeMemConfig(session.settings).workStateEnabled;
}

function requireState(session: ToolSession): ClaudeMemSessionState {
	const state = session.getClaudeMemSessionState?.();
	if (!state) throw new Error("claude-mem backend is not initialised for this session.");
	return state;
}

export class WorkStateWriteTool implements AgentTool<typeof workStateWriteSchema> {
	readonly name = "work_state_write";
	readonly approval = "read" as const;
	readonly label = "Work State";
	readonly description = workStateWriteDescription;
	readonly parameters = workStateWriteSchema;
	readonly loadMode = "discoverable";
	readonly summary = "Track cross-session to-do lists and working state (claude-mem)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WorkStateWriteTool | null {
		return workStateAvailable(session) ? new WorkStateWriteTool(session) : null;
	}

	async execute(
		_id: string,
		params: WorkStateWriteParams,
		signal?: AbortSignal,
	): Promise<AgentToolResult<{ list: string }>> {
		const text = await requireState(this.session).workStateWrite(
			{ list: params.list, fields: params.fields },
			signal,
		);
		return { content: [{ type: "text", text }], details: { list: params.list } };
	}
}

export class WorkStateReadTool implements AgentTool<typeof workStateReadSchema> {
	readonly name = "work_state_read";
	readonly approval = "read" as const;
	readonly label = "Work State";
	readonly description = workStateReadDescription;
	readonly parameters = workStateReadSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Read cross-session to-do lists and working state (claude-mem)";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): WorkStateReadTool | null {
		return workStateAvailable(session) ? new WorkStateReadTool(session) : null;
	}

	async execute(_id: string, params: WorkStateReadParams, signal?: AbortSignal): Promise<AgentToolResult> {
		const text = await requireState(this.session).workStateRead(
			{ list: params.list, includeClosed: params.includeClosed },
			signal,
		);
		return { content: [{ type: "text", text }] };
	}
}
