import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentForgeError,
  type LeaseClaim,
} from '@agentforge/contracts';
import { DeterministicProvider, ProviderRegistry, type ModelResponse } from '@agentforge/providers';
import {
  RuntimeService,
  SimulatedWorkerCrash,
  TaskRegistry,
  Worker,
} from '@agentforge/runtime';
import { FakeClock, MemoryStore, SequenceRandom } from '@agentforge/testing';
import { ToolRegistry, jsonSchema } from '@agentforge/tools';

function emptyProviders(): ProviderRegistry { return new ProviderRegistry(); }
function emptyTools(): ToolRegistry { return new ToolRegistry(); }

async function drain(worker: Worker, store: MemoryStore, runId: string, limit = 20): Promise<void> {
  for (let guard = 0; guard < limit; guard += 1) {
    const run = await store.getRun(runId);
    if (run !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) return;
    await worker.tick();
  }
  throw new Error('worker did not reach a terminal run state within the deterministic guard');
}

test('fan-out fan-in scheduling waits for every predecessor and event sequence is monotonic', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const order: string[] = [];
  const tasks = new TaskRegistry();
  for (const name of ['a', 'b', 'c', 'd']) tasks.register(name, async () => { order.push(name); return { name }; });
  const version = await runtime.createWorkflow({
    name: 'diamond',
    steps: [
      { id: 'a', kind: 'task', handler: 'a' },
      { id: 'b', kind: 'task', handler: 'b', dependsOn: ['a'] },
      { id: 'c', kind: 'task', handler: 'c', dependsOn: ['a'] },
      { id: 'd', kind: 'task', handler: 'd', dependsOn: ['b', 'c'] },
    ],
  });
  const run = await runtime.startRun(version.id, null);
  const worker = new Worker(store, tasks, emptyTools(), emptyProviders(), { workerId: 'w', concurrency: 4, claimBatchSize: 4, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await drain(worker, store, run.id);
  assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
  assert.equal(order[0], 'a');
  assert.equal(order[order.length - 1], 'd');
  assert.equal(new Set(order).size, 4);
  const events = await store.listEvents(run.id, { limit: 500 });
  for (let index = 1; index < events.length; index += 1) assert.ok((events[index]?.sequence ?? 0) > (events[index - 1]?.sequence ?? 0));
});

test('workflow run remains pinned to an immutable cloned workflow version', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const original = { name: 'pinned', steps: [{ id: 'a', kind: 'task' as const, handler: 'echo' }] };
  const version = await runtime.createWorkflow(original);
  original.name = 'mutated-after-create';
  original.steps[0] = { id: 'different', kind: 'task', handler: 'echo' };
  const run = await runtime.startRun(version.id, null);
  const context = await store.getExecutionContext((await store.listStepRuns(run.id))[0]?.id ?? 'missing');
  assert.equal(context.workflowVersion.id, version.id);
  assert.equal(context.workflowVersion.definition.name, 'pinned');
  assert.equal(context.workflowVersion.definition.steps[0]?.id, 'a');
});

test('single authoritative lease generation fences stale completion', async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const runtime = new RuntimeService(store);
  const version = await runtime.createWorkflow({ name: 'lease', steps: [{ id: 'a', kind: 'task', handler: 'echo' }] });
  const run = await runtime.startRun(version.id, null);
  const [first] = await store.claimTasks('worker-1', 1, 1000);
  assert.ok(first);
  const attempt1 = await store.beginAttempt(first);
  clock.advance(1001);
  assert.equal(await store.recoverExpiredLeases(), 1);
  const [second] = await store.claimTasks('worker-2', 1, 1000);
  assert.ok(second);
  assert.ok(second.leaseGeneration > first.leaseGeneration);
  const attempt2 = await store.beginAttempt(second);
  await store.finalizeSuccess(second, attempt2.id, { authority: 'g2' });
  await assert.rejects(() => store.finalizeSuccess(first, attempt1.id, { authority: 'g1' }), /Stale worker commit rejected/);
  assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
  assert.equal(store.snapshot().attempts.find((item) => item.id === attempt1.id)?.state, 'LEASE_LOST');
});

test('retry appends attempt history instead of overwriting the first failure', async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const runtime = new RuntimeService(store);
  let calls = 0;
  const tasks = new TaskRegistry();
  tasks.register('flaky', async () => {
    calls += 1;
    if (calls === 1) throw new AgentForgeError({ code: 'TEMP', category: 'DEPENDENCY', message: 'transient', retryable: true });
    return { ok: true };
  });
  const version = await runtime.createWorkflow({ name: 'retry', steps: [{ id: 'a', kind: 'task', handler: 'flaky', retry: { maxAttempts: 2, initialDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 0, retryableCodes: ['TEMP'] } }] });
  const run = await runtime.startRun(version.id, null);
  const worker = new Worker(store, tasks, emptyTools(), emptyProviders(), { workerId: 'retry-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 }, undefined, clock, new SequenceRandom([0.5]));
  await drain(worker, store, run.id);
  const attempts = store.snapshot().attempts;
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.state, 'FAILED');
  assert.equal(attempts[1]?.state, 'SUCCEEDED');
});

