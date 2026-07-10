import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Project } from '../db/schema.js';
import { randomUUID } from 'crypto';

export function registerProjectTools(server: McpServer): void {
  server.registerTool(
    'project_list',
    {
      description: 'List all known projects with their status, stack, and last update time.',
      inputSchema: z.object({
        status: z.enum(['active', 'paused', 'archived']).optional()
          .describe('Filter by status. Omit to get all projects.'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ status }) => {
      const db = getDb();
      const rows: Project[] = status
        ? db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status) as Project[]
        : db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Project[];

      return {
        content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }],
      };
    }
  );

  server.registerTool(
    'project_get',
    {
      description: 'Get full details for a single project by its id or name.',
      inputSchema: z.object({
        id: z.string().optional().describe('Project id (directory slug), e.g. "D--Projects-MyApp"'),
        name: z.string().optional().describe('Human name, e.g. "MyApp". Case-insensitive partial match.'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ id, name }) => {
      const db = getDb();
      let row: Project | undefined;

      if (id) {
        row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
      } else if (name) {
        row = db.prepare("SELECT * FROM projects WHERE lower(name) LIKE lower('%' || ? || '%') LIMIT 1")
          .get(name) as Project | undefined;
      }

      if (!row) {
        return { content: [{ type: 'text', text: 'Project not found.' }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'project_upsert',
    {
      description: 'Create or update a project record. Use to register a new project or update stack/description.',
      inputSchema: z.object({
        id: z.string().describe('Directory slug id, e.g. "D--Projects-MyApp"'),
        name: z.string().describe('Human-readable project name'),
        root_path: z.string().describe('Absolute path on disk, e.g. "D:\\\\Projects\\\\MyApp"'),
        stack: z.string().optional().describe('Tech stack description, e.g. "Laravel 12 + Nuxt 4 + MySQL"'),
        description: z.string().optional().describe('Short project description'),
        status: z.enum(['active', 'paused', 'archived']).optional(),
      }),
    },
    ({ id, name, root_path, stack, description, status }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const existing = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);

      if (existing) {
        db.prepare(`
          UPDATE projects SET
            name = ?, root_path = ?, stack = COALESCE(?, stack),
            description = COALESCE(?, description), status = COALESCE(?, status),
            updated_at = ?
          WHERE id = ?
        `).run(name, root_path, stack ?? null, description ?? null, status ?? null, now, id);
      } else {
        db.prepare(`
          INSERT INTO projects (id, name, root_path, stack, description, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, name, root_path, stack ?? null, description ?? null, status ?? 'active', now, now);
      }

      const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'project_set_status',
    {
      description: 'Quickly change project status to active, paused, or archived.',
      inputSchema: z.object({
        id: z.string().describe('Project id'),
        status: z.enum(['active', 'paused', 'archived']),
      }),
    },
    ({ id, status }) => {
      const db = getDb();
      const result = db.prepare(
        "UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, id);

      if (result.changes === 0) {
        return { content: [{ type: 'text', text: `Project "${id}" not found.` }], isError: true };
      }
      return { content: [{ type: 'text', text: `Project "${id}" status set to "${status}".` }] };
    }
  );
}
