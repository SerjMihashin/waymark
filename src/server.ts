import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { Express, NextFunction, Request, Response } from 'express';
import { Server as HttpServer } from 'node:http';

import { registerProjectTools } from './tools/projects.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerSessionTools } from './tools/sessions.js';
import { registerTelemetryTools } from './tools/telemetry.js';
import { registerAgentTools } from './tools/agents.js';
import { registerContextTools } from './tools/context.js';

const PORT = parseInt(process.env.PORT || '3747', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HTTP_MODE = process.argv.includes('--http');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Compact daily-work toolset exposed by default. Eager clients (e.g. Codex) inject
// every tool schema into context on every turn, so a smaller default set directly
// cuts recurring token cost. The full admin/telemetry surface is opt-in via HUB_TOOLS.
const CORE_TOOLS = new Set([
  'workspace_resume',
  'context_get',
  'memory_write',
  'memory_read',
  'memory_search',
  'task_create',
  'task_list',
  'task_claim',
  'task_update',
  'session_log',
]);

function toolProfile(): 'core' | 'full' {
  return (process.env.HUB_TOOLS || 'core').toLowerCase() === 'full' ? 'full' : 'core';
}

// Wrap registerTool so only tools allowed by the active profile are exposed.
function applyToolProfile(server: McpServer): void {
  if (toolProfile() === 'full') return;
  const original = server.registerTool.bind(server);
  (server as unknown as { registerTool: (name: string, ...rest: unknown[]) => unknown }).registerTool =
    (name: string, ...rest: unknown[]) =>
      CORE_TOOLS.has(name) ? (original as (...a: unknown[]) => unknown)(name, ...rest) : undefined;
}

export interface HttpAppOptions {
  host?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'waymark-hub', version: '1.0.0' },
    {
      instructions:
        'Shared context hub for AI agents. At session start call one workspace_resume ' +
        '(project, task, token budget). Use memory/task tools as needed; at session end ' +
        'call session_log, then memory_write for durable decisions. Default profile exposes a ' +
        'compact core toolset; set HUB_TOOLS=full for admin/telemetry/agent tools.',
    }
  );

  applyToolProfile(server);
  registerProjectTools(server);
  registerMemoryTools(server);
  registerTaskTools(server);
  registerSessionTools(server);
  registerTelemetryTools(server);
  registerAgentTools(server);
  registerContextTools(server);
  return server;
}

async function startStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function parseList(value: string | undefined): string[] {
  return value?.split(',').map(item => item.trim()).filter(Boolean) ?? [];
}

function isAllowedOrigin(origin: string, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;

  try {
    const hostname = new URL(origin).hostname;
    return LOOPBACK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export function createHttpApp(options: HttpAppOptions = {}): Express {
  const host = options.host ?? HOST;
  const allowedHosts = options.allowedHosts ?? parseList(process.env.ALLOWED_HOSTS);
  const allowedOrigins = options.allowedOrigins ?? parseList(process.env.ALLOWED_ORIGINS);

  if (!LOOPBACK_HOSTS.has(host) && allowedHosts.length === 0) {
    throw new Error('ALLOWED_HOSTS is required when HTTP binds to a non-loopback interface.');
  }

  const app = createMcpExpressApp({
    host,
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin || isAllowedOrigin(origin, allowedOrigins)) {
      next();
      return;
    }

    res.status(403).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Invalid Origin header' },
      id: null,
    });
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'waymark-hub', version: '1.0.0' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(`MCP request failed: ${String(error)}\n`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      await transport.close();
      await server.close();
    }
  });

  app.get('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  return app;
}

export async function startHttp(): Promise<HttpServer> {
  const app = createHttpApp();
  return await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(PORT, HOST, () => {
      process.stderr.write(`Waymark Hub listening on http://${HOST}:${PORT}/mcp\n`);
      resolve(listener);
    });
    listener.on('error', reject);
  });
}

if (require.main === module) {
  const start = HTTP_MODE ? startHttp : startStdio;
  start().catch((err) => {
    process.stderr.write(`Fatal: ${err}\n`);
    process.exitCode = 1;
  });
}
