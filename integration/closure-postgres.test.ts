import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '@agentforge/api';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import { ToolDefinitionStore } from '@agentforge/persistence/tool-definitions';
import { ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, SimulatedWorkerCrash, TaskRegistry, Worker } from '@agentforge/runtime';
import { ToolRegistry, jsonSchema } from '@agentforge/tools';

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
  worker_heartbeats,
  tool_definitions
RESTART IDENTITY CASCADE;
`);
}

if (databaseUrl === undefined) {
  test('closure PostgreSQL suite requires DATABASE_URL', () => {
    process.stdout.write('SKIP closure PostgreSQL integration: DATABASE_URL is not configured\n');
  });
} else {
  test('run idempotency survives API/store restart and conflicts fail closed', async () => {
    const db = new PostgresCli(databaseUrl);
    await reset(db);
    const firstStore = new PostgresStore(db);
    const runtime = new RuntimeService(firstStore);
    const workflow = await runtime.createWorkflow({ name: 'api-idempotency', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const api1 = createApi({ store: firstStore, config: { host: '127.0.0.1', port: 0, eventPollMs: 10, maxBodyBytes: 1_048_576 }, log: () => undefined });
    const address1 = await api1.start();
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'restart-key' },
      body: JSON.stringify({ workflowVersionId: workflow.id, input: { value: 1 } }),
    };
    const firstResponse = await fetch(`http://127.0.0.1:${address1.port}/v1/runs`, request);
    const firstRun = await firstResponse.json() as { id: string };
    assert.equal(firstResponse.status, 201);
    await api1.stop();

    const restartedStore = new PostgresStore(new PostgresCli(databaseUrl));
    const api2 = createApi({ store: restartedStore, config: { host: '127.0.0.1', port: 0, eventPollMs: 10, maxBodyBytes: 1_048_576 }, log: () => undefined });
    const address2 = await api2.start();
    try {
      const replay = await fetch(`http://127.0.0.1:${address2.port}/v1/runs`, request);
      const replayRun = await replay.json() as { id: string };
      assert.equal(replay.status, 201);
      assert.equal(replay.headers.get('idempotency-replayed'), 'true');
      assert.equal(replayRun.id, firstRun.id);
      const conflict = await fetch(`http://127.0.0.1:${address2.port}/v1/runs`, {
        ...request,
        body: JSON.stringify({ workflowVersionId: workflow.id, input: { value: 2 } }),
      });
      assert.equal(conflict.status, 409);
      const count = await restartedStore.db.query('SELECT count(*) FROM workflow_runs;');
      assert.equal(count[0], '1');
    } finally {
      await api2.stop();
    }
  });

  test('PostgreSQL side-effect invocation is reused after crash recovery', async () => {
    const db = new PostgresCli(databaseUrl);
    await reset(db);
    const store = new PostgresStore(db);
    const runtime = new RuntimeService(store);
    let externalEffects = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: 'charge',
      sideEffect: 'SIDE_EFFECTING',
      idempotency: 'OPERATION_KEY',
      inputSchema: jsonSchema,
      outputSchema: jsonSchema,
      async handler(_input, context) {
        externalEffects += 1;
        return { receipt: context.idempotencyKey ?? 'missing' };
      },
    });
    const workflow = await runtime.createWorkflow({ name: 'pg-side-effect', steps: [{ id: 'charge', kind: 'tool', tool: 'charge', operationKey: 'order-42' }] });
    const run = await runtime.startRun(workflow.id, null);
    const crashing = new Worker(store, new TaskRegistry(), tools, new ProviderRegistry(), { workerId: 'pg-crash-1', concurrency: 1, claimBatchSize: 1, leaseMs: 5000, heartbeatMs: 500, pollMs: 10, gracefulShutdownMs: 100 }, undefined, undefined, undefined, {
      afterToolInvocationBeforeStepCommit: async () => { throw new SimulatedWorkerCrash(); },
    });
    await crashing.tick();
    assert.equal(externalEffects, 1);
    await db.execute("UPDATE queue_tasks SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE run_id = :'run_id';", { run_id: run.id });
    const recovery = new Worker(store, new TaskRegistry(), tools, new ProviderRegistry(), { workerId: 'pg-crash-2', concurrency: 1, claimBatchSize: 1, leaseMs: 5000, heartbeatMs: 500, pollMs: 10, gracefulShutdownMs: 100 });
    await recovery.tick();
    assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
    assert.equal(externalEffects, 1);
  });

  test('durable tool definitions persist across store instances and reject version drift', async () => {
    const db = new PostgresCli(databaseUrl);
    await reset(db);
    const definitions = new ToolDefinitionStore(db);
    const created = await definitions.register({ name: 'durable-echo', sideEffect: 'PURE', idempotency: 'NONE', description: 'test tool', inputSchemaDescription: 'finite JSON' });
    const restarted = new ToolDefinitionStore(new PostgresCli(databaseUrl));
    const loaded = await restarted.get('durable-echo', 1);
    assert.equal(loaded?.id, created.id);
    assert.equal(loaded?.description, 'test tool');
    await assert.rejects(() => restarted.register({ name: 'durable-echo', sideEffect: 'IDEMPOTENT', idempotency: 'NONE' }), /different metadata|conflict/i);
  });

  test('metrics expose durable outcomes, attempts, retries, lease recovery and queue depth', async () => {
    const db = new PostgresCli(databaseUrl);
    await reset(db);
    const store = new PostgresStore(db);
    const runtime = new RuntimeService(store);
    const tasks = new TaskRegistry();
    tasks.register('echo', async (input) => input);
    const workflow = await runtime.createWorkflow({ name: 'metrics', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const run = await runtime.startRun(workflow.id, { value: 1 });
    const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'metrics-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 5000, heartbeatMs: 500, pollMs: 10, gracefulShutdownMs: 100 });
    await worker.tick();
    assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
    const api = createApi({ store, config: { host: '127.0.0.1', port: 0, eventPollMs: 10, maxBodyBytes: 1_048_576 }, log: () => undefined });
    const address = await api.start();
    try {
      const text = await (await fetch(`http://127.0.0.1:${address.port}/metrics`)).text();
      assert.match(text, /agentforge_runs_outcome_total\{state="SUCCEEDED"\} 1/);
      assert.match(text, /agentforge_attempts_total 1/);
      assert.match(text, /agentforge_retries_total 0/);
      assert.match(text, /agentforge_lease_recoveries_total 0/);
      assert.match(text, /agentforge_queue_ready_depth 0/);
    } finally {
      await api.stop();
    }
  });

  test('migration ledger records both schema versions exactly once', async () => {
    const db = new PostgresCli(databaseUrl);
    const versions = await db.query('SELECT version FROM schema_migrations ORDER BY version;');
    assert.deepEqual(versions, ['0001_initial', '0002_tool_definitions']);
  });
}
