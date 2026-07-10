#!/usr/bin/env node
// Claude Code SessionStart hook: injects a compact workspace resume from the hub
// into the new session's context, so the agent starts already knowing what other
// agents did — without spending a single tool call on it.
//
// Wiring (user or project settings.json):
//   "hooks": {
//     "SessionStart": [
//       { "hooks": [ { "type": "command",
//           "command": "node D:\\Projects\\ClaudePlus\\scripts\\hooks\\session-start-resume.cjs" } ] }
//     ]
//   }
//
// Prints nothing (exit 0) when the current directory is not a hub project, so it
// is safe to enable globally.

const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function projectIdFromPath(dir) {
  return path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(await readStdin() || '{}');
  } catch {
    // no/invalid stdin — fall back to cwd
  }
  const cwd = input.cwd || process.cwd();
  const projectId = projectIdFromPath(cwd);

  // dist/ is CommonJS; db path is anchored to the hub install dir by db/client.
  const { buildContextPacket } = require(path.join(__dirname, '..', '..', 'dist', 'context', 'builder.js'));

  let packet;
  try {
    packet = buildContextPacket({ projectId, maxTokens: 1200 });
  } catch {
    process.exit(0); // hub db unavailable — stay silent, never break session start
  }
  if (!packet) process.exit(0); // not a hub project

  const context = [
    'Shared agent-hub resume for this project (from the hub DB; other agents may have worked here).',
    'Read memory bodies on demand via memory_read(id). End significant work with session_log',
    '(outcome + next_steps) so the next agent resumes without retelling.',
    '',
    JSON.stringify(packet),
  ].join('\n');

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }));
}

main();
