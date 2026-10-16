import { ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, TaskRegistry, Worker } from '@agentforge/runtime';
import { MemoryStore } from '@agentforge/testing';
import { ToolRegistry } from '@agentforge/tools';

type Result = {
  scenario: string;
  workers: number;
  runs: number;
  stepsPerRun: number;
  durationMs: number;
  runsPerSecond: number;
  stepsPerSecond: number;
};

async function runScenario(workers: number, runs: number, stepsPerRun: number): Promise<Result> {
  const store = new MemoryStore();
  const runtime = new RuntimeService(store);
  const tasks = new TaskRegistry();
  tasks.register('noop', async () => ({}));
  const steps = Array.from({ length: stepsPerRun }, (_value, index) => ({
    id: `s${index}`,
    kind: 'task' as const,
    handler: 'noop',
    ...(index === 0 ? {} : { dependsOn: [`s${index - 1}`] }),
  }));
  const version = await runtime.createWorkflow({ name: `bench-${stepsPerRun}`, steps });
  const runIds: string[] = [];
  for (let index = 0; index < runs; index += 1) runIds.push((await runtime.startRun(version.id, { index })).id);
  const pool = Array.from({ length: workers }, (_value, index) => new Worker(
    store,
    tasks,
    new ToolRegistry(),
    new ProviderRegistry(),
    { workerId: `bench-worker-${index}`, concurrency: 8, claimBatchSize: 8, leaseMs: 5000, heartbeatMs: 500, pollMs: 1, gracefulShutdownMs: 100 },
  ));
  const start = performance.now();
  for (let guard = 0; guard < runs * stepsPerRun + 100; guard += 1) {
    const states = await Promise.all(runIds.map((id) => store.getRun(id)));
    if (states.every((run) => run?.state === 'SUCCEEDED')) break;
    await Promise.all(pool.map((worker) => worker.tick()));
  }
  const durationMs = Math.max(0.001, performance.now() - start);
  const states = await Promise.all(runIds.map((id) => store.getRun(id)));
  if (!states.every((run) => run?.state === 'SUCCEEDED')) throw new Error('benchmark did not complete every run');
  return {
    scenario: 'deterministic-memory-small-dag',
    workers,
    runs,
    stepsPerRun,
    durationMs: Number(durationMs.toFixed(3)),
    runsPerSecond: Number(((runs * 1000) / durationMs).toFixed(2)),
    stepsPerSecond: Number(((runs * stepsPerRun * 1000) / durationMs).toFixed(2)),
  };
}

const smoke = process.argv.includes('--smoke');
const runs = smoke ? 20 : 250;
const stepsPerRun = smoke ? 3 : 5;
const workerCounts = smoke ? [1, 4] : [1, 2, 4, 8];
const results: Result[] = [];
for (const workers of workerCounts) results.push(await runScenario(workers, runs, stepsPerRun));

process.stdout.write(`${JSON.stringify({
  benchmark: 'AgentForge internal deterministic runtime benchmark',
  scope: 'In-memory correctness-oriented scheduler only; not PostgreSQL throughput and not a comparison with another product.',
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  parameters: { runs, stepsPerRun, workerCounts, smoke },
  results,
}, null, 2)}\n`);
