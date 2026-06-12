import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { MemoryNode } from '../db/schema.js';
import { randomUUID } from 'crypto';

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    'memory_write',
    {
      description: 'Create or replace a named memory node for a project (or globally if no project_id). ' +
        'Use for decisions, feedback, facts, handoff notes.',
      inputSchema: z.object({
        project_id: z.string().optional().describe('Project id. Omit for global memory.'),
        name: z.string().describe('Short kebab-case slug, e.g. "auth-approach"'),
        description: z.string().describe('One-line summary of what this memory contains'),
        type: z.enum(['user', 'feedback', 'project', 'reference', 'handoff', 'decision'])
          .default('project'),
        body: z.string().describe('Full memory content in markdown'),
        tags: z.array(z.string()).optional().describe('Tags for search, e.g. ["auth", "security"]'),
        surface: z.string().default('claude-code').describe('Which Claude surface is writing this'),
        agent_id: z.string().optional().describe('Registered agent identity writing this record'),
        origin_session: z.string().optional(),
      }),
    },
    ({ project_id, name, description, type, body, tags, surface, agent_id, origin_session }) => {
      const db = getDb();
      const tagsJson = tags ? JSON.stringify(tags) : null;
      const now = new Date().toISOString();

      if (agent_id && !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent_id)) {
        return { content: [{ type: 'text', text: `Agent "${agent_id}" not found.` }], isError: true };
      }

      const existing = db.prepare(
        'SELECT id FROM memory_nodes WHERE name = ? AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))'
      ).get(name, project_id ?? null, project_id ?? null) as { id: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE memory_nodes SET
            description = ?, type = ?, body = ?, tags = ?,
            surface = ?, created_by_agent = COALESCE(?, created_by_agent),
            origin_session = ?, updated_at = ?
          WHERE id = ?
        `).run(
          description,
          type,
          body,
          tagsJson,
          surface,
          agent_id ?? null,
          origin_session ?? null,
          now,
          existing.id
        );
        const row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(existing.id);
        return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
      }

      const id = randomUUID();
      db.prepare(`
        INSERT INTO memory_nodes
          (
            id, project_id, surface, name, description, type, body, tags,
            origin_session, created_at, updated_at, created_by_agent
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        project_id ?? null,
        surface,
        name,
        description,
        type,
        body,
        tagsJson,
        origin_session ?? null,
        now,
        now,
        agent_id ?? null
      );

      const row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'memory_read',
    {
      description: 'Read a single memory node by id or by project+name.',
      inputSchema: z.object({
        id: z.string().optional().describe('Memory node UUID'),
        project_id: z.string().optional(),
        name: z.string().optional().describe('Memory node name slug'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ id, project_id, name }) => {
      const db = getDb();
      let row: MemoryNode | undefined;

      if (id) {
        row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id) as MemoryNode | undefined;
      } else if (name) {
        row = db.prepare(
          `SELECT * FROM memory_nodes
           WHERE name = ? AND (project_id = ? OR project_id IS NULL)
           ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END
           LIMIT 1`
        ).get(name, project_id ?? null, project_id ?? null) as MemoryNode | undefined;
      }

      if (!row) return { content: [{ type: 'text', text: 'Memory node not found.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'memory_list',
    {
      description: 'List all memory nodes for a project. Omit project_id for global memory. ' +
        'Returns name, description, type, surface, updated_at (not full body to save context).',
      inputSchema: z.object({
        project_id: z.string().optional().describe('Project id. Omit for global memory.'),
        type: z.enum(['user', 'feedback', 'project', 'reference', 'handoff', 'decision']).optional(),
        include_body: z.boolean().default(false).describe('Include full body in results (use sparingly)'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project_id, type, include_body }) => {
      const db = getDb();
      const cols = include_body
        ? '*'
        : 'id, project_id, surface, name, description, type, tags, updated_at';

      let sql = `SELECT ${cols} FROM memory_nodes WHERE 1=1`;
      const params: (string | null)[] = [];

      if (project_id !== undefined) {
        sql += ' AND project_id = ?';
        params.push(project_id);
      } else {
        sql += ' AND project_id IS NULL';
      }

      if (type) {
        sql += ' AND type = ?';
        params.push(type);
      }

      sql += ' ORDER BY updated_at DESC';
      const rows = db.prepare(sql).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Full-text search across all memory nodes. Use to find anything known about a topic.',
      inputSchema: z.object({
        query: z.string().describe('Search terms'),
        project_id: z.string().optional().describe('Limit to a specific project. Omit to search all.'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, project_id, limit }) => {
      const db = getDb();

      let sql = `
        SELECT m.id, m.project_id, m.surface, m.name, m.description, m.type, m.tags, m.updated_at,
               snippet(memory_fts, 2, '[', ']', '...', 20) AS snippet
        FROM memory_fts
        JOIN memory_nodes m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
      `;
      const params: (string | number)[] = [query];

      if (project_id) {
        sql += ' AND m.project_id = ?';
        params.push(project_id);
      }

      sql += ' ORDER BY rank LIMIT ?';
      params.push(limit);

      try {
        const rows = db.prepare(sql).all(...params);
        return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
      } catch {
        return {
          content: [{
            type: 'text',
            text: 'Invalid search query. Use words or quoted phrases without incomplete FTS operators.',
          }],
          isError: true,
        };
      }
    }
  );
}
