import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { Experiment, UsageReport } from '../db/schema.js';
import { estimateTokens, totalModelTokens } from '../telemetry/tokens.js';

type UsageReportWithTotal = UsageReport & { total_model_tokens: number | null };

function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

function errorContent(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true as const };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function cohortKey(row: UsageReport): string {
  return [
    row.measurement,
    row.provider ?? 'unknown-provider',
    row.model ?? 'unknown-model',
    row.client ?? 'unknown-client',
  ].join('|');
}

export function registerTelemetryTools(server: McpServer): void {
  server.registerTool(
    'experiment_create',
    {
      description: 'Create a reproducible A/B experiment for comparing agent work with and without the Hub.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        name: z.string().min(1),
        description: z.string().optional(),
        scenario: z.string().min(1).describe('Stable scenario identifier or description'),
        target_runs: z.number().int().min(1).max(1000).default(5),
      }),
    },
    ({ project_id, name, description, scenario, target_runs }) => {
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO experiments
          (id, project_id, name, description, scenario, status, target_runs, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(id, project_id ?? null, name, description ?? null, scenario, target_runs, now, now);

      const row = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id);
      return jsonContent(row);
    }
  );

  server.registerTool(
    'experiment_list',
    {
      description: 'List token-usage experiments and their current run counts.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        status: z.enum(['active', 'completed', 'cancelled']).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ project_id, status, limit }) => {
      const db = getDb();
      let sql = `
        SELECT e.*,
          SUM(CASE WHEN u.variant = 'without_hub' THEN 1 ELSE 0 END) AS without_hub_runs,
          SUM(CASE WHEN u.variant = 'with_hub' THEN 1 ELSE 0 END) AS with_hub_runs
        FROM experiments e
        LEFT JOIN usage_reports u ON u.experiment_id = e.id
        WHERE 1=1
      `;
      const params: Array<string | number> = [];

      if (project_id) {
        sql += ' AND e.project_id = ?';
        params.push(project_id);
      }
      if (status) {
        sql += ' AND e.status = ?';
        params.push(status);
      }

      sql += ' GROUP BY e.id ORDER BY e.updated_at DESC LIMIT ?';
      params.push(limit);
      return jsonContent(db.prepare(sql).all(...params));
    }
  );

  server.registerTool(
    'experiment_update',
    {
      description: 'Update experiment metadata or mark an experiment completed or cancelled.',
      inputSchema: z.object({
        id: z.string(),
        name: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z.enum(['active', 'completed', 'cancelled']).optional(),
        target_runs: z.number().int().min(1).max(1000).optional(),
      }),
    },
    ({ id, name, description, status, target_runs }) => {
      const db = getDb();
      const existing = db.prepare('SELECT 1 FROM experiments WHERE id = ?').get(id);
      if (!existing) return errorContent(`Experiment "${id}" not found.`);

      db.prepare(`
        UPDATE experiments SET
          name = COALESCE(?, name),
          description = COALESCE(?, description),
          status = COALESCE(?, status),
          target_runs = COALESCE(?, target_runs),
          updated_at = ?
        WHERE id = ?
      `).run(
        name ?? null,
        description ?? null,
        status ?? null,
        target_runs ?? null,
        new Date().toISOString(),
        id
      );

      return jsonContent(db.prepare('SELECT * FROM experiments WHERE id = ?').get(id));
    }
  );

  server.registerTool(
    'usage_report',
    {
      description: 'Record exact or estimated model usage and task-efficiency metrics for a session or A/B experiment run.',
      inputSchema: z.object({
        project_id: z.string().optional(),
        session_id: z.string().optional(),
        experiment_id: z.string().optional(),
        variant: z.enum(['without_hub', 'with_hub']).optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        client: z.string().optional(),
        measurement: z.enum(['exact', 'estimated']).default('estimated'),
        input_tokens: z.number().int().min(0).optional(),
        output_tokens: z.number().int().min(0).optional(),
        cached_input_tokens: z.number().int().min(0).optional(),
        hub_llm_input_tokens: z.number().int().min(0).default(0),
        hub_llm_output_tokens: z.number().int().min(0).default(0),
        context_tokens: z.number().int().min(0).optional(),
        context_text: z.string().optional()
          .describe('Optional context text used only to estimate context_tokens when no count is available'),
        tool_calls: z.number().int().min(0).optional(),
        files_read: z.array(z.string()).optional(),
        repeated_files: z.number().int().min(0).optional(),
        clarification_count: z.number().int().min(0).optional(),
        duration_ms: z.number().int().min(0).optional(),
        result_quality: z.number().min(0).max(100).optional(),
        success: z.boolean().optional(),
        notes: z.string().optional(),
      }).refine(
        value => !value.experiment_id || Boolean(value.variant),
        { message: 'variant is required when experiment_id is provided', path: ['variant'] }
      ).refine(
        value => value.measurement !== 'exact' ||
          value.input_tokens !== undefined ||
          value.output_tokens !== undefined,
        {
          message: 'exact measurement requires input_tokens or output_tokens',
          path: ['measurement'],
        }
      ),
    },
    ({
      project_id,
      session_id,
      experiment_id,
      variant,
      provider,
      model,
      client,
      measurement,
      input_tokens,
      output_tokens,
      cached_input_tokens,
      hub_llm_input_tokens,
      hub_llm_output_tokens,
      context_tokens,
      context_text,
      tool_calls,
      files_read,
      repeated_files,
      clarification_count,
      duration_ms,
      result_quality,
      success,
      notes,
    }) => {
      const db = getDb();

      if (session_id && !db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(session_id)) {
        return errorContent(`Session "${session_id}" not found.`);
      }
      let effectiveProjectId = project_id ?? null;
      if (experiment_id) {
        const experiment = db.prepare(
          'SELECT project_id FROM experiments WHERE id = ?'
        ).get(experiment_id) as Pick<Experiment, 'project_id'> | undefined;
        if (!experiment) return errorContent(`Experiment "${experiment_id}" not found.`);
        if (project_id && experiment.project_id && project_id !== experiment.project_id) {
          return errorContent('usage_report project_id must match the experiment project_id.');
        }
        effectiveProjectId = experiment.project_id ?? effectiveProjectId;
      }

      const id = randomUUID();
      const estimatedContextTokens = context_tokens ??
        (context_text === undefined ? null : estimateTokens(context_text));
      const now = new Date().toISOString();

      db.prepare(`
        INSERT INTO usage_reports (
          id, project_id, session_id, experiment_id, variant,
          provider, model, client, measurement,
          input_tokens, output_tokens, cached_input_tokens,
          hub_llm_input_tokens, hub_llm_output_tokens,
          context_tokens, context_chars, tool_calls, files_read,
          repeated_files, clarification_count, duration_ms,
          result_quality, success, notes, created_at
        )
        VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?
        )
      `).run(
        id,
        effectiveProjectId,
        session_id ?? null,
        experiment_id ?? null,
        variant ?? null,
        provider ?? null,
        model ?? null,
        client ?? null,
        measurement,
        input_tokens ?? null,
        output_tokens ?? null,
        cached_input_tokens ?? null,
        hub_llm_input_tokens,
        hub_llm_output_tokens,
        estimatedContextTokens,
        context_text === undefined ? null : context_text.length,
        tool_calls ?? null,
        files_read ? JSON.stringify(files_read) : null,
        repeated_files ?? null,
        clarification_count ?? null,
        duration_ms ?? null,
        result_quality ?? null,
        success === undefined ? null : Number(success),
        notes ?? null,
        now
      );

      const row = db.prepare('SELECT * FROM usage_reports WHERE id = ?').get(id) as UsageReport;
      return jsonContent({
        ...row,
        files_read: row.files_read ? JSON.parse(row.files_read) : null,
        total_model_tokens: totalModelTokens({
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          hubLlmInputTokens: row.hub_llm_input_tokens,
          hubLlmOutputTokens: row.hub_llm_output_tokens,
        }),
      });
    }
  );

  server.registerTool(
    'experiment_summary',
    {
      description: 'Summarize A/B token usage without mixing models, clients, or exact and estimated measurements.',
      inputSchema: z.object({
        id: z.string().describe('Experiment UUID'),
      }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => {
      const db = getDb();
      const experiment = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as Experiment | undefined;
      if (!experiment) return errorContent(`Experiment "${id}" not found.`);

      const rows = db.prepare(
        'SELECT * FROM usage_reports WHERE experiment_id = ? ORDER BY created_at ASC'
      ).all(id) as UsageReport[];

      const reports: UsageReportWithTotal[] = rows.map(row => ({
        ...row,
        total_model_tokens: totalModelTokens({
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          hubLlmInputTokens: row.hub_llm_input_tokens,
          hubLlmOutputTokens: row.hub_llm_output_tokens,
        }),
      }));

      const cohorts = new Map<string, UsageReportWithTotal[]>();
      for (const report of reports) {
        const key = cohortKey(report);
        const group = cohorts.get(key) ?? [];
        group.push(report);
        cohorts.set(key, group);
      }

      const summaries = Array.from(cohorts.entries()).map(([key, cohort]) => {
        const withoutHub = cohort.filter(row =>
          row.variant === 'without_hub' && row.total_model_tokens !== null
        );
        const withHub = cohort.filter(row =>
          row.variant === 'with_hub' && row.total_model_tokens !== null
        );
        const withoutMedian = median(withoutHub.map(row => row.total_model_tokens as number));
        const withMedian = median(withHub.map(row => row.total_model_tokens as number));
        const netSaving = withoutMedian === null || withMedian === null
          ? null
          : withoutMedian - withMedian;
        let savingPercent: number | null = null;
        if (netSaving !== null && withoutMedian !== null && withoutMedian !== 0) {
          savingPercent = netSaving / withoutMedian * 100;
        }

        const [measurement, provider, model, client] = key.split('|');
        return {
          measurement,
          provider,
          model,
          client,
          without_hub: {
            runs: withoutHub.length,
            median_total_model_tokens: withoutMedian,
            median_duration_ms: median(withoutHub.flatMap(row =>
              row.duration_ms === null ? [] : [row.duration_ms]
            )),
          },
          with_hub: {
            runs: withHub.length,
            median_total_model_tokens: withMedian,
            median_duration_ms: median(withHub.flatMap(row =>
              row.duration_ms === null ? [] : [row.duration_ms]
            )),
          },
          net_token_saving: netSaving,
          net_token_saving_percent: savingPercent,
          target_reached: withoutHub.length >= experiment.target_runs &&
            withHub.length >= experiment.target_runs,
        };
      });

      return jsonContent({
        experiment,
        total_reports: reports.length,
        cohorts: summaries,
      });
    }
  );
}
