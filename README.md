# Waymark

**Shared memory and handoff hub for AI agents.** A waymark is a trail sign left
for whoever walks the path next — Waymark does the same for agent sessions:
Claude Code finishes work, and the next session of Codex, Claude Desktop, or any
other MCP client starts *already knowing* what was done, what was decided, and
what to do next.

No retelling. No re-reading the repo. One token-budgeted call.

## Why

Every new agent session starts cold: it re-reads files, re-asks questions, and
burns tokens rediscovering context that another agent had five minutes ago.
Waymark replaces that with a local MCP server over a single SQLite database
shared by all your agents:

- **`workspace_resume`** — one call returns a compact packet (project metadata,
  open tasks, ranked memory, recent sessions, active handoff) within a token
  budget you set (default 1,200 tokens).
- **Automatic handoffs** — `session_log(outcome: "partial", next_steps: [...])`
  writes a handoff memory that tops the next agent's resume. Logging
  `completed` retires it. No discipline required.
- **Task queue with atomic claims** — `task_claim` guarantees only one agent
  takes a task, with capability and dependency checks.
- **Memory lifecycle** — supersede instead of accumulate; feedback ratings
  demote stale records in ranking.
- **Provider-neutral** — agents register with provider/model/client identity;
  nothing in the core is tied to one vendor.

## Measured savings

Continuation scenario (fresh session must orient in a project and name the next
step), estimated cohort, reproducible via `node scripts/benchmark-orientation.cjs`:

| | median tokens |
|---|---|
| Cold orientation (reading README, docs, sources, git log) | **13,540** |
| Waymark resume (packet + core tool schemas + follow-up reads) | **3,392** |
| **Net saving** | **74.9%** |

The orientation context itself shrinks from ~13.1k tokens of raw files to a
1.1k-token ranked packet (**−91.5%**) — and unlike cold reading, the packet
contains what files can't: what the previous agent actually did and decided.
The exact-token A/B protocol with live clients is in
[docs/BENCHMARK_RUN.md](./docs/BENCHMARK_RUN.md).

## Quick start

Requires Node.js 22+.

```bash
git clone <this-repo> waymark && cd waymark
npm install
npm run build
npm test          # 19 integration tests
```

### Connect Claude Code (stdio)

```bash
claude mcp add --scope user waymark node "<path-to>/waymark/dist/server.js"
```

Optional but recommended — auto-inject the resume packet into every new session
via a `SessionStart` hook (zero tool calls spent on orientation), see
[scripts/hooks/session-start-resume.cjs](./scripts/hooks/session-start-resume.cjs).

### Connect Codex

```toml
# ~/.codex/config.toml
[mcp_servers.waymark]
command = "node"
args = ["<path-to>/waymark/dist/server.js"]
```

### Connect Claude Desktop / web (HTTP)

```bash
node dist/server.js --http   # listens on 127.0.0.1:3747
```

Add a custom connector: `http://localhost:3747/mcp`. Also available via
`docker compose up -d` / `podman compose up -d`.

## The protocol

**Session start — one call, not three:**

```
workspace_resume(project_id, task?, agent_id?, max_tokens=1200)
```

**Session end:**

```
session_log(started_at, summary, outcome, next_steps?)   # partial/blocked → auto-handoff
memory_write(...)                                        # only durable decisions/facts
```

**Cross-agent handoff** happens automatically: agent A logs a `partial` session
with `next_steps`; agent B's `workspace_resume` surfaces that handoff first,
with the session trail and files touched. When someone logs `completed`, the
handoff retires itself.

## Tool profiles

Greedy MCP clients inject every tool schema into context each turn. Waymark
defaults to a **core** profile of 10 tools (~1.8k tokens instead of ~4.7k for
all 28). Set `HUB_TOOLS=full` where you need the admin surface (projects,
agents, experiments, telemetry).

## Tools (28)

| Group | Tools |
|---|---|
| Context | `workspace_resume`, `context_get` |
| Memory | `memory_write/read/list/search/set_status/feedback` |
| Tasks | `task_create/list/update/claim/release/add_dependency` |
| Projects | `project_list/get/upsert/set_status` |
| Agents | `agent_register/get/list/set_status` |
| Sessions & telemetry | `session_log`, `usage_report`, `experiment_create/list/update/summary` |

Full signatures and the agent-facing manual: [AGENTS.md](./AGENTS.md).
Deep dives: [docs/CONTEXT.md](./docs/CONTEXT.md),
[docs/MEMORY_LIFECYCLE.md](./docs/MEMORY_LIFECYCLE.md),
[docs/TASK_COORDINATION.md](./docs/TASK_COORDINATION.md),
[docs/BENCHMARKING.md](./docs/BENCHMARKING.md).

## Dashboard

`npm run dashboard` → read-only web panel on `http://localhost:4747`: projects,
tasks, memory (FTS search), sessions, agents, benchmark results. Opens the DB
in read-only mode — it physically cannot mutate hub state.

## Architecture

```
src/server.ts            entry point: stdio / HTTP (--http), tool profiles
src/db/client.ts         SQLite singleton (WAL) + idempotent migrations 001..005
src/tools/               projects · memory · tasks · sessions · agents · context · telemetry
src/context/builder.ts   deterministic ranking + token budget (no LLM calls)
src/cli/benchmark.ts     A/B experiment CLI
dashboard/               read-only Express panel
```

Storage: SQLite + FTS5. The core never calls an LLM or any external service.

## Principles

- **Context on demand** — summaries + ids by default; bodies only when asked.
- **Budget first** — every aggregated response fits a token budget.
- **Evidence over retelling** — link files/commits/tasks instead of copying text.
- **Replace, don't accumulate** — supersede outdated memory, no duplicates.
- **Provider-agnostic** — any MCP client is a first-class citizen.

## License

MIT
