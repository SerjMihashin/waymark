const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

function runCli(dbPath, args) {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), 'dist', 'cli', 'benchmark.js'), ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    }
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('benchmark CLI records and summarizes an isolated A/B experiment', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'waymark-cli-test-'));
  const dbPath = path.join(directory, 'hub.db');

  try {
    const experiment = runCli(dbPath, [
      'create',
      '--name', 'CLI benchmark',
      '--scenario', 'continuation',
      '--target-runs', '1',
    ]);

    runCli(dbPath, [
      'record',
      '--experiment-id', experiment.id,
      '--variant', 'without_hub',
      '--provider', 'test-provider',
      '--model', 'test-model',
      '--client', 'test-client',
      '--measurement', 'exact',
      '--input-tokens', '2000',
      '--output-tokens', '500',
      '--duration-ms', '10000',
      '--success', 'true',
    ]);

    const runFile = path.join(directory, 'with-hub.json');
    fs.writeFileSync(runFile, JSON.stringify({
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
      success: true,
    }));
    runCli(dbPath, ['record', '--file', runFile]);

    const summary = runCli(dbPath, ['summary', '--id', experiment.id]);
    assert.equal(summary.total_reports, 2);
    assert.equal(summary.cohorts.length, 1);
    assert.equal(summary.cohorts[0].net_token_saving, 600);
    assert.equal(summary.cohorts[0].net_token_saving_percent, 24);
    assert.equal(summary.cohorts[0].target_reached, true);

    const completed = runCli(dbPath, ['complete', '--id', experiment.id]);
    assert.equal(completed.status, 'completed');

    const experiments = runCli(dbPath, ['list', '--status', 'completed']);
    assert.equal(experiments.length, 1);
    assert.equal(experiments[0].without_hub_runs, 1);
    assert.equal(experiments[0].with_hub_runs, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
