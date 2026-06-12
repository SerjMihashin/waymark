# Agent identity

ClaudePlus supports provider-neutral agent identities while retaining legacy
surface fields for existing clients.

## Identity fields

- `agent_id`: stable logical agent identity;
- `provider`: model provider, such as OpenAI, Anthropic, Google, or local;
- `model`: provider model identifier;
- `client`: application or integration, such as Codex CLI or a browser agent;
- `client_version`: optional client version;
- `capabilities`: declared abilities such as `code`, `browser`, or `documents`;
- `client_session_id`: session identifier supplied by the client.

Provider, model, client, agent, and session are separate concepts. Changing a
model or client does not require changing project data.

## Registering an agent

Use `agent_register` with a stable caller-controlled id when possible:

```json
{
  "id": "codex-primary",
  "display_name": "Primary coding agent",
  "provider": "openai",
  "model": "<model-id>",
  "client": "codex",
  "capabilities": ["code", "shell", "review"]
}
```

When no id is supplied, the Hub generates a UUID.

Available tools:

- `agent_register`;
- `agent_get`;
- `agent_list`;
- `agent_set_status`.

## Linking work

The following tools accept registered agent identities:

- `session_log.agent_id`;
- `usage_report.agent_id`;
- `memory_write.agent_id`;
- `task_create.created_by_agent`;
- `task_create.assigned_agent_id`;
- `task_list.created_by_agent`;
- `task_list.assigned_agent_id`.

When `usage_report` references a linked session, it inherits the session agent,
project, provider, model, and client. Conflicting explicit values are rejected.

## Backward compatibility

Legacy fields remain supported:

- `surface`;
- `created_by`;
- `assigned_to`.

New clients should send agent identity fields. Existing clients can continue
using legacy fields until the v2 migration is complete.
