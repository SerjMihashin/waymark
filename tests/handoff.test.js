const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waymark-handoff-'));
process.env.DB_PATH = path.join(testDir, 'hub.db');
process.env.HUB_TOOLS = 'full';

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { closeDb } = require('../dist/db/client.js');
const { createMcpServer } = require('../dist/server.js');

let client;
let mcpServer;

function textContent(result) {
  const item = result.content.find(content => content.type === 'text');
  assert.ok(item, 'Expected text content in tool result');
  return item.text;
}

async function callTool(name, args) {
  return await client.callTool({ name, arguments: args });
}

test.before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'handoff-tests', version: '1.0.0' });
  mcpServer = createMcpServer();
  await Promise.all([client.connect(clientTransport), mcpServer.connect(serverTransport)]);

  await callTool('project_upsert', {
    id: 'handoff-project',
    name: 'Handoff Project',
    root_path: testDir,
  });
  await callTool('agent_register', {
    id: 'agent-a',
    display_name: 'Agent A (test)',
    provider: 'anthropic',
    client: 'claude-code',
  });
});

test.after(async () => {
  await client.close();
  await mcpServer.close();
  closeDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('partial session_log auto-creates a handoff that tops the next resume', async () => {
  const logResult = await callTool('session_log', {
    project_id: 'handoff-project',
    agent_id: 'agent-a',
    started_at: new Date(Date.now() - 60_000).toISOString(),
    summary: 'Implemented the parser for config files; validation is still missing.',
    files_touched: ['src/parser.ts'],
    outcome: 'partial',
    next_steps: ['Add schema validation to the parser', 'Cover invalid configs with tests'],
  });
  assert.match(textContent(logResult), /Handoff memory created/);

  // Agent B, a different client, resumes the project in a fresh session.
  const resume = await callTool('workspace_resume', {
    project_id: 'handoff-project',
    agent_id: 'agent-b-unregistered',
  });
  const packet = JSON.parse(textContent(resume));

  assert.ok(packet.memories.length > 0, 'resume should contain memories');
  const top = packet.memories[0];
  assert.equal(top.type, 'handoff', 'handoff must rank first');
  assert.match(top.summary, /Agent A \(test\)/);

  const body = JSON.parse(textContent(await callTool('memory_read', {
    id: top.id,
    project_id: 'handoff-project',
  })));
  assert.match(body.body, /Add schema validation to the parser/);
  assert.match(body.body, /src\/parser\.ts/);

  // Unregistered agent id gets a nudge; that must not fail the resume.
  assert.ok(Array.isArray(packet.notices), 'expected notices for unregistered agent');
  assert.match(packet.notices.join(' '), /not registered/);
});

test('a second partial session replaces the handoff instead of accumulating', async () => {
  const logResult = await callTool('session_log', {
    project_id: 'handoff-project',
    agent_id: 'agent-a',
    started_at: new Date().toISOString(),
    summary: 'Added schema validation; tests for invalid configs still pending.',
    outcome: 'partial',
    next_steps: ['Cover invalid configs with tests'],
  });
  assert.match(textContent(logResult), /Handoff memory updated/);

  const list = JSON.parse(textContent(await callTool('memory_list', {
    project_id: 'handoff-project',
    type: 'handoff',
  })));
  const active = list.filter(m => m.status === 'active');
  assert.equal(active.length, 1, 'exactly one active auto-handoff per project');
});

test('completed session retires the auto-handoff and resume no longer surfaces it', async () => {
  const logResult = await callTool('session_log', {
    project_id: 'handoff-project',
    agent_id: 'agent-a',
    started_at: new Date().toISOString(),
    summary: 'Finished parser validation with full test coverage.',
    outcome: 'completed',
  });
  assert.match(textContent(logResult), /retired/);

  const resume = await callTool('workspace_resume', {
    project_id: 'handoff-project',
    agent_id: 'agent-a',
  });
  const packet = JSON.parse(textContent(resume));
  assert.ok(
    packet.memories.every(m => m.type !== 'handoff'),
    'retired handoff must not appear in resume'
  );
  assert.equal(packet.notices, undefined, 'registered agent gets no notices');
});
