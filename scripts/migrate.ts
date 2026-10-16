import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';

const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge';
const directory = resolve(process.cwd(), 'packages/persistence/migrations');
const entries = await fs.readdir(directory, { withFileTypes: true }) as { name: string; isFile(): boolean }[];
const files = entries.filter((entry) => entry.isFile() && /^\d+.*\.sql$/.test(entry.name)).map((entry) => entry.name).sort();
const db = new PostgresCli(databaseUrl);
const store = new PostgresStore(db);

const migrationTableExists = (await db.query("SELECT to_regclass('public.schema_migrations') IS NOT NULL;")).includes('t');
const applied = new Set(migrationTableExists ? await db.query('SELECT version FROM schema_migrations ORDER BY version;') : []);

for (const file of files) {
  const version = file.replace(/\.sql$/, '');
  if (applied.has(version)) {
    process.stdout.write(`skipped ${file}\n`);
    continue;
  }
  const sql = await fs.readFile(resolve(directory, file), 'utf8');
  await store.applyMigration(sql);
  await db.execute(String.raw`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO schema_migrations(version) VALUES (:'version') ON CONFLICT DO NOTHING;
`, { version });
  applied.add(version);
  process.stdout.write(`applied ${file}\n`);
}
