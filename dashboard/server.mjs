#!/usr/bin/env node
// ClaudePlus Hub — read-only observability dashboard.
//
// A standalone viewer for the shared hub DB (projects, tasks, memory, sessions,
// agents). It opens the SQLite file in READ-ONLY mode, so it can never mutate
// the shared state agents depend on (atomic task claim, FTS triggers). Reuses
// the hub's already-installed express + better-sqlite3 — no extra deps.
// Writes, if ever added, must go through the hub's MCP tools, not this server.

import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same default anchoring as the hub (…/ClaudePlus/data/hub.db); DB_PATH overrides.
const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'data', 'hub.db');
const PORT = parseInt(process.env.DASH_PORT || '4747', 10);
const HOST = '127.0.0.1'; // loopback only

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

/** Parse a column that stores a JSON array/object as text; tolerate plain text. */
function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

const app = express();

app.get('/api/overview', (_req, res) => {
  const count = (t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  res.json({
    db_path: DB_PATH,
    counts: {
      projects: count('projects'),
      tasks: count('tasks'),
      memory: count('memory_nodes'),
      sessions: count('sessions'),
      agents: count('agents'),
      experiments: count('experiments'),
    },
    tasks_by_status: db.prepare(
      `SELECT status, COUNT(*) c FROM tasks GROUP BY status ORDER BY c DESC`,
    ).all(),
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

app.use(express.static(__dirname));

app.listen(PORT, HOST, () => {
  process.stdout.write(`ClaudePlus dashboard (read-only) → http://${HOST}:${PORT}\n`);
  process.stdout.write(`Reading: ${DB_PATH}\n`);
});
