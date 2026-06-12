import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildContextPacket } from '../context/builder.js';

const memoryType = z.enum(['user', 'feedback', 'project', 'reference', 'handoff', 'decision']);

function contextResult(
  projectId: string,
  task: string | undefined,
  agentId: string | undefined,
  clientId: string | undefined,
  maxTokens: number,
  memoryTypes: Array<z.infer<typeof memoryType>> | undefined,
  includeSources: boolean,
) {
  const packet = buildContextPacket({
    projectId,
    task,
    agentId,
    clientId,
    maxTokens,
    memoryTypes,
    includeSources,
  });

  if (!packet) {
    return {
      content: [{ type: 'text' as const, text: `Project "${projectId}" not found.` }],
      isError: true as const,
    };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(packet, null, 2) }],
  };
}

export function registerContextTools(server: McpServer): void {
  server.registerTool(
    'context_get',
    {
      description: 'Build task-specific project context using deterministic ranking within a token budget.',
      inputSchema: z.object({
        project_id: z.string(),
        task: z.string().min(1),
        agent_id: z.string().optional(),
        client_id: z.string().optional(),
        max_tokens: z.number().int().min(200).max(20_000).default(1200),
        memory_types: z.array(memoryType).optional(),
        include_sources: z.boolean().default(false),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project_id, task, agent_id, client_id, max_tokens, memory_types, include_sources }) =>
      contextResult(
        project_id,
        task,
        agent_id,
        client_id,
        max_tokens,
        memory_types,
        include_sources
      )
  );

  server.registerTool(
    'workspace_resume',
    {
      description: 'Restore compact project state for a new agent session in one token-budgeted call.',
      inputSchema: z.object({
        project_id: z.string(),
        task: z.string().optional(),
        agent_id: z.string().optional(),
        client_id: z.string().optional(),
        max_tokens: z.number().int().min(200).max(20_000).default(1200),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project_id, task, agent_id, client_id, max_tokens }) =>
      contextResult(
        project_id,
        task,
        agent_id,
        client_id,
        max_tokens,
        undefined,
        false
      )
  );
}
