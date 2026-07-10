// One-off repair: projects imported before the slug-resolution fix stored the
// slug itself as root_path. Resolve each slug against the filesystem and update.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'hub.db'));

function slugifySegment(name) {
  return name.replace(/[^A-Za-z0-9]/g, '-');
}

function resolveSlugToPath(slug) {
  const driveMatch = slug.match(/^([A-Za-z])--(.+)$/);
  if (!driveMatch) return null;
  let current = `${driveMatch[1]}:\\`;
  let rest = driveMatch[2];
  while (rest.length > 0) {
    if (!fs.existsSync(current)) return null;
    const children = fs.readdirSync(current, { withFileTypes: true }).filter((d) => d.isDirectory());
    let matched = null;
    let matchedLen = -1;
    for (const child of children) {
      const s = slugifySegment(child.name);
      if ((rest === s || rest.startsWith(`${s}-`)) && s.length > matchedLen) {
        matched = child.name;
        matchedLen = s.length;
      }
    }
    if (!matched) return null;
    current = path.join(current, matched);
    rest = rest.slice(matchedLen + 1);
  }
  return current;
}

const rows = db.prepare('SELECT id, name, root_path FROM projects').all();
const upd = db.prepare("UPDATE projects SET root_path = ?, name = ?, updated_at = datetime('now') WHERE id = ?");
for (const row of rows) {
  if (row.root_path !== row.id) continue; // already a real path
  const resolved = resolveSlugToPath(row.id);
  if (!resolved) {
    console.log(`UNRESOLVED: ${row.id} (left as is)`);
    continue;
  }
  upd.run(resolved, path.basename(resolved), row.id);
  console.log(`FIXED: ${row.id} -> ${resolved}`);
}
console.log(JSON.stringify(db.prepare('SELECT id, name, root_path FROM projects').all(), null, 1));
