/**
 * claude-mem backend behavioural tests.
 *
 * A real `Bun.serve` stands in for the claude-mem worker so the assertions
 * cover the wire contract (routes, query strings, JSON bodies, ordering)
 * rather than client internals. Sessions are fakes exposing the surface the
 * backend touches: `subscribe`, `sessionManager`, `refreshBaseSystemPrompt`,
 * `emitNotice`, `getAgentId`, `model`, `settings`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claudeMemBackend } from "@oh-my-pi/pi-coding-agent/claude-mem/backend";
import { defaultWorkerPort, loadClaudeMemConfig } from "@oh-my-pi/pi-coding-agent/claude-mem/config";
import { projectToolResponse } from "@oh-my-pi/pi-coding-agent/claude-mem/content";
import { resolveClaudeMemProject } from "@oh-my-pi/pi-coding-agent/claude-mem/project";
import {
	attachDispatchToMessage,
	type ClaudeMemSessionState,
	dispatchOfMessage,
	getClaudeMemSessionState,
	parseClaudeMemMemoryRef,
} from "@oh-my-pi/pi-coding-agent/claude-mem/state";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryBackend } from "@oh-my-pi/pi-coding-agent/memory-backend";
import type { AgentSessionEvent, AgentSessionEventListener } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { isRecord } from "@oh-my-pi/pi-utils";

interface RecordedRequest {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response> | undefined;

function defaultResponse(request: RecordedRequest): Response {
	switch (request.path) {
		case "/api/health":
			return Response.json({ status: "ok", version: "13.24.23", pid: 4242, uptime: 1 });
		case "/api/readiness":
			return new Response("ready");
		case "/api/context/inject":
			return new Response("", { headers: { "Content-Type": "text/plain" } });
		case "/api/sessions/init":
			return Response.json({
				sessionDbId: 1,
				promptNumber: 1,
				skipped: false,
				contextInjected: false,
				status: "initialized",
			});
		case "/api/sessions/observations":
		case "/api/sessions/summarize":
			return Response.json({ status: "queued" });
		case "/api/search":
			return Response.json({
				observations: [],
				sessions: [],
				prompts: [],
				totalResults: 0,
				query: request.query.query,
			});
		case "/api/stats":
			return Response.json({ database: { observations: 3 } });
		case "/api/processing-status":
			return Response.json({ isProcessing: false, queueDepth: 0, parkedSessions: 0 });
		default:
			return Response.json({ error: "not found" }, { status: 404 });
	}
}

class FakeWorker {
	readonly requests: RecordedRequest[] = [];
	readonly events: string[] = [];
	readonly #server: Bun.Server<undefined>;

	constructor(respond?: Responder) {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const url = new URL(request.url);
				const text = await request.text();
				const recorded: RecordedRequest = {
					method: request.method,
					path: url.pathname,
					query: Object.fromEntries(url.searchParams),
					body: text ? JSON.parse(text) : undefined,
				};
				this.requests.push(recorded);
				this.events.push(`${recorded.method} ${recorded.path}`);
				return (await respond?.(recorded)) ?? defaultResponse(recorded);
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

interface FakeNotice {
	level: string;
	message: string;
	source?: string;
}

interface FakeSession {
	sessionId: string;
	settings: Settings;
	model: { id: string };
	notices: FakeNotice[];
	sessionManager: {
		getEntries: () => never[];
		getCwd: () => string;
		getSessionFile: () => null;
		getSessionId: () => string;
	};
	subscribe(listener: AgentSessionEventListener): () => void;
	refreshBaseSystemPrompt: ReturnType<typeof vi.fn>;
	getAgentId(): string | undefined;
	emitNotice(level: string, message: string, source?: string): void;
	emit(event: AgentSessionEvent): void;
}

interface FakeSessionDeps {
	sessionId: string;
	settings: Settings;
	agentId?: string;
}

function makeFakeSession(deps: FakeSessionDeps): FakeSession {
	const listeners = new Set<AgentSessionEventListener>();
	const notices: FakeNotice[] = [];
	return {
		sessionId: deps.sessionId,
		settings: deps.settings,
		model: { id: "test-model" },
		notices,
		sessionManager: {
			getEntries: () => [],
			getCwd: () => deps.settings.getCwd(),
			getSessionFile: () => null,
			getSessionId: () => deps.sessionId,
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refreshBaseSystemPrompt: vi.fn().mockResolvedValue(undefined),
		getAgentId: () => deps.agentId,
		emitNotice(level, message, source) {
			notices.push({ level, message, source });
		},
		emit(event) {
			// oxlint-disable-next-line unicorn/no-useless-spread -- listeners may change during dispatch
			for (const l of [...listeners]) l(event);
		},
	};
}

const tempDirs: string[] = [];
const workers: FakeWorker[] = [];
const scrubbedEnv = new Map<string, string>();

async function makeTempDir(name: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
	tempDirs.push(dir);
	return dir;
}

function startWorker(respond?: Responder): FakeWorker {
	const worker = new FakeWorker(respond);
	workers.push(worker);
	return worker;
}

async function claudeMemSettings(
	cwd: string,
	workerUrl: string,
	overrides: Record<string, unknown> = {},
): Promise<Settings> {
	const settings = Settings.isolated({
		"memory.backend": "claude-mem",
		"claudeMem.workerUrl": workerUrl,
		"claudeMem.autoStartWorker": false,
		"claudeMem.dataDir": await makeTempDir("claude-mem-data"),
		"claudeMem.workerStartTimeoutMs": 1_000,
		...overrides,
	});
	await settings.reloadForCwd(cwd);
	return settings;
}

interface PrimaryFixture {
	session: FakeSession;
	settings: Settings;
	state: ClaudeMemSessionState;
	project: string;
}

async function startPrimary(
	worker: FakeWorker,
	sessionId: string,
	overrides: Record<string, unknown> = {},
): Promise<PrimaryFixture> {
	const cwd = await makeTempDir("claude-mem-project");
	const settings = await claudeMemSettings(cwd, worker.url, overrides);
	const session = makeFakeSession({ sessionId, settings });
	await claudeMemBackend.start({
		session: session as never,
		settings,
		modelRegistry: {} as never,
		agentDir: "/tmp",
		taskDepth: 0,
	});
	const state = getClaudeMemSessionState(session as never);
	if (!state) throw new Error("claude-mem state was not installed");
	await state.contextLoadPromise;
	return { session, settings, state, project: path.basename(cwd) };
}

/** Stage a turn start and commit it the way AgentSession does on delivery; returns the staged context. */
async function startTurn(session: unknown, prompt: string): Promise<string | undefined> {
	const preparation = await claudeMemBackend.beforeAgentStartPrompt?.(session as never, prompt);
	if (preparation && !preparation.commit()) throw new Error("claude-mem rejected the turn commit");
	return preparation?.context;
}

