/**
 * Per-session claude-mem runtime state, owned by its AgentSession.
 *
 * Reproduces the plugin's Claude Code hook lifecycle natively:
 *   session start          → `/api/context/inject` (recent project context block)
 *   every user prompt      → `/api/sessions/init`
 *   every tool result      → `/api/sessions/observations` (ordered queue)
 *   every agent_end        → `/api/sessions/summarize`
 * plus omp-style first-turn recall via `/api/search`.
 *
 * Subagents alias the parent's state: they forward tool results (tagged with
 * their agent id) into the parent's queue but never load context, register
 * prompts, or summarize — the parent turn owns those.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { composeRecallQuery, hasSubstantiveContent, stripMemoryTags, truncateRecallQuery } from "../hindsight/content";
import { extractMessages } from "../hindsight/transcript";
import type { MemoryPromptPreparation } from "../memory-backend/types";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import {
	type ClaudeMemClient,
	ClaudeMemError,
	type ClaudeMemObservation,
	type ClaudeMemSessionSummary,
} from "./client";
import type { ClaudeMemConfig } from "./config";
import {
	formatRecallBlock,
	isTextBlock,
	projectToolResponse,
	renderObservationMarkdown,
	renderSessionSummaryMarkdown,
	resolveObservedTool,
	TOOL_NAME_MAP,
} from "./content";
import type { ClaudeMemProjectContext } from "./project";
import type { ClaudeMemWorkerProbe } from "./worker";

const RECALL_PREAMBLE =
	"Relevant observations from past sessions (prioritize recent when conflicting). " +
	"Only use memories that are directly useful to continue this conversation; ignore the rest:";

const kClaudeMemSessionState = Symbol("claude-mem.sessionState");

interface AgentSessionWithClaudeMemState extends AgentSession {
	[kClaudeMemSessionState]?: ClaudeMemSessionState;
}

export function getClaudeMemSessionState(session: AgentSession | undefined): ClaudeMemSessionState | undefined {
	return session ? (session as AgentSessionWithClaudeMemState)[kClaudeMemSessionState] : undefined;
}

export function setClaudeMemSessionState(
	session: AgentSession,
	state: ClaudeMemSessionState | undefined,
): ClaudeMemSessionState | undefined {
	const typed = session as AgentSessionWithClaudeMemState;
	const previous = typed[kClaudeMemSessionState];
	if (state) typed[kClaudeMemSessionState] = state;
	else delete typed[kClaudeMemSessionState];
	return previous;
}

export interface ClaudeMemSessionStateOptions {
	sessionId: string;
	client: ClaudeMemClient;
	config: ClaudeMemConfig;
	project: ClaudeMemProjectContext;
	session: AgentSession;
	/** Subagent alias of a primary state; shares client/config/project and forwards observations. */
	aliasOf?: ClaudeMemSessionState;
	/** Authorization carried by the dispatch that spawned an alias; consumed by its first turn. */
	dispatch?: ClaudeMemTurnAuthorization;
	hasRecalledForFirstTurn?: boolean;
}

export interface ClaudeMemRecallResults {
	observations: ClaudeMemObservation[];
	sessions: ClaudeMemSessionSummary[];
	/** True when the project-scoped search was empty and results come from every project. */
	widened: boolean;
}

export type ClaudeMemMemoryRef = { kind: "observation"; id: number } | { kind: "session"; id: number };

/**
 * Authorization for one parent turn's writes. Created when the turn's prompt
 * is queued for registration; `registered` settles with the worker's verdict
 * (`false` for a wholly private prompt, an internal-protocol payload, or a
 * failed request). Every observation/summary captures the token of the turn
 * it belongs to, so a late child result or a rekeyed parent can never borrow
 * a newer turn's permission or session id.
 */
export interface ClaudeMemTurnAuthorization {
	readonly contentSessionId: string;
	readonly registered: Promise<boolean>;
}

const DENIED_SESSION = "";

/** Token that never authorizes: the result of folding in an unauthorized contributor. */
const DENIED_AUTHORIZATION: ClaudeMemTurnAuthorization = {
	contentSessionId: DENIED_SESSION,
	registered: Promise.resolve(false),
};

/**
 * Dispatch tokens riding on queued IRC/aside records. Records are deferred,
 * parked, merged, and re-queued as the same objects, so the token follows the
 * record until the moment it is injected into a turn; persistence never sees
 * it (a promise cannot be serialized, and a replayed record is unauthorized
 * by design).
 */
