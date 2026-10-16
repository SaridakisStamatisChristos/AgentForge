import { AgentForgeError, type JsonObject, type JsonValue } from '@agentforge/contracts';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import { DeterministicProvider, ProviderRegistry } from '@agentforge/providers';
import { DEFAULT_LIMITS, TaskRegistry, Worker } from '@agentforge/runtime';
import { ToolRegistry, jsonSchema } from '@agentforge/tools';

export type WorkerConfig = {
  databaseUrl: string;
  workerId: string;
  concurrency: number;
  claimBatchSize: number;
  pollMs: number;
  leaseMs: number;
  heartbeatMs: number;
  gracefulShutdownMs: number;
  maxPayloadBytes: number;
  maxCheckpointBytes: number;
};

function int(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new AgentForgeError({ code: 'INVALID_CONFIG', category: 'VALIDATION', message: `${name} must be an integer in [${min},${max}]` });
  return parsed;
}

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const concurrency = int(env.AGENTFORGE_WORKER_CONCURRENCY, 4, 1, 1024, 'AGENTFORGE_WORKER_CONCURRENCY');
  const leaseMs = int(env.AGENTFORGE_LEASE_MS, 10_000, 100, 3_600_000, 'AGENTFORGE_LEASE_MS');
  const heartbeatMs = int(env.AGENTFORGE_HEARTBEAT_MS, 2500, 10, leaseMs - 1, 'AGENTFORGE_HEARTBEAT_MS');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge',
    workerId: env.AGENTFORGE_WORKER_ID ?? `worker-${process.pid}`,
    concurrency,
    claimBatchSize: int(env.AGENTFORGE_CLAIM_BATCH_SIZE, Math.min(4, concurrency), 1, concurrency, 'AGENTFORGE_CLAIM_BATCH_SIZE'),
    pollMs: int(env.AGENTFORGE_POLL_MS, 250, 10, 60_000, 'AGENTFORGE_POLL_MS'),
    leaseMs,
    heartbeatMs,
    gracefulShutdownMs: int(env.AGENTFORGE_GRACEFUL_SHUTDOWN_MS, 5000, 0, 60_000, 'AGENTFORGE_GRACEFUL_SHUTDOWN_MS'),
    maxPayloadBytes: int(env.AGENTFORGE_MAX_PAYLOAD_BYTES, DEFAULT_LIMITS.maxPayloadBytes, 1024, 16_777_216, 'AGENTFORGE_MAX_PAYLOAD_BYTES'),
    maxCheckpointBytes: int(env.AGENTFORGE_MAX_CHECKPOINT_BYTES, DEFAULT_LIMITS.maxCheckpointBytes, 1024, 4_194_304, 'AGENTFORGE_MAX_CHECKPOINT_BYTES'),
  };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new AgentForgeError({ code: 'TASK_CANCELLED', category: 'CANCELLATION', message: 'Task cancelled' })); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

export function createDefaultTaskRegistry(): TaskRegistry {
  const tasks = new TaskRegistry();
  tasks.register('echo', async (input) => input);
  tasks.register('delay', async (input, context) => {
    const raw = input.ms;
    const ms = typeof raw === 'number' && Number.isSafeInteger(raw) ? Math.max(0, Math.min(60_000, raw)) : 100;
    await sleepAbortable(ms, context.signal);
    return { waitedMs: ms, input };
  });
  tasks.register('checkpoint-counter', async (input, context) => {
    const latest = await context.latestCheckpoint();
    const oldValue = latest !== null && typeof latest.payload === 'object' && latest.payload !== null && !Array.isArray(latest.payload) && typeof latest.payload.count === 'number' ? latest.payload.count : 0;
    const increment = typeof input.increment === 'number' && Number.isFinite(input.increment) ? input.increment : 1;
    const count = oldValue + increment;
    await context.checkpoint({ count }, 1);
    return { count };
  });
  return tasks;
}

export function createDefaultToolRegistry(): ToolRegistry {
  const tools = new ToolRegistry();
  const memo = new Map<string, JsonValue>();
  tools.register({
    name: 'echo',
    inputSchema: jsonSchema,
    outputSchema: jsonSchema,
    sideEffect: 'PURE',
    idempotency: 'NONE',
    async handler(input) { return input; },
  });
  tools.register({
    name: 'idempotent-memo',
    inputSchema: jsonSchema,
    outputSchema: jsonSchema,
    sideEffect: 'SIDE_EFFECTING',
    idempotency: 'OPERATION_KEY',
    async handler(input, context) {
      const key = context.idempotencyKey;
      if (key === undefined) throw new AgentForgeError({ code: 'MISSING_OPERATION_KEY', category: 'TOOL', message: 'Operation key required' });
      const existing = memo.get(key);
      if (existing !== undefined) return existing;
      const output: JsonObject = { acknowledged: true, input };
      memo.set(key, output);
      return output;
    },
  });
  return tools;
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  const providers = new ProviderRegistry();
  providers.register('deterministic', new DeterministicProvider([
    { kind: 'response', response: { finishReason: 'stop', text: 'deterministic-response' } },
  ]));
  return providers;
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const store = new PostgresStore(new PostgresCli(config.databaseUrl));
  const worker = new Worker(
    store,
    createDefaultTaskRegistry(),
    createDefaultToolRegistry(),
    createDefaultProviderRegistry(),
    {
      workerId: config.workerId,
      concurrency: config.concurrency,
      claimBatchSize: config.claimBatchSize,
      leaseMs: config.leaseMs,
      heartbeatMs: config.heartbeatMs,
      pollMs: config.pollMs,
      gracefulShutdownMs: config.gracefulShutdownMs,
    },
    { maxPayloadBytes: config.maxPayloadBytes, maxCheckpointBytes: config.maxCheckpointBytes, maxToolOutputBytes: config.maxPayloadBytes },
  );
  const shutdown = async () => { await worker.shutdown(); };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await worker.run();
}

if (process.argv[1]?.endsWith('/apps/worker/src/index.ts') || process.argv[1]?.endsWith('/apps/worker/dist/index.js')) void main();
