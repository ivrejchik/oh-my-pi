/**
 * Contract: a vibe worker's claude-mem writes are authorized by the parent
 * turn that dispatched the work (spawn, send, steer, or queued message), as
 * captured at the tool call — never by whatever turn the parent is on when
 * the child's turn eventually starts.
 *
 * The executor is mocked at the boundary the runtime hands the token across
 * (`runSubprocess` / `runSubagentFollowUpTurn`); the mocks consume the token
 * the way the real executor does and then emit tool results through a real
 * claude-mem alias, so the assertion is on what reaches the worker.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { claudeMemBackend } from "@oh-my-pi/pi-coding-agent/claude-mem/backend";
import {
	type ClaudeMemSessionState,
	type ClaudeMemTurnAuthorization,
	getClaudeMemSessionState,
} from "@oh-my-pi/pi-coding-agent/claude-mem/state";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSessionEvent, AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ExecutorOptions, FollowUpTurnOptions } from "@oh-my-pi/pi-coding-agent/task/executor";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord } from "@oh-my-pi/pi-utils";

const PRIVATE_PROMPT = "<private>rotate the prod key</private>";
const PARENT_SESSION_ID = "vibe-parent";

interface RecordedRequest {
	method: string;
	path: string;
	body: unknown;
}

class FakeWorker {
	readonly requests: RecordedRequest[] = [];
	readonly #server: Bun.Server<undefined>;

	constructor() {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const url = new URL(request.url);
				const text = await request.text();
				const recorded: RecordedRequest = {
					method: request.method,
					path: url.pathname,
					body: text ? JSON.parse(text) : undefined,
				};
				this.requests.push(recorded);
				return this.#respond(recorded);
			},
		});
	}

	get url(): string {
		return `http://127.0.0.1:${this.#server.port}`;
	}

	received(method: string, pathname: string): RecordedRequest[] {
		return this.requests.filter(request => request.method === method && request.path === pathname);
	}

	stop(): void {
		this.#server.stop(true);
	}

	#respond(request: RecordedRequest): Response {
		switch (request.path) {
			case "/api/health":
				return Response.json({ status: "ok", version: "13.24.23", pid: 4242, uptime: 1 });
			case "/api/readiness":
				return new Response("ready");
			case "/api/context/inject":
				return new Response("", { headers: { "Content-Type": "text/plain" } });
			case "/api/sessions/init": {
				const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
				// Real worker shape: a wholly private prompt is acknowledged but skipped.
				return prompt === PRIVATE_PROMPT
					? Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" })
					: Response.json({
							sessionDbId: 9,
							promptNumber: 2,
							skipped: false,
							contextInjected: false,
							status: "initialized",
						});
			}
			case "/api/sessions/observations":
			case "/api/sessions/summarize":
				return Response.json({ status: "queued" });
			case "/api/search":
				return Response.json({ observations: [], sessions: [], prompts: [], totalResults: 0, query: "" });
			case "/api/stats":
				return Response.json({ database: { observations: 3 } });
			case "/api/processing-status":
				return Response.json({ isProcessing: false, queueDepth: 0, parkedSessions: 0 });
			default:
				return Response.json({ error: "not found" }, { status: 404 });
		}
	}
}

interface FakeSession {
	sessionId: string;
	settings: Settings;
	model: { id: string };
	isStreaming: boolean;
	steer: Mock<(message: string) => Promise<void>>;
	sessionManager: {
		getEntries: () => never[];
		getCwd: () => string;
		getSessionFile: () => null;
		getSessionId: () => string;
	};
	subscribe(listener: AgentSessionEventListener): () => void;
	refreshBaseSystemPrompt: Mock<() => Promise<void>>;
	getAgentId(): string | undefined;
	emitNotice(): void;
	emit(event: AgentSessionEvent): void;
}

function makeFakeSession(sessionId: string, settings: Settings, agentId?: string): FakeSession {
	const listeners = new Set<AgentSessionEventListener>();
	return {
		sessionId,
		settings,
		model: { id: "test-model" },
		isStreaming: false,
		steer: vi.fn().mockResolvedValue(undefined),
		sessionManager: {
			getEntries: () => [],
			getCwd: () => settings.getCwd(),
			getSessionFile: () => null,
			getSessionId: () => sessionId,
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		getAgentId: () => agentId,
		emitNotice() {},
		emit(event) {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const l of [...listeners]) l(event);
		},
	};
}

function toolCall(session: FakeSession, toolCallId: string, command: string, output: string): void {
	session.emit({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command } });
	session.emit({
		type: "tool_execution_end",
		toolCallId,
		toolName: "bash",
		result: { content: output },
		isError: false,
	});
}

function singleResult(id: string, task: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "sonic",
		agentSource: "bundled",
		task,
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 0,
	} as SingleResult;
}

interface Fixture {
	worker: FakeWorker;
	settings: Settings;
	parent: FakeSession;
	parentState: ClaudeMemSessionState;
	toolSession: ToolSession;
	manager: AsyncJobManager;
}

const tempDirs: string[] = [];
const workers: FakeWorker[] = [];
let manager: AsyncJobManager;

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

async function startFixture(): Promise<Fixture> {
	const worker = new FakeWorker();
	workers.push(worker);
	const cwd = await makeTempDir("vibe-claude-mem-project");
	const settings = Settings.isolated({
		"memory.backend": "claude-mem",
		"claudeMem.workerUrl": worker.url,
		"claudeMem.autoStartWorker": false,
		"claudeMem.dataDir": await makeTempDir("vibe-claude-mem-data"),
		"claudeMem.workerStartTimeoutMs": 1_000,
		modelRoles: { default: "anthropic/opus", smol: "anthropic/haiku" },
	});
	await settings.reloadForCwd(cwd);
	const parent = makeFakeSession(PARENT_SESSION_ID, settings);
	await claudeMemBackend.start({
		session: parent as never,
		settings,
		modelRegistry: {} as never,
		agentDir: "/tmp",
		taskDepth: 0,
	});
	const parentState = getClaudeMemSessionState(parent as never);
	if (!parentState) throw new Error("parent claude-mem state was not installed");
	await parentState.contextLoadPromise;
	const toolSession = {
		cwd,
		settings,
		asyncJobManager: manager,
		getSessionId: () => PARENT_SESSION_ID,
		// No session file: spawn skips lifecycle persistence and stays in-memory.
		getSessionFile: () => null,
		getArtifactsDir: () => null,
		getClaudeMemSessionState: () => parentState,
		taskDepth: 0,
		enableLsp: false,
	} as unknown as ToolSession;
	return { worker, settings, parent, parentState, toolSession, manager };
}

/** Stage a turn start and commit it the way AgentSession does on delivery. */
async function startTurn(session: unknown, prompt: string): Promise<void> {
	const preparation = await claudeMemBackend.beforeAgentStartPrompt?.(session as never, prompt);
	if (preparation && !preparation.commit()) throw new Error("claude-mem rejected the turn commit");
}

