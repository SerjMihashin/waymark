import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Agent } from '../db/schema.js';
import { randomUUID } from 'crypto';

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'session_log',
    {
      description: 'Record a session summary at the end of work. ' +
        'Call this at the end of significant agent work to preserve history and identity.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        agent_id: z.string().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        client: z.string().optional(),
        client_session_id: z.string().optional(),
        surface: z.string().default('claude-code')
          .describe('Legacy client/surface identifier kept for compatibility'),
        started_at: z.string().describe('ISO datetime when session started'),
        summary: z.string().describe('Brief narrative: what was accomplished, what decisions were made'),
        files_touched: z.array(z.string()).optional().describe('List of file paths modified'),
        commits_made: z.array(z.string()).optional().describe('List of git commit SHAs or messages'),
        outcome: z.enum(['completed', 'blocked', 'partial']).default('completed'),
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

      return { content: [{ type: 'text', text: `Session logged with id "${id}".` }] };
    }
  );
}
