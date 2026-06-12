import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Agent } from '../db/schema.js';

function parseAgent(row: Agent) {
  return {
    ...row,
    capabilities: row.capabilities ? JSON.parse(row.capabilities) : [],
    metadata: row.metadata ? JSON.parse(row.metadata) : null,
  };
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'agent_register',
    {
      description: 'Register or update an AI agent identity independently of model provider or client.',
      inputSchema: z.object({
        id: z.string().optional().describe('Stable agent id. A UUID is generated when omitted.'),
        display_name: z.string().min(1),
        provider: z.string().optional(),
        model: z.string().optional(),
        client: z.string().optional(),
        client_version: z.string().optional(),
        capabilities: z.array(z.string()).default([]),
        metadata: z.record(z.string(), z.unknown()).optional(),
        status: z.enum(['active', 'paused', 'retired']).default('active'),
      }),
    },
    ({
      id: requestedId,
      display_name,
      provider,
      model,
      client,
      client_version,
      capabilities,
      metadata,
      status,
    }) => {
      const db = getDb();
      const id = requestedId ?? randomUUID();
      const now = new Date().toISOString();
      const existing = db.prepare('SELECT 1 FROM agents WHERE id = ?').get(id);

      if (existing) {
        db.prepare(`
          UPDATE agents SET
            display_name = ?,
            provider = ?,
            model = ?,
            client = ?,
            client_version = ?,
            capabilities = ?,
            metadata = ?,
            status = ?,
            updated_at = ?
          WHERE id = ?
        `).run(
          display_name,
          provider ?? null,
          model ?? null,
          client ?? null,
          client_version ?? null,
          JSON.stringify(capabilities),
          metadata ? JSON.stringify(metadata) : null,
          status,
          now,
          id
        );
      } else {
        db.prepare(`
          INSERT INTO agents (
            id, display_name, provider, model, client, client_version,
            capabilities, metadata, status, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          display_name,
          provider ?? null,
          model ?? null,
          client ?? null,
          client_version ?? null,
          JSON.stringify(capabilities),
          metadata ? JSON.stringify(metadata) : null,
          status,
          now,
          now
        );
      }

      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
      return { content: [{ type: 'text', text: JSON.stringify(parseAgent(row), null, 2) }] };
    }
  );

  server.registerTool(
    'agent_get',
    {
      description: 'Get one registered agent identity.',
      inputSchema: z.object({ id: z.string() }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const db = getDb();
      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | undefined;
      if (!row) {
        return { content: [{ type: 'text', text: `Agent "${id}" not found.` }], isError: true };
      }
      return { content: [{ type: 'text', text: JSON.stringify(parseAgent(row), null, 2) }] };
    }
  );

  server.registerTool(
    'agent_list',
    {
      description: 'List registered agents by provider, model, client, status, or capability.',
      inputSchema: z.object({
        provider: z.string().optional(),
        model: z.string().optional(),
        client: z.string().optional(),
        status: z.enum(['active', 'paused', 'retired']).optional(),
        capability: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ provider, model, client, status, capability, limit }) => {
      const db = getDb();
      let sql = 'SELECT * FROM agents WHERE 1=1';
      const params: string[] = [];

      if (provider) {
        sql += ' AND provider = ?';
        params.push(provider);
      }
      if (model) {
        sql += ' AND model = ?';
        params.push(model);
      }
      if (client) {
        sql += ' AND client = ?';
        params.push(client);
      }
      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      sql += ' ORDER BY updated_at DESC';
      const rows = (db.prepare(sql).all(...params) as Agent[])
        .map(parseAgent)
        .filter(row => !capability || row.capabilities.includes(capability))
        .slice(0, limit);

      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    }
  );

  server.registerTool(
    'agent_set_status',
    {
      description: 'Set an agent identity to active, paused, or retired.',
      inputSchema: z.object({
        id: z.string(),
        status: z.enum(['active', 'paused', 'retired']),
      }),
    },
    ({ id, status }) => {
      const db = getDb();
      const result = db.prepare(
        'UPDATE agents SET status = ?, updated_at = ? WHERE id = ?'
      ).run(status, new Date().toISOString(), id);

      if (result.changes === 0) {
        return { content: [{ type: 'text', text: `Agent "${id}" not found.` }], isError: true };
      }
      const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent;
      return { content: [{ type: 'text', text: JSON.stringify(parseAgent(row), null, 2) }] };
    }
  );
}
