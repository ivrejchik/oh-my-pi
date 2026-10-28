# work_state_read

> Read the current project's claude-mem work-state lists written with `work_state_write`.

## Source
- Entry: `packages/coding-agent/src/tools/work-state.ts` (`WorkStateReadTool`)
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/work-state-read.md`
- Backend collaborator: `packages/coding-agent/src/claude-mem/state.ts` (`workStateRead(...)`) → `GET /api/work-state`

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`.
- Same gating as [`work_state_write`](./work_state_write.md): `memory.backend = "claude-mem"` and work state not disabled.
- In an ordinary `tools.xdev` session it is presented as `xd://work_state_read`.

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `list` | `string` | No | Read only this list. |
| `includeClosed` | `boolean` | No | Also show done and dropped items and closed lists. |

## Outputs
- `content[0].type = "text"`: the worker's rendering of the entries, or `Nothing open … for <project>.` / `Nothing recorded …` when empty.

## Flow
1. `execute(...)` fetches `session.getClaudeMemSessionState()` and fails if the backend is not initialized.
2. `state.workStateRead(...)` sends `cwd`, `list`, and `includeClosed=true` when set.
3. The worker reads every key the checkout reads (worktree parent included), the same scope SessionStart shows.
4. Results are never recorded as observations.
