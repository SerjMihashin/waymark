#!/usr/bin/env node
// Waymark Hub — read-only observability dashboard.
//
// A standalone viewer for the shared hub DB (projects, tasks, memory, sessions,
// agents). It opens the SQLite file in READ-ONLY mode, so it can never mutate
// the shared state agents depend on (atomic task claim, FTS triggers). Reuses
// the hub's already-installed express + better-sqlite3 — no extra deps.
// Writes, if ever added, must go through the hub's MCP tools, not this server.

import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Same DB resolution as the hub itself (DB_PATH → WAYMARK_HOME → install dir → ~/.waymark).
const { resolveDbPath } = require(path.join(__dirname, '..', 'dist', 'db', 'client.js'));
const DB_PATH = resolveDbPath();
const PORT = parseInt(process.env.DASH_PORT || '4747', 10);
const HOST = '127.0.0.1'; // loopback only

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

/** Parse a column that stores a JSON array/object as text; tolerate plain text. */
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

// ---- Optional admin mode ----------------------------------------------------
// WAYMARK_ADMIN=1 enables a small set of write actions. Writes go through the
// hub's own MCP tools (in-process client), never raw SQL — so task_update /
// memory_set_status semantics (completed_at, FTS, supersede) stay intact.
const ADMIN = process.env.WAYMARK_ADMIN === '1';
let adminClient = null;
async function initAdmin() {
  process.env.HUB_TOOLS = 'full';
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = require(path.join(__dirname, '..', 'dist', 'server.js'));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'waymark-dashboard-admin', version: '1.0.0' });
  const mcpServer = createMcpServer();
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);
  return client;
}

async function adminTool(res, name, args) {
  if (!adminClient) return res.status(403).json({ error: 'admin mode is off (set WAYMARK_ADMIN=1)' });
  try {
    const result = await adminClient.callTool({ name, arguments: args });
    const text = result.content?.find(c => c.type === 'text')?.text ?? '';
    if (result.isError) return res.status(400).json({ error: text });
    res.json({ ok: true, result: text });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}

const app = express();

app.get('/api/capabilities', (_req, res) => {
  res.json({ admin: ADMIN, db_path: DB_PATH });
});

// Cheap change detection for live refresh: data_version increments whenever
// another connection commits to the DB.
app.get('/api/stats', (_req, res) => {
  res.json({
    data_version: db.pragma('data_version', { simple: true }),
    now: new Date().toISOString(),
  });
});

// Trail: the handoff timeline for a project — sessions in reverse chronology
// plus the active auto-handoff (what the next agent should pick up).
app.get('/api/trail', (req, res) => {
  const projectId = req.query.project_id || null;
  const where = projectId ? 'WHERE s.project_id = ?' : '';
  const params = projectId ? [projectId] : [];
  const sessions = db.prepare(`
    SELECT s.id, s.project_id, s.started_at, s.ended_at, s.summary, s.outcome,
           s.agent_id, s.provider, s.model, s.client, s.surface,
           s.files_touched, s.commits_made,
           p.name AS project_name, a.display_name AS agent_name
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN agents a ON a.id = s.agent_id
      ${where}
      ORDER BY COALESCE(s.ended_at, s.started_at) DESC
      LIMIT 100`).all(...params).map(r => ({
    ...r,
    files_touched: parseJson(r.files_touched, []),
    commits_made: parseJson(r.commits_made, []),
  }));
  const handoffs = db.prepare(`
    SELECT m.id, m.project_id, m.name, m.description, m.body, m.status,
           m.updated_at, m.origin_session, m.created_by_agent,
           a.display_name AS agent_name, p.name AS project_name
      FROM memory_nodes m
      LEFT JOIN agents a ON a.id = m.created_by_agent
      LEFT JOIN projects p ON p.id = m.project_id
      WHERE m.type = 'handoff' ${projectId ? 'AND m.project_id = ?' : ''}
      ORDER BY m.updated_at DESC`).all(...params);
  res.json({ sessions, handoffs });
});

app.get('/api/overview', (_req, res) => {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const counts = {
    projects: count('projects'),
    tasks: count('tasks'),
    memory: count('memory_nodes'),
    sessions: count('sessions'),
    agents: count('agents'),
    experiments: count('experiments'),
  };

  // Per-project drill-down for the overview table.
  const projects = db.prepare(`
    SELECT p.id, p.name, p.status, p.stack,
      (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
      (SELECT COUNT(*) FROM memory_nodes m WHERE m.project_id = p.id AND m.status = 'active') AS memory,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status IN ('pending','in_progress')) AS open_tasks,
      (SELECT COUNT(*) FROM memory_nodes m WHERE m.project_id = p.id AND m.type = 'handoff' AND m.status = 'active') AS active_handoffs,
      (SELECT MAX(COALESCE(s.ended_at, s.started_at)) FROM sessions s WHERE s.project_id = p.id) AS last_activity
    FROM projects p
    ORDER BY last_activity IS NULL, last_activity DESC, p.name`).all();

  // Token economy from recorded benchmark runs (median per variant).
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const usage = db.prepare(`
    SELECT variant, measurement, COALESCE(input_tokens,0) + COALESCE(output_tokens,0) AS total
    FROM usage_reports
    WHERE variant IN ('with_hub','without_hub') AND input_tokens IS NOT NULL`).all();
  const withHub = usage.filter(u => u.variant === 'with_hub').map(u => u.total);
  const withoutHub = usage.filter(u => u.variant === 'without_hub').map(u => u.total);
  const mWith = median(withHub);
  const mWithout = median(withoutHub);
  let tokens = null;
  if (mWith != null && mWithout != null && mWithout > 0) {
    const savedPerSession = mWithout - mWith;
    tokens = {
      measurement: usage.every(u => u.measurement === 'exact') ? 'exact' : 'estimated',
      runs: { with_hub: withHub.length, without_hub: withoutHub.length },
      median: { with_hub: mWith, without_hub: mWithout },
      saving_pct: Math.round((savedPerSession / mWithout) * 1000) / 10,
      saved_per_session: savedPerSession,
      hub_sessions: counts.sessions,
      saved_total_est: savedPerSession * counts.sessions,
    };
  }

  res.json({
    db_path: DB_PATH,
    counts,
    tasks_by_status: db.prepare(
      `SELECT status, COUNT(*) c FROM tasks GROUP BY status ORDER BY c DESC`,
    ).all(),
    projects,
    tokens,
  });
});

app.get('/api/projects', (_req, res) => {
  res.json(db.prepare(
    `SELECT id, name, root_path, stack, status, description, created_at, updated_at
       FROM projects ORDER BY updated_at DESC, name`,
  ).all());
});

app.get('/api/tasks', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.project_id) { where.push('t.project_id = ?'); params.push(req.query.project_id); }
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  const sql = `
    SELECT t.id, t.project_id, t.title, t.description, t.status, t.priority,
           t.created_by, t.assigned_to, t.assigned_agent_id, t.claimed_by_agent,
           t.claimed_at, t.blocker, t.progress, t.required_capabilities,
           t.created_at, t.updated_at, t.completed_at,
           p.name AS project_name, a.display_name AS claimed_agent_name
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN agents a ON a.id = t.claimed_by_agent
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.priority DESC, t.created_at DESC`;
  const rows = db.prepare(sql).all(...params).map(r => ({
    ...r,
    required_capabilities: parseJson(r.required_capabilities, []),
  }));
  res.json(rows);
});

