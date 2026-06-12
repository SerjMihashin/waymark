# Memory lifecycle

Memory records are durable project knowledge, not an append-only transcript.
The lifecycle prevents obsolete records from polluting future agent context.

## Statuses

- `active`: eligible for normal search and context packets;
- `superseded`: replaced by a newer record;
- `stale`: known to require verification;
- `archived`: retained for audit but excluded from normal work.

Existing records migrate as `active`.

## Quality and provenance

`memory_write` supports:

- `importance`: 0–100;
- `confidence`: 0–100;
- `source_type`: file, commit, task, URL, user, or another source class;
- `source_ref`: path, SHA, URL, task id, or other source identifier;
- `valid_from` and `valid_until`;
- `last_verified_at`;
- `supersedes_id`.

Context ranking uses importance, confidence, recency, task relevance, memory
type, project scope, and feedback.

## Replacing a record

Create the new record with `supersedes_id` referencing the old record. The Hub
uses one SQLite transaction to:

1. write the new record;
2. mark the old record `superseded`.

This prevents both versions from appearing as active context.

## Feedback

Use `memory_feedback` after consuming a context packet:

- `used`;
- `not_used`;
- `helpful`;
- `irrelevant`;
- `stale`;
- `incorrect`;
- `too_verbose`.

Positive feedback increases ranking. Negative feedback reduces ranking.
Feedback does not automatically delete or rewrite memory.

Use `memory_set_status` when a record is known to be stale, archived, or active
again after verification.

## Read behavior

- `context_get` and `workspace_resume` include only active and currently valid
  records.
- `memory_search` excludes inactive and expired records by default.
- `memory_search(include_inactive=true)` supports audit and historical lookup.
- `memory_read(id=...)` can always retrieve a known record regardless of status.
- `memory_list` can filter by status and returns lifecycle metadata.
