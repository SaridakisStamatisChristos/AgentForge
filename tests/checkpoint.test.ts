import test from 'node:test';
import assert from 'node:assert/strict';
import { DeterministicProvider, ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, TaskRegistry, Worker } from '@agentforge/runtime';
import { FakeClock, MemoryStore } from '@agentforge/testing';
import { ToolRegistry } from '@agentforge/tools';

test('runtime-owned agent checkpoint rejects unsupported version explicitly', async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const runtime = new RuntimeService(store);
  const version = await runtime.createWorkflow({
    name: 'checkpoint-version',
    steps: [{ id: 'agent', kind: 'agent', provider: 'deterministic', prompt: 'resume', maxIterations: 2 }],
  });
  const run = await runtime.startRun(version.id, null);
  const [claim] = await store.claimTasks('seed-worker', 1, 1000);
  assert.ok(claim);
  const attempt = await store.beginAttempt(claim);
  await store.writeCheckpoint({ claim, attemptId: attempt.id, version: 2, payload: { iteration: 1, messages: [] }, maxBytes: 4096 });
  clock.advance(1001);
  assert.equal(await store.recoverExpiredLeases(), 1);

  const providers = new ProviderRegistry();
  providers.register('deterministic', new DeterministicProvider([{ kind: 'response', response: { finishReason: 'stop', text: 'should-not-be-used' } }]));
  const worker = new Worker(store, new TaskRegistry(), new ToolRegistry(), providers, { workerId: 'resume-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 }, undefined, clock);
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
  assert.equal((await store.listStepRuns(run.id))[0]?.error?.code, 'CHECKPOINT_INCOMPATIBLE');
});

test('runtime-owned agent checkpoint rejects malformed message history explicitly', async () => {
  const clock = new FakeClock();
  const store = new MemoryStore(clock);
  const runtime = new RuntimeService(store);
  const version = await runtime.createWorkflow({
    name: 'checkpoint-shape',
    steps: [{ id: 'agent', kind: 'agent', provider: 'deterministic', prompt: 'resume', maxIterations: 2 }],
  });
  const run = await runtime.startRun(version.id, null);
  const [claim] = await store.claimTasks('seed-worker', 1, 1000);
  assert.ok(claim);
  const attempt = await store.beginAttempt(claim);
  await store.writeCheckpoint({ claim, attemptId: attempt.id, version: 1, payload: { iteration: 1, messages: [{ role: 'bogus', content: 123 }] }, maxBytes: 4096 });
  clock.advance(1001);
  await store.recoverExpiredLeases();

  const providers = new ProviderRegistry();
  providers.register('deterministic', new DeterministicProvider([{ kind: 'response', response: { finishReason: 'stop', text: 'should-not-be-used' } }]));
  const worker = new Worker(store, new TaskRegistry(), new ToolRegistry(), providers, { workerId: 'resume-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 }, undefined, clock);
  await worker.tick();
  assert.equal((await store.getRun(run.id))?.state, 'FAILED');
  assert.equal((await store.listStepRuns(run.id))[0]?.error?.code, 'CHECKPOINT_INCOMPATIBLE');
});
