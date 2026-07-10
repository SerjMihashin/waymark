import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Agent } from '../db/schema.js';
import { randomUUID } from 'crypto';

const AUTO_HANDOFF_PREFIX = 'auto-handoff';

function autoHandoffName(projectId: string | undefined): string {
  return projectId ? `${AUTO_HANDOFF_PREFIX}:${projectId}` : AUTO_HANDOFF_PREFIX;
}

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'session_log',
    {
      description:
        'Record a session summary at the end of significant agent work. ' +
        'On outcome "partial"/"blocked" (or when next_steps are given) the hub automatically ' +
        'writes a handoff memory so the next agent resumes without retelling; ' +
        'outcome "completed" retires that auto-handoff.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        agent_id: z.string().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        client: z.string().optional(),
        client_session_id: z.string().optional(),
        surface: z.string().default('claude-code'),
        started_at: z.string().describe('ISO datetime session started'),
        summary: z.string().describe('what was accomplished and decided'),
        files_touched: z.array(z.string()).optional(),
        commits_made: z.array(z.string()).optional(),
        outcome: z.enum(['completed', 'blocked', 'partial']).default('completed'),
        next_steps: z.array(z.string()).optional()
          .describe('concrete next actions for whichever agent continues this work'),
      }),
    },
    ({
      project_id,
      agent_id,
      provider,
      model,
      client,
      client_session_id,
      surface,
      started_at,
      summary,
      files_touched,
      commits_made,
      outcome,
      next_steps,
    }) => {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      let agent: Agent | undefined;

      if (agent_id) {
        agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agent_id) as Agent | undefined;
        if (!agent) {
          return { content: [{ type: 'text', text: `Agent "${agent_id}" not found.` }], isError: true };
        }
      }

      db.prepare(`
        INSERT INTO sessions
          (
            id, project_id, surface, started_at, ended_at, summary,
            files_touched, commits_made, outcome,
            agent_id, provider, model, client, client_session_id
          )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        project_id ?? null,
        surface,
        started_at,
        now,
        summary,
        files_touched ? JSON.stringify(files_touched) : null,
        commits_made ? JSON.stringify(commits_made) : null,
        outcome,
        agent_id ?? null,
        provider ?? agent?.provider ?? null,
        model ?? agent?.model ?? null,
        client ?? agent?.client ?? surface,
        client_session_id ?? null
      );

      const handoffName = autoHandoffName(project_id);
      const existingHandoff = db.prepare(`
        SELECT id FROM memory_nodes
        WHERE name = ? AND (project_id IS ? OR project_id = ?) AND status = 'active'
      `).get(handoffName, project_id ?? null, project_id ?? null) as { id: string } | undefined;

      let handoffNote = '';
      const needsHandoff = outcome !== 'completed' || (next_steps?.length ?? 0) > 0;

      if (needsHandoff) {
        const who = agent?.display_name ?? agent_id ?? client ?? surface;
        const bodyParts = [
          `Outcome: ${outcome} (session ${id}, agent: ${who})`,
          `Done: ${summary}`,
        ];
        if (next_steps?.length) bodyParts.push(`Next steps:\n${next_steps.map(s => `- ${s}`).join('\n')}`);
        if (files_touched?.length) bodyParts.push(`Files touched: ${files_touched.join(', ')}`);
        if (commits_made?.length) bodyParts.push(`Commits: ${commits_made.join(', ')}`);
        const body = bodyParts.join('\n\n');
        const description = `Continue from ${who}: ${summary.slice(0, 200)}`;

        if (existingHandoff) {
          db.prepare(`
            UPDATE memory_nodes
            SET description = ?, body = ?, origin_session = ?, created_by_agent = ?,
                source_type = 'session', source_ref = ?, updated_at = ?
            WHERE id = ?
          `).run(description, body, id, agent_id ?? null, id, now, existingHandoff.id);
          handoffNote = ` Handoff memory updated ("${handoffName}").`;
        } else {
          db.prepare(`
            INSERT INTO memory_nodes
              (id, project_id, surface, name, description, type, body,
               origin_session, created_by_agent, status, importance, confidence,
               source_type, source_ref, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'handoff', ?, ?, ?, 'active', 90, 80, 'session', ?, ?, ?)
          `).run(
            randomUUID(), project_id ?? null, surface, handoffName, description, body,
            id, agent_id ?? null, id, now, now
          );
          handoffNote = ` Handoff memory created ("${handoffName}").`;
        }
      } else if (existingHandoff) {
        db.prepare(`
          UPDATE memory_nodes SET status = 'superseded', updated_at = ? WHERE id = ?
        `).run(now, existingHandoff.id);
        handoffNote = ` Work completed: auto-handoff "${handoffName}" retired.`;
      }

      return {
        content: [{
          type: 'text',
          text: `Session logged with id "${id}".${handoffNote}` +
            ' Use memory_write for decisions/facts that should outlive this handoff.',
        }],
      };
    }
  );
}
