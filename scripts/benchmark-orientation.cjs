// Reproducible estimated-cohort benchmark for the continuation/orientation
// scenario (docs/BENCHMARK_RUN.md). Compares the token cost of a fresh agent
// orienting cold (reading repo files) vs. resuming through the hub
// (workspace_resume packet + core tool schemas). measurement=estimated;
// the exact-token protocol with live clients is documented separately.
//
// Usage: node scripts/benchmark-orientation.cjs [--record]
//   without --record: prints the comparison only
//   with    --record: creates an experiment and records all runs into the hub DB

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { estimateTokens } = require(path.join(ROOT, 'dist', 'telemetry', 'tokens.js'));
const { buildContextPacket } = require(path.join(ROOT, 'dist', 'context', 'builder.js'));

const PROJECT_ID = 'D--Projects-ClaudePlus';
const FIXED_TASK =
  'You are a new agent session on the Waymark project. Without any prior ' +
  'conversation, produce: (1) a 5-8 line summary of the current project state, ' +
  '(2) the single most relevant next implementation step, (3) one risk to watch. ' +
  'Stop after producing this - do not implement anything.';

// Core-profile tool schemas an MCP client loads to use the hub (measured claim
// in AGENTS.md: ~1.8k tokens for the 10 core tools).
const CORE_TOOLS_SCHEMA_TOKENS = 1800;
// Same assumed answer size for both variants; savings come from input only.
const OUTPUT_TOKENS = 400;

function fileTokens(rel) {
  return estimateTokens(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function gitLogTokens(lines) {
  const log = execFileSync('git', ['log', '--oneline', `-${lines}`], { cwd: ROOT, encoding: 'utf8' });
  return estimateTokens(log);
}

// Five plausible cold-orientation reading paths for a fresh agent.
const COLD_PATHS = [
  ['README.md', 'AGENTS.md'],
  ['README.md', 'AGENTS.md', 'docs/TZ_V2.md'],
  ['AGENTS.md', 'docs/TZ_V2.md', 'docs/CONTEXT.md', 'src/server.ts'],
  ['README.md', 'AGENTS.md', 'docs/TZ_V2.md', 'docs/BENCHMARKING.md', 'package.json'],
  ['README.md', 'CLAUDE.md', 'AGENTS.md', 'docs/TZ_V2.md', 'src/context/builder.ts'],
];

const taskTokens = estimateTokens(FIXED_TASK);

const withoutHubRuns = COLD_PATHS.map((files) => {
  const corpus = files.reduce((sum, f) => sum + fileTokens(f), 0) + gitLogTokens(30);
  return { files, input: corpus + taskTokens, output: OUTPUT_TOKENS };
});

const packet = buildContextPacket({ projectId: PROJECT_ID, task: FIXED_TASK, maxTokens: 1200 });
if (!packet) throw new Error(`Project ${PROJECT_ID} not found in hub DB`);
// Two of five hub runs additionally read one memory body by id (~300 tokens) —
// a conservative allowance for detail lookups.
const withHubRuns = [0, 0, 0, 300, 300].map((extraRead) => ({
  input: packet.estimated_tokens + CORE_TOOLS_SCHEMA_TOKENS + taskTokens + extraRead,
  output: OUTPUT_TOKENS,
}));

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const mWithout = median(withoutHubRuns.map(r => r.input + r.output));
const mWith = median(withHubRuns.map(r => r.input + r.output));
const savingPct = ((mWithout - mWith) / mWithout * 100);

console.log('Cold orientation runs (input tokens):');
for (const r of withoutHubRuns) console.log(`  ${String(r.input).padStart(6)}  <- ${r.files.join(', ')} + git log`);
console.log(`Hub resume packet: ${packet.estimated_tokens} tokens (budget 1200), + ${CORE_TOOLS_SCHEMA_TOKENS} core tool schemas`);
console.log(`Hub runs (input tokens): ${withHubRuns.map(r => r.input).join(', ')}`);
console.log('');
console.log(`median without_hub total: ${mWithout}`);
console.log(`median with_hub total:    ${mWith}`);
console.log(`net token saving:         ${(mWithout - mWith).toFixed(0)} (${savingPct.toFixed(1)}%)`);

if (!process.argv.includes('--record')) {
  console.log('\nDry run. Pass --record to write an experiment into the hub DB.');
  process.exit(0);
}

const cli = (args) => execFileSync('node', [path.join(ROOT, 'dist', 'cli', 'benchmark.js'), ...args], {
  cwd: ROOT, encoding: 'utf8',
});

const created = JSON.parse(cli([
  'create',
  '--name', 'orientation-estimated',
  '--scenario', 'continue-orientation',
  '--project-id', PROJECT_ID,
  '--target-runs', '5',
  '--description', 'Estimated cohort: cold file-reading orientation vs workspace_resume packet. See scripts/benchmark-orientation.cjs.',
]));
const experimentId = created.id;
console.log(`\nExperiment created: ${experimentId}`);

function record(variant, run, notes) {
  cli([
    'record',
    '--experiment-id', experimentId,
    '--variant', variant,
    '--provider', 'any', '--model', 'any', '--client', 'estimated',
    '--measurement', 'estimated',
    '--input-tokens', String(run.input),
    '--output-tokens', String(run.output),
    '--success', 'true',
    '--notes', notes,
  ]);
}

for (const run of withoutHubRuns) record('without_hub', run, `cold read: ${run.files.join(', ')} + git log 30`);
for (const run of withHubRuns) record('with_hub', run, 'workspace_resume(1200) + core tool schemas');

console.log(cli(['summary', '--id', experimentId]));