const messageDispatch = new WeakMap<object, ClaudeMemTurnAuthorization>();

/** Attach the dispatcher's token to a record about to be queued for a turn. */
export function attachDispatchToMessage(message: object, token: ClaudeMemTurnAuthorization | undefined): void {
	if (token) messageDispatch.set(message, token);
}

/** Token attached to a queued record, or `undefined` for an unauthorized one. */
export function dispatchOfMessage(message: object): ClaudeMemTurnAuthorization | undefined {
	return messageDispatch.get(message);
}

/**
 * Fold the authorizations of every dispatch contributing to one child turn
 * into a single token. Undefined when any contributor carries none (an
 * unauthorized dispatch taints the whole turn); a token whose verdict is
 * negative when the contributors name different sessions (a queued message
 * from before a parent rekey cannot share a turn with one from after it);
 * otherwise positive only if every contributor's verdict is positive.
 */
export function combineTurnAuthorizations(
	tokens: ReadonlyArray<ClaudeMemTurnAuthorization | undefined>,
): ClaudeMemTurnAuthorization | undefined {
	if (tokens.length === 0) return undefined;
	const present: ClaudeMemTurnAuthorization[] = [];
	for (const token of tokens) {
		if (!token) return undefined;
		present.push(token);
	}
	if (present.length === 1) return present[0];
	const [first] = present;
	if (present.some(token => token.contentSessionId !== first.contentSessionId)) {
		return { contentSessionId: DENIED_SESSION, registered: Promise.resolve(false) };
	}
	return {
		contentSessionId: first.contentSessionId,
		registered: Promise.all(present.map(token => token.registered)).then(verdicts => verdicts.every(Boolean)),
	};
}

/** Parse `memory://` hosts: `1234` → observation, `S12` → session summary. */
export function parseClaudeMemMemoryRef(raw: string): ClaudeMemMemoryRef | undefined {
	const value = raw.trim();
	const session = /^[sS](\d+)$/.exec(value);
	if (session) return { kind: "session", id: Number.parseInt(session[1], 10) };
	if (/^\d+$/.test(value)) return { kind: "observation", id: Number.parseInt(value, 10) };
	return undefined;
}

