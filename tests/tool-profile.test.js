const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waymark-profile-'));
process.env.DB_PATH = path.join(testDir, 'hub.db');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { createMcpServer } = require('../dist/server.js');

async function listToolNames() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'profile-probe', version: '1.0.0' });
  const server = createMcpServer();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    return tools.map(t => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

test('default core profile exposes only the compact daily toolset', async () => {
  delete process.env.HUB_TOOLS;
  const names = await listToolNames();
  assert.equal(names.length, 10, `expected 10 core tools, got ${names.length}`);
  assert.ok(names.includes('workspace_resume'));
  assert.ok(names.includes('session_log'));
  // admin/telemetry tools are hidden by default
  assert.ok(!names.includes('experiment_create'));
  assert.ok(!names.includes('agent_register'));
  assert.ok(!names.includes('usage_report'));
  assert.ok(!names.includes('project_upsert'));
});

test('HUB_TOOLS=full exposes the complete tool surface', async () => {
  process.env.HUB_TOOLS = 'full';
  const names = await listToolNames();
  assert.equal(names.length, 28, `expected 28 tools, got ${names.length}`);
  assert.ok(names.includes('experiment_create'));
  assert.ok(names.includes('agent_register'));
  delete process.env.HUB_TOOLS;
});
