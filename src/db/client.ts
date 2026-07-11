import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import os from 'os';

// DB location, in priority order:
//   1. DB_PATH        — explicit override (tests, benchmarks, custom deployments)
//   2. WAYMARK_HOME   — explicit data home; DB lives at $WAYMARK_HOME/hub.db
//   3. <install>/data/hub.db — but only when it ALREADY exists (git-clone installs
//      that have been running; anchored via __dirname, never process.cwd(), since
//      clients spawn the hub from arbitrary project directories)
//   4. ~/.waymark/hub.db — default for fresh installs. npm upgrades replace the
//      package directory, so the DB must not live inside it.
export function resolveDbPath(): string {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  if (process.env.WAYMARK_HOME) return path.join(process.env.WAYMARK_HOME, 'hub.db');
  const installDbPath = path.resolve(__dirname, '..', '..', 'data', 'hub.db');
  if (fs.existsSync(installDbPath)) return installDbPath;
  return path.join(os.homedir(), '.waymark', 'hub.db');
}

const DB_PATH = resolveDbPath();

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');

  runMigrations(_db);
  return _db;
}

export function closeDb(): void {
  if (!_db) return;
  _db.close();
  _db = null;
}

function runMigrations(db: Database.Database): void {
  const migrationDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationDir).filter(f => f.endsWith('.sql')).sort();

  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  for (const file of files) {
    const already = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (already) continue;

    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}
