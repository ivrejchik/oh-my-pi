/**
 * claude-mem backend configuration.
 *
 * Resolution order for every knob: `CLAUDE_MEM_*` environment > `claudeMem.*`
 * settings > the plugin's own `~/.claude-mem/settings.json` (worker host/port
 * only) > built-in default. The plugin file is consulted so an omp session
 * lands on the same worker the Claude Code hooks and the MCP server use.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Settings } from "../config/settings";

export const CLAUDE_MEM_BACKEND_ID = "claude-mem" as const;

/** Worker script relative to a claude-mem plugin root. */
export const WORKER_SCRIPT_RELATIVE = path.join("scripts", "worker-service.cjs");

export interface ClaudeMemConfig {
	/** claude-mem data directory (`settings.json`, `claude-mem.db`, logs). */
	dataDir: string;
	/** Resolved plugin root containing `scripts/worker-service.cjs`; undefined when not installed. */
	pluginRoot?: string;
	/** Worker base URL, e.g. `http://127.0.0.1:37700`. */
	workerUrl: string;
	/** Platform source tag written on every session/observation and used to filter reads. */
	platformSource: string;
	autoStartWorker: boolean;
	autoContext: boolean;
	autoRecall: boolean;
	autoObserve: boolean;
	observeSubagents: boolean;
	autoSummarize: boolean;
	recallLimit: number;
	recallContextTurns: number;
	recallMaxQueryChars: number;
	injectionTokenLimit: number;
	requestTimeoutMs: number;
	workerStartTimeoutMs: number;
	/** How long the first turn waits for bootstrap/context/recall before generating without them. */
	firstTurnDeadlineMs: number;
	debug: boolean;
}

function envBool(value: string | undefined): boolean | undefined {
	if (value === undefined) return undefined;
	return ["true", "1", "yes"].includes(value.toLowerCase());
}

function envInt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : undefined;
}

function envString(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/** Default data directory used by the plugin when nothing overrides it. */
export function defaultClaudeMemDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return envString(env.CLAUDE_MEM_DATA_DIR) ?? path.join(os.homedir(), ".claude-mem");
}

/** Claude Code config dir (`~/.claude` unless `CLAUDE_CONFIG_DIR` is set). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	return envString(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude");
}

/**
 * Flat `CLAUDE_MEM_*` map from the plugin's `settings.json`. Accepts the legacy
 * `{ env: {...} }` wrapper the plugin still tolerates. Missing/invalid → `{}`.
 */
export function readPluginSettings(dataDir: string): Record<string, string> {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8")) as unknown;
		if (!raw || typeof raw !== "object") return {};
		const obj = raw as Record<string, unknown>;
		const source = obj.env && typeof obj.env === "object" ? (obj.env as Record<string, unknown>) : obj;
		const out: Record<string, string> = {};
		for (const [key, value] of Object.entries(source)) {
			if (typeof value === "string") out[key] = value;
			else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
		}
		return out;
	} catch {
		return {};
	}
}

/** The plugin's UID-derived default port (see `SettingsDefaultsManager`). */
export function defaultWorkerPort(): number {
	const uid = typeof process.getuid === "function" ? process.getuid() : 77;
	return 37700 + (uid % 100);
}

function normalizeHost(host: string): string {
	const trimmed = host.trim();
	if (!trimmed || trimmed === "localhost") return "127.0.0.1";
	return trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
}

function semverParts(name: string): [number, number, number, number] {
	const [base = ""] = name.split("-");
	const [a = 0, b = 0, c = 0] = base.split(".").map(n => Number.parseInt(n, 10) || 0);
	return [a, b, c, name.includes("-") ? 0 : 1];
}

/**
 * Latest non-orphaned plugin version dir that ships the worker script — the
 * same rule the plugin's own hook launcher applies. `explicit` (setting or
 * `CLAUDE_PLUGIN_ROOT`) wins when it contains the script.
 */
export function resolveClaudeMemPluginRoot(explicit: string | undefined, configDir: string): string | undefined {
	if (explicit) {
		const root = expandHome(explicit);
		if (fs.existsSync(path.join(root, WORKER_SCRIPT_RELATIVE))) return root;
	}
	const cache = path.join(configDir, "plugins", "cache", "thedotmack", "claude-mem");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(cache, { withFileTypes: true });
	} catch {
		return undefined;
	}
	const versions = entries
		.filter(d => d.isDirectory() && /^\d/.test(d.name) && !fs.existsSync(path.join(cache, d.name, ".orphaned_at")))
		.map(d => d.name)
		.sort((x, y) => {
			const a = semverParts(x);
			const b = semverParts(y);
			for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return b[i] - a[i];
			return y.localeCompare(x);
		});
	for (const version of versions) {
		const root = path.join(cache, version);
		if (fs.existsSync(path.join(root, WORKER_SCRIPT_RELATIVE))) return root;
	}
	return undefined;
}