/** Register a prompt the way a turn start does, so gated writes are accepted. */
async function registerPrompt(fixture: PrimaryFixture, prompt = "Do the thing"): Promise<void> {
	await startTurn(fixture.session as never, prompt);
	await fixture.state.flush();
}

function toolCall(
	session: FakeSession,
	toolName: string,
	toolCallId: string,
	args: unknown,
	result: unknown,
	isError = false,
): void {
	session.emit({ type: "tool_execution_start", toolCallId, toolName, args });
	session.emit({ type: "tool_execution_end", toolCallId, toolName, result, isError });
}

function assistantTurn(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		model: "x",
		provider: "x",
		api: "x",
		stopReason: "end_turn" as const,
		timestamp: 0,
	};
}

async function closedPort(): Promise<number> {
	const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
	const port = probe.port;
	probe.stop(true);
	if (typeof port !== "number") throw new Error("Bun.serve did not assign a port");
	return port;
}

function toolNames(requests: RecordedRequest[]): unknown[] {
	return requests.map(request => (isRecord(request.body) ? request.body.tool_name : undefined));
}

beforeEach(() => {
	resetSettingsForTest();
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("CLAUDE_MEM_") || key === "CLAUDE_PLUGIN_ROOT") {
			scrubbedEnv.set(key, process.env[key] ?? "");
			delete process.env[key];
		}
	}
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const worker of workers.splice(0)) worker.stop();
	for (const [key, value] of scrubbedEnv) process.env[key] = value;
	scrubbedEnv.clear();
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("loadClaudeMemConfig worker URL resolution", () => {
	it("prefers CLAUDE_MEM_WORKER_URL over the claudeMem.workerUrl setting and strips trailing slashes", async () => {
		const settings = Settings.isolated({
			"claudeMem.workerUrl": "http://127.0.0.1:2222",
			"claudeMem.dataDir": await makeTempDir("claude-mem-data"),
		});
		const config = loadClaudeMemConfig(settings, { CLAUDE_MEM_WORKER_URL: "http://127.0.0.1:1111/" });
		expect(config.workerUrl).toBe("http://127.0.0.1:1111");
	});

	it("uses the claudeMem.workerUrl setting when no env override is present", async () => {
		const settings = Settings.isolated({
			"claudeMem.workerUrl": "http://127.0.0.1:2222/",
			"claudeMem.dataDir": await makeTempDir("claude-mem-data"),
		});
		expect(loadClaudeMemConfig(settings, {}).workerUrl).toBe("http://127.0.0.1:2222");
	});

	it("falls back to <dataDir>/settings.json host/port and normalizes localhost", async () => {
		const dataDir = await makeTempDir("claude-mem-data");
		await Bun.write(
			path.join(dataDir, "settings.json"),
			JSON.stringify({ CLAUDE_MEM_WORKER_PORT: "39999", CLAUDE_MEM_WORKER_HOST: "localhost" }),
		);
		const settings = Settings.isolated({ "claudeMem.dataDir": dataDir });
		expect(loadClaudeMemConfig(settings, {}).workerUrl).toBe("http://127.0.0.1:39999");
	});

	it("accepts the legacy { env: {...} } settings.json wrapper with numeric ports", async () => {
		const dataDir = await makeTempDir("claude-mem-data");
		await Bun.write(path.join(dataDir, "settings.json"), JSON.stringify({ env: { CLAUDE_MEM_WORKER_PORT: 40000 } }));
		const settings = Settings.isolated({ "claudeMem.dataDir": dataDir });
		expect(loadClaudeMemConfig(settings, {}).workerUrl).toBe("http://127.0.0.1:40000");
	});

	it("uses the UID-derived default port when neither settings nor settings.json name one", async () => {
		const settings = Settings.isolated({ "claudeMem.dataDir": await makeTempDir("claude-mem-data") });
		expect(loadClaudeMemConfig(settings, {}).workerUrl).toBe(`http://127.0.0.1:${defaultWorkerPort()}`);
	});
});

describe("resolveClaudeMemProject", () => {
	it("names a plain directory by its basename", async () => {
		const dir = await makeTempDir("claude-mem-plain");
		expect(resolveClaudeMemProject(dir)).toEqual({ primary: path.basename(dir), allProjects: [path.basename(dir)] });
	});

	it("names a git checkout by its root basename even from a nested directory", async () => {
		const root = await makeTempDir("claude-mem-repo");
		const init = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "pipe" });
		expect(await init.exited).toBe(0);
		const nested = path.join(root, "packages", "inner");
		await fs.mkdir(nested, { recursive: true });
		const name = path.basename(root);
		expect(resolveClaudeMemProject(nested)).toEqual({ primary: name, allProjects: [name] });
	});

	it("falls back to unknown-project for an empty cwd", () => {
		expect(resolveClaudeMemProject("")).toEqual({ primary: "unknown-project", allProjects: ["unknown-project"] });
		expect(resolveClaudeMemProject("   ").primary).toBe("unknown-project");
	});
});

