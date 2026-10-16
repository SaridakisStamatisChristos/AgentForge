import { createApi } from '@agentforge/api';
import { ProviderRegistry } from '@agentforge/providers';
import { TaskRegistry, Worker } from '@agentforge/runtime';
import { AgentForgeClient, defineWorkflow } from '@agentforge/sdk';
import { MemoryStore } from '@agentforge/testing';
import { ToolRegistry } from '@agentforge/tools';

const store = new MemoryStore();
const api = createApi({ store, config: { host: '127.0.0.1', port: 0, eventPollMs: 25 }, log: () => undefined });
const address = await api.start();
const client = new AgentForgeClient({ baseUrl: `http://127.0.0.1:${address.port}`, requestIdFactory: () => 'example-hello' });

const tasks = new TaskRegistry();
tasks.register('echo', async (input) => input);
const worker = new Worker(
  store,
  tasks,
  new ToolRegistry(),
  new ProviderRegistry(),
  {
    workerId: 'hello-worker',
    concurrency: 2,
    claimBatchSize: 2,
    leaseMs: 1000,
    heartbeatMs: 100,
    pollMs: 10,
    gracefulShutdownMs: 100,
  },
);

try {
  const workflow = await client.createWorkflow(defineWorkflow({
    name: 'hello-workflow',
    steps: [
      { id: 'a', kind: 'task', handler: 'echo', input: { message: 'hello' } },
      { id: 'b', kind: 'task', handler: 'echo', dependsOn: ['a'], input: { fromA: '$steps.a.output.message' } },
      { id: 'c', kind: 'task', handler: 'echo', dependsOn: ['b'], input: { fromB: '$steps.b.output.fromA' } },
    ],
  }));
  const started = await client.startRun(workflow.id, { source: 'sdk-example' });

  for (let guard = 0; guard < 20; guard += 1) {
    const run = await client.getRun(started.id);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) break;
    const claimed = await worker.tick();
    if (claimed === 0) throw new Error(`hello-workflow stalled in state ${run.state}`);
  }

  const finished = await client.getRun(started.id);
  if (finished.state !== 'SUCCEEDED') throw new Error(`hello-workflow finished as ${finished.state}`);
  const steps = await client.listSteps(started.id);
  const streamed = [];
  for await (const event of client.liveEvents(started.id)) streamed.push(event);
  process.stdout.write(`${JSON.stringify({ run: finished, steps, eventTypes: streamed.map((event) => event.type) }, null, 2)}\n`);
} finally {
  await worker.shutdown();
  await api.stop();
}
