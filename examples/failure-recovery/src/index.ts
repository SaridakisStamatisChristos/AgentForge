import { type LeaseClaim } from '@agentforge/contracts';
import { ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, SimulatedWorkerCrash, TaskRegistry, Worker } from '@agentforge/runtime';
import { FakeClock, MemoryStore } from '@agentforge/testing';
import { ToolRegistry } from '@agentforge/tools';

const clock = new FakeClock();
const store = new MemoryStore(clock);
const runtime = new RuntimeService(store);
let firstStepExecutions = 0;
let downstreamExecutions = 0;

const workflow = await runtime.createWorkflow({
  name: 'failure-recovery',
  steps: [
    { id: 'x', kind: 'task', handler: 'step-x' },
    { id: 'y', kind: 'task', handler: 'step-y', dependsOn: ['x'] },
  ],
});
const run = await runtime.startRun(workflow.id, { demo: true });

const tasks = new TaskRegistry();
tasks.register('step-x', async () => {
  firstStepExecutions += 1;
  return { execution: firstStepExecutions };
});
tasks.register('step-y', async () => {
  downstreamExecutions += 1;
  return { execution: downstreamExecutions };
});

const worker1 = new Worker(
  store,
  tasks,
  new ToolRegistry(),
  new ProviderRegistry(),
  { workerId: 'worker-1', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 },
  undefined,
  clock,
  undefined,
  { afterExecutionBeforeCommit: async () => { throw new SimulatedWorkerCrash('crash after execution before commit'); } },
);
await worker1.tick();

const afterCrash = store.snapshot();
const leased = afterCrash.queues.find((task) => task.state === 'LEASED');
const oldAttempt = afterCrash.attempts.find((attempt) => attempt.state === 'RUNNING');
if (leased?.leaseOwner === undefined || leased.leaseExpiresAt === undefined || oldAttempt === undefined) {
  throw new Error('worker-1 did not leave an in-flight leased attempt');
}
const staleClaim: LeaseClaim = {
  ...leased,
  state: 'LEASED',
  leaseOwner: leased.leaseOwner,
  leaseExpiresAt: leased.leaseExpiresAt,
};

clock.advance(1001);
const worker2 = new Worker(
  store,
  tasks,
  new ToolRegistry(),
  new ProviderRegistry(),
  { workerId: 'worker-2', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 },
  undefined,
  clock,
);
await worker2.tick();

let staleCommitRejected = false;
try {
  await store.finalizeSuccess(staleClaim, oldAttempt.id, { stale: true });
} catch (error) {
  staleCommitRejected = error instanceof Error && error.message.includes('Stale worker commit rejected');
}
if (!staleCommitRejected) throw new Error('stale generation G1 was not fenced after G2 recovery');

await worker2.tick();
const finished = await store.getRun(run.id);
const finalSnapshot = store.snapshot();
if (finished?.state !== 'SUCCEEDED') throw new Error(`failure-recovery finished as ${finished?.state ?? 'missing'}`);
if (downstreamExecutions !== 1) throw new Error(`downstream step executed ${downstreamExecutions} times`);
if (!finalSnapshot.events.some((event) => event.type === 'lease.recovered')) throw new Error('recovery event missing');
if (!finalSnapshot.attempts.some((attempt) => attempt.state === 'LEASE_LOST')) throw new Error('lost attempt history missing');

process.stdout.write(`${JSON.stringify({
  run: finished,
  firstStepExecutions,
  downstreamExecutions,
  staleCommitRejected,
  attempts: finalSnapshot.attempts,
  events: finalSnapshot.events.map((event) => ({ sequence: event.sequence, type: event.type })),
}, null, 2)}\n`);
