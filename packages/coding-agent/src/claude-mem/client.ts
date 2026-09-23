/**
 * HTTP client for the claude-mem worker service.
 *
 * Speaks the same REST surface the plugin's own hook CLI and MCP server use
 * (`/api/sessions/*`, `/api/search`, `/api/context/inject`, `/api/memory/save`,
 * …) so an omp session is indistinguishable from a Claude Code session on the
 * worker side. Writes (prompt, observation, summary, manual save) carry the
 * configured `platformSource`; sessions are keyed on
 * `(platform_source, content_session_id)` server-side. Reads send no source, so
 * the worker answers from every pool: omp sees Claude Code's history and the
 * other way round.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import { withTimeoutSignal } from "../utils/fetch-timeout";
import { isTextBlock } from "./content";

export interface ClaudeMemClientOptions {
	baseUrl: string;
	platformSource: string;
	timeoutMs: number;
}

/** Observation row as stored by the worker; JSON-encoded list columns are decoded. */
export interface ClaudeMemObservation {
	id: number;
	memory_session_id: string;
	project: string;
	type: string;
	title: string | null;
	subtitle: string | null;
	facts: string[];
	narrative: string | null;
	concepts: string[];
	files_read: string[];
	files_modified: string[];
	prompt_number: number | null;
	created_at: string;
	created_at_epoch: number;
	agent_type?: string | null;
	agent_id?: string | null;
	metadata?: unknown;
}

export interface ClaudeMemSessionSummary {
	id: number;
	memory_session_id: string;
	project: string;
	request: string | null;
	investigated: string | null;
	learned: string | null;
	completed: string | null;
	next_steps: string | null;
	files_read: string[];
	files_edited: string[];
	notes: string | null;
	prompt_number: number | null;
	created_at: string;
	created_at_epoch: number;
}

export interface ClaudeMemUserPrompt {
	id: number;
	content_session_id: string;
	prompt_number: number;
	prompt_text: string;
	created_at: string;
	project?: string;
}

export interface ClaudeMemSearchResult {
	observations: ClaudeMemObservation[];
	sessions: ClaudeMemSessionSummary[];
	prompts: ClaudeMemUserPrompt[];
	totalResults: number;
	query: string;
}

export interface ClaudeMemSearchOptions {
	project?: string;
	limit?: number;
	offset?: number;
	/** Comma-separated observation types (`decision,bugfix,…`). */
	obsType?: string;
	orderBy?: "date_desc" | "date_asc" | "relevance";
	dateStart?: string;
	dateEnd?: string;
	signal?: AbortSignal;
}

export interface ClaudeMemHealth {
	status: string;
	version?: string;
	pid?: number;
	uptime?: number;
	initialized?: boolean;
	mcpReady?: boolean;
	ai?: { provider?: string; authMethod?: string; lastInteraction?: string };
	dependencies?: { degraded?: boolean; statuses?: unknown[] };
}

export interface ClaudeMemProcessingStatus {
	isProcessing: boolean;
	queueDepth: number;
	parkedSessions: number;
}

export interface ClaudeMemStats {
	worker?: { version?: string; uptime?: number; activeSessions?: number; sseClients?: number; port?: number };
	database?: {
		path?: string;
		size?: number;
		observations?: number;
		sessions?: number;
		summaries?: number;
		firstObservationAt?: string | null;
	};
}

export interface ClaudeMemSessionInitInput {
	contentSessionId: string;
	project: string;
	prompt: string;
}

/**
 * `/api/sessions/init` outcome. `skipped: true` with `reason: "private"` or
 * `"internal_protocol"` means the worker stored no prompt row for this turn;
 * `reason: "duplicate"` refers to an already-stored identical prompt.
 */
export interface ClaudeMemSessionInitResult {
	skipped: boolean;
	reason?: string;
	sessionDbId?: number;
	promptNumber?: number;
	/** True when the worker recorded the prompt (fresh or duplicate); false when it must not be observed. */
	registered: boolean;
}

