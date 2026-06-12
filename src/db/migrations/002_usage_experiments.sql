CREATE TABLE IF NOT EXISTS experiments (
    id              TEXT PRIMARY KEY,
    project_id      TEXT REFERENCES projects(id),
    name            TEXT NOT NULL,
    description     TEXT,
    scenario        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
    target_runs     INTEGER NOT NULL DEFAULT 5,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS usage_reports (
    id                      TEXT PRIMARY KEY,
    project_id              TEXT REFERENCES projects(id),
    session_id              TEXT REFERENCES sessions(id),
    experiment_id           TEXT REFERENCES experiments(id),
    variant                 TEXT,
    provider                TEXT,
    model                   TEXT,
    client                  TEXT,
    measurement             TEXT NOT NULL DEFAULT 'estimated',
    input_tokens            INTEGER,
    output_tokens           INTEGER,
    cached_input_tokens     INTEGER,
    hub_llm_input_tokens    INTEGER NOT NULL DEFAULT 0,
    hub_llm_output_tokens   INTEGER NOT NULL DEFAULT 0,
    context_tokens          INTEGER,
    context_chars           INTEGER,
    tool_calls              INTEGER,
    files_read              TEXT,
    repeated_files          INTEGER,
    clarification_count     INTEGER,
    duration_ms             INTEGER,
    result_quality          REAL,
    success                 INTEGER,
    notes                   TEXT,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_experiments_project
    ON experiments(project_id);
CREATE INDEX IF NOT EXISTS idx_experiments_status
    ON experiments(status);
CREATE INDEX IF NOT EXISTS idx_usage_project
    ON usage_reports(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_session
    ON usage_reports(session_id);
CREATE INDEX IF NOT EXISTS idx_usage_experiment
    ON usage_reports(experiment_id);
CREATE INDEX IF NOT EXISTS idx_usage_variant
    ON usage_reports(variant);