describe("projectToolResponse", () => {
	it("joins text blocks and renders image blocks as placeholders", () => {
		const result = {
			content: [
				{ type: "text", text: "first" },
				{ type: "image", mimeType: "image/png", data: "AAAA" },
				{ type: "text", text: "second" },
			],
		};
		expect(projectToolResponse(result, false)).toEqual({ output: "first\n[image image/png]\nsecond" });
	});

	it("reports errors under the error key", () => {
		expect(projectToolResponse({ content: "boom" }, true)).toEqual({ error: "boom" });
	});

	it("passes string content and scalar results through", () => {
		expect(projectToolResponse({ content: "plain" }, false)).toEqual({ output: "plain" });
		expect(projectToolResponse(42, false)).toEqual({ output: "42" });
		expect(projectToolResponse(undefined, false)).toEqual({ output: "" });
	});

	it("truncates output over 100k characters with a marker", () => {
		const projected = projectToolResponse({ content: "x".repeat(100_001) }, false);
		if (!("output" in projected)) throw new Error("expected output");
		expect(projected.output.endsWith("\n[truncated]")).toBe(true);
		expect(projected.output.length).toBe(100_000 + "\n[truncated]".length);
	});

	it("removes a <private> block that straddles the cap instead of truncating away its closing tag", () => {
		const secret = "SECRET-TOKEN-".repeat(10);
		const text = `${"a".repeat(99_990)}<private>${secret}</private>tail`;
		const projected = projectToolResponse({ content: text }, false);
		if (!("output" in projected)) throw new Error("expected output");
		expect(projected.output).not.toContain("SECRET-TOKEN");
		expect(projected.output).not.toContain("<private>");
		expect(projected.output).toBe(`${"a".repeat(99_990)}tail`);
		// Unclosed tags are kept verbatim, matching the worker's own stripping.
		expect(projectToolResponse({ content: "<private>open" }, false)).toEqual({ output: "<private>open" });
	});
});