function lastAssistantText(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const text = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map(block => block.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

function lastUserText(messages: AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user") continue;
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter(isTextBlock)
							.map(block => block.text)
							.join("\n")
					: "";
		if (hasSubstantiveContent(text)) return text;
	}
	return undefined;
}

export class ClaudeMemSessionState {
	sessionId: string;
	readonly client: ClaudeMemClient;
	readonly config: ClaudeMemConfig;
	readonly project: ClaudeMemProjectContext;
	readonly session: AgentSession;
	readonly aliasOf?: ClaudeMemSessionState;
	/** Result of the startup worker probe; `undefined` until `start()` settles it. */
	workerProbe?: ClaudeMemWorkerProbe;
	/** Cached startup context block (`<claude_mem_context>`), injected into developer instructions. */
	contextSnippet?: string;
	/** In-flight context load; the first turn races it against `config.firstTurnDeadlineMs`. */
	contextLoadPromise?: Promise<void>;
	/** Cached first-turn `<memories>` block. */
	lastRecallSnippet?: string;
	hasRecalledForFirstTurn: boolean;
	/** Bumped per staged turn start; a commit from a superseded preparation is rejected. */
	#promptGeneration = 0;
	/** Ordered write chain: session-init → observations → summarize, one HTTP call at a time. */
	#queue: Promise<void> = Promise.resolve();
	/** Settles once the worker bootstrap probe is done; every queued write waits behind it. */
	#bootstrapped: Promise<boolean> = Promise.resolve(true);
	#queued = 0;
	#pendingArgs = new Map<string, unknown>();
	#unsubscribe?: () => void;
	#warnedUnavailable = false;
	/**
	 * Token of the turn this state is currently working for. A primary sets it
	 * when it queues the turn's prompt. An alias only ever holds a token handed
	 * to it by the dispatch that started or steered its turn — never the
	 * parent's current token read at execution time, which may belong to a
	 * later turn than the one that queued the work. Undefined until the first
	 * prompt, after a rekey, and for a child turn that no dispatch authorized.
	 */
	#turn: ClaudeMemTurnAuthorization | undefined;
	/** Alias only: authorization waiting for the next turn start to consume it. */
	#pendingDispatch: ClaudeMemTurnAuthorization | undefined;

	constructor(options: ClaudeMemSessionStateOptions) {
		this.sessionId = options.sessionId;
		this.client = options.client;
		this.config = options.config;
		this.project = options.project;
		this.session = options.session;
		this.aliasOf = options.aliasOf;
		this.hasRecalledForFirstTurn = options.hasRecalledForFirstTurn ?? false;
		if (options.aliasOf) this.#pendingDispatch = options.dispatch;
	}

	/** The state that owns the worker session: itself for a primary, the parent for an alias. */
	get primary(): ClaudeMemSessionState {
		return this.aliasOf ?? this;
	}

	get cwd(): string {
		return this.session.sessionManager.getCwd();
	}

	/** Writes still waiting on the ordered queue. */
	get pendingWrites(): number {
		return this.#queued;
	}

	get workerAvailable(): boolean {
		return this.primary.workerProbe?.ready === true;
	}

	/** Order every queued write behind the worker bootstrap; records the probe result when it lands. */
	setBootstrap(probe: Promise<ClaudeMemWorkerProbe>): void {
		this.#bootstrapped = probe.then(
			result => {
				this.workerProbe = result;
				return result.ready;
			},
			() => false,
		);
	}

	/** Resolves with worker readiness once the bootstrap probe settles. */
	whenBootstrapped(): Promise<boolean> {
		return this.primary.#bootstrapped;
	}

	/**
	 * Rekey to a new worker session. Writes already queued keep the token (and
	 * session id) they were built with; nothing else is authorized until the
	 * next prompt registers under the new id.
	 */
	setSessionId(sessionId: string): void {
		if (sessionId === this.sessionId) return;
		this.sessionId = sessionId;
		this.#turn = undefined;
	}

	// ---- dispatch authorization ----------------------------------------------------

	/**
	 * Token of the turn the caller is currently working for, to be carried by a
	 * spawn, send, steer, or queued message it dispatches right now. A child
	 * dispatching its own children hands on the token that authorized it.
	 */
	captureDispatch(): ClaudeMemTurnAuthorization | undefined {
		return this.#turn;
	}

	/**
	 * Authorize the alias's next turn with the tokens carried by the dispatches
	 * that make it up (one for a spawn or send, several for queued messages
	 * folded into one turn). Accumulates: content folded into the child's
	 * context before the turn started (plan-mode appends, stranded asides)
	 * keeps its say over the turn that eventually runs, and an unauthorized
	 * contributor pins the pending verdict to denied until a turn consumes it.
	 * No-op on a primary: its turns are its own.
	 */
	authorizeNextTurn(...tokens: ReadonlyArray<ClaudeMemTurnAuthorization | undefined>): void {
		if (!this.aliasOf) return;
		const pending = this.#pendingDispatch;
		this.#pendingDispatch =
			combineTurnAuthorizations(pending ? [pending, ...tokens] : tokens) ?? DENIED_AUTHORIZATION;
	}

	/**
	 * Start an alias turn that bypasses the prompt hook (an IRC wake prompts the
	 * agent core directly): the turn is authorized right now by the records'
	 * tokens plus anything pending, and the pending slot is consumed exactly as
	 * `beforeAgentStartPrompt` would have. No-op on a primary.
	 */
	beginDispatchedTurn(...tokens: ReadonlyArray<ClaudeMemTurnAuthorization | undefined>): void {
		if (!this.aliasOf) return;
		const pending = this.#pendingDispatch;
		this.#pendingDispatch = undefined;
		this.#turn = combineTurnAuthorizations(pending ? [pending, ...tokens] : tokens) ?? DENIED_AUTHORIZATION;
	}

	/**
	 * Fold a mid-turn steer's authorization into the alias's running turn: from
	 * here on its writes need both the original dispatch and the steer to be
	 * authorized. Writes already queued keep the token they were built with.
	 * No-op on a primary.
	 */
	authorizeSteer(...tokens: ReadonlyArray<ClaudeMemTurnAuthorization | undefined>): void {
		if (!this.aliasOf) return;
		this.#turn = combineTurnAuthorizations([this.#turn, ...tokens]) ?? DENIED_AUTHORIZATION;
	}

	/** New transcript in the same process: re-arm first-turn recall and refresh the startup context. */
	resetConversationTracking(): void {
		this.hasRecalledForFirstTurn = false;
		this.lastRecallSnippet = undefined;
		if (this.config.autoContext) void this.loadContext();
	}

	// ---- startup context ---------------------------------------------------------

	/** Fetch the plugin's SessionStart context block and promote it into the base prompt. */
	loadContext(): Promise<void> {
		if (this.aliasOf || !this.config.autoContext) return Promise.resolve();
		const task = (async () => {
			let snippet: string | undefined;
			try {
				const text = await this.client.contextInject(this.project.allProjects);
				snippet = text ? `<claude_mem_context>\n${text}\n</claude_mem_context>` : undefined;
			} catch (error) {
				this.#reportFailure("context load", error);
				return;
			}
			if (snippet === this.contextSnippet) return;
			this.contextSnippet = snippet;
			try {
				await this.session.refreshBaseSystemPrompt();
			} catch (error) {
				this.#reportFailure("prompt refresh", error);
			}
		})();
		this.contextLoadPromise = task;
		return task;
	}

	// ---- per-turn -------------------------------------------------------------------

	/**
	 * Stage a turn start. The first turn waits (bounded) for the startup context
	 * and runs semantic recall; the staged context is only the new recall block,
	 * because the base prompt already renders the startup context. Every state
	 * write — prompt registration, dispatch consumption, first-turn recall
	 * bookkeeping — happens in `commit`, which runs only for the turn that is
	 * actually delivered: a preparation may be retried or abandoned.
	 */
	async beforeAgentStartPrompt(promptText: string, signal?: AbortSignal): Promise<MemoryPromptPreparation> {
		const generation = ++this.#promptGeneration;
		if (this.aliasOf) {
			// A child turn is authorized only by the dispatch that started it.
			// Without one (a wake or follow-up that carried no token) the turn's
			// writes are dropped rather than borrowed from whatever the parent is
			// doing now.
			return {
				commit: () => {
					if (this.#promptGeneration !== generation) return false;
					this.#turn = this.#pendingDispatch;
					this.#pendingDispatch = undefined;
					return true;
				},
			};
		}
		const prompt = promptText.trim();

		// First turn: give the bootstrap (and the startup context behind it) a
		// bounded head start so recall and the context block can land in the
		// very first prompt; later turns find both promises already settled.
		// The same budget bounds auto-recall: when it expires the recall is
		// deferred to the next turn instead of waiting out a slow daemon spawn.
		let bootstrapSettled = true;
		if (this.contextSnippet === undefined || !this.hasRecalledForFirstTurn) {
			bootstrapSettled = await Promise.race([
				(this.contextLoadPromise ?? this.#bootstrapped).then(() => true),
				Bun.sleep(this.config.firstTurnDeadlineMs).then(() => false),
			]);
		}

		let recall: string | undefined;
		let recallDone = false;
		if (bootstrapSettled && this.config.autoRecall && !this.hasRecalledForFirstTurn && prompt) {
			const history = extractMessages(this.session.sessionManager);
			const query = composeRecallQuery(
				prompt,
				[...history, { role: "user", content: prompt }],
				this.config.recallContextTurns,
			);
			const truncated = truncateRecallQuery(query, prompt, this.config.recallMaxQueryChars);
			recall = await this.recallForContext(truncated, signal);
			recallDone = recall !== undefined || this.workerAvailable;
		}

		return {
			context: recall,
			commit: () => {
				if (this.#promptGeneration !== generation) return false;
				if (recallDone) this.hasRecalledForFirstTurn = true;
				if (recall) this.lastRecallSnippet = recall;
				if (prompt) this.#registerPrompt(prompt);
				return true;
			},
		};
	}

	/**
	 * Queue the turn's `/api/sessions/init` and make its verdict the turn's
	 * authorization. Every turn registers its prompt, even when the text
	 * repeats: the worker's own dedupe window answers `duplicate` for a hook
	 * double-fire, and a genuinely repeated prompt is a new turn with its own
	 * privacy decision. Deduping here against an earlier registration would let
	 * a pending public init open the gate for a later private turn.
	 */
	#registerPrompt(prompt: string): void {
		const contentSessionId = this.sessionId;
		let settle: (registered: boolean) => void = () => {};
		const registered = new Promise<boolean>(resolve => {
			settle = resolve;
		});
		this.#turn = { contentSessionId, registered };
		this.#enqueue("session-init", async () => {
			let verdict = false;
			try {
				const result = await this.client.sessionInit({
					contentSessionId,
					project: this.project.primary,
					prompt,
				});
				// A `skipped` answer (wholly private prompt, internal protocol
				// payload) is definitive: the worker stored no prompt row, so nothing
				// from this turn may be observed. `duplicate` names an existing row
				// and does count as registered.
				verdict = result.registered;
				if (!verdict && this.config.debug) {
					logger.debug("claude-mem: prompt not recorded; turn will not be observed", {
						sessionId: contentSessionId,
						reason: result.reason,
					});
				}
			} finally {
				settle(verdict);
			}
		});
	}

	/**
	 * Project-scoped semantic recall rendered as a `<memories>` block; `undefined`
	 * when empty or failed. Does not wait for the bootstrap: callers on the
	 * prompt path decide whether the budget allows it.
	 */
	async recallForContext(query: string, signal?: AbortSignal): Promise<string | undefined> {
		try {
			const result = await this.client.search(query, {
				project: this.project.primary,
				limit: this.config.recallLimit,
				signal,
			});
			if (result.observations.length === 0 && result.sessions.length === 0) return undefined;
			return formatRecallBlock(result.observations, result.sessions.slice(0, 3), RECALL_PREAMBLE);
		} catch (error) {
			this.#reportFailure("recall", error);
			return undefined;
		}
	}

	async recallForCompaction(messages: AgentMessage[]): Promise<string | undefined> {
		const latest = lastUserText(messages);
		if (!latest) return undefined;
		const history = extractMessages(this.session.sessionManager);
		const query = composeRecallQuery(latest, history, this.config.recallContextTurns);
		return await this.recallForContext(truncateRecallQuery(query, latest, this.config.recallMaxQueryChars));
	}

	// ---- observation pipeline -------------------------------------------------------

	attachSessionListeners(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = this.session.subscribe(event => this.#onSessionEvent(event));
	}

	#onSessionEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "tool_execution_start":
				this.#pendingArgs.set(event.toolCallId, event.args);
				return;
			case "tool_execution_end": {
				const args = this.#pendingArgs.get(event.toolCallId);
				this.#pendingArgs.delete(event.toolCallId);
				this.observeToolResult(event.toolName, args, event.result, event.isError === true, event.toolCallId);
				return;
			}
			case "agent_end":
				if (this.aliasOf || event.isTerminal === false) return;
				this.summarizeTurn(event.messages);
				return;
			default:
				return;
		}
	}

	/** Queue one tool result as an observation. No-op for skipped tools and disabled subagents. */
	observeToolResult(toolName: string, args: unknown, result: unknown, isError: boolean, toolCallId?: string): void {
		if (!this.config.autoObserve) return;
		const observed = resolveObservedTool(toolName, args);
		if (!observed) return;
		if (this.aliasOf && !this.config.observeSubagents) return;
		const primary = this.primary;
		const turn = this.#turn;
		const agentId = this.aliasOf ? (this.session.getAgentId() ?? this.session.sessionId) : undefined;
		const payload = {
			contentSessionId: turn?.contentSessionId ?? primary.sessionId,
			toolName: TOOL_NAME_MAP[observed.name] ?? observed.name,
			toolInput: observed.args ?? {},
			toolResponse: projectToolResponse(result, isError),
			cwd: this.cwd,
			toolUseId: toolCallId,
			agentId,
			agentType: agentId ? "task" : undefined,
		};
		primary.#enqueue("observation", () => primary.client.observation(payload), { turn });
	}

	/** Queue the turn's final assistant message for summarization. */
	summarizeTurn(messages: AgentMessage[]): void {
		if (!this.config.autoSummarize || this.aliasOf) return;
		const text = lastAssistantText(messages);
		if (!text) return;
		this.#enqueueSummarize(text);
	}

	/** `/memory enqueue`: summarize the current transcript now and wait for the queue to drain. */
	async forceSummarizeCurrentSession(): Promise<void> {
		if (this.aliasOf) return;
		const latest = extractMessages(this.session.sessionManager).findLast(message => message.role === "assistant");
		if (latest) this.#enqueueSummarize(latest.content);
		await this.flush();
	}

	#enqueueSummarize(text: string): void {
		const cleaned = stripMemoryTags(text).trim();
		if (!hasSubstantiveContent(cleaned)) return;
		const turn = this.#turn;
		const payload = {
			contentSessionId: turn?.contentSessionId ?? this.sessionId,
			lastAssistantMessage: cleaned,
			observedModel: this.session.model?.id,
		};
		this.#enqueue("summarize", () => this.client.summarize(payload), { turn });
	}

	/**
	 * Wait for every queued write to settle (failures are already logged).
	 * With `timeoutMs` the wait is bounded; writes still in flight keep going
	 * in the background, which is what shutdown wants when the worker is slow.
	 */
	flush(timeoutMs?: number): Promise<void> {
		const queue = this.primary.#queue;
		return timeoutMs === undefined ? queue : Promise.race([queue, Bun.sleep(timeoutMs)]);
	}

	/**
	 * Append a write to the ordered chain. With `turn` given, the write waits
	 * for that turn's registration verdict (its init is always ahead in the
	 * chain) and is dropped unless the worker recorded the prompt; a write
	 * with no turn at all is never authorized.
	 */
	#enqueue(
		operation: string,
		work: () => Promise<unknown>,
		options: { turn?: ClaudeMemTurnAuthorization | undefined } = {},
	): void {
		const gated = "turn" in options;
		this.#queued++;
		this.#queue = this.#queue
			.then(() => this.#bootstrapped)
			.then(async () => {
				if (gated) {
					const authorized = options.turn ? await options.turn.registered : false;
					if (!authorized) {
						throw new ClaudeMemError(
							`${operation} dropped: prompt not registered for session ${options.turn?.contentSessionId ?? this.sessionId}`,
						);
					}
				}
				return await work();
			})
			.then(
				() => {
					this.#warnedUnavailable = false;
				},
				error => this.#reportFailure(operation, error),
			)
			.finally(() => {
				this.#queued--;
			});
	}

	#reportFailure(operation: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const meta = { operation, sessionId: this.sessionId, workerUrl: this.config.workerUrl, error: message };
		if (!this.#warnedUnavailable) {
			this.#warnedUnavailable = true;
			logger.warn(`claude-mem: ${operation} failed`, meta);
			return;
		}
		if (this.config.debug) logger.debug(`claude-mem: ${operation} failed`, meta);
	}

	// ---- explicit tools ------------------------------------------------------------------

	/** Search observations/sessions, project-scoped first and widened to every project when empty. */
	async search(
		query: string,
		options: { limit?: number; signal?: AbortSignal } = {},
	): Promise<ClaudeMemRecallResults> {
		await this.whenBootstrapped();
		const limit = options.limit ?? this.config.recallLimit;
		const scoped = await this.client.search(query, { project: this.project.primary, limit, signal: options.signal });
		if (scoped.observations.length > 0 || scoped.sessions.length > 0) {
			return { observations: scoped.observations, sessions: scoped.sessions, widened: false };
		}
		const widened = await this.client.search(query, { limit, signal: options.signal });
		return { observations: widened.observations, sessions: widened.sessions, widened: true };
	}

	/** Store an explicit note as an observation under the session's project. Returns the observation id. */
	async saveMemory(
		content: string,
		options: { title?: string; context?: string; source: string; importance?: number },
	): Promise<number> {
		await this.whenBootstrapped();
		const result = await this.client.saveMemory({
			text: content,
			title: options.title,
			project: this.project.primary,
			metadata: {
				source: options.source,
				session_id: this.primary.sessionId,
				cwd: this.cwd,
				context: options.context ?? null,
				importance: options.importance ?? null,
			},
		});
		return result.id;
	}

	/** Delete an observation by id; `false` when it does not exist. */
	async forget(id: number): Promise<boolean> {
		await this.whenBootstrapped();
		return await this.client.deleteObservation(id);
	}

	/** Full markdown for `memory://<id>` / `memory://S<id>`; `null` when the row does not exist. */
	async readMemory(ref: ClaudeMemMemoryRef, signal?: AbortSignal): Promise<string | null> {
		await this.whenBootstrapped();
		if (ref.kind === "session") {
			const summary = await this.client.getSessionSummary(ref.id, signal);
			return summary ? renderSessionSummaryMarkdown(summary) : null;
		}
		const observation = await this.client.getObservation(ref.id, signal);
		return observation ? renderObservationMarkdown(observation) : null;
	}

	dispose(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#pendingArgs.clear();
	}
}
