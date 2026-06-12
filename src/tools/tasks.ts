import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Task } from '../db/schema.js';
import { randomUUID } from 'crypto';

export function registerTaskTools(server: McpServer): void {
  server.registerTool(
    'task_create',
    {
      description: 'Create a handoff task to be picked up by another agent or client.',
      inputSchema: z.object({
        title: z.string().describe('Short imperative title, e.g. "Scrape competitor pricing"'),
        description: z.string().describe('Full context: what to do and why'),
        project_id: z.string().optional(),
        created_by: z.string().default('claude-code')
          .describe('Legacy originating surface/client identifier'),
        created_by_agent: z.string().optional().describe('Registered agent creating the task'),
        assigned_to: z.string().optional()
          .describe('Legacy target surface/client identifier'),
        assigned_agent_id: z.string().optional().describe('Specific registered agent assigned to the task'),
        required_capabilities: z.array(z.string()).default([])
          .describe('Capabilities required from the claiming agent'),
        dependency_ids: z.array(z.string()).default([])
          .describe('Tasks that must be done before this task can be claimed'),
        priority: z.number().int().min(0).max(100).default(50)
          .describe('0-100, higher is more urgent'),
        context_json: z.record(z.string(), z.unknown()).optional()
          .describe('Structured handoff data: file paths, URLs, selectors, etc.'),
      }),
    },
    ({
      title,
      description,
      project_id,
      created_by,
      created_by_agent,
      assigned_to,
      assigned_agent_id,
      required_capabilities,
      dependency_ids,
      priority,
      context_json,
    }) => {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      const uniqueCapabilities = [...new Set(required_capabilities)];
      const uniqueDependencyIds = [...new Set(dependency_ids)];

      for (const agentId of [created_by_agent, assigned_agent_id]) {
        if (agentId && !db.prepare('SELECT 1 FROM agents WHERE id = ?').get(agentId)) {
          return { content: [{ type: 'text', text: `Agent "${agentId}" not found.` }], isError: true };
        }
      }
      for (const dependencyId of uniqueDependencyIds) {
        if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(dependencyId)) {
          return {
            content: [{ type: 'text', text: `Dependency task "${dependencyId}" not found.` }],
            isError: true,
          };
        }
      }

      db.transaction(() => {
        db.prepare(`
          INSERT INTO tasks
            (
              id, project_id, title, description, status, priority,
              created_by, assigned_to, context_json, created_at, updated_at,
              created_by_agent, assigned_agent_id, required_capabilities
            )
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, project_id ?? null, title, description, priority,
          created_by, assigned_to ?? null,
          context_json ? JSON.stringify(context_json) : null,
          now, now, created_by_agent ?? null, assigned_agent_id ?? null,
          JSON.stringify(uniqueCapabilities)
        );
        const insertDependency = db.prepare(`
          INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
          VALUES (?, ?, ?)
        `);
        for (const dependencyId of uniqueDependencyIds) {
          insertDependency.run(id, dependencyId, now);
        }
      })();

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
        assigned_agent_id: z.string().optional().describe('Filter by registered target agent'),
        created_by: z.string().optional().describe('Filter by originating surface'),
        created_by_agent: z.string().optional().describe('Filter by registered creator agent'),
        claimed_by_agent: z.string().optional().describe('Filter by agent that claimed the task'),
        blocked: z.boolean().optional().describe('Filter tasks by presence of a blocker'),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    ({
      status,
      project_id,
      assigned_to,
      assigned_agent_id,
      created_by,
      created_by_agent,
      claimed_by_agent,
      blocked,
      limit,
    }) => {
      const db = getDb();
      let sql = 'SELECT * FROM tasks WHERE 1=1';
      const params: (string | number)[] = [];

      if (status)      { sql += ' AND status = ?';      params.push(status); }
      if (project_id)  { sql += ' AND project_id = ?';  params.push(project_id); }
      if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to); }
      if (assigned_agent_id) {
        sql += ' AND assigned_agent_id = ?';
        params.push(assigned_agent_id);
      }
      if (created_by)  { sql += ' AND created_by = ?';  params.push(created_by); }
      if (created_by_agent) {
        sql += ' AND created_by_agent = ?';
        params.push(created_by_agent);
      }
      if (claimed_by_agent) {
        sql += ' AND claimed_by_agent = ?';
        params.push(claimed_by_agent);
      }
      if (blocked === true) sql += ' AND blocker IS NOT NULL';
      if (blocked === false) sql += ' AND blocker IS NULL';

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
        blocker: z.string().nullable().optional().describe('Current blocker; null clears it'),
        progress: z.number().int().min(0).max(100).optional(),
      }),
    },
    ({ id, status, description, context_json, blocker, progress }) => {
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
      const nextProgress = status === 'done' ? 100 : progress ?? existing.progress;
      const nextBlocker = blocker === undefined
        ? status === 'done' ? null : existing.blocker
        : blocker;

      db.prepare(`
        UPDATE tasks SET
          status = COALESCE(?, status),
          description = COALESCE(?, description),
          context_json = ?,
          completed_at = ?,
          blocker = ?,
          progress = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        status ?? null,
        description ?? null,
        newContext,
        completedAt,
        nextBlocker,
        nextProgress,
        now,
        id
      );

      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );

  server.registerTool(
    'task_add_dependency',
    {
      description: 'Require one task to be completed before another can be claimed.',
      inputSchema: z.object({
        id: z.string().describe('Blocked task id'),
        depends_on_id: z.string().describe('Dependency task id'),
      }),
    },
    ({ id, depends_on_id }) => {
      const db = getDb();
      if (id === depends_on_id) {
        return { content: [{ type: 'text', text: 'A task cannot depend on itself.' }], isError: true };
      }
      for (const taskId of [id, depends_on_id]) {
        if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) {
          return { content: [{ type: 'text', text: `Task "${taskId}" not found.` }], isError: true };
        }
      }
      const createsCycle = db.prepare(`
        WITH RECURSIVE dependency_chain(task_id) AS (
          SELECT depends_on_task_id
          FROM task_dependencies
          WHERE task_id = ?
          UNION
          SELECT d.depends_on_task_id
          FROM task_dependencies d
          JOIN dependency_chain c ON d.task_id = c.task_id
        )
        SELECT 1 FROM dependency_chain WHERE task_id = ? LIMIT 1
      `).get(depends_on_id, id);
      if (createsCycle) {
        return {
          content: [{ type: 'text', text: 'This dependency would create a cycle.' }],
          isError: true,
        };
      }
      db.prepare(`
        INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id, created_at)
        VALUES (?, ?, ?)
      `).run(id, depends_on_id, new Date().toISOString());

      return {
        content: [{
          type: 'text',
          text: `Task "${id}" now depends on "${depends_on_id}".`,
        }],
      };
    }
  );

  server.registerTool(
    'task_claim',
    {
      description: 'Atomically claim a pending task after validating assignment, capabilities, and dependencies.',
      inputSchema: z.object({
        id: z.string(),
        agent_id: z.string(),
      }),
    },
    ({ id, agent_id }) => {
      const db = getDb();
      const claim = db.transaction(() => {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task | undefined;
        if (!task) return { error: `Task "${id}" not found.` };
        if (task.status !== 'pending' || task.claimed_by_agent) {
          return { error: `Task "${id}" is not available for claim.` };
        }

        const agent = db.prepare(
          'SELECT capabilities, status FROM agents WHERE id = ?'
        ).get(agent_id) as { capabilities: string | null; status: string } | undefined;
        if (!agent) return { error: `Agent "${agent_id}" not found.` };
        if (agent.status !== 'active') return { error: `Agent "${agent_id}" is not active.` };
        if (task.assigned_agent_id && task.assigned_agent_id !== agent_id) {
          return { error: `Task "${id}" is assigned to another agent.` };
        }

        const required = task.required_capabilities
          ? JSON.parse(task.required_capabilities) as string[]
          : [];
        const capabilities = agent.capabilities
          ? JSON.parse(agent.capabilities) as string[]
          : [];
        const missing = required.filter(capability => !capabilities.includes(capability));
        if (missing.length > 0) {
          return { error: `Agent is missing required capabilities: ${missing.join(', ')}.` };
        }

        const incomplete = db.prepare(`
          SELECT d.depends_on_task_id, t.status
          FROM task_dependencies d
          JOIN tasks t ON t.id = d.depends_on_task_id
          WHERE d.task_id = ? AND t.status <> 'done'
        `).all(id) as Array<{ depends_on_task_id: string; status: string }>;
        if (incomplete.length > 0) {
          return {
            error: `Task has incomplete dependencies: ${
              incomplete.map(item => item.depends_on_task_id).join(', ')
            }.`,
          };
        }

        const now = new Date().toISOString();
        const result = db.prepare(`
          UPDATE tasks SET
            status = 'in_progress',
            claimed_by_agent = ?,
            claimed_at = ?,
            updated_at = ?
          WHERE id = ? AND status = 'pending' AND claimed_by_agent IS NULL
        `).run(agent_id, now, now, id);
        if (result.changes !== 1) {
          return { error: `Task "${id}" was claimed by another agent.` };
        }

        return { task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) };
      }).immediate();

      if ('error' in claim) {
        return {
          content: [{ type: 'text', text: claim.error ?? `Task "${id}" could not be claimed.` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(claim.task, null, 2) }] };
    }
  );

  server.registerTool(
    'task_release',
    {
      description: 'Release a claimed task back to pending so another agent can take it.',
      inputSchema: z.object({
        id: z.string(),
        agent_id: z.string(),
        blocker: z.string().optional(),
      }),
    },
    ({ id, agent_id, blocker }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const result = db.prepare(`
        UPDATE tasks SET
          status = 'pending',
          claimed_by_agent = NULL,
          claimed_at = NULL,
          blocker = COALESCE(?, blocker),
          updated_at = ?
        WHERE id = ? AND claimed_by_agent = ? AND status = 'in_progress'
      `).run(blocker ?? null, now, id, agent_id);

      if (result.changes !== 1) {
        return {
          content: [{ type: 'text', text: `Task "${id}" is not claimed by agent "${agent_id}".` }],
          isError: true,
        };
      }
      const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      return { content: [{ type: 'text', text: JSON.stringify(row, null, 2) }] };
    }
  );
}