describe("claudeMemBackend session lifecycle", () => {
	it("loads the startup context for the project and promotes it into the developer instructions once", async () => {
		const worker = startWorker(request =>
			request.path === "/api/context/inject" ? new Response("## Recent\n- fixed the parser") : undefined,
		);
		const { session, settings, project } = await startPrimary(worker, "s-context", { "claudeMem.autoRecall": false });

		const [inject] = worker.received("GET", "/api/context/inject");
		expect(inject?.query).toEqual({ projects: project });
		expect(session.refreshBaseSystemPrompt).toHaveBeenCalledTimes(1);

		const instructions = await claudeMemBackend.buildDeveloperInstructions("/tmp", settings, session as never);
		expect(instructions).toContain("<claude_mem_context>\n## Recent\n- fixed the parser\n</claude_mem_context>");

		expect(await startTurn(session as never, "hello")).toBeUndefined();
	});

	it("posts observations before the turn summary even when the observation response is slow", async () => {
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/observations") return undefined;
			// Real delay on purpose: the contract under test is HTTP write ordering
			// through the client's queue, which fake timers cannot exercise.
			return Bun.sleep(50).then(() => {
				worker.events.push("observation settled");
				return Response.json({ status: "queued" });
			});
		});
		const fixture = await startPrimary(worker, "s-order");
		const { session, state, settings } = fixture;
		await registerPrompt(fixture);

		toolCall(session, "read", "call-1", { path: "src/a.ts" }, { content: [{ type: "text", text: "file body" }] });
		session.emit({
			type: "agent_end",
			messages: [assistantTurn("Read the file and found the config key.")] as never,
		});
		await state.flush();

		const [observation] = worker.received("POST", "/api/sessions/observations");
		expect(observation?.body).toMatchObject({
			contentSessionId: "s-order",
			platformSource: "claude",
			tool_name: "Read",
			tool_input: { path: "src/a.ts" },
			tool_response: { output: "file body" },
			cwd: settings.getCwd(),
			tool_use_id: "call-1",
		});
		const [summary] = worker.received("POST", "/api/sessions/summarize");
		expect(summary?.body).toMatchObject({
			contentSessionId: "s-order",
			last_assistant_message: "Read the file and found the config key.",
			observedModel: "test-model",
		});
		const observationIndex = worker.events.indexOf("POST /api/sessions/observations");
		const settledIndex = worker.events.indexOf("observation settled");
		const summarizeIndex = worker.events.indexOf("POST /api/sessions/summarize");
		expect(observationIndex).toBeGreaterThanOrEqual(0);
		expect(settledIndex).toBeGreaterThan(observationIndex);
		expect(summarizeIndex).toBeGreaterThan(settledIndex);
	});

	it("never observes memory tools but forwards todo as TodoWrite", async () => {
		const worker = startWorker();
		const fixture = await startPrimary(worker, "s-skip");
		const { session, state } = fixture;
		await registerPrompt(fixture);

		toolCall(session, "recall", "call-recall", { query: "x" }, { content: "remembered" });
		toolCall(session, "retain", "call-retain", { content: "y" }, { content: "stored" });
		toolCall(session, "todo", "call-todo", { todos: [] }, { content: "ok" });
		await state.flush();

		expect(toolNames(worker.received("POST", "/api/sessions/observations"))).toEqual(["TodoWrite"]);
	});

	it("unwraps xd:// device writes to the device tool and skips memory devices and memory:// reads", async () => {
		const worker = startWorker();
		const fixture = await startPrimary(worker, "s-xd");
		const { session, state } = fixture;
		await registerPrompt(fixture);

		toolCall(
			session,
			"write",
			"call-xd-recall",
			{ path: "xd://recall", content: '{"query":"x"}' },
			{ content: "remembered" },
		);
		toolCall(session, "read", "call-mem-read", { path: "memory://1234" }, { content: "---\nid: 1234\n---" });
		toolCall(
			session,
			"write",
			"call-xd-lsp",
			{ path: "xd://lsp", content: '{"action":"hover"}' },
			{ content: "sig" },
		);
		toolCall(session, "write", "call-real-write", { path: "notes.md", content: "hello" }, { content: "written" });
		await state.flush();

		const posted = worker.received("POST", "/api/sessions/observations");
		expect(toolNames(posted)).toEqual(["lsp", "Write"]);
		expect(posted[0]?.body).toMatchObject({ tool_input: { action: "hover" }, tool_use_id: "call-xd-lsp" });
	});

	it("posts nothing when autoObserve is off", async () => {
		const worker = startWorker();
		const { session, state } = await startPrimary(worker, "s-quiet", { "claudeMem.autoObserve": false });

		toolCall(session, "read", "call-1", { path: "a" }, { content: "body" });
		await state.flush();

		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(0);
	});

	it("registers the prompt on every turn and injects first-turn recall results once", async () => {
		const worker = startWorker(request => {
			if (request.path !== "/api/search") return undefined;
			return Response.json({
				observations: [
					{
						id: 4242,
						memory_session_id: "m-1",
						project: request.query.project,
						type: "decision",
						title: "Use tabs",
						subtitle: null,
						facts: JSON.stringify(["Tabs everywhere"]),
						narrative: null,
						concepts: "[]",
						files_read: "[]",
						files_modified: "[]",
						prompt_number: 1,
						created_at: "2026-09-14T10:00:00.000Z",
						created_at_epoch: 1_789_207_200_000,
					},
				],
				sessions: [],
				prompts: [],
				totalResults: 1,
				query: request.query.query,
			});
		});
		const { session, state, project } = await startPrimary(worker, "s-recall");

		const prompt = "What did we decide about indentation?";
		const first = await startTurn(session as never, prompt);
		expect(first).toContain("<memories>");
		expect(first).toContain("#4242");
		expect(first).toContain("Tabs everywhere");

		const [search] = worker.received("GET", "/api/search");
		expect(search?.query).toMatchObject({ project, format: "json" });
		// Reads span every platform source; only writes are tagged.
		expect(search?.query).not.toHaveProperty("platformSource");
		expect(search?.query.query).toContain(prompt);

		// A second turn with identical text is a new turn: it registers again and
		// leaves the worker's dedupe window to decide; recall stays first-turn only.
		expect(await startTurn(session as never, prompt)).toBeUndefined();
		await state.flush();
		const inits = worker.received("POST", "/api/sessions/init");
		expect(inits).toHaveLength(2);
		expect(inits[0]?.body).toEqual({ contentSessionId: "s-recall", project, prompt, platformSource: "claude" });
		expect(inits[1]?.body).toEqual(inits[0]?.body);

		await startTurn(session as never, "Now change the linter config");
		await state.flush();
		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(3);
		expect(worker.received("GET", "/api/search")).toHaveLength(1);
	});

	it("forwards subagent tool results under the parent session with the agent id and never summarizes", async () => {
		const worker = startWorker();
		const parent = await startPrimary(worker, "parent-1");
		await registerPrompt(parent);

		const subSession = makeFakeSession({ sessionId: "sub-1", settings: parent.settings, agentId: "agent-xyz" });
		await claudeMemBackend.start({
			session: subSession as never,
			settings: parent.settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentClaudeMemSessionState: parent.state,
			parentClaudeMemDispatch: parent.state.captureDispatch(),
		});
		// The spawn's dispatch token authorizes the child's first turn.
		expect(await startTurn(subSession as never, "list files")).toBeUndefined();

		toolCall(subSession, "bash", "call-sub", { command: "ls" }, { content: "a.ts" });
		subSession.emit({ type: "agent_end", messages: [assistantTurn("Listed the directory.")] as never });
		await parent.state.flush();

		const observations = worker.received("POST", "/api/sessions/observations");
		expect(observations).toHaveLength(1);
		expect(observations[0]?.body).toMatchObject({
			contentSessionId: "parent-1",
			tool_name: "Bash",
			tool_use_id: "call-sub",
			agentId: "agent-xyz",
			agentType: "task",
		});
		expect(worker.received("POST", "/api/sessions/summarize")).toHaveLength(0);
		// Only the parent's own registration; the alias never registers prompts.
		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(1);
	});

	it("degrades without throwing when the worker is unreachable", async () => {
		const cwd = await makeTempDir("claude-mem-project");
		const settings = await claudeMemSettings(cwd, `http://127.0.0.1:${await closedPort()}`);
		const session = makeFakeSession({ sessionId: "s-down", settings });

		await claudeMemBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getClaudeMemSessionState(session as never);
		if (!state) throw new Error("claude-mem state was not installed");
		await state.contextLoadPromise;

		const status = await claudeMemBackend.status?.({ session: session as never, agentDir: "/tmp", cwd });
		expect(status?.active).toBe(false);
		expect(status?.message).toContain("unreachable");
		expect(session.notices).toEqual([
			expect.objectContaining({ level: "warning", message: expect.stringContaining("claude-mem") }),
		]);

		const started = performance.now();
		expect(await startTurn(session as never, "hello there")).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(9_000);
	});

	it("holds cold-start writes until the worker is ready when the first turn starts right after start()", async () => {
		const readyAt = Date.now() + 300;
		const worker = startWorker(request => {
			if (request.path !== "/api/readiness") return undefined;
			if (Date.now() < readyAt) {
				worker.events.push("readiness 503");
				return Response.json({ status: "initializing" }, { status: 503 });
			}
			worker.events.push("readiness 200");
			return new Response("ready");
		});
		const cwd = await makeTempDir("claude-mem-project");
		// A short first-turn budget delivers the turn while the probe is still polling readiness.
		const settings = await claudeMemSettings(cwd, worker.url, { "claudeMem.firstTurnDeadlineMs": 50 });
		const session = makeFakeSession({ sessionId: "s-cold", settings });
		await claudeMemBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getClaudeMemSessionState(session as never);
		if (!state) throw new Error("claude-mem state was not installed");

		// No await on contextLoadPromise: the turn starts while the probe is still polling readiness.
		await startTurn(session as never, "cold start prompt");
		expect(worker.events).not.toContain("readiness 200");
		toolCall(session, "read", "call-cold", { path: "a.ts" }, { content: "body" });
		session.emit({ type: "agent_end", messages: [assistantTurn("Done reading.")] as never });
		await state.flush();

		const events = worker.events;
		const firstWrite = events.findIndex(event => event.startsWith("POST /api/sessions/"));
		expect(events.indexOf("readiness 503")).toBeGreaterThanOrEqual(0);
		expect(events.indexOf("readiness 503")).toBeLessThan(firstWrite);
		expect(events.indexOf("readiness 200")).toBeLessThan(firstWrite);
		expect(events.filter(event => event.startsWith("POST /api/sessions/"))).toEqual([
			"POST /api/sessions/init",
			"POST /api/sessions/observations",
			"POST /api/sessions/summarize",
		]);
		expect(worker.received("POST", "/api/sessions/init")[0]?.body).toMatchObject({ prompt: "cold start prompt" });
	});

	it("writes nothing for a staged turn start until it is committed, and rejects a superseded preparation", async () => {
		const worker = startWorker();
		const { session, state } = await startPrimary(worker, "s-staged");

		// The agent loop may retry or abandon a preparation; neither may leave a trace.
		const superseded = await claudeMemBackend.beforeAgentStartPrompt?.(session as never, "abandoned attempt");
		const delivered = await claudeMemBackend.beforeAgentStartPrompt?.(session as never, "delivered prompt");
		await state.flush();
		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(0);

		expect(superseded?.commit()).toBe(false);
		expect(delivered?.commit()).toBe(true);
		await state.flush();
		expect(worker.received("POST", "/api/sessions/init").map(r => r.body)).toEqual([
			expect.objectContaining({ prompt: "delivered prompt" }),
		]);
	});

	it("drops a turn's writes when prompt registration fails and retries the same prompt next turn", async () => {
		let initAttempts = 0;
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			initAttempts++;
			return initAttempts === 1 ? Response.json({ error: "boom" }, { status: 500 }) : undefined;
		});
		const fixture = await startPrimary(worker, "s-init-fail");
		const { session, state } = fixture;

		await startTurn(session as never, "same prompt");
		toolCall(session, "read", "call-a", { path: "a.ts" }, { content: "a" });
		session.emit({ type: "agent_end", messages: [assistantTurn("First answer.")] as never });
		await state.flush();
		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(1);
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(0);
		expect(worker.received("POST", "/api/sessions/summarize")).toHaveLength(0);

		await startTurn(session as never, "same prompt");
		toolCall(session, "read", "call-b", { path: "b.ts" }, { content: "b" });
		session.emit({ type: "agent_end", messages: [assistantTurn("Second answer.")] as never });
		await state.flush();
		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(2);
		expect(worker.received("POST", "/api/sessions/observations").map(r => r.body)).toEqual([
			expect.objectContaining({ tool_use_id: "call-b" }),
		]);
		expect(worker.received("POST", "/api/sessions/summarize")[0]?.body).toMatchObject({
			last_assistant_message: "Second answer.",
		});
	});

	it("drops a child result dispatched during a private turn even after the parent moved on to a public turn", async () => {
		const privatePrompt = "<private>rotate the prod key</private>";
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			return prompt === privatePrompt
				? Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" })
				: Response.json({
						sessionDbId: 9,
						promptNumber: 2,
						skipped: false,
						contextInjected: false,
						status: "initialized",
					});
		});
		const parent = await startPrimary(worker, "parent-priv");

		// Turn A (private) spawns a child; the spawn carries A's token and the
		// child's first turn consumes it.
		await startTurn(parent.session as never, privatePrompt);
		const child = makeFakeSession({ sessionId: "child-priv", settings: parent.settings, agentId: "agent-priv" });
		await claudeMemBackend.start({
			session: child as never,
			settings: parent.settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentClaudeMemSessionState: parent.state,
			parentClaudeMemDispatch: parent.state.captureDispatch(),
		});
		await startTurn(child as never, "do the private work");

		// Parent turn B (public) registers and fully settles: its verdict is "recorded".
		await startTurn(parent.session as never, "public follow-up");
		await parent.state.flush();

		// The child's result lands only now.
		toolCall(child, "bash", "call-child-late", { command: "cat prod.key" }, { content: "hunter2" });
		await parent.state.flush();

		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(0);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");

		// A child turn dispatched under the public parent turn is observed normally.
		const child2 = getClaudeMemSessionState(child as never);
		if (!child2) throw new Error("child claude-mem state missing");
		child2.authorizeNextTurn(parent.state.captureDispatch());
		await startTurn(child as never, "do the public work");
		toolCall(child, "bash", "call-child-pub", { command: "ls" }, { content: "a.ts" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations").map(r => r.body)).toEqual([
			expect.objectContaining({
				tool_use_id: "call-child-pub",
				agentId: "agent-priv",
				contentSessionId: "parent-priv",
			}),
		]);
	});

	it("authorizes a queued child turn by the token captured when the message was queued, not the parent's turn at start", async () => {
		const privatePrompt = "<private>rotate the prod key</private>";
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			return prompt === privatePrompt
				? Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" })
				: Response.json({
						sessionDbId: 9,
						promptNumber: 2,
						skipped: false,
						contextInjected: false,
						status: "initialized",
					});
		});
		const parent = await startPrimary(worker, "parent-queue");
		const child = makeFakeSession({ sessionId: "child-queue", settings: parent.settings, agentId: "agent-queue" });
		await claudeMemBackend.start({
			session: child as never,
			settings: parent.settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentClaudeMemSessionState: parent.state,
		});
		const childState = getClaudeMemSessionState(child as never);
		if (!childState) throw new Error("child claude-mem state missing");

		// Private turn A queues a message for the child (vibe_send while the child is busy).
		await startTurn(parent.session as never, privatePrompt);
		const queuedUnderA = parent.state.captureDispatch();
		// Parent moves on to public turn B, which settles before the child gets to its queue.
		await startTurn(parent.session as never, "public follow-up");
		await parent.state.flush();

		// The queued message starts now, carrying the token it was queued with.
		childState.authorizeNextTurn(queuedUnderA);
		await startTurn(child as never, "queued private work");
		toolCall(child, "bash", "call-queued", { command: "cat prod.key" }, { content: "hunter2" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(0);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");

		// A message queued under B is authorized when it starts.
		childState.authorizeNextTurn(parent.state.captureDispatch());
		await startTurn(child as never, "queued public work");
		toolCall(child, "bash", "call-queued-pub", { command: "ls" }, { content: "a.ts" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations").map(r => r.body)).toEqual([
			expect.objectContaining({ tool_use_id: "call-queued-pub", contentSessionId: "parent-queue" }),
		]);

		// Two queued messages folded into one turn need every contributor authorized.
		childState.authorizeNextTurn(queuedUnderA, parent.state.captureDispatch());
		await startTurn(child as never, "combined work");
		toolCall(child, "bash", "call-combined", { command: "cat prod.key" }, { content: "hunter2-combined" });
		await parent.state.flush();
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2-combined");
	});

	it("authorizes a hook-bypassing wake turn by its records' tokens, not the previous public turn", async () => {
		const privatePrompt = "<private>rotate the prod key</private>";
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			return prompt === privatePrompt
				? Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" })
				: Response.json({
						sessionDbId: 9,
						promptNumber: 2,
						skipped: false,
						contextInjected: false,
						status: "initialized",
					});
		});
		const parent = await startPrimary(worker, "parent-wake");
		await startTurn(parent.session as never, "public work");
		const child = makeFakeSession({ sessionId: "child-wake", settings: parent.settings, agentId: "agent-wake" });
		await claudeMemBackend.start({
			session: child as never,
			settings: parent.settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentClaudeMemSessionState: parent.state,
			parentClaudeMemDispatch: parent.state.captureDispatch(),
		});
		const childState = getClaudeMemSessionState(child as never);
		if (!childState) throw new Error("child claude-mem state missing");
		// Completed public child turn.
		await startTurn(child as never, "child public work");
		toolCall(child, "read", "call-public", { path: "a.ts" }, { content: "a" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(1);

		// Parent turns private and its message is delivered as an idle wake: the
		// record carries the private token and the wake prompts the agent core
		// directly, so only beginDispatchedTurn runs — never the prompt hook.
		await startTurn(parent.session as never, privatePrompt);
		const record = { role: "custom", customType: "irc:incoming", content: "rotate", timestamp: 0 };
		attachDispatchToMessage(record, parent.state.captureDispatch());
		expect(dispatchOfMessage(record)).toBe(parent.state.captureDispatch());
		childState.beginDispatchedTurn(dispatchOfMessage(record));
		toolCall(child, "bash", "call-wake", { command: "cat prod.key" }, { content: "hunter2" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(1);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");

		// A wake assembled from a record that carries no token is denied outright.
		await startTurn(parent.session as never, "public again");
		await parent.state.flush();
		childState.beginDispatchedTurn(dispatchOfMessage({ role: "user", content: "untagged" }));
		toolCall(child, "read", "call-untagged", { path: "b.ts" }, { content: "b" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(1);

		// Content folded into context before a turn keeps its say: a private aside
		// folded ahead of a public follow-up denies that follow-up's turn.
		await startTurn(parent.session as never, privatePrompt);
		childState.authorizeNextTurn(parent.state.captureDispatch());
		await startTurn(parent.session as never, "public follow-up");
		await parent.state.flush();
		childState.authorizeNextTurn(parent.state.captureDispatch());
		await startTurn(child as never, "follow-up work");
		toolCall(child, "read", "call-tainted", { path: "c.ts" }, { content: "c" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(1);

		// Consumed pending does not linger: the next properly authorized turn is observed.
		childState.authorizeNextTurn(parent.state.captureDispatch());
		await startTurn(child as never, "clean work");
		toolCall(child, "read", "call-clean", { path: "d.ts" }, { content: "d" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations").map(r => r.body)).toEqual([
			expect.objectContaining({ tool_use_id: "call-public" }),
			expect.objectContaining({ tool_use_id: "call-clean" }),
		]);
	});

	it("folds a private steer into a running child turn and denies a child turn with no dispatch at all", async () => {
		const privatePrompt = "<private>rotate the prod key</private>";
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			return prompt === privatePrompt
				? Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" })
				: Response.json({
						sessionDbId: 9,
						promptNumber: 2,
						skipped: false,
						contextInjected: false,
						status: "initialized",
					});
		});
		const parent = await startPrimary(worker, "parent-steer");
		await startTurn(parent.session as never, "public work");
		const child = makeFakeSession({ sessionId: "child-steer", settings: parent.settings, agentId: "agent-steer" });
		await claudeMemBackend.start({
			session: child as never,
			settings: parent.settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentClaudeMemSessionState: parent.state,
			parentClaudeMemDispatch: parent.state.captureDispatch(),
		});
		const childState = getClaudeMemSessionState(child as never);
		if (!childState) throw new Error("child claude-mem state missing");
		await startTurn(child as never, "child work");
		toolCall(child, "read", "call-before-steer", { path: "a.ts" }, { content: "a" });

		// Parent enters a private turn and steers the still-running child.
		await startTurn(parent.session as never, privatePrompt);
		childState.authorizeSteer(parent.state.captureDispatch());
		toolCall(child, "bash", "call-after-steer", { command: "cat prod.key" }, { content: "hunter2" });
		await parent.state.flush();

		expect(worker.received("POST", "/api/sessions/observations").map(r => r.body)).toEqual([
			expect.objectContaining({ tool_use_id: "call-before-steer" }),
		]);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");

		// Parent is public again, but a child turn that no dispatch authorized stays unobserved.
		await startTurn(parent.session as never, "public again");
		await parent.state.flush();
		await startTurn(child as never, "unattributed wake");
		toolCall(child, "read", "call-unauthorized", { path: "b.ts" }, { content: "b" });
		await parent.state.flush();
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(1);
	});

	it("keeps a child result on the session and verdict of its dispatching turn across a parent rekey", async () => {
		const worker = startWorker();
		const parent = await startPrimary(worker, "parent-old");

		await startTurn(parent.session as never, "spawn a helper");
		const child = makeFakeSession({ sessionId: "child-rekey", settings: parent.settings, agentId: "agent-rekey" });
		await claudeMemBackend.start({
			session: child as never,
			settings: parent.settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 1,
			parentClaudeMemSessionState: parent.state,
			parentClaudeMemDispatch: parent.state.captureDispatch(),
		});
		await startTurn(child as never, "helper work");
		await parent.state.flush();

		// Parent starts a new transcript; no prompt registered under the new id yet.
		parent.state.setSessionId("parent-new");
		toolCall(child, "read", "call-child-old", { path: "x.ts" }, { content: "x" });
		toolCall(parent.session, "read", "call-parent-unauthorized", { path: "y.ts" }, { content: "y" });
		await parent.state.flush();

		const observations = worker.received("POST", "/api/sessions/observations").map(r => r.body);
		expect(observations).toEqual([
			expect.objectContaining({
				tool_use_id: "call-child-old",
				contentSessionId: "parent-old",
				agentId: "agent-rekey",
			}),
		]);
	});

	it("re-registers a repeated private prompt while an earlier public init is still pending", async () => {
		const privatePrompt = "<private>rotate the prod key</private>";
		let releaseB: (() => void) | undefined;
		const bBlocked = new Promise<void>(resolve => {
			releaseB = resolve;
		});
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			if (prompt === privatePrompt) {
				return Response.json({ sessionDbId: 9, promptNumber: 1, skipped: true, reason: "private" });
			}
			return bBlocked.then(() =>
				Response.json({
					sessionDbId: 9,
					promptNumber: 2,
					skipped: false,
					contextInjected: false,
					status: "initialized",
				}),
			);
		});
		const fixture = await startPrimary(worker, "s-race");
		const { session, state } = fixture;

		// Turn A (private) fully settles: gate closed.
		await startTurn(session as never, privatePrompt);
		await state.flush();
		// Turn B (public) is queued but its init response is held back.
		await startTurn(session as never, "public follow-up");
		// Turn A again, identical text, with a secret tool result behind it.
		await startTurn(session as never, privatePrompt);
		toolCall(session, "bash", "call-secret", { command: "cat prod.key" }, { content: "hunter2" });
		session.emit({ type: "agent_end", messages: [assistantTurn("Rotated the key.")] as never });
		releaseB?.();
		await state.flush();

		expect(
			worker.received("POST", "/api/sessions/init").map(r => (isRecord(r.body) ? r.body.prompt : undefined)),
		).toEqual([privatePrompt, "public follow-up", privatePrompt]);
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(0);
		expect(worker.received("POST", "/api/sessions/summarize")).toHaveLength(0);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");
	});

	it("keeps the gate closed for a wholly private prompt and reopens it on the next public prompt", async () => {
		let promptNumber = 0;
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			promptNumber++;
			const prompt = isRecord(request.body) && typeof request.body.prompt === "string" ? request.body.prompt : "";
			// Real worker shape: a wholly private prompt is acknowledged with 200
			// but no prompt row is stored.
			if (/^\s*<private>[\s\S]*<\/private>\s*$/.test(prompt)) {
				return Response.json({ sessionDbId: 9, promptNumber, skipped: true, reason: "private" });
			}
			return Response.json({
				sessionDbId: 9,
				promptNumber,
				skipped: false,
				contextInjected: false,
				status: "initialized",
			});
		});
		const fixture = await startPrimary(worker, "s-private");
		const { session, state } = fixture;

		await startTurn(session as never, "public one");
		toolCall(session, "read", "call-pub-1", { path: "a.ts" }, { content: "a" });
		session.emit({ type: "agent_end", messages: [assistantTurn("Public answer one.")] as never });

		await startTurn(session as never, "<private>rotate the prod key</private>");
		toolCall(session, "bash", "call-secret", { command: "cat prod.key" }, { content: "hunter2" });
		session.emit({ type: "agent_end", messages: [assistantTurn("Rotated the key.")] as never });

		await startTurn(session as never, "public two");
		toolCall(session, "read", "call-pub-2", { path: "b.ts" }, { content: "b" });
		session.emit({ type: "agent_end", messages: [assistantTurn("Public answer two.")] as never });
		await state.flush();

		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(3);
		expect(worker.received("POST", "/api/sessions/observations").map(r => r.body)).toEqual([
			expect.objectContaining({ tool_use_id: "call-pub-1" }),
			expect.objectContaining({ tool_use_id: "call-pub-2" }),
		]);
		expect(worker.received("POST", "/api/sessions/summarize").map(r => r.body)).toEqual([
			expect.objectContaining({ last_assistant_message: "Public answer one." }),
			expect.objectContaining({ last_assistant_message: "Public answer two." }),
		]);
		expect(JSON.stringify(worker.requests)).not.toContain("hunter2");
	});

	it("treats a duplicate prompt acknowledgement as registered", async () => {
		const worker = startWorker(request =>
			request.path === "/api/sessions/init"
				? Response.json({
						sessionDbId: 3,
						promptNumber: 2,
						skipped: true,
						reason: "duplicate",
						contextInjected: false,
					})
				: undefined,
		);
		const fixture = await startPrimary(worker, "s-dup");
		const { session, state } = fixture;

		await startTurn(session as never, "again");
		toolCall(session, "read", "call-dup", { path: "a.ts" }, { content: "a" });
		await state.flush();

		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(1);
	});

	it("defers first-turn recall instead of waiting out a slow bootstrap past the first-turn budget", async () => {
		const readyAt = Date.now() + 700;
		const worker = startWorker(request => {
			if (request.path === "/api/readiness" && Date.now() < readyAt) {
				return Response.json({ status: "initializing" }, { status: 503 });
			}
			return undefined;
		});
		const cwd = await makeTempDir("claude-mem-project");
		const settings = await claudeMemSettings(cwd, worker.url, {
			"claudeMem.firstTurnDeadlineMs": 150,
			"claudeMem.workerStartTimeoutMs": 3_000,
		});
		const session = makeFakeSession({ sessionId: "s-slow", settings });
		await claudeMemBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp",
			taskDepth: 0,
		});
		const state = getClaudeMemSessionState(session as never);
		if (!state) throw new Error("claude-mem state was not installed");

		const started = performance.now();
		expect(await startTurn(session as never, "slow start")).toBeUndefined();
		expect(performance.now() - started).toBeLessThan(600);
		expect(worker.received("GET", "/api/search")).toHaveLength(0);

		await state.contextLoadPromise;
		await startTurn(session as never, "slow start");
		expect(worker.received("GET", "/api/search")).toHaveLength(1);
		await state.flush();
		// Both turns registered their prompt, in order, once the worker was ready.
		expect(worker.received("POST", "/api/sessions/init")).toHaveLength(2);
	});

	it("keeps queued writes on the session id they were built for across a rekey", async () => {
		let releaseInit: (() => void) | undefined;
		const blocked = new Promise<void>(resolve => {
			releaseInit = resolve;
		});
		const worker = startWorker(request => {
			if (request.path !== "/api/sessions/init") return undefined;
			return blocked.then(() => Response.json({ success: true }));
		});
		const fixture = await startPrimary(worker, "s-old");
		const { session, state } = fixture;

		await startTurn(session as never, "old prompt");
		session.emit({ type: "agent_end", messages: [assistantTurn("Old answer.")] as never });
		state.setSessionId("s-new");
		toolCall(session, "read", "call-new", { path: "n.ts" }, { content: "n" });
		releaseInit?.();
		await state.flush();

		expect(worker.received("POST", "/api/sessions/init")[0]?.body).toMatchObject({ contentSessionId: "s-old" });
		expect(worker.received("POST", "/api/sessions/summarize")[0]?.body).toMatchObject({
			contentSessionId: "s-old",
			last_assistant_message: "Old answer.",
		});
		// The new session has no registered prompt yet, so its observation is dropped.
		expect(worker.received("POST", "/api/sessions/observations")).toHaveLength(0);

		await startTurn(session as never, "new prompt");
		toolCall(session, "read", "call-new-2", { path: "m.ts" }, { content: "m" });
		await state.flush();
		expect(worker.received("POST", "/api/sessions/init")[1]?.body).toMatchObject({
			contentSessionId: "s-new",
			prompt: "new prompt",
		});
		expect(worker.received("POST", "/api/sessions/observations")[0]?.body).toMatchObject({
			contentSessionId: "s-new",
			tool_use_id: "call-new-2",
		});
	});
});

