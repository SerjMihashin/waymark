const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeplus-test-'));
process.env.DB_PATH = path.join(testDir, 'hub.db');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { closeDb, getDb } = require('../dist/db/client.js');
const { createHttpApp, createMcpServer } = require('../dist/server.js');
const { estimateTokens } = require('../dist/telemetry/tokens.js');

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

function httpGet(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      headers,
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end();
  });
}

function httpPost(port, pathName, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathName,
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        responseBody += chunk;
      });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: responseBody,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

test.before(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'claudeplus-tests', version: '1.0.0' });
  mcpServer = createMcpServer();

  await Promise.all([
    client.connect(clientTransport),
    mcpServer.connect(serverTransport),
  ]);

  await callTool('project_upsert', {
    id: 'test-project',
    name: 'Test Project',
    root_path: testDir,
  });
});

test.after(async () => {
  await client.close();
  await mcpServer.close();
  closeDb();
  fs.rmSync(testDir, { recursive: true, force: true });
});

test('project memory takes precedence over same-named global memory', async () => {
  await callTool('memory_write', {
    name: 'shared-name',
    description: 'global record',
    body: 'GLOBAL',
  });
  await callTool('memory_write', {
    project_id: 'test-project',
    name: 'shared-name',
    description: 'project record',
    body: 'PROJECT',
  });

  const result = await callTool('memory_read', {
    project_id: 'test-project',
    name: 'shared-name',
  });
  const memory = JSON.parse(textContent(result));

  assert.equal(memory.project_id, 'test-project');
  assert.equal(memory.body, 'PROJECT');
});

test('registered agent identity links memory, tasks, sessions, and usage', async () => {
  const registered = await callTool('agent_register', {
    id: 'test-agent',
    display_name: 'Test Agent',
    provider: 'test-provider',
    model: 'test-model',
    client: 'test-client',
    client_version: '1.2.3',
    capabilities: ['code', 'browser'],
    metadata: { role: 'integration-test' },
  });
  const agent = JSON.parse(textContent(registered));
  assert.equal(agent.id, 'test-agent');
  assert.deepEqual(agent.capabilities, ['code', 'browser']);
  assert.deepEqual(agent.metadata, { role: 'integration-test' });

  const listed = await callTool('agent_list', { capability: 'browser' });
  assert.equal(JSON.parse(textContent(listed))[0].id, 'test-agent');

  const memoryResult = await callTool('memory_write', {
    project_id: 'test-project',
    name: 'agent-linked-memory',
    description: 'Agent-linked memory',
    body: 'Linked to a registered agent',
    agent_id: 'test-agent',
    surface: 'legacy-surface',
  });
  assert.equal(JSON.parse(textContent(memoryResult)).created_by_agent, 'test-agent');
  const legacyMemoryUpdate = await callTool('memory_write', {
    project_id: 'test-project',
    name: 'agent-linked-memory',
    description: 'Updated by a legacy client',
    body: 'Identity must remain linked',
    surface: 'legacy-surface',
  });
  assert.equal(JSON.parse(textContent(legacyMemoryUpdate)).created_by_agent, 'test-agent');

  const taskResult = await callTool('task_create', {
    project_id: 'test-project',
    title: 'Agent-linked task',
    description: 'Verify agent task ownership',
    created_by_agent: 'test-agent',
    assigned_agent_id: 'test-agent',
  });
  const task = JSON.parse(textContent(taskResult));
  assert.equal(task.created_by_agent, 'test-agent');
  assert.equal(task.assigned_agent_id, 'test-agent');

  const sessionResult = await callTool('session_log', {
    project_id: 'test-project',
    agent_id: 'test-agent',
    surface: 'legacy-surface',
    client_session_id: 'client-session-123',
    started_at: new Date().toISOString(),
    summary: 'Agent identity integration test',
  });
  const sessionId = textContent(sessionResult).match(/"([^"]+)"/)?.[1];
  assert.ok(sessionId);

  const session = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  assert.equal(session.agent_id, 'test-agent');
  assert.equal(session.provider, 'test-provider');
  assert.equal(session.model, 'test-model');
  assert.equal(session.client, 'test-client');
  assert.equal(session.client_session_id, 'client-session-123');

  const usageResult = await callTool('usage_report', {
    project_id: 'test-project',
    session_id: sessionId,
    agent_id: 'test-agent',
    measurement: 'exact',
    input_tokens: 100,
    output_tokens: 20,
  });
  const usage = JSON.parse(textContent(usageResult));
  assert.equal(usage.agent_id, 'test-agent');
  assert.equal(usage.provider, 'test-provider');
  assert.equal(usage.model, 'test-model');
  assert.equal(usage.client, 'test-client');

  const inheritedUsageResult = await callTool('usage_report', {
    session_id: sessionId,
    measurement: 'exact',
    input_tokens: 50,
    output_tokens: 10,
  });
  const inheritedUsage = JSON.parse(textContent(inheritedUsageResult));
  assert.equal(inheritedUsage.project_id, 'test-project');
  assert.equal(inheritedUsage.agent_id, 'test-agent');
  assert.equal(inheritedUsage.provider, 'test-provider');

  const paused = await callTool('agent_set_status', {
    id: 'test-agent',
    status: 'paused',
  });
  assert.equal(JSON.parse(textContent(paused)).status, 'paused');
});

