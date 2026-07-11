import { getDb } from '../db/client.js';
import { MemoryNode, Project, Session, Task } from '../db/schema.js';
import { estimateTokens } from '../telemetry/tokens.js';

interface ContextMemory {
  id: string;
  name: string;
  type: MemoryNode['type'];
  summary: string;
  updated_at: string;
  source: 'project' | 'global';
  score: number;
  reasons: string[];
  importance: number;
  confidence: number;
  source_type: string | null;
  source_ref: string | null;
  body?: string;
}

interface ContextTask {
  id: string;
  title: string;
  description: string | null;
  status: Task['status'];
  priority: number;
  assigned_to: string | null;
  assigned_agent_id: string | null;
  updated_at: string;
}

interface ContextSession {
  id: string;
  summary: string | null;
  outcome: string | null;
  agent_id: string | null;
  client: string | null;
  ended_at: string | null;
}

export interface ContextPacket {
  project: {
    id: string;
    name: string;
    root_path: string;
    stack: string | null;
    description: string | null;
  };
  task: string | null;
  notices?: string[];
  active_tasks: ContextTask[];
  memories: ContextMemory[];
  recent_sessions: ContextSession[];
  omitted: {
    active_tasks: number;
    memories: number;
    recent_sessions: number;
  };
  estimated_tokens: number;
  max_tokens: number;
}

export interface BuildContextOptions {
  projectId: string;
  task?: string;
  agentId?: string;
  clientId?: string;
  maxTokens: number;
  memoryTypes?: MemoryNode['type'][];
  includeSources?: boolean;
}

const TYPE_WEIGHT: Record<MemoryNode['type'], number> = {
  handoff: 60,
  decision: 50,
  user: 45,
  feedback: 35,
  project: 30,
  reference: 20,
};

const FEEDBACK_WEIGHT: Record<string, number> = {
  used: 3,
  helpful: 8,
  not_used: -2,
  irrelevant: -12,
  stale: -20,
  incorrect: -30,
  too_verbose: -5,
};

function terms(value: string): Set<string> {
  return new Set(
    value.toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .map(term => term.trim())
      .filter(term => term.length >= 3)
  );
}

function overlapScore(queryTerms: Set<string>, value: string): number {
  if (queryTerms.size === 0) return 0;
  const valueTerms = terms(value);
  let matches = 0;
  for (const term of queryTerms) {
    if (valueTerms.has(term)) matches++;
  }
  return matches * 25;
}

function recencyScore(updatedAt: string): number {
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return 10;
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 1) return 15;
  if (ageDays <= 7) return 10;
  if (ageDays <= 30) return 5;
  return 0;
}