export interface ClaudeMemObservationInput {
	contentSessionId: string;
	toolName: string;
	toolInput: unknown;
	toolResponse: unknown;
	cwd: string;
	toolUseId?: string;
	agentId?: string;
	agentType?: string;
}

export interface ClaudeMemSummarizeInput {
	contentSessionId: string;
	lastAssistantMessage: string;
	observedModel?: string;
}

export interface ClaudeMemSaveInput {
	text: string;
	title?: string;
	project: string;
	metadata?: Record<string, unknown>;
}

export interface ClaudeMemSaveResult {
	success: boolean;
	id: number;
	title?: string;
	project?: string;
	message?: string;
}

export type ClaudeMemQueuedStatus = { status: "queued" } | { status: "skipped"; reason?: string };

export class ClaudeMemError extends Error {
	constructor(
		message: string,
		readonly statusCode?: number,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ClaudeMemError";
	}
}

function parseJsonList(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value !== "string" || !value.trim()) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

/** Decode the worker's JSON-string list columns into arrays. */
export function normalizeObservation(row: Record<string, unknown>): ClaudeMemObservation {
	let metadata: unknown = row.metadata;
	if (typeof metadata === "string") {
		try {
			metadata = JSON.parse(metadata);
		} catch {
			// keep the raw string
		}
	}
	return {
		id: Number(row.id),
		memory_session_id: String(row.memory_session_id ?? ""),
		project: String(row.project ?? ""),
		type: String(row.type ?? "discovery"),
		title: typeof row.title === "string" ? row.title : null,
		subtitle: typeof row.subtitle === "string" ? row.subtitle : null,
		facts: parseJsonList(row.facts),
		narrative: typeof row.narrative === "string" ? row.narrative : null,
		concepts: parseJsonList(row.concepts),
		files_read: parseJsonList(row.files_read),
		files_modified: parseJsonList(row.files_modified),
		prompt_number: typeof row.prompt_number === "number" ? row.prompt_number : null,
		created_at: String(row.created_at ?? ""),
		created_at_epoch: Number(row.created_at_epoch ?? 0),
		agent_type: typeof row.agent_type === "string" ? row.agent_type : null,
		agent_id: typeof row.agent_id === "string" ? row.agent_id : null,
		metadata: metadata ?? null,
	};
}

export function normalizeUserPrompt(row: Record<string, unknown>): ClaudeMemUserPrompt {
	return {
		id: Number(row.id),
		content_session_id: String(row.content_session_id ?? ""),
		prompt_number: Number(row.prompt_number ?? 0),
		prompt_text: typeof row.prompt_text === "string" ? row.prompt_text : "",
		created_at: String(row.created_at ?? ""),
		project: typeof row.project === "string" ? row.project : undefined,
	};
}

export function normalizeSessionSummary(row: Record<string, unknown>): ClaudeMemSessionSummary {
	return {
		id: Number(row.id),
		memory_session_id: String(row.memory_session_id ?? ""),
		project: String(row.project ?? ""),
		request: typeof row.request === "string" ? row.request : null,
		investigated: typeof row.investigated === "string" ? row.investigated : null,
		learned: typeof row.learned === "string" ? row.learned : null,
		completed: typeof row.completed === "string" ? row.completed : null,
		next_steps: typeof row.next_steps === "string" ? row.next_steps : null,
		files_read: parseJsonList(row.files_read),
		files_edited: parseJsonList(row.files_edited),
		notes: typeof row.notes === "string" ? row.notes : null,
		prompt_number: typeof row.prompt_number === "number" ? row.prompt_number : null,
		created_at: String(row.created_at ?? ""),
		created_at_epoch: Number(row.created_at_epoch ?? 0),
	};
}

