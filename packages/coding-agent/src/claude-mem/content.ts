/**
 * Pure formatting helpers for the claude-mem backend: tool-result projection
 * for observation ingest, recall rendering for prompts and tools, and the
 * markdown rendering behind `memory://<id>`.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import type { ClaudeMemObservation, ClaudeMemSessionSummary } from "./client";

/** Longest tool output forwarded to the observer; matches the plugin's hook cap. */
export const MAX_TOOL_RESPONSE_CHARS = 100_000;

/**
 * OMP tool name → Claude Code tool name. The worker's skip list, tier routing,
 * and file tracking key on Claude Code names (`Read`, `Edit`, `TodoWrite`, …),
 * so mapped names get the same treatment an equivalent Claude Code call would.
 * Unmapped tools pass through verbatim.
 */
export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
	read: "Read",
	write: "Write",
	edit: "Edit",
	bash: "Bash",
	grep: "Grep",
	glob: "Glob",
	todo: "TodoWrite",
	ask: "AskUserQuestion",
	task: "Task",
	web_search: "WebSearch",
	web_fetch: "WebFetch",
	notebook_edit: "NotebookEdit",
};

/** omp memory tools never become observations — that would feed recall back into memory. */
export const OBSERVATION_SKIP_TOOLS: Readonly<Record<string, true>> = {
	recall: true,
	retain: true,
	reflect: true,
	memory_edit: true,
	learn: true,
};

const OBS_TYPE_GLYPH: Readonly<Record<string, string>> = {
	bugfix: "●",
	feature: "◆",
	refactor: "↻",
	change: "✓",
	discovery: "○",
	decision: "⚖",
	security_alert: "⚠",
	security_note: "⚷",
	sensitive: "⊘",
};

/** `{ type: "text", text }` content block guard shared by tool results and messages. */
export function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

const XD_DEVICE_PREFIX = "xd://";
const MEMORY_URL_PREFIX = "memory://";

export interface ObservedTool {
	/** Tool name as the worker should see it (before Claude Code mapping). */
	name: string;
	/** Tool arguments as the worker should see them. */
	args: unknown;
}

/**
 * Decide what a finished tool call looks like to the observer, or `undefined`
 * when it must not be observed.
 *
 * Discoverable tools run as `write` calls to `xd://<device>` with a JSON body,
 * so a memory `recall` would otherwise arrive as a `Write` of a fake path
 * carrying the recalled memories — a feedback loop. Those calls are unwrapped
 * to the device name and its decoded arguments, then gated like a direct call.
 * `read memory://…` is skipped for the same reason.
 */
