import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDb } from '../src/db/client.js';

const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content.trim() };

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) meta[key.trim()] = rest.join(':').trim();
  }
  return { meta, body: match[2].trim() };
}

function projectSlugToId(slug: string): string {
  return slug;
}

function importProject(projectSlug: string): void {
  const db = getDb();
  const memDir = path.join(CLAUDE_PROJECTS_DIR, projectSlug, 'memory');

  if (!fs.existsSync(memDir)) return;

  const projectId = projectSlugToId(projectSlug);
  const rootPath = projectSlug.replace(/--/g, '\\').replace(/-(?=[A-Z])/g, ' ').replace(/ /g, '-');

  const existingProject = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!existingProject) {
    db.prepare(`
      INSERT INTO projects (id, name, root_path, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))
    `).run(projectId, projectSlug.split('-').pop() || projectSlug, projectSlug);
  }

  const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
  let imported = 0;

  for (const file of files) {
    const content = fs.readFileSync(path.join(memDir, file), 'utf8');
    const { meta, body } = parseFrontmatter(content);

    const name = meta['name'] || path.basename(file, '.md');
    const description = meta['description'] || '';
    const type = (meta['type'] as MemoryNode['type']) || 'project';

    const existing = db.prepare(
      'SELECT id FROM memory_nodes WHERE name = ? AND project_id = ?'
    ).get(name, projectId);

    if (existing) continue;

    const id = randomUUID();
    db.prepare(`
      INSERT INTO memory_nodes
        (id, project_id, surface, name, description, type, body, created_at, updated_at)
      VALUES (?, ?, 'claude-code', ?, ?, ?, ?, datetime('now'), datetime('now'))
    `).run(id, projectId, name, description, type, body);

    imported++;
  }

  if (imported > 0) console.log(`  ${projectSlug}: imported ${imported} memory nodes`);
}

type MemoryNode = { type: 'user' | 'feedback' | 'project' | 'reference' | 'handoff' | 'decision' };

async function main(): Promise<void> {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    console.error(`Claude projects dir not found: ${CLAUDE_PROJECTS_DIR}`);
    process.exit(1);
  }

  const projects = fs.readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  console.log(`Found ${projects.length} project directories. Importing memory...`);
  for (const slug of projects) importProject(slug);
  console.log('Import complete.');
}

main();
