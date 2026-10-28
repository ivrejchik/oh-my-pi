Cross-session to-do lists and working state for this project, kept by claude-mem. Whatever is still open shows in `<claude_mem_context>` at the start of every session here, and as cards in claude-mem's My Work.

Each call appends one entry to `list`; returns what is still open in that list.
- To-do item: `fields` `{"task": "<name>", "status": "todo" | "doing" | "done" | "dropped", ...details}`.
- List state: any other keys; latest value per key wins, `null` clears a key, `"status": "done"` closes the list.
- Something a person can open (PR, report, page, file): add `"work_product": "https://…"` or an absolute path to its item.

Values: strings, finite numbers, booleans, or `null`. Excluded projects (`CLAUDE_MEM_EXCLUDED_PROJECTS`) are not saved.
