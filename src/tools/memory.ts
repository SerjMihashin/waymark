import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { MemoryNode } from '../db/schema.js';
import { randomUUID } from 'crypto';

const memoryStatus = z.enum(['active', 'superseded', 'stale', 'archived']);
const feedbackRating = z.enum([
  'used',
  'not_used',
  'helpful',
  'irrelevant',
  'stale',
  'incorrect',
  'too_verbose',
]);

export function registerMemoryTools(server: McpServer): void {
  server.registerTool(
    'memory_write',
    {
      description: 'Create or replace a named memory node (project-scoped, or global if no project_id).',
      inputSchema: z.object({
        project_id: z.string().optional().describe('omit for global'),
        name: z.string().describe('kebab-case slug'),
        description: z.string().describe('one-line summary'),
        type: z.enum(['user', 'feedback', 'project', 'reference', 'handoff', 'decision'])
          .default('project'),
        body: z.string().describe('markdown body'),
        tags: z.array(z.string()).optional(),
        surface: z.string().default('claude-code'),
        agent_id: z.string().optional(),
        origin_session: z.string().optional(),
        status: memoryStatus.optional(),
        importance: z.number().int().min(0).max(100).optional(),
        confidence: z.number().int().min(0).max(100).optional(),
        source_type: z.string().optional(),
        source_ref: z.string().optional(),
        valid_from: z.string().optional(),
        valid_until: z.string().optional(),
        supersedes_id: z.string().optional().describe('id this record replaces'),
        last_verified_at: z.string().optional(),
      }),
    },
    ({
      project_id,
      name,
      description,
      type,
      body,
      tags,
      surface,
      agent_id,
      origin_session,
      status,
      importance,
      confidence,
      source_type,
      source_ref,
      valid_from,
      valid_until,
      supersedes_id,
      last_verified_at,
    }) => {
      const db = getDb();
      const tagsJson = tags ? JSON.stringify(tags) : null;
      const now = new Date().toISOString();

      if (agent_id && !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent_id)) {
        return { content: [{ type: 'text', text: `Agent "${agent_id}" not found.` }], isError: true };
      }
      if (supersedes_id && !db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(supersedes_id)) {
        return {
          content: [{ type: 'text', text: `Memory node "${supersedes_id}" not found.` }],
          isError: true,
        };
      }

      const existing = db.prepare(
        'SELECT id FROM memory_nodes WHERE name = ? AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))'
      ).get(name, project_id ?? null, project_id ?? null) as { id: string } | undefined;

      if (existing) {
        if (supersedes_id === existing.id) {
          return { content: [{ type: 'text', text: 'A memory cannot supersede itself.' }], isError: true };
        }
        db.transaction(() => {
          db.prepare(`
            UPDATE memory_nodes SET
              description = ?, type = ?, body = ?, tags = ?,
              surface = ?, created_by_agent = COALESCE(?, created_by_agent),
              origin_session = ?, status = COALESCE(?, status),
              importance = COALESCE(?, importance),
              confidence = COALESCE(?, confidence),
              source_type = COALESCE(?, source_type),
              source_ref = COALESCE(?, source_ref),
              valid_from = COALESCE(?, valid_from),
              valid_until = COALESCE(?, valid_until),
              supersedes_id = COALESCE(?, supersedes_id),
              last_verified_at = COALESCE(?, last_verified_at),
              updated_at = ?
            WHERE id = ?
          `).run(
            description,
            type,
            body,
            tagsJson,
            surface,
            agent_id ?? null,
            origin_session ?? null,
            status ?? null,
            importance ?? null,
            confidence ?? null,
            source_type ?? null,
            source_ref ?? null,
            valid_from ?? null,
            valid_until ?? null,
            supersedes_id ?? null,
            last_verified_at ?? null,
            now,
            existing.id
          );
          if (supersedes_id) {
            db.prepare(
              "UPDATE memory_nodes SET status = 'superseded', updated_at = ? WHERE id = ?"
            ).run(now, supersedes_id);
          }
        })();
        const row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(existing.id);
        return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
      }

      const id = randomUUID();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO memory_nodes
            (
              id, project_id, surface, name, description, type, body, tags,
              origin_session, created_at, updated_at, created_by_agent,
              status, importance, confidence, source_type, source_ref,
              valid_from, valid_until, supersedes_id, last_verified_at
            )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          agent_id ?? null,
          status ?? 'active',
          importance ?? 50,
          confidence ?? 50,
          source_type ?? null,
          source_ref ?? null,
          valid_from ?? null,
          valid_until ?? null,
          supersedes_id ?? null,
          last_verified_at ?? null
        );
        if (supersedes_id) {
          db.prepare(
            "UPDATE memory_nodes SET status = 'superseded', updated_at = ? WHERE id = ?"
          ).run(now, supersedes_id);
        }
      })();

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
        status: memoryStatus.optional(),
        include_body: z.boolean().default(false).describe('Include full body in results (use sparingly)'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project_id, type, status, include_body }) => {
      const db = getDb();
      const cols = include_body
        ? '*'
        : `id, project_id, surface, name, description, type, tags,
           status, importance, confidence, source_type, source_ref,
           valid_from, valid_until, supersedes_id, last_verified_at,
           created_by_agent, updated_at`;

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
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
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
        include_inactive: z.boolean().default(false)
          .describe('Include stale, superseded, archived, and expired records'),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ query, project_id, include_inactive, limit }) => {
      const db = getDb();

      let sql = `
        SELECT m.id, m.project_id, m.surface, m.name, m.description, m.type, m.tags,
               m.status, m.importance, m.confidence, m.source_type, m.source_ref,
               m.updated_at,
               snippet(memory_fts, 2, '[', ']', '...', 20) AS snippet
        FROM memory_fts
        JOIN memory_nodes m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ?
      `;
      const params: (string | number)[] = [query];

      if (!include_inactive) {
        sql += `
          AND m.status = 'active'
          AND (m.valid_from IS NULL OR m.valid_from <= ?)
          AND (m.valid_until IS NULL OR m.valid_until >= ?)
        `;
        const now = new Date().toISOString();
        params.push(now, now);
      }
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
            text: `FTS5 could not parse the query ${JSON.stringify(query)}. ` +
              'Use plain words ("auth token"), quoted phrases ("\\"session log\\""), or prefix search ("bench*"). ' +
              'Characters like -, :, ( ) are FTS operators — wrap terms containing them in double quotes.',
          }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'memory_set_status',
    {
      description: 'Mark a memory record active, superseded, stale, or archived.',
      inputSchema: z.object({
        id: z.string(),
        status: memoryStatus,
        last_verified_at: z.string().optional(),
      }),
    },
    ({ id, status, last_verified_at }) => {
      const db = getDb();
      const result = db.prepare(`
        UPDATE memory_nodes SET
          status = ?,
          last_verified_at = COALESCE(?, last_verified_at),
          updated_at = ?
        WHERE id = ?
      `).run(status, last_verified_at ?? null, new Date().toISOString(), id);

      if (result.changes === 0) {
        return { content: [{ type: 'text', text: `Memory node "${id}" not found.` }], isError: true };
      }
      const row = db.prepare('SELECT * FROM memory_nodes WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'memory_feedback',
    {
      description: 'Record whether a memory was useful, irrelevant, stale, incorrect, or too verbose.',
      inputSchema: z.object({
        memory_id: z.string(),
        agent_id: z.string().optional(),
        session_id: z.string().optional(),
        rating: feedbackRating,
        notes: z.string().optional(),
      }),
    },
    ({ memory_id, agent_id, session_id, rating, notes }) => {
      const db = getDb();
      if (!db.prepare('SELECT 1 FROM memory_nodes WHERE id = ?').get(memory_id)) {
        return {
          content: [{ type: 'text', text: `Memory node "${memory_id}" not found.` }],
          isError: true,
        };
      }
      if (agent_id && !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agent_id)) {
        return { content: [{ type: 'text', text: `Agent "${agent_id}" not found.` }], isError: true };
      }
      if (session_id && !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session_id)) {
        return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }], isError: true };
      }

      const id = randomUUID();
      db.prepare(`
        INSERT INTO memory_feedback
          (id, memory_id, agent_id, session_id, rating, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        memory_id,
        agent_id ?? null,
        session_id ?? null,
        rating,
        notes ?? null,
        new Date().toISOString()
      );

      const row = db.prepare('SELECT * FROM memory_feedback WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );
}
