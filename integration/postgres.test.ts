import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentForgeError } from '@agentforge/contracts';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import { ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, TaskRegistry, Worker } from '@agentforge/runtime';
import { ToolRegistry } from '@agentforge/tools';

const databaseUrl = process.env.DATABASE_URL;

async function reset(db: PostgresCli): Promise<void> {
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
  worker_heartbeats
RESTART IDENTITY CASCADE;
`);
}

async function storeForTest(): Promise<{ db: PostgresCli; store: PostgresStore; runtime: RuntimeService }> {
  if (databaseUrl === undefined) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');
  const db = new PostgresCli(databaseUrl);
  await reset(db);
  const store = new PostgresStore(db);
  return { db, store, runtime: new RuntimeService(store) };
}

if (databaseUrl === undefined) {
  test('PostgreSQL integration suite requires DATABASE_URL', () => {
    process.stdout.write('SKIP PostgreSQL integration: DATABASE_URL is not configured\n');
  });
} else {
  test('concurrent workers cannot both claim the same logical task', async () => {
    const { store, runtime } = await storeForTest();
    const version = await runtime.createWorkflow({ name: 'one-task', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    await runtime.startRun(version.id, null);
    const [left, right] = await Promise.all([
      store.claimTasks('worker-left', 1, 2000),
      store.claimTasks('worker-right', 1, 2000),
    ]);
    assert.equal(left.length + right.length, 1);
    const claim = left[0] ?? right[0];
    assert.ok(claim);
    const heartbeat = await store.heartbeat(claim, 2000);
    assert.equal(heartbeat.authoritative, true);
  });

  test('stale lease generation is fenced after expiry and recovery', async () => {
    const { db, store, runtime } = await storeForTest();
    const version = await runtime.createWorkflow({ name: 'fence', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const run = await runtime.startRun(version.id, null);
    const [g1] = await store.claimTasks('worker-1', 1, 5000);
    assert.ok(g1);
    const a1 = await store.beginAttempt(g1);
    await db.execute(`UPDATE queue_tasks SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = :'id';`, { id: g1.id });
    assert.equal(await store.recoverExpiredLeases(), 1);
    const [g2] = await store.claimTasks('worker-2', 1, 5000);
    assert.ok(g2);
    assert.ok(g2.leaseGeneration > g1.leaseGeneration);
    const a2 = await store.beginAttempt(g2);
    await store.finalizeSuccess(g2, a2.id, { generation: 2 });
    await assert.rejects(() => store.finalizeSuccess(g1, a1.id, { generation: 1 }), /lease|stale|authoritative/i);
    assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
    const events = await store.listEvents(run.id, { limit: 500 });
    assert.ok(events.some((event) => event.type === 'lease.recovered'));
    for (let index = 1; index < events.length; index += 1) assert.ok((events[index]?.sequence ?? 0) > (events[index - 1]?.sequence ?? 0));
  });

  test('failed SQL transaction rolls back instead of exposing a partial row', async () => {
    const { db } = await storeForTest();
    await assert.rejects(() => db.execute(`
BEGIN;
INSERT INTO workflow_definitions(id, name) VALUES ('rollback-probe', 'rollback-probe');
SELECT 1 / 0;
COMMIT;
`));
    const rows = await db.query(`SELECT count(*) FROM workflow_definitions WHERE id='rollback-probe';`);
    assert.equal(rows[0], '0');
  });

  test('a new store instance recovers persisted work after an expired in-flight lease', async () => {
    const { db, store, runtime } = await storeForTest();
    const version = await runtime.createWorkflow({ name: 'restart', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const run = await runtime.startRun(version.id, { durable: true });
    const [claim] = await store.claimTasks('old-worker', 1, 5000);
    assert.ok(claim);
    await store.beginAttempt(claim);
    await db.execute(`UPDATE queue_tasks SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = :'id';`, { id: claim.id });

    const restarted = new PostgresStore(new PostgresCli(databaseUrl));
    assert.equal((await restarted.getRun(run.id))?.state, 'RUNNING');
    assert.equal(await restarted.recoverExpiredLeases(), 1);
    const [replacement] = await restarted.claimTasks('replacement-worker', 1, 5000);
    assert.ok(replacement);
    const replacementAttempt = await restarted.beginAttempt(replacement);
    await restarted.finalizeSuccess(replacement, replacementAttempt.id, { recovered: true });
    assert.equal((await restarted.getRun(run.id))?.state, 'SUCCEEDED');
  });

  test('signal wait survives store recreation and duplicate signal is explicit', async () => {
    const { store, runtime } = await storeForTest();
    const version = await runtime.createWorkflow({ name: 'wait', steps: [
      { id: 'approval', kind: 'wait', signal: 'approved' },
      { id: 'after', kind: 'task', handler: 'echo', dependsOn: ['approval'] },
    ] });
    const run = await runtime.startRun(version.id, null);
    const [claim] = await store.claimTasks('wait-worker', 1, 5000);
    assert.ok(claim);
    const attempt = await store.beginAttempt(claim);
    await store.markWaiting(claim, attempt.id, 'approved');
    assert.equal((await store.getRun(run.id))?.state, 'WAITING');

    const restarted = new PostgresStore(new PostgresCli(databaseUrl));
    assert.equal((await restarted.submitSignal(run.id, 'approved', { reviewer: 'human' }, 'approval-1')).status, 'accepted');
    assert.equal((await restarted.submitSignal(run.id, 'approved', { reviewer: 'human' }, 'approval-1')).status, 'duplicate');
    const steps = await restarted.listStepRuns(run.id);
    assert.equal(steps.find((step) => step.stepId === 'approval')?.state, 'SUCCEEDED');
    assert.equal(steps.find((step) => step.stepId === 'after')?.state, 'READY');
  });

  test('retry exhaustion preserves all PostgreSQL attempt rows and fails terminally', async () => {
    const { store, runtime } = await storeForTest();
    const version = await runtime.createWorkflow({ name: 'exhaust', steps: [{
      id: 'x', kind: 'task', handler: 'always-fail', retry: { maxAttempts: 2, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0, retryableCodes: ['TEMP'] },
    }] });
    const run = await runtime.startRun(version.id, null);
    const tasks = new TaskRegistry();
    tasks.register('always-fail', async () => { throw new AgentForgeError({ code: 'TEMP', category: 'DEPENDENCY', message: 'temporary but persistent', retryable: true }); });
    const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'retry-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 5000, heartbeatMs: 500, pollMs: 10, gracefulShutdownMs: 100 });
    await worker.tick();
    await worker.tick();
    assert.equal((await store.getRun(run.id))?.state, 'FAILED');
    const attemptRows = await store.db.query(`SELECT count(*) FROM attempts;`);
    assert.equal(attemptRows[0], '2');
  });

  test('cancel-vs-complete race ends in one immutable terminal interpretation', async () => {
    const { store, runtime } = await storeForTest();
    const version = await runtime.createWorkflow({ name: 'cancel-race', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const run = await runtime.startRun(version.id, null);
    const [claim] = await store.claimTasks('race-worker', 1, 5000);
    assert.ok(claim);
    const attempt = await store.beginAttempt(claim);
    await Promise.allSettled([
      runtime.cancelRun(run.id),
      store.finalizeSuccess(claim, attempt.id, { completed: true }),
    ]);
    const finalRun = await store.getRun(run.id);
    assert.ok(finalRun !== null && ['SUCCEEDED', 'CANCELLED'].includes(finalRun.state));
    const steps = await store.listStepRuns(run.id);
    if (finalRun?.state === 'SUCCEEDED') assert.equal(steps[0]?.state, 'SUCCEEDED');
    if (finalRun?.state === 'CANCELLED') assert.equal(steps[0]?.state, 'CANCELLED');
  });
}
