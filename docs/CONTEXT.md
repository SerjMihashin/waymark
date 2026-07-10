# Token-budgeted context

The Hub provides two high-level read-only tools for restoring project context
without loading all memory into the agent prompt.

## `workspace_resume`

Use once at the beginning of a session:

```json
{
  "project_id": "D--Projects-ClaudePlus",
  "task": "Continue implementation of compact context",
  "agent_id": "codex-primary",
  "client_id": "codex",
  "max_tokens": 1200
}
```

The task is optional. When supplied, it improves memory ranking.

**When to use which:** `workspace_resume` is the session opener — call it exactly
once, at the start, to restore the whole workspace picture (tasks, sessions,
handoffs, top memories). `context_get` is the mid-session refiner — call it when
you hit a *new sub-task* and want memories re-ranked for it (optionally filtered
by `memory_types` or with bodies via `include_sources`). If you only need one
known record, use `memory_read(id)` instead of either.

The packet may include `notices` — short protocol nudges (for example, an
unregistered `agent_id`). They cost a few tokens and appear only when relevant.

## `context_get`

Use when the agent needs context for a specific task:

```json
{
  "project_id": "D--Projects-ClaudePlus",
  "task": "Investigate SQLite write contention",
  "agent_id": "codex-primary",
  "max_tokens": 800,
  "memory_types": ["decision", "handoff", "project"],
  "include_sources": false
}
```

`include_sources=true` includes truncated memory bodies and therefore consumes
more of the budget. By default only compact summaries and record ids are
returned.

## Packet contents

- compact project metadata;
- the current task;
- active pending and in-progress tasks;
- ranked project and global memories;
- recent session summaries;
- counts of records omitted because of the budget;
- estimated serialized response tokens.

## Ranking

The deterministic ranking uses:

- memory type;
- project records over global records;
- term overlap with the requested task;
- update recency.

The core does not call an LLM or external service.

## Budget behavior

- Accepted budget: 200–20,000 estimated tokens.
- Default budget: 1,200.
- The estimate is calculated from the pretty-printed JSON returned to the
  client.
- Candidates are added one at a time and removed if they exceed the budget.
- For very small budgets, optional project metadata is trimmed first.
- Detailed bodies are omitted unless explicitly requested.

The estimate uses the current deterministic fallback of approximately four
UTF-8 bytes per token. Future model-specific tokenizers can replace this
adapter without changing the context API.

## Recommended session start

New clients should use:

1. `agent_register` or a previously assigned stable `agent_id`;
2. one `workspace_resume` call;
3. low-level tools only for details referenced by record or task id.

This replaces the legacy requirement to always call `project_list`,
`memory_list`, and `task_list` at session start.