interface RequestOptions {
	body?: unknown;
	query?: Record<string, string | number | boolean | undefined>;
	/** Return `null` on 404 instead of throwing. */
	allow404?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
	/** Parse the response as text instead of JSON. */
	text?: boolean;
}

export class ClaudeMemClient {
	readonly baseUrl: string;
	readonly platformSource: string;
	readonly timeoutMs: number;

	constructor(options: ClaudeMemClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.platformSource = options.platformSource;
		this.timeoutMs = options.timeoutMs;
	}

	// ---- lifecycle -------------------------------------------------------

	/** `null` when the worker is unreachable (connection refused / timeout). */
	async health(timeoutMs = 3_000): Promise<ClaudeMemHealth | null> {
		try {
			const raw = await this.#request("GET", "/api/health", "health", { timeoutMs });
			if (!isRecord(raw)) return null;
			const ai = isRecord(raw.ai) ? raw.ai : undefined;
			return {
				status: typeof raw.status === "string" ? raw.status : "unknown",
				version: typeof raw.version === "string" ? raw.version : undefined,
				pid: typeof raw.pid === "number" ? raw.pid : undefined,
				uptime: typeof raw.uptime === "number" ? raw.uptime : undefined,
				initialized: typeof raw.initialized === "boolean" ? raw.initialized : undefined,
				mcpReady: typeof raw.mcpReady === "boolean" ? raw.mcpReady : undefined,
				ai: ai
					? {
							provider: typeof ai.provider === "string" ? ai.provider : undefined,
							authMethod: typeof ai.authMethod === "string" ? ai.authMethod : undefined,
						}
					: undefined,
			};
		} catch {
			return null;
		}
	}

	/** True once the worker reports DB/vector/MCP initialization complete. */
	async ready(timeoutMs = 3_000): Promise<boolean> {
		try {
			const res = await fetch(`${this.baseUrl}/api/readiness`, { signal: withTimeoutSignal(timeoutMs) });
			return res.status === 200;
		} catch {
			return false;
		}
	}

	async processingStatus(signal?: AbortSignal): Promise<ClaudeMemProcessingStatus> {
		const raw = await this.#request("GET", "/api/processing-status", "processing-status", { signal });
		const res = isRecord(raw) ? raw : {};
		return {
			isProcessing: res.isProcessing === true,
			queueDepth: Number(res.queueDepth ?? 0),
			parkedSessions: Number(res.parkedSessions ?? 0),
		};
	}

	async stats(signal?: AbortSignal): Promise<ClaudeMemStats> {
		const raw = await this.#request("GET", "/api/stats", "stats", { signal });
		if (!isRecord(raw)) return {};
		// Boundary assertion: /api/stats is `{ worker, database }` with optional numeric fields.
		const stats = raw as ClaudeMemStats;
		return stats;
	}

	async chromaStatus(signal?: AbortSignal): Promise<{ status?: string; connected?: boolean } | null> {
		const raw = await this.#request("GET", "/api/chroma/status", "chroma-status", { signal, allow404: true });
		if (!isRecord(raw)) return null;
		return {
			status: typeof raw.status === "string" ? raw.status : undefined,
			connected: typeof raw.connected === "boolean" ? raw.connected : undefined,
		};
	}

	// ---- hook equivalents --------------------------------------------------

