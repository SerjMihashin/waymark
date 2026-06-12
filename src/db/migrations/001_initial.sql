CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    root_path   TEXT NOT NULL,
    stack       TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    description TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_nodes (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES projects(id),
    surface         TEXT NOT NULL DEFAULT 'claude-code',
    name            TEXT NOT NULL,
    description     TEXT,
    type            TEXT NOT NULL DEFAULT 'project',
    body            TEXT NOT NULL,
    tags            TEXT,
    origin_session  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
    id            TEXT PRIMARY KEY,
    project_id    TEXT REFERENCES projects(id),
    title         TEXT NOT NULL,
    description   TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',
    priority      INTEGER NOT NULL DEFAULT 50,
    created_by    TEXT NOT NULL,
    assigned_to   TEXT,
    context_json  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id            TEXT PRIMARY KEY,
    project_id    TEXT REFERENCES projects(id),
    surface       TEXT NOT NULL,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    summary       TEXT,
    files_touched TEXT,
    commits_made  TEXT,
    outcome       TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_project ON memory_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_type    ON memory_nodes(type);
CREATE INDEX IF NOT EXISTS idx_memory_name    ON memory_nodes(name);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_project  ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_sessions_proj  ON sessions(project_id);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    name,
    description,
    body,
    tags,
    content='memory_nodes',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memory_nodes BEGIN
    INSERT INTO memory_fts(rowid, name, description, body, tags)
    VALUES (new.rowid, new.name, new.description, new.body, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memory_nodes BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, name, description, body, tags)
    VALUES ('delete', old.rowid, old.name, old.description, old.body, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE ON memory_nodes BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, name, description, body, tags)
    VALUES ('delete', old.rowid, old.name, old.description, old.body, old.tags);
    INSERT INTO memory_fts(rowid, name, description, body, tags)
    VALUES (new.rowid, new.name, new.description, new.body, new.tags);
END;