export function resolveObservedTool(toolName: string, args: unknown): ObservedTool | undefined {
	let name = toolName;
	let observedArgs = args;
	if (
		toolName === "write" &&
		isRecord(args) &&
		typeof args.path === "string" &&
		args.path.startsWith(XD_DEVICE_PREFIX)
	) {
		name = args.path.slice(XD_DEVICE_PREFIX.length).split(/[/?#]/, 1)[0] ?? "";
		if (!name) return undefined;
		observedArgs = args.content;
		if (typeof observedArgs === "string") {
			try {
				observedArgs = JSON.parse(observedArgs) as unknown;
			} catch {
				// keep the raw body
			}
		}
	}
	if (OBSERVATION_SKIP_TOOLS[name]) return undefined;
	if (name === "read" && isRecord(args) && typeof args.path === "string" && args.path.startsWith(MEMORY_URL_PREFIX)) {
		return undefined;
	}
	return { name, args: observedArgs };
}

/**
 * Tags whose complete `<tag>…</tag>` pairs the worker strips before storing
 * or forwarding text (`utils/tag-stripping.ts` upstream). Mirrored here so a
 * pair that straddles the response cap is removed whole instead of losing its
 * closing tag to truncation and leaking the body.
 */
const PRIVATE_TAG_NAMES = [
	"private",
	"claude-mem-context",
	"system_instruction",
	"system-instruction",
	"persisted-output",
	"system-reminder",
];
const PRIVATE_TAG_PAIR_REGEX = new RegExp(`<(${PRIVATE_TAG_NAMES.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "g");

/** Remove every complete private/meta tag pair, exactly like the worker does. */
export function stripPrivateTags(text: string): string {
	return text.replace(PRIVATE_TAG_PAIR_REGEX, "");
}

/** Flatten a tool result into the `{ output }` / `{ error }` shape the worker expects. */
export function projectToolResponse(result: unknown, isError: boolean): { output: string } | { error: string } {
	const parts: string[] = [];
	const content = isRecord(result) ? result.content : undefined;
	if (typeof content === "string") parts.push(content);
	else if (Array.isArray(content)) {
		for (const block of content) {
			if (isTextBlock(block)) parts.push(block.text);
			else if (isRecord(block) && block.type === "image") {
				parts.push(`[image${typeof block.mimeType === "string" ? ` ${block.mimeType}` : ""}]`);
			}
		}
	} else if (result !== undefined && result !== null && typeof result !== "object") {
		parts.push(String(result));
	}
	let text = stripPrivateTags(parts.join("\n"));
	if (text.length > MAX_TOOL_RESPONSE_CHARS) text = `${text.slice(0, MAX_TOOL_RESPONSE_CHARS)}\n[truncated]`;
	return isError ? { error: text } : { output: text };
}

export function formatObservationDate(
	observation: Pick<ClaudeMemObservation, "created_at" | "created_at_epoch">,
): string {
	const epoch = observation.created_at_epoch || Date.parse(observation.created_at);
	if (!Number.isFinite(epoch) || epoch <= 0) return observation.created_at || "unknown";
	return new Date(epoch).toISOString().slice(0, 16).replace("T", " ");
}

/** One-line index entry: `#1234 2026-09-14 10:01 ◆ feature — Title — subtitle`. */
export function formatObservationLine(observation: ClaudeMemObservation): string {
	const glyph = OBS_TYPE_GLYPH[observation.type] ?? "·";
	const title = observation.title?.trim() || "(untitled)";
	const subtitle = observation.subtitle?.trim();
	return `#${observation.id} ${formatObservationDate(observation)} ${glyph} ${observation.type} — ${title}${subtitle ? ` — ${subtitle}` : ""}`;
}

/** Compact multi-line entry with facts, used inside `<memories>` blocks. */
export function formatObservationEntry(observation: ClaudeMemObservation, maxFacts = 6): string {
	const lines = [formatObservationLine(observation)];
	for (const fact of observation.facts.slice(0, maxFacts)) lines.push(`  - ${fact}`);
	if (observation.facts.length > maxFacts) lines.push(`  - … ${observation.facts.length - maxFacts} more facts`);
	const files = [...observation.files_modified, ...observation.files_read].slice(0, 5);
	if (files.length > 0) lines.push(`  files: ${files.join(", ")}`);
	return lines.join("\n");
}

export function formatSessionSummaryLine(summary: ClaudeMemSessionSummary): string {
	const request = summary.request?.trim() || "(no request recorded)";
	return `#S${summary.id} ${formatObservationDate(summary)} 🎯 session — ${request}`;
}

/** Recall block for prompt injection (first turn, compaction). */
export function formatRecallBlock(
	observations: ClaudeMemObservation[],
	sessions: ClaudeMemSessionSummary[],
	preamble: string,
): string {
	const entries = [...observations.map(obs => formatObservationEntry(obs)), ...sessions.map(formatSessionSummaryLine)];
	return `<memories>\n${preamble}\nCurrent time: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC\n\n${entries.join("\n")}\n</memories>`;
}

/** `recall` tool rendering: index with ids and the follow-up read hint. */
export function formatRecallForTool(observations: ClaudeMemObservation[], sessions: ClaudeMemSessionSummary[]): string {
	const lines: string[] = [];
	if (observations.length > 0) {
		lines.push("Observations (read full detail with `read memory://<id>`):");
		for (const obs of observations) lines.push(formatObservationEntry(obs, 4));
	}
	if (sessions.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Session summaries (read with `read memory://S<id>`):");
		for (const summary of sessions) lines.push(formatSessionSummaryLine(summary));
	}
	return lines.join("\n");
}

/** Plain-text projection used for `MemoryBackendSearchItem.content`. */
export function observationToText(observation: ClaudeMemObservation): string {
	const parts = [observation.title?.trim() || "(untitled)"];
	if (observation.subtitle?.trim()) parts.push(observation.subtitle.trim());
	if (observation.facts.length > 0) parts.push(observation.facts.map(fact => `- ${fact}`).join("\n"));
	else if (observation.narrative?.trim()) parts.push(observation.narrative.trim());
	return parts.join("\n");
}

/** Full observation as markdown with a YAML front-matter header (the `memory://<id>` body). */
export function renderObservationMarkdown(observation: ClaudeMemObservation): string {
	const header = [
		"---",
		`id: ${observation.id}`,
		"kind: observation",
		`type: ${observation.type}`,
		`project: ${JSON.stringify(observation.project)}`,
		`created_at: ${observation.created_at}`,
		`memory_session_id: ${JSON.stringify(observation.memory_session_id)}`,
		observation.prompt_number != null ? `prompt_number: ${observation.prompt_number}` : undefined,
		observation.agent_type ? `agent_type: ${JSON.stringify(observation.agent_type)}` : undefined,
		observation.agent_id ? `agent_id: ${JSON.stringify(observation.agent_id)}` : undefined,
		observation.concepts.length > 0 ? `concepts: ${JSON.stringify(observation.concepts)}` : undefined,
		observation.files_read.length > 0 ? `files_read: ${JSON.stringify(observation.files_read)}` : undefined,
		observation.files_modified.length > 0
			? `files_modified: ${JSON.stringify(observation.files_modified)}`
			: undefined,
		observation.metadata != null ? `metadata: ${JSON.stringify(observation.metadata)}` : undefined,
		"---",
		"",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	const body: string[] = [`# ${observation.title?.trim() || "(untitled)"}`];
	if (observation.subtitle?.trim()) body.push("", observation.subtitle.trim());
	if (observation.facts.length > 0) body.push("", "## Facts", ...observation.facts.map(fact => `- ${fact}`));
	if (observation.narrative?.trim()) body.push("", "## Narrative", observation.narrative.trim());
	return `${header}${body.join("\n")}\n`;
}

/** Full session summary as markdown with a YAML front-matter header (the `memory://S<id>` body). */
export function renderSessionSummaryMarkdown(summary: ClaudeMemSessionSummary): string {
	const header = [
		"---",
		`id: S${summary.id}`,
		"kind: session_summary",
		`project: ${JSON.stringify(summary.project)}`,
		`created_at: ${summary.created_at}`,
		`memory_session_id: ${JSON.stringify(summary.memory_session_id)}`,
		summary.prompt_number != null ? `prompt_number: ${summary.prompt_number}` : undefined,
		summary.files_read.length > 0 ? `files_read: ${JSON.stringify(summary.files_read)}` : undefined,
		summary.files_edited.length > 0 ? `files_edited: ${JSON.stringify(summary.files_edited)}` : undefined,
		"---",
		"",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
	const sections: [string, string | null][] = [
		["Request", summary.request],
		["Investigated", summary.investigated],
		["Learned", summary.learned],
		["Completed", summary.completed],
		["Next steps", summary.next_steps],
		["Notes", summary.notes],
	];
	const body: string[] = [`# Session summary #S${summary.id}`];
	for (const [title, text] of sections) {
		if (!text?.trim()) continue;
		body.push("", `## ${title}`, text.trim());
	}
	return `${header}${body.join("\n")}\n`;
}
