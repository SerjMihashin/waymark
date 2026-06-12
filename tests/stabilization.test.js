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
const { closeDb } = require('../dist/db/client.js');
const { createHttpApp, createMcpServer } = require('../dist/server.js');

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
