/**
 * claude-mem worker bootstrap.
 *
 * The worker is a shared per-user daemon; Claude Code hooks, the MCP server,
 * and omp all talk to the same instance. Bootstrap only checks health and, when
 * the daemon is down and autostart is on, runs the plugin's own
 * `worker-service.cjs start` so spawn locking, daemonization, pid files, and
 * readiness gating stay the plugin's responsibility.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ClaudeMemClient } from "./client";
import type { ClaudeMemConfig } from "./config";
import { claudeConfigDir, WORKER_SCRIPT_RELATIVE } from "./config";

export interface ClaudeMemWorkerProbe {
	reachable: boolean;
	ready: boolean;
	version?: string;
	pid?: number;
	/** True when this call launched the daemon. */
	started?: boolean;
	error?: string;
}

const READINESS_POLL_MS = 500;

/** In-flight bootstraps keyed by worker URL so concurrent sessions share one spawn. */
const inflight = new Map<string, Promise<ClaudeMemWorkerProbe>>();

/** Bun executable for the worker script (the plugin requires `bun:sqlite`). */
export function resolveBunExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = env.BUN?.trim();
	if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
	const onPath = Bun.which("bun");
	if (onPath) return onPath;
	const home = path.join(os.homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun");
	if (fs.existsSync(home)) return home;
	return path.basename(process.execPath).toLowerCase().startsWith("bun") ? process.execPath : undefined;
}

async function waitForReadiness(client: ClaudeMemClient, deadline: number): Promise<boolean> {
	while (Date.now() < deadline) {
		if (await client.ready()) return true;
		await Bun.sleep(READINESS_POLL_MS);
	}
	return await client.ready();
}

async function probe(client: ClaudeMemClient, config: ClaudeMemConfig): Promise<ClaudeMemWorkerProbe> {
	const health = await client.health();
	if (health) {
		const deadline = Date.now() + config.workerStartTimeoutMs;
		const ready = await waitForReadiness(client, deadline);
		return { reachable: true, ready, version: health.version, pid: health.pid };
	}
	if (!config.autoStartWorker) {
		return {
			reachable: false,
			ready: false,
			error: `worker unreachable at ${config.workerUrl} (autoStartWorker off)`,
		};
	}
	if (!config.pluginRoot) {
		return {
			reachable: false,
			ready: false,
			error: "claude-mem plugin not found; set claudeMem.pluginRoot or install the plugin in Claude Code",
		};
	}
	const bun = resolveBunExecutable();
	if (!bun) {
		return { reachable: false, ready: false, error: "bun executable not found; claude-mem worker requires Bun" };
	}

	const script = path.join(config.pluginRoot, WORKER_SCRIPT_RELATIVE);
	const port = new URL(config.workerUrl).port;
	const env: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_MEM_DATA_DIR: config.dataDir,
		CLAUDE_PLUGIN_ROOT: config.pluginRoot,
		CLAUDE_CONFIG_DIR: claudeConfigDir(),
	};
	if (port) env.CLAUDE_MEM_WORKER_PORT = port;

	const deadline = Date.now() + config.workerStartTimeoutMs;
	let stderr = "";
	try {
		const proc = Bun.spawn([bun, script, "start"], {
			env,
			cwd: config.dataDir,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => proc.kill(), config.workerStartTimeoutMs);
		try {
			const [, err, code] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			stderr = err.trim();
			if (code !== 0) {
				return {
					reachable: false,
					ready: false,
					error: `worker start exited ${code}${stderr ? `: ${stderr.slice(-400)}` : ""}`,
				};
			}
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		return {
			reachable: false,
			ready: false,
			error: `worker start failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	const afterStart = await client.health();
	if (!afterStart) {
		return {
			reachable: false,
			ready: false,
			started: true,
			error: `worker did not answer after start${stderr ? `: ${stderr.slice(-400)}` : ""}`,
		};
	}
	const ready = await waitForReadiness(client, deadline);
	return { reachable: true, ready, version: afterStart.version, pid: afterStart.pid, started: true };
}

/** Health-check the worker, launching it through the plugin when allowed. Never throws. */
export function ensureClaudeMemWorker(client: ClaudeMemClient, config: ClaudeMemConfig): Promise<ClaudeMemWorkerProbe> {
	const key = config.workerUrl;
	const existing = inflight.get(key);
	if (existing) return existing;
	const task = probe(client, config)
		.catch(error => ({
			reachable: false,
			ready: false,
			error: error instanceof Error ? error.message : String(error),
		}))
		.then(result => {
			if (config.debug) logger.debug("claude-mem: worker probe", { ...result, workerUrl: config.workerUrl });
			return result;
		})
		.finally(() => {
			inflight.delete(key);
		});
	inflight.set(key, task);
	return task;
}
