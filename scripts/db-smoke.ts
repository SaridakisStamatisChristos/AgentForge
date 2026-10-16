import { PostgresCli, PostgresStore } from '@agentforge/persistence';
const databaseUrl = process.env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge';
const db = new PostgresCli(databaseUrl);
const store = new PostgresStore(db);
if (!(await store.ping())) throw new Error('PostgreSQL readiness failed');
const migrations = await db.query("SELECT version FROM schema_migrations ORDER BY version;");
if (!migrations.includes('0001_initial')) throw new Error('0001_initial migration is not recorded');
process.stdout.write('database smoke passed\n');
