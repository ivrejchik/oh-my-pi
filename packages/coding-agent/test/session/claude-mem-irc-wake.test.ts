/**
 * claude-mem authorization of an IRC wake turn on a real `AgentSession`.
 *
 * A parent (`Main`) and a subagent (`Worker`) run genuine turns against a
 * mock model; a `Bun.serve` stands in for the claude-mem worker. The wake is
 * driven through `IrcBus.send`, the same path the `hub send` tool takes, so
 * the sender token travels with the record exactly as in production and the
 * test never touches a claude-mem hook itself.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { claudeMemBackend } from "@oh-my-pi/pi-coding-agent/claude-mem/backend";
import { type ClaudeMemSessionState, getClaudeMemSessionState } from "@oh-my-pi/pi-coding-agent/claude-mem/state";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

interface RecordedRequest {
	method: string;
	path: string;
	body: unknown;
}

const PRIVATE_PROMPT_REGEX = /^\s*<private>[\s\S]*<\/private>\s*$/;

function workerResponse(request: RecordedRequest): Response {
	switch (request.path) {
		case "/api/health":
			return Response.json({ status: "ok", version: "13.24.23", pid: 1, uptime: 1 });
		case "/api/readiness":
			return new Response("ready");
		case "/api/context/inject":
			return new Response("", { headers: { "Content-Type": "text/plain" } });
		case "/api/sessions/init": {
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			return PRIVATE_PROMPT_REGEX.test(prompt)
				? Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" })
				: Response.json({
						sessionDbId: 9,
						promptNumber: 1,
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
		default:
			return Response.json({ error: "not found" }, { status: 404 });
	}
}

class FakeWorker {
	readonly requests: RecordedRequest[] = [];
	readonly #server: Bun.Server<undefined>;

	constructor() {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const text = await request.text();
				const recorded: RecordedRequest = {
					method: request.method,
					path: new URL(request.url).pathname,
					body: text ? JSON.parse(text) : undefined,
				};
				this.requests.push(recorded);
				return workerResponse(recorded);
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
}

const SECRET = "hunter2";
const PRIVATE_PROMPT = "<private>rotate the key</private>";

describe("claude-mem IRC wake authorization on a real AgentSession", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let settings: Settings;
	let worker: FakeWorker;
	const sessions: AgentSession[] = [];
	const scrubbedEnv = new Map<string, string>();

	beforeEach(() => {
		resetSettingsForTest();
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("CLAUDE_MEM_") || key === "CLAUDE_PLUGIN_ROOT") {
				scrubbedEnv.set(key, process.env[key] ?? "");
				delete process.env[key];
			}
		}
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		tempDir = TempDir.createSync("@claude-mem-irc-wake-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		worker = new FakeWorker();
		settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"memory.backend": "claude-mem",
			"claudeMem.workerUrl": worker.url,
			"claudeMem.autoStartWorker": false,
			"claudeMem.dataDir": tempDir.join("claude-mem-data"),
			"claudeMem.workerStartTimeoutMs": 1_000,
		});
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) await session.dispose();
		worker.stop();
		authStorage.close();
		tempDir.removeSync();
		for (const [key, value] of scrubbedEnv) process.env[key] = value;
		scrubbedEnv.clear();
	});

	function createSession(options: {
		agentId: string;
		agentKind: "main" | "sub";
		memoryTaskDepth: number;
		responses: MockResponse[];
		onRead?: () => void;
		/** Called once the `wait` tool has parked a real bus waiter for this agent. */
		onWaiting?: () => void;
	}): AgentSession {
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: options.responses });
		const read: AgentTool = {
			name: "read",
			label: "read",
			description: "Read a file",
			parameters: type({ path: "string" }),
			async execute() {
				options.onRead?.();
				return { content: [{ type: "text", text: SECRET }] };
			},
		};
		// Stand-in for `hub wait`: blocks on the real bus exactly like the tool does.
		const wait: AgentTool = {
			name: "wait",
			label: "wait",
			description: "Wait for a peer message",
			parameters: type({}),
			async execute() {
				const pending = IrcBus.global().wait(options.agentId, {}, 10_000);
				options.onWaiting?.();
				const message = await pending;
				return { content: [{ type: "text", text: message?.body ?? "timeout" }] };
			},
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["test"], tools: [read, wait], messages: [] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			memoryAgentDir: tempDir.path(),
			memoryTaskDepth: options.memoryTaskDepth,
			toolRegistry: new Map([
				[read.name, read],
				[wait.name, wait],
			]),
			builtInToolNames: [read.name, wait.name],
			agentId: options.agentId,
			agentKind: options.agentKind,
		});
		sessions.push(session);
		return session;
	}

	function terminalAgentEnd(session: AgentSession): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type !== "agent_end" || event.isTerminal === false) return;
			unsubscribe();
			resolve();
		});
		return promise;
	}

	function observationBodies(): unknown[] {
		return worker.received("POST", "/api/sessions/observations").map(request => request.body);
	}

	interface Fixture {
		parent: AgentSession;
		parentState: ClaudeMemSessionState;
		child: AgentSession;
		childReads: () => number;
	}

	/** Parent and child both complete a public turn; the child is idle with one public turn behind it. */
	async function setupPublicHistory(childScript?: {
		responses: MockResponse[];
		onWaiting?: () => void;
	}): Promise<Fixture> {
		const parent = createSession({
			agentId: "Main",
			agentKind: "main",
			memoryTaskDepth: 0,
			responses: [
				{ content: ["parent done"] },
				{ content: ["parent follow-up done"] },
				{ content: ["parent third turn done"] },
			],
		});
		AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session: parent });
		await parent.applyMemoryBackend();
		const parentState = getClaudeMemSessionState(parent);
		if (!parentState) throw new Error("claude-mem primary state was not installed on the parent");
		await parentState.contextLoadPromise;

		await parent.prompt("public parent turn");
		await parentState.flush();
		expect(worker.received("POST", "/api/sessions/init").map(request => request.body)).toEqual([
			expect.objectContaining({ contentSessionId: parent.sessionId, prompt: "public parent turn" }),
		]);

		let reads = 0;
		const child = createSession({
			agentId: "Worker",
			agentKind: "sub",
			memoryTaskDepth: 1,
			responses: childScript?.responses ?? [
				{ content: ["ok"] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "secret.txt" } }] },
				{ content: ["done"] },
			],
			onRead: () => {
				reads++;
			},
			onWaiting: childScript?.onWaiting,
		});
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: "Main",
			session: child,
		});
		expect(AgentRegistry.global().get("Worker")?.parentId).toBe("Main");
		expect(AgentRegistry.global().get("Main")?.session).toBe(parent);
		await claudeMemBackend.start({
			session: child,
			settings,
			modelRegistry,
			agentDir: tempDir.path(),
			taskDepth: 1,
			parentClaudeMemSessionState: parentState,
			parentClaudeMemDispatch: parentState.captureDispatch(),
		});
		expect(getClaudeMemSessionState(child)?.aliasOf).toBe(parentState);

		await child.prompt("child public work");
		await parentState.flush();
		expect(reads).toBe(0);
		expect(observationBodies()).toEqual([]);

		return { parent, parentState, child, childReads: () => reads };
	}

	async function wakeChildFromParent(fixture: Fixture): Promise<void> {
		const ended = terminalAgentEnd(fixture.child);
		const receipt = await IrcBus.global().send({ from: "Main", to: "Worker", body: "read secret.txt" });
		expect(receipt).toEqual({ to: "Worker", outcome: "woken" });
		await ended;
		await fixture.child.waitForIdle();
		await fixture.parentState.flush();
		expect(fixture.childReads()).toBe(1);
	}

	it("runs a wake delivered during a private parent turn without observing it, despite a public previous turn", async () => {
		const fixture = await setupPublicHistory();

		await fixture.parent.prompt(PRIVATE_PROMPT);
		await fixture.parentState.flush();
		const inits = worker.received("POST", "/api/sessions/init").map(request => request.body);
		expect(inits).toHaveLength(2);
		expect(inits[1]).toEqual(expect.objectContaining({ prompt: PRIVATE_PROMPT }));
		const summariesBeforeWake = worker.received("POST", "/api/sessions/summarize").length;

		await wakeChildFromParent(fixture);

		expect(observationBodies()).toEqual([]);
		expect(worker.received("POST", "/api/sessions/summarize")).toHaveLength(summariesBeforeWake);
		expect(JSON.stringify(worker.requests)).not.toContain(SECRET);
	});

	it("observes a wake delivered during a public parent turn under the parent session with the child agent id", async () => {
		const fixture = await setupPublicHistory();

		await fixture.parent.prompt("public follow-up");
		await fixture.parentState.flush();
		expect(worker.received("POST", "/api/sessions/init").map(request => request.body)).toEqual([
			expect.objectContaining({ prompt: "public parent turn" }),
			expect.objectContaining({ prompt: "public follow-up" }),
		]);
		const summariesBeforeWake = worker.received("POST", "/api/sessions/summarize").length;

		await wakeChildFromParent(fixture);

		expect(observationBodies()).toEqual([
			expect.objectContaining({
				contentSessionId: fixture.parent.sessionId,
				tool_name: "Read",
				tool_input: { path: "secret.txt" },
				tool_response: { output: SECRET },
				tool_use_id: "mock-tc-1",
				agentId: "Worker",
				agentType: "task",
			}),
		]);
		expect(worker.received("POST", "/api/sessions/summarize")).toHaveLength(summariesBeforeWake);
	});

	/**
	 * The child is woken publicly and parks inside a real bus `wait` (the `hub
	 * wait` / `send await:true` path, which hands the message to the waiter
	 * before any session injection). The parent's next turn then sends it a
	 * message; the child's turn continues with a tool call.
	 */
	async function parkChildInWait(parentTurn: string): Promise<Fixture> {
		let signalWaiting: () => void = () => {};
		const waiting = new Promise<void>(resolve => {
			signalWaiting = resolve;
		});
		const fixture = await setupPublicHistory({
			responses: [
				{ content: ["ok"] },
				{ content: [{ type: "toolCall", name: "wait", arguments: {} }] },
				{ content: [{ type: "toolCall", name: "read", arguments: { path: "secret.txt" } }] },
				{ content: ["done"] },
			],
			onWaiting: () => signalWaiting(),
		});

		// Public wake: the child's turn starts and parks in `wait`.
		await fixture.parent.prompt("public follow-up");
		await fixture.parentState.flush();
		const ended = terminalAgentEnd(fixture.child);
		const wake = await IrcBus.global().send({ from: "Main", to: "Worker", body: "wait for instructions" });
		expect(wake).toEqual({ to: "Worker", outcome: "woken" });
		await waiting;
		expect(fixture.child.isStreaming).toBe(true);

		// The parent's next turn is the one under test; its message resolves the waiter directly.
		await fixture.parent.prompt(parentTurn);
		await fixture.parentState.flush();
		const observationsBefore = observationBodies().length;
		const receipt = await IrcBus.global().send({ from: "Main", to: "Worker", body: "read secret.txt" });
		expect(receipt).toEqual({ to: "Worker", outcome: "injected" });
		await ended;
		await fixture.child.waitForIdle();
		await fixture.parentState.flush();
		expect(fixture.childReads()).toBe(1);
		expect(observationsBefore).toBe(0);
		return fixture;
	}

	it("keeps a child parked in a bus wait from observing after a private message resolves the wait", async () => {
		await parkChildInWait(PRIVATE_PROMPT);

		expect(worker.received("POST", "/api/sessions/init").map(request => request.body)).toEqual([
			expect.objectContaining({ prompt: "public parent turn" }),
			expect.objectContaining({ prompt: "public follow-up" }),
			expect.objectContaining({ prompt: PRIVATE_PROMPT }),
		]);
		expect(observationBodies()).toEqual([]);
		expect(JSON.stringify(worker.requests)).not.toContain(SECRET);
	});

	it("observes the tool call a child makes after a public message resolves its bus wait", async () => {
		const fixture = await parkChildInWait("public third turn");

		// Both the message surfaced by the wait and the read it triggered are
		// observed: the sender's public token folded into the running turn.
		expect(observationBodies()).toEqual([
			expect.objectContaining({
				contentSessionId: fixture.parent.sessionId,
				tool_name: "wait",
				tool_response: { output: "read secret.txt" },
				tool_use_id: "mock-tc-1",
				agentId: "Worker",
			}),
			expect.objectContaining({
				contentSessionId: fixture.parent.sessionId,
				tool_name: "Read",
				tool_input: { path: "secret.txt" },
				tool_response: { output: SECRET },
				tool_use_id: "mock-tc-2",
				agentId: "Worker",
				agentType: "task",
			}),
		]);
	});
});
