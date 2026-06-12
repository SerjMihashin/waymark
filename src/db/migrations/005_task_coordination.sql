ALTER TABLE tasks ADD COLUMN required_capabilities TEXT;
ALTER TABLE tasks ADD COLUMN claimed_by_agent TEXT REFERENCES agents(id);
ALTER TABLE tasks ADD COLUMN claimed_at TEXT;
ALTER TABLE tasks ADD COLUMN blocker TEXT;
ALTER TABLE tasks ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on_task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (task_id, depends_on_task_id),
    CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_claimed_agent ON tasks(claimed_by_agent);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_task_dependencies_dependency ON task_dependencies(depends_on_task_id);
