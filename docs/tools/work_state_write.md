# work_state_write

> Append one entry to a claude-mem work-state list: cross-session to-do lists and working state for the current project.

## Source
- Entry: `packages/coding-agent/src/tools/work-state.ts` (`WorkStateWriteTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/work-state-write.md`
- Backend collaborator: `packages/coding-agent/src/claude-mem/state.ts` (`workStateWrite(...)`) → `POST /api/work-state/entries`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `loadMode = "discoverable"`, not strict (`fields` is an open map).
- Registration requires `memory.backend = "claude-mem"` and `CLAUDE_MEM_WORK_STATE_ENABLED` not `false` (environment, then `~/.claude-mem/settings.json`; default on). It follows backend switches like the other memory tools.
- In an unrestricted session with an explicit tool list, registration auto-includes it for claude-mem. Restricted lists are not widened.
- In an ordinary `tools.xdev` session it is presented as `xd://work_state_write`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `list` | `string` | Yes | List name (1–200 characters), e.g. `release`. |
| `fields` | `Record<string, string \| number \| boolean \| null>` | Yes | Keys to set. `task` + `status` (`todo`/`doing`/`done`/`dropped`) updates a to-do item; other keys are list state (latest value wins, `null` clears, `status: "done"` closes the list). |

## Outputs
- `content[0].type = "text"`: the worker's answer — `Saved to "<list>" in <project>.` plus what is still open in the list.
- `details` is `{ list }`.
- An excluded checkout (`CLAUDE_MEM_EXCLUDED_PROJECTS`) returns `Not saved: this project is excluded …` as a normal result.
- Viewer-only lists (`my-rules`, `my-focus`) and invalid owner-goal rows are refused by the worker (HTTP 403/400); the tool throws with the worker's text.

## Flow
1. `execute(...)` fetches `session.getClaudeMemSessionState()` and fails if the backend is not initialized.
2. `state.workStateWrite(...)` waits for the worker bootstrap and posts `{ cwd, list, fields }` with the session's cwd.
3. The worker keys the entry to the checkout's primary project (its own resolver: worktrees, markers, environments), stores it, and answers with the open items.
4. Open items appear in the next session's `<claude_mem_context>` block and in claude-mem's My Work view.
5. Calls are observed like other tools; `work_state_read` is not.
