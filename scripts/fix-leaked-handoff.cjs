// One-off repair: a vision-bot trading session was logged without project_id,
// creating a global auto-handoff that leaked into every project's resume.
// Reattach both the session and the handoff to the trading project.
const path = require('path');
const db = require('better-sqlite3')(path.join(__dirname, '..', 'data', 'hub.db'));

const PROJECT = 'D--Projects-ai-trader';
const SESSION = '1b38fa21-7488-4a02-882c-ea2512686a55';
const HANDOFF = 'aa9fb3c4-3e62-4863-bad5-63b3b24d7cef';

db.prepare("UPDATE sessions SET project_id = ? WHERE id = ? AND project_id IS NULL").run(PROJECT, SESSION);
db.prepare(`
  UPDATE memory_nodes SET project_id = ?, name = ?, updated_at = datetime('now')
  WHERE id = ? AND project_id IS NULL
`).run(PROJECT, `auto-handoff:${PROJECT}`, HANDOFF);

console.log(JSON.stringify(db.prepare(
  "SELECT id, name, project_id, status FROM memory_nodes WHERE type='handoff'"
).all(), null, 1));