function compact(value: string | null, maxChars: number): string | null {
  if (value === null) return null;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function packetTokens(packet: Omit<ContextPacket, 'estimated_tokens'> | ContextPacket): number {
  const serializable = { ...packet, estimated_tokens: 999_999 };
  return estimateTokens(JSON.stringify(serializable, null, 2));
}

function fits(packet: ContextPacket): boolean {
  return packetTokens(packet) <= packet.max_tokens;
}

function finalize(packet: ContextPacket): ContextPacket {
  packet.estimated_tokens = packetTokens(packet);
  return packet;
}

function addWithinBudget<T>(
  packet: ContextPacket,
  target: T[],
  item: T,
): boolean {
  target.push(item);
  if (fits(packet)) return true;
  target.pop();
  return false;
}

function parseTags(tags: string | null): string {
  if (!tags) return '';
  try {
    const parsed = JSON.parse(tags);
    return Array.isArray(parsed) ? parsed.join(' ') : tags;
  } catch {
    return tags;
  }
}

export function buildContextPacket(options: BuildContextOptions): ContextPacket | null {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(options.projectId) as
    Project | undefined;
  if (!project) return null;

  const queryTerms = terms(options.task ?? '');
  const packet: ContextPacket = {
    project: {
      id: project.id,
      name: compact(project.name, 120) ?? project.name,
      root_path: compact(project.root_path, 240) ?? project.root_path,
      stack: compact(project.stack, 240),
      description: compact(project.description, 360),
    },
    task: compact(options.task ?? null, 500),
    active_tasks: [],
    memories: [],
    recent_sessions: [],
    omitted: {
      active_tasks: 0,
      memories: 0,
      recent_sessions: 0,
    },
    estimated_tokens: 0,
    max_tokens: options.maxTokens,
  };

  const notices: string[] = [];
  if (options.agentId) {
    const knownAgent = db.prepare('SELECT 1 FROM agents WHERE id = ?').get(options.agentId);
    if (!knownAgent) {
      notices.push(
        `agent_id "${options.agentId}" is not registered; call agent_register (HUB_TOOLS=full) ` +
        'or reuse a registered id so sessions and handoffs are attributed.'
      );
    }
  } else {
    notices.push('No agent_id supplied: pass a stable agent_id so other agents can see who did what.');
  }
  if (notices.length) packet.notices = notices;

  // Very small budgets keep identity and task while progressively trimming metadata.
  if (!fits(packet)) packet.project.description = null;
  if (!fits(packet)) packet.project.stack = null;
  if (!fits(packet)) packet.project.root_path = '';
  if (!fits(packet) && packet.task) packet.task = compact(packet.task, 160);

  const taskRows = db.prepare(`
    SELECT * FROM tasks
    WHERE project_id = ?
      AND status IN ('pending', 'in_progress')
    ORDER BY
      CASE WHEN assigned_agent_id = ? THEN 0
           WHEN assigned_to = ? THEN 1
           WHEN assigned_agent_id IS NULL AND assigned_to IS NULL THEN 2
           ELSE 3 END,
      priority DESC,
      updated_at DESC
  `).all(
    options.projectId,
    options.agentId ?? null,
    options.clientId ?? null
  ) as Task[];

  for (const row of taskRows) {
    const item: ContextTask = {
      id: row.id,
      title: compact(row.title, 180) ?? row.title,
      description: compact(row.description, 320),
      status: row.status,
      priority: row.priority,
      assigned_to: row.assigned_to,
      assigned_agent_id: row.assigned_agent_id,
      updated_at: row.updated_at,
    };
    if (!addWithinBudget(packet, packet.active_tasks, item)) {
      packet.omitted.active_tasks++;
    }
  }

  // Handoffs are inherently project-bound: a global one is almost always a
  // session_log that forgot project_id, and surfacing it in every project's
  // resume cross-contaminates unrelated work.
  const memories = db.prepare(`
    SELECT * FROM memory_nodes
    WHERE (project_id = ? OR project_id IS NULL)
      AND status = 'active'
      AND NOT (type = 'handoff' AND project_id IS NULL)
      AND (valid_from IS NULL OR valid_from <= ?)
      AND (valid_until IS NULL OR valid_until >= ?)
    ORDER BY updated_at DESC
  `).all(options.projectId, new Date().toISOString(), new Date().toISOString()) as MemoryNode[];

  const feedbackRows = db.prepare(`
    SELECT memory_id, rating, COUNT(*) AS count
    FROM memory_feedback
    GROUP BY memory_id, rating
  `).all() as Array<{ memory_id: string; rating: string; count: number }>;
  const feedbackScores = new Map<string, number>();
  for (const feedback of feedbackRows) {
    const current = feedbackScores.get(feedback.memory_id) ?? 0;
    feedbackScores.set(
      feedback.memory_id,
      current + (FEEDBACK_WEIGHT[feedback.rating] ?? 0) * feedback.count
    );
  }

  const rankedMemories = memories
    .filter(row => !options.memoryTypes || options.memoryTypes.includes(row.type))
    .map(row => {
      const searchable = [
        row.name,
        row.description ?? '',
        row.body,
        parseTags(row.tags),
      ].join(' ');
      const projectBoost = row.project_id === options.projectId ? 20 : 0;
      const termScore = overlapScore(queryTerms, searchable);
      const recentScore = recencyScore(row.updated_at);
      const feedbackScore = feedbackScores.get(row.id) ?? 0;
      const reasons = [
        row.type,
        row.project_id === options.projectId ? 'project-memory' : 'global-memory',
      ];
      if (termScore > 0) reasons.push('task-term-match');
      if (recentScore >= 10) reasons.push('recent');
      if (row.importance >= 75) reasons.push('high-importance');
      if (row.confidence >= 75) reasons.push('high-confidence');
      if (feedbackScore > 0) reasons.push('positive-feedback');
      return {
        row,
        score: TYPE_WEIGHT[row.type] +
          projectBoost +
          termScore +
          recentScore +
          Math.round(row.importance / 5) +
          Math.round(row.confidence / 10) +
          feedbackScore,
        reasons,
      };
    })
    .sort((a, b) => b.score - a.score || b.row.updated_at.localeCompare(a.row.updated_at));

  for (const { row, score, reasons } of rankedMemories) {
    const item: ContextMemory = {
      id: row.id,
      name: compact(row.name, 120) ?? row.name,
      type: row.type,
      summary: compact(row.description || row.body, 360) ?? '',
      updated_at: row.updated_at,
      source: row.project_id === options.projectId ? 'project' : 'global',
      score,
      reasons,
      importance: row.importance,
      confidence: row.confidence,
      source_type: row.source_type,
      source_ref: row.source_ref,
    };
    if (options.includeSources) {
      item.body = compact(row.body, 1000) ?? '';
    }

    if (!addWithinBudget(packet, packet.memories, item)) {
      packet.omitted.memories++;
    }
  }

  const sessions = db.prepare(`
    SELECT * FROM sessions
    WHERE project_id = ? AND summary IS NOT NULL
    ORDER BY COALESCE(ended_at, started_at) DESC
    LIMIT 20
  `).all(options.projectId) as Session[];

  for (const row of sessions) {
    const item: ContextSession = {
      id: row.id,
      summary: compact(row.summary, 360),
      outcome: row.outcome,
      agent_id: row.agent_id,
      client: row.client ?? row.surface,
      ended_at: row.ended_at,
    };
    if (!addWithinBudget(packet, packet.recent_sessions, item)) {
      packet.omitted.recent_sessions++;
    }
  }

  return finalize(packet);
}
