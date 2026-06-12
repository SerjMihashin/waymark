#!/usr/bin/env node

import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../server.js';

type FlagValue = string | true;
type Flags = Record<string, FlagValue>;

const BOOLEAN_FIELDS = new Set(['success']);
const NUMBER_FIELDS = new Set([
  'target_runs',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'hub_llm_input_tokens',
  'hub_llm_output_tokens',
  'context_tokens',
  'tool_calls',
  'repeated_files',
  'clarification_count',
  'duration_ms',
  'result_quality',
  'limit',
]);

function usage(): string {
  return `Usage:
  claudeplus-benchmark create --name <name> --scenario <scenario> [--project-id <id>] [--target-runs 5]
  claudeplus-benchmark record --file <run.json>
  claudeplus-benchmark record --experiment-id <id> --variant <without_hub|with_hub> [usage flags]
  claudeplus-benchmark list [--project-id <id>] [--status <active|completed|cancelled>]
  claudeplus-benchmark summary --id <experiment-id>
  claudeplus-benchmark complete --id <experiment-id>

Common record flags:
  --project-id, --session-id, --experiment-id, --variant
  --provider, --model, --client, --measurement
  --input-tokens, --output-tokens, --cached-input-tokens
  --hub-llm-input-tokens, --hub-llm-output-tokens
  --context-tokens, --context-file
  --tool-calls, --files-read <json-array-or-comma-list>
  --repeated-files, --clarification-count, --duration-ms
  --result-quality, --success <true|false>, --notes

Set DB_PATH to target a database other than data/hub.db.`;
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const equalsIndex = arg.indexOf('=');
    if (equalsIndex !== -1) {
      flags[arg.slice(2, equalsIndex)] = arg.slice(equalsIndex + 1);
      continue;
    }

    const name = arg.slice(2);
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
      continue;
    }

    flags[name] = next;
    index++;
  }

  return flags;
}

function snakeCase(name: string): string {
  return name.replace(/-/g, '_');
}

function parseBoolean(value: FlagValue, name: string): boolean {
  if (value === true || value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`--${name} must be true or false`);
}

function parseNumber(value: FlagValue, name: string): number {
  if (value === true || value.trim() === '') {
    throw new Error(`--${name} requires a numeric value`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a number`);
  }
  return parsed;
}

function parseFiles(value: FlagValue): string[] {
  if (value === true) throw new Error('--files-read requires a value');
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item: unknown) => typeof item !== 'string')) {
      throw new Error('--files-read JSON must be an array of strings');
    }
    return parsed as string[];
  }
  return trimmed.split(',').map(item => item.trim()).filter(Boolean);
}

function flagsToInput(flags: Flags): Record<string, unknown> {
  const input: Record<string, unknown> = {};

  for (const [rawName, value] of Object.entries(flags)) {
    if (rawName === 'file') continue;
    const name = snakeCase(rawName);

    if (NUMBER_FIELDS.has(name)) {
      input[name] = parseNumber(value, rawName);
    } else if (BOOLEAN_FIELDS.has(name)) {
      input[name] = parseBoolean(value, rawName);
    } else if (name === 'files_read') {
      input[name] = parseFiles(value);
    } else if (name === 'context_file') {
      if (value === true) throw new Error('--context-file requires a path');
      input.context_text = fs.readFileSync(value, 'utf8');
    } else {
      if (value === true) throw new Error(`--${rawName} requires a value`);
      input[name] = value;
    }
  }

  return input;
}

function readJsonFile(file: FlagValue | undefined): Record<string, unknown> {
  if (file === undefined) return {};
  if (file === true) throw new Error('--file requires a path');

  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Benchmark JSON file must contain an object');
  }
  return parsed as Record<string, unknown>;
}

function textFromResult(result: unknown): string {
  if (!result || typeof result !== 'object' || !('content' in result)) {
    throw new Error('Tool returned an unsupported result type');
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error('Tool returned no content');
  }

  const text = content.find(item =>
    Boolean(item) &&
    typeof item === 'object' &&
    'type' in item &&
    item.type === 'text' &&
    'text' in item &&
    typeof item.text === 'string'
  ) as { type: 'text'; text: string } | undefined;

  if (!text) {
    throw new Error('Tool returned no text result');
  }
  if ('isError' in result && result.isError === true) throw new Error(text.text);
  return text.text;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'claudeplus-benchmark-cli', version: '1.0.0' });
  const server = createMcpServer();

  try {
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    return textFromResult(await client.callTool({ name, arguments: args }));
  } finally {
    await client.close();
    await server.close();
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const flags = parseFlags(rest);
  let tool: string;
  let input: Record<string, unknown>;

  switch (command) {
    case 'create':
      tool = 'experiment_create';
      input = flagsToInput(flags);
      break;
    case 'record':
      tool = 'usage_report';
      input = { ...readJsonFile(flags.file), ...flagsToInput(flags) };
      break;
    case 'list':
      tool = 'experiment_list';
      input = flagsToInput(flags);
      break;
    case 'summary':
      tool = 'experiment_summary';
      input = flagsToInput(flags);
      break;
    case 'complete':
      tool = 'experiment_update';
      input = { ...flagsToInput(flags), status: 'completed' };
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }

  process.stdout.write(`${await callTool(tool, input)}\n`);
}

main().catch(error => {
  process.stderr.write(`Benchmark command failed: ${String(error)}\n`);
  process.exitCode = 1;
});
