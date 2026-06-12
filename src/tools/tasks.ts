import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Task } from '../db/schema.js';
import { randomUUID } from 'crypto';

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'task_create',
    {
      description: 'Create a handoff task to be picked up by another Claude surface. ' +
        'Use when you cannot complete work yourself and need another instance to continue.',
      inputSchema: z.object({
        title: z.string().describe('Short imperative title, e.g. "Scrape competitor pricing"'),
        description: z.string().describe('Full context: what to do and why'),
        project_id: z.string().optional(),
        created_by: z.string().default('claude-code')
          .describe('Your surface: "claude-code" | "claude-desktop" | "browser-agent" | "claude-web"'),
        assigned_to: z.string().optional()
          .describe('Target surface. Omit for any. Options: claude-code, claude-desktop, browser-agent, claude-web'),
        priority: z.number().int().min(0).max(100).default(50)
          .describe('0-100, higher is more urgent'),
        context_json: z.record(z.string(), z.unknown()).optional()
          .describe('Structured handoff data: file paths, URLs, selectors, etc.'),
      }),
    },
    ({ title, description, project_id, created_by, assigned_to, priority, context_json }) => {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO tasks
          (id, project_id, title, description, status, priority, created_by, assigned_to, context_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        id, project_id ?? null, title, description, priority,
        created_by, assigned_to ?? null,
        context_json ? JSON.stringify(context_json) : null,
        now, now
      );

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'task_list',
    {
      description: 'List tasks filtered by status, project, or assigned surface. ' +
        'Call at session start with assigned_to=<your surface> and status=pending to find pending handoffs.',
      inputSchema: z.object({
        status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
        project_id: z.string().optional(),
        assigned_to: z.string().optional().describe('Filter by target surface'),
        created_by: z.string().optional().describe('Filter by originating surface'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ status, project_id, assigned_to, created_by, limit }) => {
      const db = getDb();
      let sql = 'SELECT * FROM tasks WHERE 1=1';
      const params: (string | number)[] = [];

      if (status)      { sql += ' AND status = ?';      params.push(status); }
      if (project_id)  { sql += ' AND project_id = ?';  params.push(project_id); }
      if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
      if (created_by)  { sql += ' AND created_by = ?';  params.push(created_by); }

      sql += ' ORDER BY priority DESC, created_at ASC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params);
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'task_update',
    {
      description: 'Update task status or add completion notes. ' +
        'Set status to in_progress when starting, done when finished.',
      inputSchema: z.object({
        id: z.string().describe('Task UUID'),
        status: z.enum(['pending', 'in_progress', 'done', 'cancelled']).optional(),
        description: z.string().optional().describe('Append notes or update description'),
        context_json: z.record(z.string(), z.unknown()).optional().describe('Update handoff context'),
      }),
    },
    ({ id, status, description, context_json }) => {
      const db = getDb();
      const existing = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
      if (!existing) {
        return { content: [{ type: 'text', text: `Task "${id}" not found.` }], isError: true };
      }

      const now = new Date().toISOString();
      const completedAt = status === 'done' || status === 'cancelled'
        ? now
        : status === 'pending' || status === 'in_progress'
          ? null
          : existing.completed_at;
      const newContext = context_json
        ? JSON.stringify(context_json)
        : existing.context_json;

      db.prepare(`
        UPDATE tasks SET
          status = COALESCE(?, status),
          description = COALESCE(?, description),
          context_json = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ?
      `).run(status ?? null, description ?? null, newContext, completedAt, now, id);

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );
}