/** Plugin version string derived from the resolved plugin root's directory name. */
export function pluginVersionFromRoot(pluginRoot: string | undefined): string | undefined {
	if (!pluginRoot) return undefined;
	const base = path.basename(pluginRoot);
	return /^\d/.test(base) ? base : undefined;
}

export function loadClaudeMemConfig(settings: Settings, env: NodeJS.ProcessEnv = process.env): ClaudeMemConfig {
	const dataDir = expandHome(
		envString(env.CLAUDE_MEM_DATA_DIR) ?? settings.get("claudeMem.dataDir")?.trim() ?? defaultClaudeMemDataDir(env),
	);
	const plugin = readPluginSettings(dataDir);
	const pluginRoot = resolveClaudeMemPluginRoot(
		envString(env.CLAUDE_PLUGIN_ROOT) ?? settings.get("claudeMem.pluginRoot")?.trim() ?? undefined,
		claudeConfigDir(env),
	);

	const explicitUrl = envString(env.CLAUDE_MEM_WORKER_URL) ?? settings.get("claudeMem.workerUrl")?.trim();
	let workerUrl: string;
	if (explicitUrl) {
		workerUrl = explicitUrl.replace(/\/+$/, "");
	} else {
		const host = normalizeHost(envString(env.CLAUDE_MEM_WORKER_HOST) ?? plugin.CLAUDE_MEM_WORKER_HOST ?? "127.0.0.1");
		const port = envInt(env.CLAUDE_MEM_WORKER_PORT) ?? envInt(plugin.CLAUDE_MEM_WORKER_PORT) ?? defaultWorkerPort();
		workerUrl = `http://${host}:${port}`;
	}

	return {
		dataDir,
		pluginRoot,
		workerUrl,
		platformSource:
			envString(env.CLAUDE_MEM_PLATFORM_SOURCE) ?? settings.get("claudeMem.platformSource")?.trim() ?? "claude",
		autoStartWorker: envBool(env.CLAUDE_MEM_AUTO_START_WORKER) ?? settings.get("claudeMem.autoStartWorker"),
		autoContext: envBool(env.CLAUDE_MEM_AUTO_CONTEXT) ?? settings.get("claudeMem.autoContext"),
		autoRecall: envBool(env.CLAUDE_MEM_AUTO_RECALL) ?? settings.get("claudeMem.autoRecall"),
		autoObserve: envBool(env.CLAUDE_MEM_AUTO_OBSERVE) ?? settings.get("claudeMem.autoObserve"),
		observeSubagents: envBool(env.CLAUDE_MEM_OBSERVE_SUBAGENTS) ?? settings.get("claudeMem.observeSubagents"),
		autoSummarize: envBool(env.CLAUDE_MEM_AUTO_SUMMARIZE) ?? settings.get("claudeMem.autoSummarize"),
		recallLimit: Math.max(1, envInt(env.CLAUDE_MEM_RECALL_LIMIT) ?? settings.get("claudeMem.recallLimit")),
		recallContextTurns: Math.max(
			1,
			envInt(env.CLAUDE_MEM_RECALL_CONTEXT_TURNS) ?? settings.get("claudeMem.recallContextTurns"),
		),
		recallMaxQueryChars: Math.max(
			0,
			envInt(env.CLAUDE_MEM_RECALL_MAX_QUERY_CHARS) ?? settings.get("claudeMem.recallMaxQueryChars"),
		),
		injectionTokenLimit: Math.max(
			0,
			envInt(env.CLAUDE_MEM_INJECTION_TOKEN_LIMIT) ?? settings.get("claudeMem.injectionTokenLimit"),
		),
		requestTimeoutMs: Math.max(
			1_000,
			envInt(env.CLAUDE_MEM_API_TIMEOUT_MS) ??
				envInt(plugin.CLAUDE_MEM_API_TIMEOUT_MS) ??
				settings.get("claudeMem.requestTimeoutMs"),
		),
		workerStartTimeoutMs: Math.max(
			1_000,
			envInt(env.CLAUDE_MEM_WORKER_START_TIMEOUT_MS) ?? settings.get("claudeMem.workerStartTimeoutMs"),
		),
		firstTurnDeadlineMs: Math.max(
			0,
			envInt(env.CLAUDE_MEM_FIRST_TURN_DEADLINE_MS) ?? settings.get("claudeMem.firstTurnDeadlineMs"),
		),
		debug: envBool(env.CLAUDE_MEM_DEBUG) ?? settings.get("claudeMem.debug"),
	};
}