	/** SessionStart context block (markdown) for the given project names; last is primary. */
	async contextInject(projects: string[], signal?: AbortSignal): Promise<string> {
		const text = await this.#request("GET", "/api/context/inject", "context", {
			query: { projects: projects.join(",") },
			signal,
			text: true,
		});
		if (typeof text !== "string") return "";
		return text.trim();
	}

	/** UserPromptSubmit equivalent: registers the prompt and (re)activates the session. */
	async sessionInit(input: ClaudeMemSessionInitInput, signal?: AbortSignal): Promise<ClaudeMemSessionInitResult> {
		const raw = await this.#request("POST", "/api/sessions/init", "session-init", {
			body: {
				contentSessionId: input.contentSessionId,
				project: input.project,
				prompt: input.prompt,
				platformSource: this.platformSource,
			},
			signal,
		});
		const res = isRecord(raw) ? raw : {};
		const skipped = res.skipped === true;
		const reason = typeof res.reason === "string" ? res.reason : undefined;
		return {
			skipped,
			reason,
			sessionDbId: typeof res.sessionDbId === "number" ? res.sessionDbId : undefined,
			promptNumber: typeof res.promptNumber === "number" ? res.promptNumber : undefined,
			registered: !skipped || reason === "duplicate",
		};
	}

	/** PostToolUse equivalent: queues one tool result for observation extraction. */
	async observation(input: ClaudeMemObservationInput, signal?: AbortSignal): Promise<ClaudeMemQueuedStatus> {
		return (await this.#request("POST", "/api/sessions/observations", "observation", {
			body: {
				contentSessionId: input.contentSessionId,
				platformSource: this.platformSource,
				tool_name: input.toolName,
				tool_input: input.toolInput,
				tool_response: input.toolResponse,
				cwd: input.cwd,
				tool_use_id: input.toolUseId,
				agentId: input.agentId,
				agentType: input.agentType,
			},
			signal,
		})) as ClaudeMemQueuedStatus;
	}

	/** Stop equivalent: queues the turn's final assistant message for session summarization. */
	async summarize(input: ClaudeMemSummarizeInput, signal?: AbortSignal): Promise<ClaudeMemQueuedStatus> {
		return (await this.#request("POST", "/api/sessions/summarize", "summarize", {
			body: {
				contentSessionId: input.contentSessionId,
				last_assistant_message: input.lastAssistantMessage,
				platformSource: this.platformSource,
				observedModel: input.observedModel,
			},
			signal,
		})) as ClaudeMemQueuedStatus;
	}

	// ---- reads -----------------------------------------------------------------

	async search(query: string, options: ClaudeMemSearchOptions = {}): Promise<ClaudeMemSearchResult> {
		const raw = await this.#request("GET", "/api/search", "search", {
			query: {
				query,
				format: "json",
				project: options.project,
				limit: options.limit,
				offset: options.offset,
				obs_type: options.obsType,
				orderBy: options.orderBy,
				dateStart: options.dateStart,
				dateEnd: options.dateEnd,
			},
			signal: options.signal,
		});
		if (!isRecord(raw)) throw new ClaudeMemError("search returned a non-object payload", undefined, raw);
		const observations = Array.isArray(raw.observations)
			? raw.observations.filter(isRecord).map(normalizeObservation)
			: [];
		const sessions = Array.isArray(raw.sessions) ? raw.sessions.filter(isRecord).map(normalizeSessionSummary) : [];
		const prompts = Array.isArray(raw.prompts) ? raw.prompts.filter(isRecord).map(normalizeUserPrompt) : [];
		return {
			observations,
			sessions,
			prompts,
			totalResults: Number(raw.totalResults ?? observations.length + sessions.length + prompts.length),
			query: typeof raw.query === "string" ? raw.query : query,
		};
	}

	/** Timeline markdown around an observation id, `S<id>` session, ISO timestamp, or query. */
	async timeline(
		options: { anchor?: string; query?: string; depthBefore?: number; depthAfter?: number; project?: string },
		signal?: AbortSignal,
	): Promise<string> {
		const raw = await this.#request("GET", "/api/timeline", "timeline", {
			query: {
				anchor: options.anchor,
				query: options.query,
				depth_before: options.depthBefore,
				depth_after: options.depthAfter,
				project: options.project,
			},
			signal,
		});
		const content = isRecord(raw) && Array.isArray(raw.content) ? raw.content : [];
		const text = content
			.filter(isTextBlock)
			.map(block => block.text)
			.join("\n");
		if (isRecord(raw) && raw.isError === true)
			throw new ClaudeMemError(`timeline failed: ${text || "unknown error"}`);
		return text;
	}

	async getObservation(id: number, signal?: AbortSignal): Promise<ClaudeMemObservation | null> {
		const row = await this.#request("GET", `/api/observation/${id}`, "observation-read", {
			allow404: true,
			signal,
		});
		return isRecord(row) ? normalizeObservation(row) : null;
	}

	async getObservations(ids: number[], signal?: AbortSignal): Promise<ClaudeMemObservation[]> {
		if (ids.length === 0) return [];
		const rows = await this.#request("POST", "/api/observations/batch", "observations-batch", {
			body: { ids },
			signal,
		});
		return Array.isArray(rows) ? rows.filter(isRecord).map(normalizeObservation) : [];
	}

	async getSessionSummary(id: number, signal?: AbortSignal): Promise<ClaudeMemSessionSummary | null> {
		const row = await this.#request("GET", `/api/session/${id}`, "session-read", {
			allow404: true,
			signal,
		});
		return isRecord(row) ? normalizeSessionSummary(row) : null;
	}

	// ---- writes ----------------------------------------------------------------

	/** Store a manual note as a `discovery` observation (synchronous, no LLM pass). */
	async saveMemory(input: ClaudeMemSaveInput, signal?: AbortSignal): Promise<ClaudeMemSaveResult> {
		const body: Record<string, unknown> = {
			text: input.text,
			project: input.project,
			metadata: { ...input.metadata, platformSource: this.platformSource },
		};
		if (input.title) body.title = input.title;
		const raw = await this.#request("POST", "/api/memory/save", "memory-save", { body, signal });
		const res = isRecord(raw) ? raw : {};
		if (typeof res.id !== "number")
			throw new ClaudeMemError("memory-save returned no observation id", undefined, raw);
		return {
			success: res.success !== false,
			id: res.id,
			title: typeof res.title === "string" ? res.title : undefined,
			project: typeof res.project === "string" ? res.project : undefined,
			message: typeof res.message === "string" ? res.message : undefined,
		};
	}

	/** Delete one observation; `false` when it does not exist. */
	async deleteObservation(id: number, signal?: AbortSignal): Promise<boolean> {
		const raw = await this.#request("DELETE", `/api/observation/${id}`, "observation-delete", {
			allow404: true,
			signal,
		});
		return isRecord(raw) && raw.success === true;
	}

	// ---- transport ---------------------------------------------------------------

	async #request(method: string, endpoint: string, operation: string, options: RequestOptions = {}): Promise<unknown> {
		const url = new URL(`${this.baseUrl}${endpoint}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			if (value === undefined || value === "") continue;
			url.searchParams.set(key, String(value));
		}
		const timeoutMs = options.timeoutMs ?? this.timeoutMs;
		const headers: Record<string, string> = {
			Accept: options.text ? "text/plain, */*" : "application/json",
		};
		const init: RequestInit = { method, headers, signal: withTimeoutSignal(timeoutMs, options.signal) };
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(options.body);
		}

		let res: Response;
		try {
			res = await fetch(url, init);
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new ClaudeMemError(`${operation} request timed out after ${Math.round(timeoutMs / 1000)}s`);
			}
			throw new ClaudeMemError(
				`${operation} request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (res.status === 404 && options.allow404) return null;
		if (!res.ok) {
			let detail = "";
			let details: unknown;
			try {
				const text = await res.text();
				try {
					details = JSON.parse(text);
					const obj = details as { error?: unknown; message?: unknown };
					detail =
						typeof obj.error === "string" ? obj.error : typeof obj.message === "string" ? obj.message : text;
				} catch {
					detail = text;
				}
			} catch {
				// unreadable body
			}
			throw new ClaudeMemError(`${operation} failed: ${detail || `HTTP ${res.status}`}`, res.status, details);
		}
		if (options.text) return await res.text();
		const text = await res.text();
		if (!text) return null;
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return text;
		}
	}
}
