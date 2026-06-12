# Task Coordination

The task queue supports coordinated work by multiple registered agents.

## Claim protocol

1. Create tasks with `required_capabilities` and optional `dependency_ids`.
2. An agent calls `task_claim` with its registered `agent_id`.
3. The hub validates that the task is pending, dependencies are done, the
   assignment matches, and the agent has every required capability.
4. The claim changes the task to `in_progress` in an immediate SQLite
   transaction. A competing claim cannot take the same task.
5. Update `progress` and `blocker` with `task_update`.
6. Mark the task `done`, or return it to the queue with `task_release`.

## Tools

- `task_create`: accepts `required_capabilities` and `dependency_ids`.
- `task_add_dependency`: adds a prerequisite to an existing task.
- `task_claim`: atomically assigns available work to one agent.
- `task_update`: updates status, progress, blocker, notes, and context.
- `task_release`: releases work only when called by the claiming agent.
- `task_list`: filters by claiming agent and blocker state.

Task dependencies prevent premature work, and cyclic dependency graphs are
rejected. Capabilities describe functional requirements such as `code`,
`browser`, or `review`; they are not tied to a specific provider or model.
