CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    provider        TEXT,
    model           TEXT,
    client          TEXT,
    client_version  TEXT,
    capabilities    TEXT,
    metadata        TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id);
ALTER TABLE sessions ADD COLUMN provider TEXT;
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN client TEXT;
ALTER TABLE sessions ADD COLUMN client_session_id TEXT;

ALTER TABLE usage_reports ADD COLUMN agent_id TEXT REFERENCES agents(id);

ALTER TABLE memory_nodes ADD COLUMN created_by_agent TEXT REFERENCES agents(id);

ALTER TABLE tasks ADD COLUMN created_by_agent TEXT REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN assigned_agent_id TEXT REFERENCES agents(id);

CREATE INDEX IF NOT EXISTS idx_agents_provider ON agents(provider);
CREATE INDEX IF NOT EXISTS idx_agents_model ON agents(model);
CREATE INDEX IF NOT EXISTS idx_agents_client ON agents(client);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_client_session ON sessions(client_session_id);
CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_nodes(created_by_agent);
CREATE INDEX IF NOT EXISTS idx_tasks_created_agent ON tasks(created_by_agent);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_agent ON tasks(assigned_agent_id);
