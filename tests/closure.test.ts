import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApiConfig } from '@agentforge/api';
import { type ExecutionEvent, AgentForgeError } from '@agentforge/contracts';
import { pumpEvents, type EventSink, type EventSource } from '@agentforge/events';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import { DeterministicProvider, ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, TaskRegistry, Worker } from '@agentforge/runtime';
import { createToolRegistry, defineWorkflow } from '@agentforge/sdk';
import { FakeClock, MemoryStore } from '@agentforge/testing';
import { ToolRegistry, jsonSchema } from '@agentforge/tools';
import { loadWorkerConfig } from '../apps/worker/src/index.ts';

test('SDK workflow helper validates and embedded tool registry is usable', () => {
  assert.throws(() => defineWorkflow({ name: 'invalid', steps: [] }), /step|workflow/i);
  const registry = createToolRegistry([{
    name: 'echo',
    sideEffect: 'PURE',
    idempotency: 'NONE',
    inputSchema: jsonSchema,
    outputSchema: jsonSchema,
    async handler(input) { return input; },
  }]);
  assert.equal(registry.get('echo').name, 'echo');
});

test('event sink boundary drains ordered durable events with a bounded cursor', async () => {
  const events: ExecutionEvent[] = [1, 2].map((sequence) => ({
    id: `e${sequence}`,
    runId: 'run-1',
    type: 'workflow.started',
    timestamp: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    sequence,
    payload: {},
  }));
  const source: EventSource = {
    async listEvents(_runId, options = {}) {
      return events.filter((event) => event.sequence > (options.after ?? 0)).slice(0, options.limit ?? 100);
    },
  };
  const delivered: number[] = [];
  const sink: EventSink = {
    name: 'test-sink',
    async deliver(_runId, batch) { delivered.push(...batch.map((event) => event.sequence)); },
  };
  assert.equal(await pumpEvents(source, sink, 'run-1', { batchSize: 1, maxBatches: 3 }), 2);
  assert.deepEqual(delivered, [1, 2]);
});

test('provider timeout is classified as TIMED_OUT and cannot later succeed', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const providers = new ProviderRegistry();
  providers.register('slow', new DeterministicProvider([{ kind: 'response', response: { finishReason: 'stop', text: 'late' }, delayMs: 50 }]));
  const workflow = await runtime.createWorkflow({ name: 'provider-timeout', steps: [{ id: 'model', kind: 'model', provider: 'slow', prompt: 'slow', timeout: { timeoutMs: 5 } }] });
  const run = await runtime.startRun(workflow.id, null);
  const worker = new Worker(store, new TaskRegistry(), new ToolRegistry(), providers, { workerId: 'provider-timeout', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
  assert.equal(store.snapshot().attempts[0]?.state, 'TIMED_OUT');
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
});

async function assertToolFailure(handler: () => Promise<unknown>): Promise<void> {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const tools = new ToolRegistry();
  tools.register({
    name: 'boom',
    sideEffect: 'PURE',
    idempotency: 'NONE',
    inputSchema: jsonSchema,
    async handler() { return await handler(); },
  });
  const workflow = await runtime.createWorkflow({ name: 'tool-failure', steps: [{ id: 'tool', kind: 'tool', tool: 'boom' }] });
  const run = await runtime.startRun(workflow.id, null);
  const worker = new Worker(store, new TaskRegistry(), tools, new ProviderRegistry(), { workerId: 'tool-failure', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
  assert.equal((await store.listStepRuns(run.id))[0]?.error?.category, 'TOOL');
}

test('synchronous tool throw is captured as a tool failure', async () => {
  await assertToolFailure(async () => { throw new Error('sync-shaped tool throw'); });
});

test('asynchronous tool rejection is captured as a tool failure', async () => {
  await assertToolFailure(() => Promise.reject(new Error('async tool rejection')));
});

test('graceful shutdown revokes active work and later recovery completes it', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  let calls = 0;
  const tasks = new TaskRegistry();
  tasks.register('interruptible', async (_input, context) => {
    calls += 1;
    if (calls > 1) return { recovered: true };
    return await new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new AgentForgeError({ code: 'TASK_CANCELLED', category: 'CANCELLATION', message: 'worker shutting down' })), { once: true });
    });
  });
  const workflow = await runtime.createWorkflow({ name: 'shutdown-recovery', steps: [{ id: 'x', kind: 'task', handler: 'interruptible' }] });
  const run = await runtime.startRun(workflow.id, null);
  const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'shutdown-1', concurrency: 1, claimBatchSize: 1, leaseMs: 40, heartbeatMs: 10, pollMs: 5, gracefulShutdownMs: 100 });
  const ticking = worker.tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  await worker.shutdown();
  await ticking;
  await new Promise<void>((resolve) => setTimeout(resolve, 45));
  const recovery = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'shutdown-2', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 5, gracefulShutdownMs: 100 });
  await recovery.tick();
  assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
  assert.ok(store.snapshot().attempts.some((attempt) => attempt.state === 'LEASE_LOST'));
});

