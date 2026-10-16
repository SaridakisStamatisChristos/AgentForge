import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge';
const directory = resolve(process.cwd(), 'packages/persistence/migrations');
const entries = await fs.readdir(directory, { withFileTypes: true }) as { name: string; isFile(): boolean }[];
const files = entries.filter((entry) => entry.isFile() && /^\d+.*\.sql$/.test(entry.name)).map((entry) => entry.name).sort();
const store = new PostgresStore(new PostgresCli(databaseUrl));
for (const file of files) {
  const sql = await fs.readFile(resolve(directory, file), 'utf8');
  await store.applyMigration(sql);
  process.stdout.write(`applied ${file}\n`);
}
