import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { randomUUID } from 'crypto';

export function registerSessionTools(server: McpServer): void {
  server.registerTool(
    'session_log',
    {
      description: 'Record a session summary at the end of work. ' +
        'Call this at the end of any significant Claude session to keep a history of what was done and by which surface.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        surface: z.string().default('claude-code')
          .describe('claude-code | claude-desktop | browser-agent | claude-web'),
        started_at: z.string().describe('ISO datetime when session started'),
        summary: z.string().describe('Brief narrative: what was accomplished, what decisions were made'),
        files_touched: z.array(z.string()).optional().describe('List of file paths modified'),
        commits_made: z.array(z.string()).optional().describe('List of git commit SHAs or messages'),
        outcome: z.enum(['completed', 'blocked', 'partial']).default('completed'),
      }),
    },
    ({ project_id, surface, started_at, summary, files_touched, commits_made, outcome }) => {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO sessions
          (id, project_id, surface, started_at, ended_at, summary, files_touched, commits_made, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        project_id ?? null,
        surface,
        started_at,
        now,
        summary,
        files_touched ? JSON.stringify(files_touched) : null,
        commits_made ? JSON.stringify(commits_made) : null,
        outcome
      );

      return { content: [{ type: 'text', text: `Session logged with id "${id}".` }] };
    }
  );
}
