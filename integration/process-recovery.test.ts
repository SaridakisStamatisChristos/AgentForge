import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import { RuntimeService } from '@agentforge/runtime';

const databaseUrl = process.env.DATABASE_URL;

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

async function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolveClose) => child.on('close', () => resolveClose()));
}

if (databaseUrl === undefined) {
  test('process recovery suite requires DATABASE_URL', () => {
    process.stdout.write('SKIP process recovery integration: DATABASE_URL is not configured\n');
  });
} else {
  test('SIGKILL mid-run is recovered by a new worker after lease expiry', async () => {
    const db = new PostgresCli(databaseUrl);
    await db.execute(`
TRUNCATE TABLE
  signals,
  idempotency_records,
  tool_invocations,
  checkpoints,
  execution_events,
  attempts,
  queue_tasks,
  step_runs,
  workflow_runs,
  workflow_versions,
  workflow_definitions,
  worker_heartbeats,
  tool_definitions
RESTART IDENTITY CASCADE;
`);
    const store = new PostgresStore(db);
    const runtime = new RuntimeService(store);
    const workflow = await runtime.createWorkflow({
      name: 'process-kill-recovery',
      steps: [{ id: 'x', kind: 'task', handler: 'process-delay', input: { ms: '$run.input.ms' } }],
    });
    const run = await runtime.startRun(workflow.id, { ms: 1000 });
    const workerPath = resolve(process.cwd(), 'integration/fixtures/process-worker.ts');
    const spawnWorker = (workerId: string) => spawn('node', ['--experimental-transform-types', '--conditions=development', workerPath], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl, AGENTFORGE_WORKER_ID: workerId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const first = spawnWorker('process-kill-1');
    await waitFor(async () => (await db.query("SELECT count(*) FROM attempts WHERE state='RUNNING';"))[0] === '1');
    assert.equal(first.kill('SIGKILL'), true);
    await waitForClose(first);
    await db.execute("UPDATE queue_tasks SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = :'run_id';", { run_id: run.id });

    const second = spawnWorker('process-kill-2');
    try {
      await waitFor(async () => (await db.query("SELECT state FROM workflow_runs WHERE id = :'run_id';", { run_id: run.id }))[0] === 'SUCCEEDED', 8000);
    } finally {
      second.kill('SIGTERM');
      await waitForClose(second);
    }

    const states = await db.query("SELECT state FROM attempts ORDER BY started_at;");
    assert.ok(states.includes('LEASE_LOST'));
    assert.ok(states.includes('SUCCEEDED'));
    const recovered = await db.query("SELECT count(*) FROM execution_events WHERE run_id = :'run_id' AND type = 'lease.recovered';", { run_id: run.id });
    assert.equal(recovered[0], '1');
  });
}