test('valid runtime-owned checkpoint resumes an agent after lease recovery', async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const runtime = new RuntimeService(store);
  const workflow = await runtime.createWorkflow({ name: 'resume-valid', steps: [{ id: 'agent', kind: 'agent', provider: 'deterministic', prompt: 'resume', maxIterations: 2 }] });
  const run = await runtime.startRun(workflow.id, null);
  const [claim] = await store.claimTasks('seed', 1, 1000);
  assert.ok(claim);
  const attempt = await store.beginAttempt(claim);
  await store.writeCheckpoint({ claim, attemptId: attempt.id, version: 1, payload: { iteration: 1, messages: [{ role: 'user', content: 'resume' }] }, maxBytes: 4096 });
  clock.advance(1001);
  assert.equal(await store.recoverExpiredLeases(), 1);
  const providers = new ProviderRegistry();
  providers.register('deterministic', new DeterministicProvider([{ kind: 'response', response: { finishReason: 'stop', text: 'resumed' } }]));
  const worker = new Worker(store, new TaskRegistry(), new ToolRegistry(), providers, { workerId: 'resume', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 }, undefined, clock);
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
  assert.equal((await store.listStepRuns(run.id))[0]?.output !== undefined, true);
});

test('database loss during claim and commit fails closed', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const workflow = await runtime.createWorkflow({ name: 'db-loss', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
  await runtime.startRun(workflow.id, null);
  store.setDatabaseAvailable(false);
  await assert.rejects(() => store.claimTasks('w', 1, 1000), /database unavailable/i);
  store.setDatabaseAvailable(true);
  const [claim] = await store.claimTasks('w', 1, 1000);
  assert.ok(claim);
  const attempt = await store.beginAttempt(claim);
  store.setDatabaseAvailable(false);
  await assert.rejects(() => store.finalizeSuccess(claim, attempt.id, { ok: true }), /database unavailable/i);
});

test('Postgres client dependency failure is explicit and retryable at claim boundary', async () => {
  const store = new PostgresStore(new PostgresCli('postgresql://agentforge:agentforge@127.0.0.1:1/agentforge', 'false'));
  await assert.rejects(() => store.claimTasks('w', 1, 1000), /PostgreSQL command failed|psql/i);
});

test('invalid API and worker environment configuration is rejected', () => {
  assert.throws(() => loadApiConfig({ AGENTFORGE_API_PORT: 'not-a-number' }), /AGENTFORGE_API_PORT/);
  assert.throws(() => loadWorkerConfig({ AGENTFORGE_WORKER_CONCURRENCY: '0' }), /AGENTFORGE_WORKER_CONCURRENCY/);
  assert.throws(() => loadWorkerConfig({ AGENTFORGE_LEASE_MS: '100', AGENTFORGE_HEARTBEAT_MS: '100' }), /AGENTFORGE_HEARTBEAT_MS/);
});
