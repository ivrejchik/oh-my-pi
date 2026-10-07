/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// claude-mem (https://github.com/thedotmack/claude-mem): talks to the plugin's worker daemon.
// `CLAUDE_MEM_*` environment overrides are applied in `claude-mem/config.ts`.

export const cfgClaudeMemWorkerUrl = register({
	id: "claudeMem.workerUrl",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Worker URL",
		description:
			"Worker base URL. Defaults to http://<CLAUDE_MEM_WORKER_HOST>:<CLAUDE_MEM_WORKER_PORT> from ~/.claude-mem/settings.json",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemDataDir = register({
	id: "claudeMem.dataDir",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Data Dir",
		description: "claude-mem data directory (settings.json, database, logs). Defaults to ~/.claude-mem",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemPluginRoot = register({
	id: "claudeMem.pluginRoot",
	type: "string",
	default: undefined,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Plugin Root",
		description:
			"Directory containing scripts/worker-service.cjs. Defaults to the newest installed plugin under ~/.claude/plugins/cache/thedotmack/claude-mem",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemPlatformSource = register({
	id: "claudeMem.platformSource",
	type: "string",
	default: "claude",
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Platform Source",
		description:
			"Source tag written on this agent's sessions, prompts, observations, and summaries. omp reads every source; Claude Code's hooks read only `claude`, so another tag keeps omp sessions out of Claude Code's startup context",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemAutoStartWorker = register({
	id: "claudeMem.autoStartWorker",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Auto-Start Worker",
		description: "Launch the worker daemon through the plugin when it is not running",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemAutoContext = register({
	id: "claudeMem.autoContext",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Startup Context",
		description: "Inject the project's recent observations and session summaries at session start",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemAutoRecall = register({
	id: "claudeMem.autoRecall",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Auto Recall",
		description: "Search observations relevant to the first prompt of each session",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemAutoObserve = register({
	id: "claudeMem.autoObserve",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Auto Observe",
		description: "Send every tool result to the worker for observation extraction",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemObserveSubagents = register({
	id: "claudeMem.observeSubagents",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Observe Subagents",
		description: "Also observe subagent tool results (tagged with the subagent id)",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemAutoSummarize = register({
	id: "claudeMem.autoSummarize",
	type: "boolean",
	default: true,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Auto Summarize",
		description: "Queue a session summary from the final assistant message after every turn",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemRecallLimit = register({
	id: "claudeMem.recallLimit",
	type: "number",
	default: 10,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Recall Limit",
		description: "Maximum observations returned by recall and first-turn injection",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemRecallContextTurns = register({
	id: "claudeMem.recallContextTurns",
	type: "number",
	default: 1,
});

export const cfgClaudeMemRecallMaxQueryChars = register({
	id: "claudeMem.recallMaxQueryChars",
	type: "number",
	default: 800,
});

export const cfgClaudeMemInjectionTokenLimit = register({
	id: "claudeMem.injectionTokenLimit",
	type: "number",
	default: 8_000,
	ui: {
		tab: "memory",
		group: "Claude-mem",
		label: "claude-mem Injection Token Limit",
		description: "Approximate token cap for the memory block in the system prompt (0 = unlimited)",
		condition: "claudeMemActive",
	},
});

export const cfgClaudeMemRequestTimeoutMs = register({
	id: "claudeMem.requestTimeoutMs",
	type: "number",
	default: 30_000,
});

export const cfgClaudeMemWorkerStartTimeoutMs = register({
	id: "claudeMem.workerStartTimeoutMs",
	type: "number",
	default: 45_000,
});

export const cfgClaudeMemFirstTurnDeadlineMs = register({
	id: "claudeMem.firstTurnDeadlineMs",
	type: "number",
	default: 8_000,
});

export const cfgClaudeMemDebug = register({ id: "claudeMem.debug", type: "boolean", default: false });
