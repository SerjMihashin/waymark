import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getDb } from '../src/db/client.js';

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const defaultPath = path.join(process.cwd(), 'data', 'backups', `hub-${timestamp()}.db`);
  const destination = path.resolve(process.argv[2] || defaultPath);
  const source = path.resolve(process.env.DB_PATH || path.join(process.cwd(), 'data', 'hub.db'));

  if (destination === source) {
    throw new Error('Backup destination must differ from the active database path.');
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });

  const db = getDb();
  try {
    await db.backup(destination);
  } finally {
    closeDb();
  }

  process.stdout.write(`Database backup created: ${destination}\n`);
}

main().catch(error => {
  process.stderr.write(`Backup failed: ${String(error)}\n`);
  process.exitCode = 1;
});