/** Parent turn start, the way the agent loop registers a prompt before dispatching tools. */
async function parentTurn(fixture: Fixture, prompt: string): Promise<ClaudeMemTurnAuthorization | undefined> {
	await startTurn(fixture.parent as never, prompt);
	return fixture.parentState.captureDispatch();
}

/** The executor side of a first turn: create the child's alias from the spawn options and start its turn. */
async function startChildFromSpawn(options: ExecutorOptions, settings: Settings): Promise<FakeSession> {
	const child = makeFakeSession(`${options.id}-session`, settings, options.id);
	await claudeMemBackend.start({
		session: child as never,
		settings,
		modelRegistry: {} as never,
		agentDir: "/tmp",
		taskDepth: 1,
		parentClaudeMemSessionState: options.parentClaudeMemSessionState,
		parentClaudeMemDispatch: options.parentClaudeMemDispatch,
	});
	await startTurn(child as never, options.task);
	return child;
}

/** The executor side of a follow-up turn: arm the alias with the carried token and start the turn. */
async function startChildFollowUp(child: FakeSession, options: FollowUpTurnOptions): Promise<void> {
	getClaudeMemSessionState(child as never)?.authorizeNextTurn(options.claudeMemDispatch);
	await startTurn(child as never, options.message);
}

function registerChildRef(id: string, child: FakeSession, status: "idle" | "running"): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: child as never,
		status,
	});
}

function observations(worker: FakeWorker): unknown[] {
	return worker.received("POST", "/api/sessions/observations").map(request => request.body);
}

beforeEach(() => {
	resetSettingsForTest();
	manager = new AsyncJobManager({ onJobComplete: () => {} });
});

