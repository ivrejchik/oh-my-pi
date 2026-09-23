# claude-mem memory backend

Oh My Pi can use [claude-mem](https://github.com/thedotmack/claude-mem) as a long-term memory backend. claude-mem is a Claude Code plugin whose memory lives in a shared per-user worker daemon (`worker-service.cjs`) that compresses tool results into observations and turns into session summaries. This backend drives that daemon natively over HTTP: no MCP server and no plugin hook CLI are involved, and an omp session shares the same worker, database, and project history that the Claude Code hooks use.

Set:

```yaml
memory:
  backend: claude-mem
```

Example:

```yaml
memory:
  backend: claude-mem
claudeMem:
  platformSource: omp
  recallLimit: 10
```

With this backend enabled, the coding agent:

1. Probes the worker (`/api/health`, then readiness) in the background and, when the daemon is down and `claudeMem.autoStartWorker` is on, launches it through the plugin's own `worker-service.cjs start` script. Session creation never blocks on the spawn.
2. Loads the plugin's SessionStart context block through `/api/context/inject` for the project and injects it into the system prompt as a `<claude_mem_context>` block (`claudeMem.autoContext`).
3. Registers every new user prompt with the worker through `/api/sessions/init` (`contentSessionId` = the omp session id, `project`, `prompt`).
4. On the first model turn waits up to 8 seconds for the startup context, then runs a project-scoped `/api/search` for the prompt (`claudeMem.autoRecall`) and injects the results as a `<memories>` block.
5. Sends every tool result to `/api/sessions/observations` in order through a per-session write queue (`claudeMem.autoObserve`).
6. At agent end (terminal turn only) sends the final assistant message to `/api/sessions/summarize` (`claudeMem.autoSummarize`).
7. Adds project-scoped recall as extra compaction context when compaction asks the backend for `preCompactionContext`.
8. Uses the normal `/memory view`, `/memory stats`, `/memory diagnose`, `/memory queue`, `/memory clear`, and `/memory enqueue` commands through the shared memory backend interface.

Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Observation ingest

Tool results are forwarded under the Claude Code tool names the worker already keys its skip list, tier routing, and file tracking on:

| omp tool        | Sent as           |
| --------------- | ----------------- |
| `read`          | `Read`            |
| `write`         | `Write`           |
| `edit`          | `Edit`            |
| `bash`          | `Bash`            |
| `grep`          | `Grep`            |
| `glob`          | `Glob`            |
| `todo`          | `TodoWrite`       |
| `ask`           | `AskUserQuestion` |
| `task`          | `Task`            |
| `web_search`    | `WebSearch`       |
| `web_fetch`     | `WebFetch`        |
| `notebook_edit` | `NotebookEdit`    |

Unmapped tools pass through with their omp name. `todo` and `ask` are forwarded but dropped by the worker's own skip list (`TodoWrite`, `AskUserQuestion`). Discoverable tools invoked as `write` to `xd://<device>` are unwrapped first: the observation carries the device name (`lsp`, `ast_edit`, `mcp__…`) and its decoded JSON arguments, not a `Write` of a fake path. The omp memory tools (`recall`, `retain`, `reflect`, `memory_edit`, `learn`) — direct or through `xd://` — and `read memory://…` are never observed, so recalled memory does not feed back into memory. Tool output is flattened to text (image blocks become `[image <mime>]`) and truncated at 100,000 characters with a `[truncated]` marker, matching the plugin's hook cap.

Observation extraction happens asynchronously inside the worker. The backend only queues the HTTP write; the worker's own processing queue is visible through `/memory queue` and `/memory stats`.

### Write ordering and the prompt gate

All writes for a session go through one ordered queue: `session-init` → observations → `summarize`, one HTTP call at a time. The queue waits behind the worker bootstrap, so a turn that starts while the daemon is still coming up does not lose its prompt registration. Every turn registers its prompt, even when the text repeats — a repeated prompt is a new turn with its own privacy decision, and the worker's own dedupe window answers `duplicate` for a genuine double-fire. Each turn owns an authorization token: the session id it registered under plus the worker's eventual verdict on `/api/sessions/init`. `skipped: true` with `reason: "private"` (a wholly `<private>` prompt) or `"internal_protocol"` means the worker stored no prompt row, so the verdict is negative; `reason: "duplicate"` names an existing row and is positive; a failed request is negative. Every observation and summary captures the token of the turn it belongs to when it is queued and is dropped in queue order unless that token's verdict is positive — a later public turn can never authorize an earlier private turn's output, and a write queued with no turn at all is never sent. Rekeying to a new session (`/new`, resume) leaves already-captured tokens untouched, so in-flight writes finish on the old session id, and nothing is authorized under the new id until its first prompt registers. Complete `<private>…</private>` (and the worker's other meta-tag) pairs are removed before the 100k cap so a pair straddling the cap cannot leak its body. At shutdown queued writes are flushed within the interactive/print exit budget; writes still in flight continue in the background.

## Worker bootstrap

Bootstrap runs once per worker URL, shared between concurrent sessions in the same process:

1. `GET /api/health`. If the worker answers, poll readiness every 500 ms until `claudeMem.workerStartTimeoutMs` elapses.
2. If the worker is unreachable and `claudeMem.autoStartWorker` is `false`, the backend is degraded for this session.
3. Otherwise the backend needs a plugin root and a Bun executable. The plugin root is `CLAUDE_PLUGIN_ROOT` / `claudeMem.pluginRoot` when it contains `scripts/worker-service.cjs`; failing that, the newest non-orphaned version directory under `<CLAUDE_CONFIG_DIR|~/.claude>/plugins/cache/thedotmack/claude-mem/` that ships the script (version directories carrying a `.orphaned_at` marker are skipped). Bun is resolved from `$BUN`, then `PATH`, then `~/.bun/bin/bun`, then the current executable when it is itself Bun.
4. `bun <pluginRoot>/scripts/worker-service.cjs start` is spawned with `CLAUDE_MEM_DATA_DIR`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_CONFIG_DIR`, and `CLAUDE_MEM_WORKER_PORT` set, cwd = the data directory, and killed if it exceeds `claudeMem.workerStartTimeoutMs`. Spawn locking, daemonisation, pid files, and readiness gating stay the plugin's responsibility.
5. After a successful start the backend re-checks health and waits for readiness against the same deadline.

When the running worker reports a version that differs from the resolved plugin directory's version, a warning is logged; the session continues against the running worker. A probe failure logs a warning, emits a session notice, and leaves the session usable with memory inert; memory tools then report that the backend is not initialised.

## Project naming

The project name mirrors the plugin's own `getProjectContext(cwd)`: the basename of the repository checkout root (or of the working directory outside a repository; an empty cwd yields `unknown-project`). A linked git worktree writes observations, prompts, and summaries under the composite `<primary>/<worktree>` name and injects startup context for both `<primary>` and `<primary>/<worktree>`, so the worktree sees the shared repository history plus its own. Explicit `recall`/`reflect` searches are scoped to the primary name first and widen to every project only when the scoped search is empty.

## Platform source

Every session, prompt, observation, summary, and manual save written by omp is tagged with `claudeMem.platformSource` (default `claude`). omp's reads — startup context, recall, `recall`/`reflect`, `memory://` — send no source filter, so the worker answers from every pool and omp sessions see Claude Code history. Claude Code's own hooks request their startup context with their `claude` source, so a different tag (for example `omp`) keeps omp's sessions out of Claude Code's startup context while leaving them attributable.

## Agent tools

Selecting claude-mem makes these discoverable tools available:

- `recall` — search observations and session summaries. Results are an index of ids with titles, dates, and a few facts; read a full entry with `read memory://<id>` or `read memory://S<id>`. Project-scoped first, widened to every project when nothing matches.
- `retain` — store an explicit note as an observation under the current project (`/api/memory/save`). Tool results and turn summaries are already recorded automatically; retain only what a tool did not show.
- `reflect` — gather every relevant observation for a broader question.
- `memory_edit` — `forget` only. claude-mem observations are LLM-generated rows on the shared worker; there is no update or invalidate operation, so `memory_edit` deletes the observation by id (`DELETE /api/observation/<id>`; `forget` reports `false` when the id does not exist).

The optional `learn` tool also retains into claude-mem when `autolearn.enabled: true`.

## `memory://` reads

| URL                          | Content                                                                                                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory://<observation-id>`  | Full observation as markdown: YAML front matter (`id`, `kind: observation`, `type`, `project`, `created_at`, `memory_session_id`, `prompt_number`, agent tags, concepts, files, metadata) followed by title, subtitle, `## Facts`, and `## Narrative` |
| `memory://S<session-id>`     | Full session summary as markdown: YAML front matter (`id: S<n>`, `kind: session_summary`, `project`, `created_at`, `memory_session_id`, `prompt_number`, files) followed by `## Request`, `## Investigated`, `## Learned`, `## Completed`, `## Next steps`, `## Notes` |

Reads are not filtered by platform source; an id that does not exist yields no document.

## `/memory` command

| Subcommand  | Effect                                                                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `view`      | Show the current injection payload (static instructions plus the cached `<claude_mem_context>` and `<memories>` blocks, truncated to `claudeMem.injectionTokenLimit`)                                              |
| `stats`     | Worker URL/version/uptime/active sessions, project, platform source, database path/size, observation/session/summary counts, worker queue depth and processing state, local writes still waiting                   |
| `diagnose`  | Health and readiness, plugin root and version, data directory, auto-start, platform source, project chain, feature toggles, observer provider, vector-store status, session context/recall state, last probe error |
| `queue`     | Local writes waiting on the ordered queue plus the worker's own queue depth, processing state, and parked sessions                                                                                                  |
| `enqueue`   | Summarize the current transcript now and wait for the local write queue to drain                                                                                                                                    |
| `clear`     | Flush pending writes, drop the local session state and cached prompt blocks, then rebuild the session state. **Never deletes server-side data**; delete observations with `memory_edit forget` or the claude-mem viewer |

## Subagents

Subagents alias the parent's state. Their tool results are observed under the parent's worker session, tagged with the subagent's agent id (`agentType: task`), when `claudeMem.observeSubagents` is on; they never load startup context, register prompts, run first-turn recall, or summarize — the parent turn owns those. A child turn is authorized by the dispatch that started it, and the authorization travels with the dispatch itself: the `task` tool, eval `agent()`, workpool `push`, and vibe `spawn`/`send` capture the dispatcher's current turn token synchronously in the tool call (or when a message is queued), and that token — not whatever turn the parent is in when the child eventually starts — is handed to the child's first turn (`parentClaudeMemDispatch`), its follow-up turns (`FollowUpTurnOptions.claudeMemDispatch`), or folded into its running turn for a steer. Queued vibe messages carry their own tokens and a turn assembled from several of them is authorized only if every contributor is, and only if they name the same session. A `hub` message carries its sender's token from the moment `IrcBus.send` runs, inside the sender's turn and before any roster or revival wait; the bus folds it into the recipient's running turn wherever it hands the message over without session injection — a pending `hub wait` or `send await:true`, a mailbox `take`, or an `inbox` read — and otherwise passes it to the session bridge, which moves it onto the queued record so it survives deferral, parking, and merging: an idle wake (which prompts the agent core directly, bypassing the prompt hook) is authorized at the moment it wins prompt ownership from the tokens of every record in it; a mid-turn aside, a parent steer, or a record read through the session inbox folds its token into the running turn; a record folded into context without a turn weighs on the next turn. A child turn that starts with no dispatch token at all is never observed, and one unauthorized contributor denies the whole turn. Every result of a child turn — however late it lands, and even after the parent has moved on to another turn or rekeyed to a new session — is posted to its token's session id and only if that token's verdict is positive. Explicit `recall`, `retain`, `reflect`, and `memory_edit` calls from a subagent go through the parent's client and project. A subagent started without a parent claude-mem state stays inert.

## Settings

| Setting                          | Default                                                          | Description                                                                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                 | `off`                                                            | Set to `claude-mem` to enable this backend.                                                                                                                                                             |
| `claudeMem.workerUrl`            | `http://<host>:<port>` from `~/.claude-mem/settings.json`        | Worker base URL. When unset, host and port come from the plugin's `settings.json` (`CLAUDE_MEM_WORKER_HOST`/`CLAUDE_MEM_WORKER_PORT`), then `127.0.0.1` and `37700 + (uid % 100)`. `localhost` is normalised to `127.0.0.1`; a trailing slash is stripped. |
| `claudeMem.dataDir`              | `~/.claude-mem`                                                  | claude-mem data directory (`settings.json`, database, logs). Also the cwd and `CLAUDE_MEM_DATA_DIR` for an auto-started worker.                                                                         |
| `claudeMem.pluginRoot`           | newest installed plugin under `~/.claude/plugins/cache/thedotmack/claude-mem` | Directory containing `scripts/worker-service.cjs`. Only used to auto-start the worker and to compare versions.                                                                              |
| `claudeMem.platformSource`       | `claude`                                                         | Source tag written on sessions, prompts, observations, and summaries. Reads span every source regardless.                                                                                               |
| `claudeMem.autoStartWorker`      | `true`                                                           | Launch the worker daemon through the plugin when it is not running.                                                                                                                                     |
| `claudeMem.autoContext`          | `true`                                                           | Inject the project's recent observations and session summaries at session start.                                                                                                                        |
| `claudeMem.autoRecall`           | `true`                                                           | Search observations relevant to the first prompt of each session.                                                                                                                                       |
| `claudeMem.autoObserve`          | `true`                                                           | Send every tool result to the worker for observation extraction.                                                                                                                                        |
| `claudeMem.observeSubagents`     | `true`                                                           | Also observe subagent tool results (tagged with the subagent id).                                                                                                                                       |
| `claudeMem.autoSummarize`        | `true`                                                           | Queue a session summary from the final assistant message after every turn.                                                                                                                              |
| `claudeMem.recallLimit`          | `10`                                                             | Maximum observations returned by recall and first-turn injection (minimum `1`; the shared backend search API clamps explicit limits to `1`–`50`).                                                       |
| `claudeMem.recallContextTurns`   | `1`                                                              | Prior user-bounded turns included in recall queries (minimum `1`).                                                                                                                                      |
| `claudeMem.recallMaxQueryChars`  | `800`                                                            | Maximum composed recall query length (minimum `0`).                                                                                                                                                     |
| `claudeMem.injectionTokenLimit`  | `8000`                                                           | Approximate token cap for the memory block in the system prompt (`0` = unlimited).                                                                                                                      |
| `claudeMem.requestTimeoutMs`     | `30000`                                                          | Per-request HTTP timeout (minimum `1000`). The plugin's `settings.json` `CLAUDE_MEM_API_TIMEOUT_MS` takes precedence over this setting.                                                                  |
| `claudeMem.workerStartTimeoutMs` | `45000`                                                          | Deadline for worker spawn and readiness polling (minimum `1000`).                                                                                                                                       |
| `claudeMem.firstTurnDeadlineMs`  | `8000`                                                           | How long the first turn waits for the bootstrap, startup context, and auto-recall before generating without them; a slow daemon spawn defers recall to the next turn instead of blocking the prompt.     |
| `claudeMem.debug`                | `false`                                                          | Log every failed worker request and the probe result at debug level; without it only the first failure per outage is warned.                                                                            |

Resolution order is `CLAUDE_MEM_*` environment > `claudeMem.*` setting > built-in default, with two exceptions that consult the plugin's own `~/.claude-mem/settings.json` so an omp session lands on the same worker the Claude Code hooks use: the worker host/port fall back to that file when neither `CLAUDE_MEM_WORKER_URL` nor `claudeMem.workerUrl` is set, and that file's `CLAUDE_MEM_API_TIMEOUT_MS` takes precedence over `claudeMem.requestTimeoutMs`.

## Environment overrides

| Variable                             | Overrides                                        | Accepted value                                                              |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `CLAUDE_MEM_WORKER_URL`              | `claudeMem.workerUrl`                            | Non-empty base URL; wins over host/port                                     |
| `CLAUDE_MEM_WORKER_HOST`             | host part of the derived worker URL              | Hostname or IP; `localhost` → `127.0.0.1`; bare IPv6 is bracketed           |
| `CLAUDE_MEM_WORKER_PORT`             | port part of the derived worker URL              | Integer; default `37700 + (uid % 100)`                                      |
| `CLAUDE_MEM_DATA_DIR`                | `claudeMem.dataDir`                              | Directory path (`~` expanded)                                               |
| `CLAUDE_PLUGIN_ROOT`                 | `claudeMem.pluginRoot`                           | Directory containing `scripts/worker-service.cjs` (`~` expanded)            |
| `CLAUDE_CONFIG_DIR`                  | plugin cache search root                         | Claude Code config directory; default `~/.claude`                           |
| `CLAUDE_MEM_API_TIMEOUT_MS`          | `claudeMem.requestTimeoutMs`                     | Integer milliseconds                                                        |
| `CLAUDE_MEM_PLATFORM_SOURCE`         | `claudeMem.platformSource`                       | Non-empty string                                                            |
| `CLAUDE_MEM_AUTO_START_WORKER`       | `claudeMem.autoStartWorker`                      | Boolean                                                                     |
| `CLAUDE_MEM_AUTO_CONTEXT`            | `claudeMem.autoContext`                          | Boolean                                                                     |
| `CLAUDE_MEM_AUTO_RECALL`             | `claudeMem.autoRecall`                           | Boolean                                                                     |
| `CLAUDE_MEM_AUTO_OBSERVE`            | `claudeMem.autoObserve`                          | Boolean                                                                     |
| `CLAUDE_MEM_OBSERVE_SUBAGENTS`       | `claudeMem.observeSubagents`                     | Boolean                                                                     |
| `CLAUDE_MEM_AUTO_SUMMARIZE`          | `claudeMem.autoSummarize`                        | Boolean                                                                     |
| `CLAUDE_MEM_RECALL_LIMIT`            | `claudeMem.recallLimit`                          | Integer                                                                     |
| `CLAUDE_MEM_RECALL_CONTEXT_TURNS`    | `claudeMem.recallContextTurns`                   | Integer                                                                     |
| `CLAUDE_MEM_RECALL_MAX_QUERY_CHARS`  | `claudeMem.recallMaxQueryChars`                  | Integer                                                                     |
| `CLAUDE_MEM_INJECTION_TOKEN_LIMIT`   | `claudeMem.injectionTokenLimit`                  | Integer                                                                     |
| `CLAUDE_MEM_WORKER_START_TIMEOUT_MS` | `claudeMem.workerStartTimeoutMs`                 | Integer milliseconds                                                        |
| `CLAUDE_MEM_FIRST_TURN_DEADLINE_MS`  | `claudeMem.firstTurnDeadlineMs`                  | Integer milliseconds                                                        |
| `CLAUDE_MEM_DEBUG`                   | `claudeMem.debug`                                | Boolean                                                                     |

String values are trimmed and an empty string is ignored. Booleans are case-insensitive: `true`, `1`, and `yes` mean true; any other defined value means false. Integers use base-10 `parseInt`; non-numeric values are ignored, then the same minimums as the settings apply. See the [environment-variable reference](./environment-variables.md#claude-mem-memory-backend).

## Operational notes

- The worker is one shared daemon per user: Claude Code hooks, the claude-mem MCP server, and every omp session talk to the same instance and database (`<dataDir>/claude-mem.db`). omp reads every platform source; Claude Code's hooks read their own.
- `/memory clear` only drops omp's local session cache and rebuilds it; no observation or summary is deleted from the worker.
- Observation extraction is asynchronous: a tool result is accepted immediately and compressed by the worker later. `/memory queue` shows the worker's queue depth alongside omp's own pending HTTP writes.
- Writes go through one ordered per-session queue (`session-init`, `observation`, `summarize`). A failed write is logged once per outage and dropped; the coding session is never blocked by the worker.
- Backend start, `/memory clear` rehydration, and worker bootstrap are best-effort: failures log a warning and leave memory inert for the session.
- Session disposal and `/memory clear` flush the queued HTTP writes before releasing the state; `/memory enqueue` additionally summarizes the current transcript first. Extraction already handed to the worker completes on the worker's schedule.