app.get('/api/memory', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.project_id) { where.push('project_id = ?'); params.push(req.query.project_id); }
  if (req.query.type) { where.push('type = ?'); params.push(req.query.type); }
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  if (req.query.q) {
    where.push('(name LIKE ? OR description LIKE ? OR body LIKE ? OR tags LIKE ?)');
    const like = `%${req.query.q}%`;
    params.push(like, like, like, like);
  }
  const sql = `
    SELECT id, project_id, name, description, type, body, tags, status,
           importance, confidence, surface, created_by_agent, created_at, updated_at
      FROM memory_nodes
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY importance DESC, updated_at DESC`;
  const rows = db.prepare(sql).all(...params).map(r => ({
    ...r,
    tags: parseJson(r.tags, []),
  }));
  res.json(rows);
});

app.get('/api/sessions', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.project_id) { where.push('s.project_id = ?'); params.push(req.query.project_id); }
  const sql = `
    SELECT s.id, s.project_id, s.surface, s.started_at, s.ended_at, s.summary,
           s.files_touched, s.commits_made, s.outcome, s.agent_id,
           s.provider, s.model, s.client,
           p.name AS project_name, a.display_name AS agent_name
      FROM sessions s
      LEFT JOIN projects p ON p.id = s.project_id
      LEFT JOIN agents a ON a.id = s.agent_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.started_at DESC`;
  const rows = db.prepare(sql).all(...params).map(r => ({
    ...r,
    files_touched: parseJson(r.files_touched, []),
    commits_made: parseJson(r.commits_made, []),
  }));
  res.json(rows);
});

app.get('/api/agents', (_req, res) => {
  const rows = db.prepare(
    `SELECT id, display_name, provider, model, client, client_version,
            capabilities, status, created_at, updated_at
       FROM agents ORDER BY updated_at DESC`,
  ).all().map(r => ({ ...r, capabilities: parseJson(r.capabilities, []) }));
  res.json(rows);
});

app.get('/api/experiments', (_req, res) => {
  res.json(db.prepare(
    `SELECT e.id, e.project_id, e.name, e.description, e.scenario, e.status,
            e.target_runs, e.created_at, e.updated_at, p.name AS project_name
       FROM experiments e
       LEFT JOIN projects p ON p.id = e.project_id
       ORDER BY e.created_at DESC`,
  ).all());
});

