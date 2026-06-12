ALTER TABLE memory_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE memory_nodes ADD COLUMN importance INTEGER NOT NULL DEFAULT 50;
ALTER TABLE memory_nodes ADD COLUMN confidence INTEGER NOT NULL DEFAULT 50;
ALTER TABLE memory_nodes ADD COLUMN source_type TEXT;
ALTER TABLE memory_nodes ADD COLUMN source_ref TEXT;
ALTER TABLE memory_nodes ADD COLUMN valid_from TEXT;
ALTER TABLE memory_nodes ADD COLUMN valid_until TEXT;
ALTER TABLE memory_nodes ADD COLUMN supersedes_id TEXT REFERENCES memory_nodes(id);
ALTER TABLE memory_nodes ADD COLUMN last_verified_at TEXT;

CREATE TABLE IF NOT EXISTS memory_feedback (
    id              TEXT PRIMARY KEY,
    memory_id       TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    agent_id        TEXT REFERENCES agents(id),
    session_id      TEXT REFERENCES sessions(id),
    rating          TEXT NOT NULL,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_nodes(status);
CREATE INDEX IF NOT EXISTS idx_memory_valid_until ON memory_nodes(valid_until);
CREATE INDEX IF NOT EXISTS idx_memory_supersedes ON memory_nodes(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_agent ON memory_feedback(agent_id);
