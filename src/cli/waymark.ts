#!/usr/bin/env node

// waymark-hub — one-command setup and operations CLI.
//
//   waymark-hub init        interactive setup: register the MCP server in
//                           Claude Code / Codex, optionally install the
//                           SessionStart hook (flags for non-interactive use)
//   waymark-hub serve       run the hub (stdio; --http for :3747)
//   waymark-hub dashboard   run the web dashboard (:4747)
//   waymark-hub doctor      check the installation end to end

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { resolveDbPath } from '../db/client.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..');
const SERVER_JS = path.join(PKG_ROOT, 'dist', 'server.js');
const DASHBOARD_MJS = path.join(PKG_ROOT, 'dashboard', 'server.mjs');
const HOOK_CJS = path.join(PKG_ROOT, 'scripts', 'hooks', 'session-start-resume.cjs');
const CODEX_CONFIG = path.join(os.homedir(), '.codex', 'config.toml');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

const ok = (m: string) => console.log(`  + ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const info = (m: string) => console.log(`  - ${m}`);

function run(cmd: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function hasClaude(): boolean {
  return run('claude', ['--version']).status === 0;
}

async function confirm(rl: readline.Interface | null, question: string, fallback: boolean): Promise<boolean> {
  if (!rl) return fallback;
  const answer = await new Promise<string>(resolve => rl.question(`${question} [y/n] `, resolve));
  return /^y(es)?$/i.test(answer.trim());
}

// ---- init steps -------------------------------------------------------------

function setupClaudeCode(): void {
  if (!hasClaude()) {
    warn('Claude Code CLI not found — skipped. Register later with:');
    info(`claude mcp add --scope user waymark node "${SERVER_JS}"`);
    return;
  }
  const listed = run('claude', ['mcp', 'list']);
  if (/^waymark:/m.test(listed.out)) {
    ok('Claude Code: "waymark" is already registered.');
    return;
  }
  const added = run('claude', ['mcp', 'add', '--scope', 'user', 'waymark', 'node', SERVER_JS]);
  if (added.status === 0) ok('Claude Code: registered MCP server "waymark" (user scope).');
  else warn(`Claude Code: registration failed — ${added.out.trim()}`);
}

function setupCodex(): void {
  if (!fs.existsSync(path.dirname(CODEX_CONFIG))) {
    info('Codex not detected (~/.codex missing) — skipped.');
    return;
  }
  let toml = '';
  try { toml = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { /* new file */ }
  if (/\[mcp_servers\.waymark\]/.test(toml)) {
    ok('Codex: [mcp_servers.waymark] is already configured.');
    return;
  }
  const serverPath = SERVER_JS.replace(/\\/g, '\\\\');
  const block = `\n[mcp_servers.waymark]\ncommand = "node"\nargs = ["${serverPath}"]\n`;
  fs.writeFileSync(CODEX_CONFIG, toml + block);
  ok(`Codex: added [mcp_servers.waymark] to ${CODEX_CONFIG}.`);
}

function setupHook(): void {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch { /* new file */ }

  const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  const sessionStart = hooks.SessionStart ?? [];
  const already = sessionStart.some(entry =>
    (entry.hooks ?? []).some(h => (h.command ?? '').includes('session-start-resume.cjs')));
  if (already) {
    ok('SessionStart hook is already installed.');
    return;
  }
  sessionStart.push({
    hooks: [{
      type: 'command',
      command: `node ${HOOK_CJS.replace(/\\/g, '/')}`,
      timeout: 10,
      statusMessage: 'Loading Waymark resume...',
    } as never],
  });
  hooks.SessionStart = sessionStart;
  settings.hooks = hooks;
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  ok('SessionStart hook installed: new Claude Code sessions get the resume packet automatically.');
}

async function init(argv: string[]): Promise<void> {
  const yes = argv.includes('--yes') || argv.includes('-y');
  const flagged = argv.some(a => ['--claude', '--codex', '--hook'].includes(a));
  const interactive = !yes && !flagged && process.stdin.isTTY;
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  console.log('Waymark setup');
  console.log(`  package: ${PKG_ROOT}`);
  console.log(`  hub DB:  ${resolveDbPath()}\n`);

  const want = async (flag: string, question: string): Promise<boolean> =>
    yes || argv.includes(flag) || await confirm(rl, question, false);

  if (await want('--claude', 'Register the hub in Claude Code (claude mcp add)?')) setupClaudeCode();
  if (await want('--codex', 'Register the hub in Codex (~/.codex/config.toml)?')) setupCodex();
  if (await want('--hook', 'Install the Claude Code SessionStart hook (auto-resume, zero tool calls)?')) setupHook();
  rl?.close();

  console.log('\nClaude Desktop / web: run "waymark-hub serve --http" and add the connector http://localhost:3747/mcp');
  console.log('Dashboard: waymark-hub dashboard  ->  http://localhost:4747');
}

// ---- doctor ------------------------------------------------------------------

function doctor(): void {
  console.log('Waymark doctor\n');
  const [major] = process.versions.node.split('.').map(Number);
  (major >= 22 ? ok : warn)(`node ${process.versions.node} ${major >= 22 ? '' : '(need >= 22)'}`.trim());

  const dbPath = resolveDbPath();
  if (fs.existsSync(dbPath)) {
    try {
      const { getDb } = require(path.join(PKG_ROOT, 'dist', 'db', 'client.js'));
      const db = getDb();
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      ok(`DB ${dbPath}: ${count('projects')} projects, ${count('memory_nodes')} memories, ${count('tasks')} tasks, ${count('sessions')} sessions`);
    } catch (e) {
      warn(`DB ${dbPath} exists but cannot be opened: ${String(e)}`);
    }
  } else {
    info(`DB not created yet (will appear at ${dbPath} on first use)`);
  }

  if (hasClaude()) {
    const listed = run('claude', ['mcp', 'list']);
    if (/^waymark:.*Connected/m.test(listed.out)) ok('Claude Code: "waymark" registered and connected');
    else if (/^waymark:/m.test(listed.out)) warn('Claude Code: "waymark" registered but not connected');
    else warn('Claude Code: "waymark" not registered — run waymark-hub init --claude');
  } else {
    info('Claude Code CLI not found');
  }

  let codexToml = '';
  try { codexToml = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { /* absent */ }
  if (/\[mcp_servers\.waymark\]/.test(codexToml)) ok('Codex: [mcp_servers.waymark] configured');
  else info('Codex: not configured (run waymark-hub init --codex)');

  let claudeSettings = '';
  try { claudeSettings = fs.readFileSync(CLAUDE_SETTINGS, 'utf8'); } catch { /* absent */ }
  if (claudeSettings.includes('session-start-resume.cjs')) ok('SessionStart hook installed');
  else info('SessionStart hook not installed (run waymark-hub init --hook)');
}

// ---- main ---------------------------------------------------------------------

function usage(): void {
  console.log(`waymark-hub — shared memory and handoff hub for AI agents

Usage:
  waymark-hub init [--claude] [--codex] [--hook] [--yes]
  waymark-hub serve [--http]
  waymark-hub dashboard
  waymark-hub doctor

init without flags asks interactively; --yes enables everything applicable.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'init':
      await init(rest);
      break;
    case 'serve':
      spawn(process.execPath, [SERVER_JS, ...rest], { stdio: 'inherit' });
      break;
    case 'dashboard':
      spawn(process.execPath, [DASHBOARD_MJS, ...rest], { stdio: 'inherit' });
      break;
    case 'doctor':
      doctor();
      break;
    default:
      usage();
      if (command && command !== 'help' && command !== '--help') process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(`waymark-hub failed: ${String(error)}`);
  process.exitCode = 1;
});
