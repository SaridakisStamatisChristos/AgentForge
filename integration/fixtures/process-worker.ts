import { AgentForgeError } from '@agentforge/contracts';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import { ProviderRegistry } from '@agentforge/providers';
import { TaskRegistry, Worker } from '@agentforge/runtime';
import { ToolRegistry } from '@agentforge/tools';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined) throw new Error('DATABASE_URL is required');

const tasks = new TaskRegistry();
tasks.register('process-delay', async (input, context) => {
  const raw = input.ms;
  const ms = typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : 1000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    context.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new AgentForgeError({ code: 'PROCESS_WORKER_ABORTED', category: 'CANCELLATION', message: 'process worker aborted' }));
    }, { once: true });
  });
  return { finished: true, ms };
});

const worker = new Worker(
  new PostgresStore(new PostgresCli(databaseUrl)),
  tasks,
  new ToolRegistry(),
  new ProviderRegistry(),
  {
    workerId: process.env.AGENTFORGE_WORKER_ID ?? `process-worker-${process.pid}`,
    concurrency: 1,
    claimBatchSize: 1,
    leaseMs: 5000,
    heartbeatMs: 500,
    pollMs: 10,
    gracefulShutdownMs: 100,
  },
);

await worker.run();