test('context tools rank relevant records and enforce the serialized token budget', async () => {
  await callTool('project_upsert', {
    id: 'context-project',
    name: 'Context Project',
    root_path: path.join(testDir, 'context-project'),
    stack: 'TypeScript and SQLite',
    description: 'Project used to verify compact context packets.',
  });
  await callTool('agent_register', {
    id: 'context-agent',
    display_name: 'Context Agent',
    provider: 'test-provider',
    model: 'test-model',
    client: 'test-client',
    capabilities: ['code'],
  });
  await callTool('memory_write', {
    project_id: 'context-project',
    name: 'sqlite-locking-decision',
    description: 'Use WAL and short transactions to prevent SQLite locking during writes.',
    body: 'Detailed SQLite locking decision. '.repeat(80),
    type: 'decision',
    agent_id: 'context-agent',
  });
  await callTool('memory_write', {
    project_id: 'context-project',
    name: 'unrelated-css-reference',
    description: 'Historical CSS color palette reference.',
    body: 'Unrelated visual design details. '.repeat(80),
    type: 'reference',
    agent_id: 'context-agent',
  });
  for (let index = 0; index < 8; index++) {
    await callTool('memory_write', {
      project_id: 'context-project',
      name: `unrelated-reference-${index}`,
      description: `Unrelated archived reference ${index} about a different subsystem and historical details.`,
      body: 'Unrelated historical information. '.repeat(40),
      type: 'reference',
      agent_id: 'context-agent',
    });
  }
  await callTool('task_create', {
    project_id: 'context-project',
    title: 'Fix SQLite locking',
    description: 'Continue the database concurrency fix.',
    assigned_agent_id: 'context-agent',
    priority: 90,
  });
  await callTool('task_create', {
    project_id: 'context-project',
    title: 'Update CSS palette',
    description: 'Unrelated design task.',
    priority: 10,
  });
  await callTool('session_log', {
    project_id: 'context-project',
    agent_id: 'context-agent',
    started_at: new Date().toISOString(),
    summary: 'Investigated SQLite locking and selected WAL with short transactions.',
  });

  const result = await callTool('context_get', {
    project_id: 'context-project',
    task: 'Fix SQLite locking and database concurrency',
    agent_id: 'context-agent',
    max_tokens: 650,
  });
  const text = textContent(result);
  const packet = JSON.parse(text);

  assert.ok(estimateTokens(text) <= 650);
  assert.ok(packet.estimated_tokens <= 650);
  assert.equal(packet.active_tasks[0].title, 'Fix SQLite locking');
  assert.equal(packet.memories[0].name, 'sqlite-locking-decision');
  assert.ok(packet.memories[0].reasons.includes('task-term-match'));
  assert.equal('body' in packet.memories[0], false);
  assert.ok(packet.omitted.memories >= 1);

  const resumed = await callTool('workspace_resume', {
    project_id: 'context-project',
    agent_id: 'context-agent',
    max_tokens: 200,
  });
  const resumeText = textContent(resumed);
  const resumePacket = JSON.parse(resumeText);

  assert.ok(estimateTokens(resumeText) <= 200);
  assert.equal(resumePacket.project.id, 'context-project');
});

test('reopening a completed task clears completed_at', async () => {
  const created = await callTool('task_create', {
    project_id: 'test-project',
    title: 'Lifecycle test',
    description: 'Verify completion timestamp behavior',
  });
  const task = JSON.parse(textContent(created));

  const completed = await callTool('task_update', {
    id: task.id,
    status: 'done',
  });
  assert.ok(JSON.parse(textContent(completed)).completed_at);

  const reopened = await callTool('task_update', {
    id: task.id,
    status: 'in_progress',
  });
  const reopenedTask = JSON.parse(textContent(reopened));

  assert.equal(reopenedTask.status, 'in_progress');
  assert.equal(reopenedTask.completed_at, null);
});

test('malformed FTS query returns a stable client-facing error', async () => {
  const result = await callTool('memory_search', { query: 'foo OR' });

  assert.equal(result.isError, true);
  assert.equal(
    textContent(result),
    'Invalid search query. Use words or quoted phrases without incomplete FTS operators.'
  );
});