afterEach(async () => {
	vi.restoreAllMocks();
	await manager.dispose({ timeoutMs: 200 });
	VibeSessionRegistry.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	for (const worker of workers.splice(0)) worker.stop();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("vibe claude-mem dispatch authorization", () => {
	it("authorizes a queued message by the parent turn that queued it, not the turn running when it starts", async () => {
		const fixture = await startFixture();
		const { worker, settings, toolSession } = fixture;
		const registry = VibeSessionRegistry.global();

		// First turn stays in flight until released so that sends queue behind it.
		const firstTurn = Promise.withResolvers<void>();
		const spawned = Promise.withResolvers<FakeSession>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.resolve(await startChildFromSpawn(options, settings));
			await firstTurn.promise;
			return singleResult(options.id, options.task);
		});
		const followUps: FollowUpTurnOptions[] = [];
		const followUpDone = Promise.withResolvers<void>();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			followUps.push(options);
			const child = await spawned.promise;
			await startChildFollowUp(child, options);
			toolCall(child, `call-${followUps.length}`, "cat prod.key", `hunter2-${followUps.length}`);
			followUpDone.resolve();
			return singleResult(options.id, options.message);
		});

		// Public turn B0 spawns the worker; private turn A queues work for it.
		await parentTurn(fixture, "spawn a helper");
		const { id } = await registry.spawn(toolSession, { cli: "fast", prompt: "first job" });
		const child = await spawned.promise;
		registerChildRef(id, child, "idle");
		toolCall(child, "call-first", "ls", "a.ts");

		const tokenA = await parentTurn(fixture, PRIVATE_PROMPT);
		expect(await registry.send(toolSession, { session: id, message: "read the prod key" })).toMatchObject({
			mode: "queued",
		});

		// The parent moves on to public turn B and it settles; under the old
		// design the gate would now be open when the queued turn starts.
		await parentTurn(fixture, "public follow-up");
		await fixture.parentState.flush();

		firstTurn.resolve();
		await followUpDone.promise;
		await fixture.parentState.flush();

		expect(followUps).toHaveLength(1);
		expect(followUps[0]?.claudeMemDispatch).toBe(tokenA);
		expect(observations(worker)).toEqual([
			expect.objectContaining({ tool_use_id: "call-first", contentSessionId: PARENT_SESSION_ID }),
		]);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");
	});

	it("posts an idle worker's turn under the public parent turn that sent it", async () => {
		const fixture = await startFixture();
		const { worker, settings, toolSession } = fixture;
		const registry = VibeSessionRegistry.global();

		const spawned = Promise.withResolvers<FakeSession>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.resolve(await startChildFromSpawn(options, settings));
			return singleResult(options.id, options.task);
		});
		const followUpDone = Promise.withResolvers<FollowUpTurnOptions>();
		vi.spyOn(executorModule, "runSubagentFollowUpTurn").mockImplementation(async options => {
			const child = await spawned.promise;
			await startChildFollowUp(child, options);
			toolCall(child, "call-follow-up", "ls", "b.ts");
			followUpDone.resolve(options);
			return singleResult(options.id, options.message);
		});

		await parentTurn(fixture, "spawn a helper");
		const { id, jobId } = await registry.spawn(toolSession, { cli: "fast", prompt: "first job" });
		const child = await spawned.promise;
		registerChildRef(id, child, "idle");
		await manager.getJob(jobId)?.promise;

		const tokenB = await parentTurn(fixture, "public follow-up");
		expect(await registry.send(toolSession, { session: id, message: "list files" })).toMatchObject({ mode: "turn" });
		const followUp = await followUpDone.promise;
		await fixture.parentState.flush();

		expect(followUp.claudeMemDispatch).toBe(tokenB);
		expect(observations(worker)).toEqual([
			expect.objectContaining({ tool_use_id: "call-follow-up", contentSessionId: PARENT_SESSION_ID }),
		]);
	});

	it("folds a private steer into the running child turn so later results are dropped", async () => {
		const fixture = await startFixture();
		const { worker, settings, toolSession } = fixture;
		const registry = VibeSessionRegistry.global();

		const firstTurn = Promise.withResolvers<void>();
		const spawned = Promise.withResolvers<FakeSession>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.resolve(await startChildFromSpawn(options, settings));
			await firstTurn.promise;
			return singleResult(options.id, options.task);
		});

		// Public turn B spawns the worker; its first result is observed under B.
		await parentTurn(fixture, "spawn a helper");
		const { id } = await registry.spawn(toolSession, { cli: "fast", prompt: "first job" });
		const child = await spawned.promise;
		child.isStreaming = true;
		registerChildRef(id, child, "running");
		toolCall(child, "call-before-steer", "ls", "a.ts");
		await fixture.parentState.flush();
		expect(observations(worker)).toEqual([expect.objectContaining({ tool_use_id: "call-before-steer" })]);

		// Private turn A steers the streaming child mid-turn.
		await parentTurn(fixture, PRIVATE_PROMPT);
		expect(await registry.send(toolSession, { session: id, message: "now read the prod key" })).toMatchObject({
			mode: "steered",
		});
		expect(child.steer.mock.calls.map(call => call[0])).toEqual(["now read the prod key"]);

		toolCall(child, "call-after-steer", "cat prod.key", "hunter2");
		firstTurn.resolve();
		await fixture.parentState.flush();

		expect(observations(worker)).toHaveLength(1);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");
	});

	it("drops a child turn that no dispatch authorized even while the parent's turn is public", async () => {
		const fixture = await startFixture();
		const { worker, settings, toolSession } = fixture;
		const registry = VibeSessionRegistry.global();

		const spawned = Promise.withResolvers<FakeSession>();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			spawned.resolve(await startChildFromSpawn(options, settings));
			return singleResult(options.id, options.task);
		});

		await parentTurn(fixture, "spawn a helper");
		const { jobId } = await registry.spawn(toolSession, { cli: "fast", prompt: "first job" });
		const child = await spawned.promise;
		await manager.getJob(jobId)?.promise;

		// A wake that bypassed vibe dispatch: the alias holds no pending token.
		await parentTurn(fixture, "still public");
		await startTurn(child as never, "unsolicited work");
		toolCall(child, "call-unauthorized", "cat prod.key", "hunter2");
		await fixture.parentState.flush();

		expect(observations(worker)).toHaveLength(0);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");
	});
});