// ---- Optional Russian translation (opt-in, cached) -------------------------
// Translates English hub content on demand via the user's existing DeepSeek
// key, reusing the same resolution dsc uses (env → ~/.deepseek-code/settings.json).
// The key stays server-side; every unique string is translated once and cached
// to disk, so repeat views cost nothing. Off unless the UI requests it.

const CACHE_DIR = path.join(__dirname, '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'translations.json');
let trCache = {};
try { trCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { trCache = {}; }
let cacheDirty = false;
function persistCache() {
  if (!cacheDirty) return;
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(trCache)); cacheDirty = false; } catch { /* non-fatal */ }
}
setInterval(persistCache, 5000).unref();

function translateConfig() {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.deepseek-code', 'settings.json'), 'utf8')); } catch { /* none */ }
  const apiKey = (process.env.DEEPSEEK_API_KEY || settings.apiKey || '').trim();
  const baseUrl = (process.env.DEEPSEEK_BASE_URL || settings.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = process.env.TRANSLATE_MODEL || 'deepseek-v4-flash';
  return { apiKey, baseUrl, model };
}

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function translateBatch(texts, cfg) {
  const prompt = 'Translate each string in the following JSON array to Russian. '
    + 'Return ONLY a JSON array of strings, same length and order. Translate prose only; '
    + 'keep code, identifiers, slugs, file paths, URLs, and IDs unchanged.\n\n'
    + JSON.stringify(texts);
  const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      messages: [
        { role: 'system', content: 'You are a precise translator. Output strictly valid JSON, nothing else.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`translate API ${resp.status}`);
  const data = await resp.json();
  let content = data.choices?.[0]?.message?.content ?? '';
  content = content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  const arr = JSON.parse(content);
  if (!Array.isArray(arr) || arr.length !== texts.length) throw new Error('translation shape mismatch');
  return arr.map(String);
}

app.use(express.json({ limit: '4mb' }));

app.post('/api/translate', async (req, res) => {
  const texts = Array.isArray(req.body?.texts) ? req.body.texts.filter(t => typeof t === 'string') : [];
  const cfg = translateConfig();
  const out = {};
  const missing = [];
  for (const t of texts) {
    const k = hash(t);
    if (trCache[k] != null) out[t] = trCache[k];
    else if (!missing.includes(t)) missing.push(t);
  }
  if (missing.length === 0) { process.stdout.write(`[translate] ${texts.length} texts, all cached\n`); return res.json({ translations: out }); }
  if (!cfg.apiKey) { process.stdout.write('[translate] NO API KEY (set DEEPSEEK_API_KEY or apiKey in ~/.deepseek-code/settings.json)\n'); return res.json({ translations: out, error: 'no_key' }); }
  try {
    process.stdout.write(`[translate] calling ${cfg.baseUrl} model=${cfg.model} for ${missing.length} new texts…\n`);
    const translated = await translateBatch(missing, cfg);
    missing.forEach((src, i) => { trCache[hash(src)] = translated[i]; out[src] = translated[i]; });
    cacheDirty = true; persistCache();
    process.stdout.write(`[translate] ok (${missing.length} translated, ${Object.keys(trCache).length} cached total)\n`);
    res.json({ translations: out });
  } catch (e) {
    process.stdout.write(`[translate] ERROR: ${String(e.message || e)}\n`);
    res.json({ translations: out, error: String(e.message || e) });
  }
});

// Admin write endpoints (403 unless WAYMARK_ADMIN=1). Statuses are validated
// by the hub tools' own schemas.
app.post('/api/admin/task-status', (req, res) => {
  const { id, status } = req.body ?? {};
  if (!id || !status) return res.status(400).json({ error: 'id and status are required' });
  adminTool(res, 'task_update', { id, status });
});

app.post('/api/admin/memory-status', (req, res) => {
  const { id, status } = req.body ?? {};
  if (!id || !status) return res.status(400).json({ error: 'id and status are required' });
  adminTool(res, 'memory_set_status', { id, status });
});

app.use(express.static(__dirname));

if (ADMIN) {
  adminClient = await initAdmin();
}

const server = app.listen(PORT, HOST, () => {
  process.stdout.write(`Waymark dashboard (${ADMIN ? 'ADMIN mode' : 'read-only'}) → http://${HOST}:${PORT}\n`);
  process.stdout.write(`Reading: ${DB_PATH}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(
      `\n[!] Порт ${PORT} уже занят другим процессом (вероятно, старый дашборд ещё работает).\n` +
      `    Останови его или запусти на другом порту: $env:DASH_PORT='4748'; npm run dashboard\n`,
    );
  } else {
    process.stderr.write(`\n[!] Не удалось запустить дашборд: ${err.message}\n`);
  }
  process.exit(1);
});