test('HTTP app rejects untrusted Host and Origin headers', async () => {
  const app = createHttpApp({ host: '127.0.0.1' });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });

  try {
    const address = listener.address();
    assert.ok(address && typeof address === 'object');

    const valid = await httpGet(address.port);
    assert.equal(valid, 200);

    const invalidHost = await httpGet(address.port, {
      Host: 'evil.example',
    });
    assert.equal(invalidHost, 403);

    const invalidOrigin = await httpGet(address.port, {
      Origin: 'https://evil.example',
    });
    assert.equal(invalidOrigin, 403);

    const validOrigin = await httpGet(address.port, {
      Origin: 'http://localhost:3000',
    });
    assert.equal(validOrigin, 200);
  } finally {
    await new Promise((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    });
  }
});

test('non-loopback HTTP binding requires an explicit host allowlist', () => {
  assert.throws(
    () => createHttpApp({ host: '0.0.0.0', allowedHosts: [] }),
    /ALLOWED_HOSTS is required/
  );

  assert.doesNotThrow(() => createHttpApp({
    host: '0.0.0.0',
    allowedHosts: ['localhost', '127.0.0.1'],
  }));
});

test('stateless HTTP transport handles an MCP initialize request', async () => {
  const app = createHttpApp({ host: '127.0.0.1' });
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });

  try {
    const address = listener.address();
    assert.ok(address && typeof address === 'object');

    const response = await httpPost(address.port, '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'http-test', version: '1.0.0' },
      },
    });

    assert.equal(response.status, 200);
    assert.match(response.body, /"name":"claudeplus-hub"/);
  } finally {
    await new Promise((resolve, reject) => {
      listener.close(error => error ? reject(error) : resolve());
    });
  }
});

test('usage report estimates context tokens without double-counting them', async () => {
  const result = await callTool('usage_report', {
    project_id: 'test-project',
    provider: 'test-provider',
    model: 'test-model',
    client: 'test-client',
    measurement: 'exact',
    input_tokens: 1000,
    output_tokens: 200,
    hub_llm_input_tokens: 50,
    hub_llm_output_tokens: 25,
    context_text: 'x'.repeat(400),
  });
  const report = JSON.parse(textContent(result));

  assert.equal(report.context_tokens, 100);
  assert.equal(report.context_chars, 400);
  assert.equal(report.total_model_tokens, 1275);
});

test('exact usage requires token counts', async () => {
  const result = await callTool('usage_report', {
    project_id: 'test-project',
    measurement: 'exact',
  });

  assert.equal(result.isError, true);
});

test('experiment summary calculates savings within isolated measurement cohorts', async () => {
  const created = await callTool('experiment_create', {
    project_id: 'test-project',
    name: 'Continuation benchmark',
    scenario: 'continue-bugfix',
    target_runs: 1,
  });
  const experiment = JSON.parse(textContent(created));

  await callTool('usage_report', {
    project_id: 'test-project',
    experiment_id: experiment.id,
    variant: 'without_hub',
    provider: 'test-provider',
    model: 'test-model',
    client: 'test-client',
    measurement: 'exact',
    input_tokens: 2000,
    output_tokens: 500,
    duration_ms: 10000,
  });
  await callTool('usage_report', {
    project_id: 'test-project',
    experiment_id: experiment.id,
    variant: 'with_hub',
    provider: 'test-provider',
    model: 'test-model',
    client: 'test-client',
    measurement: 'exact',
    input_tokens: 1400,
    output_tokens: 400,
    hub_llm_input_tokens: 75,
    hub_llm_output_tokens: 25,
    context_tokens: 300,
    duration_ms: 7000,
  });
  await callTool('usage_report', {
    project_id: 'test-project',
    experiment_id: experiment.id,
    variant: 'with_hub',
    provider: 'test-provider',
    model: 'test-model',
    client: 'test-client',
    measurement: 'estimated',
    input_tokens: 1000,
    output_tokens: 200,
  });

  const result = await callTool('experiment_summary', { id: experiment.id });
  const summary = JSON.parse(textContent(result));

  assert.equal(summary.total_reports, 3);
  assert.equal(summary.cohorts.length, 2);

  const exact = summary.cohorts.find(cohort => cohort.measurement === 'exact');
  assert.ok(exact);
  assert.equal(exact.without_hub.median_total_model_tokens, 2500);
  assert.equal(exact.with_hub.median_total_model_tokens, 1900);
  assert.equal(exact.net_token_saving, 600);
  assert.equal(exact.net_token_saving_percent, 24);
  assert.equal(exact.target_reached, true);

  const estimated = summary.cohorts.find(cohort => cohort.measurement === 'estimated');
  assert.ok(estimated);
  assert.equal(estimated.without_hub.runs, 0);
  assert.equal(estimated.net_token_saving, null);

  const updated = await callTool('experiment_update', {
    id: experiment.id,
    status: 'completed',
  });
  assert.equal(JSON.parse(textContent(updated)).status, 'completed');

  const listed = await callTool('experiment_list', {
    project_id: 'test-project',
    status: 'completed',
  });
  const experiments = JSON.parse(textContent(listed));
  assert.equal(experiments.length, 1);
  assert.equal(experiments[0].without_hub_runs, 1);
  assert.equal(experiments[0].with_hub_runs, 2);
});