describe("claude-mem memory references", () => {
	it("parses observation and session hosts", () => {
		expect(parseClaudeMemMemoryRef("77")).toEqual({ kind: "observation", id: 77 });
		expect(parseClaudeMemMemoryRef("S12")).toEqual({ kind: "session", id: 12 });
		expect(parseClaudeMemMemoryRef("s12")).toEqual({ kind: "session", id: 12 });
		expect(parseClaudeMemMemoryRef("abc")).toBeUndefined();
		expect(parseClaudeMemMemoryRef("S")).toBeUndefined();
	});

	it("renders an observation with front-matter and facts, and null when missing", async () => {
		const worker = startWorker(request => {
			if (request.path === "/api/observation/77") {
				return Response.json({
					id: 77,
					memory_session_id: "m-1",
					project: "demo",
					type: "bugfix",
					title: "Fixed null deref",
					subtitle: null,
					facts: JSON.stringify(["guard added"]),
					narrative: "Added a null guard.",
					concepts: JSON.stringify(["bug"]),
					files_read: "[]",
					files_modified: JSON.stringify(["src/a.ts"]),
					prompt_number: 3,
					created_at: "2026-09-14T10:00:00.000Z",
					created_at_epoch: 1_789_207_200_000,
				});
			}
			return undefined;
		});
		const { state } = await startPrimary(worker, "s-read");

		const markdown = await state.readMemory({ kind: "observation", id: 77 });
		expect(markdown).toContain("id: 77");
		expect(markdown).toContain("type: bugfix");
		expect(markdown).toContain("# Fixed null deref");
		expect(markdown).toContain("## Facts\n- guard added");
		expect(markdown).toContain("## Narrative\nAdded a null guard.");
		expect(worker.received("GET", "/api/observation/77")[0]?.query).not.toHaveProperty("platformSource");

		await expect(state.readMemory({ kind: "observation", id: 78 })).resolves.toBeNull();
	});

	it("renders a session summary and null when missing", async () => {
		const worker = startWorker(request => {
			if (request.path === "/api/session/12") {
				return Response.json({
					id: 12,
					memory_session_id: "m-2",
					project: "demo",
					request: "Wire the backend",
					investigated: null,
					learned: "Queue must stay ordered",
					completed: "Backend wired",
					next_steps: null,
					files_read: "[]",
					files_edited: "[]",
					notes: null,
					prompt_number: 2,
					created_at: "2026-09-14T10:00:00.000Z",
					created_at_epoch: 1_789_207_200_000,
				});
			}
			return undefined;
		});
		const { state } = await startPrimary(worker, "s-read-session");

		const markdown = await state.readMemory({ kind: "session", id: 12 });
		expect(markdown).toContain("id: S12");
		expect(markdown).toContain("## Request\nWire the backend");
		expect(markdown).toContain("## Learned\nQueue must stay ordered");

		await expect(state.readMemory({ kind: "session", id: 13 })).resolves.toBeNull();
	});

	it("forgets by DELETE and reports false for unknown ids", async () => {
		const worker = startWorker(request => {
			if (request.method === "DELETE" && request.path === "/api/observation/77")
				return Response.json({ success: true });
			return undefined;
		});
		const { state } = await startPrimary(worker, "s-forget");

		await expect(state.forget(77)).resolves.toBe(true);
		await expect(state.forget(78)).resolves.toBe(false);
		expect(worker.received("DELETE", "/api/observation/77")).toHaveLength(1);
		expect(worker.received("DELETE", "/api/observation/78")).toHaveLength(1);
	});
});

describe("resolveMemoryBackend", () => {
	it("returns the claude-mem backend for memory.backend = claude-mem", async () => {
		const settings = Settings.isolated({ "memory.backend": "claude-mem" });
		expect((await resolveMemoryBackend(settings)).id).toBe("claude-mem");
	});
});