test('cancellation is monotonic and revokes an already-running attempt', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const version = await runtime.createWorkflow({ name: 'cancel', steps: [{ id: 'a', kind: 'task', handler: 'echo' }, { id: 'b', kind: 'task', handler: 'echo', dependsOn: ['a'] }] });
  const run = await runtime.startRun(version.id, null);
  const [claim] = await store.claimTasks('worker', 1, 1000);
  assert.ok(claim);
  const attempt = await store.beginAttempt(claim);
  const cancelled = await runtime.cancelRun(run.id);
  assert.equal(cancelled.state, 'CANCELLED');
  await assert.rejects(() => store.finalizeSuccess(claim, attempt.id, { tooLate: true }), /Cancellation revoked commit authority|Stale worker commit rejected/);
  assert.equal((await store.getRun(run.id))?.state, 'CANCELLED');
  assert.equal((await store.listStepRuns(run.id)).some((step) => step.stepId === 'b' && step.state === 'SUCCEEDED'), false);
});

test('concurrency key prevents overlapping authoritative leases', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const version = await runtime.createWorkflow({ name: 'serial-resource', steps: [
    { id: 'a', kind: 'task', handler: 'echo', concurrencyKey: 'tenant:1' },
    { id: 'b', kind: 'task', handler: 'echo', concurrencyKey: 'tenant:1' },
  ] });
  await runtime.startRun(version.id, null);
  const claims = await store.claimTasks('worker', 2, 1000);
  assert.equal(claims.length, 1);
});

test('wait state is durable, duplicate signal is explicit, and late signal fails closed', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const tasks = new TaskRegistry();
  tasks.register('echo', async (input) => input);
  const version = await runtime.createWorkflow({ name: 'signal', steps: [
    { id: 'wait', kind: 'wait', signal: 'approved' },
    { id: 'after', kind: 'task', handler: 'echo', dependsOn: ['wait'], input: { signalPayload: '$steps.wait.output' } },
  ] });
  const run = await runtime.startRun(version.id, null);
  const worker = new Worker(store, tasks, emptyTools(), emptyProviders(), { workerId: 'w', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'WAITING');
  assert.equal((await runtime.signal(run.id, 'approved', { by: 'human' }, 'signal-1')).status, 'accepted');
  assert.equal((await runtime.signal(run.id, 'approved', { by: 'human' }, 'signal-1')).status, 'duplicate');
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
  await assert.rejects(() => runtime.signal(run.id, 'approved', { late: true }, 'signal-2'), /No waiting step accepts/);
});

test('side-effect crash boundary reuses durable completed invocation after lease recovery', async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
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
  const version = await runtime.createWorkflow({ name: 'side-effect', steps: [{ id: 'charge', kind: 'tool', tool: 'charge', operationKey: 'order-42' }] });
  const run = await runtime.startRun(version.id, null);
  const crashing = new Worker(store, new TaskRegistry(), tools, emptyProviders(), { workerId: 'w1', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 }, undefined, clock, undefined, {
    afterToolInvocationBeforeStepCommit: async () => { throw new SimulatedWorkerCrash(); },
  });
  await crashing.tick();
  assert.equal(externalEffects, 1);
  clock.advance(1001);
  const recovery = new Worker(store, new TaskRegistry(), tools, emptyProviders(), { workerId: 'w2', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 }, undefined, clock);
  await recovery.tick();
  assert.equal((await store.getRun(run.id))?.state, 'SUCCEEDED');
  assert.equal(externalEffects, 1);
  assert.ok(store.snapshot().events.some((event) => event.type === 'lease.recovered'));
});

test('checkpoint payload is size bounded', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const version = await runtime.createWorkflow({ name: 'checkpoint', steps: [{ id: 'a', kind: 'task', handler: 'echo' }] });
  await runtime.startRun(version.id, null);
  const [claim] = await store.claimTasks('w', 1, 1000);
  assert.ok(claim);
  const attempt = await store.beginAttempt(claim);
  await assert.rejects(() => store.writeCheckpoint({ claim, attemptId: attempt.id, version: 1, payload: { data: 'x'.repeat(100) }, maxBytes: 16 }), /Checkpoint too large/);
});

test('timeout is distinct from cancellation and an abort-ignoring handler cannot commit success later', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const tasks = new TaskRegistry();
  tasks.register('slow-ignore-abort', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return { late: true };
  });
  const version = await runtime.createWorkflow({ name: 'timeout', steps: [{ id: 'a', kind: 'task', handler: 'slow-ignore-abort', timeout: { timeoutMs: 5 } }] });
  const run = await runtime.startRun(version.id, null);
  const worker = new Worker(store, tasks, emptyTools(), emptyProviders(), { workerId: 'w', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
  assert.equal(store.snapshot().attempts[0]?.state, 'TIMED_OUT');
  await new Promise<void>((resolve) => setTimeout(resolve, 25));
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
});

test('malformed provider output fails explicitly', async () => {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const providers = new ProviderRegistry();
  providers.register('bad', new DeterministicProvider([
    { kind: 'response', response: ({ finishReason: 'stop' } as unknown as ModelResponse) },
  ]));
  const version = await runtime.createWorkflow({ name: 'provider', steps: [{ id: 'm', kind: 'model', provider: 'bad', prompt: 'test' }] });
  const run = await runtime.startRun(version.id, null);
  const worker = new Worker(store, new TaskRegistry(), emptyTools(), providers, { workerId: 'w', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
  assert.equal((await store.listStepRuns(run.id))[0]?.error?.code, 'MALFORMED_PROVIDER_RESPONSE');
});

test('SIDE_EFFECTING tool registration requires explicit operation-key idempotency', () => {
  const tools = new ToolRegistry();
  assert.throws(() => tools.register({
    name: 'unsafe',
    sideEffect: 'SIDE_EFFECTING',
    idempotency: 'NONE',
    inputSchema: jsonSchema,
    async handler(input) { return input; },
  }), /OPERATION_KEY/);
});
