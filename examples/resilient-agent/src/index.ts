import { DeterministicProvider, ProviderRegistry } from '@agentforge/providers';
import { RuntimeService, TaskRegistry, Worker } from '@agentforge/runtime';
import { FakeClock, MemoryStore, SequenceRandom } from '@agentforge/testing';
import { ToolRegistry, jsonSchema } from '@agentforge/tools';

const clock = new FakeClock();
const random = new SequenceRandom([0.5]);
const store = new MemoryStore(clock);
const runtime = new RuntimeService(store);
const providers = new ProviderRegistry();
providers.register('deterministic', new DeterministicProvider([
  { kind: 'error', code: 'TRANSIENT_MODEL_FAILURE', message: 'synthetic transient provider failure', retryable: true },
  { kind: 'response', response: { finishReason: 'tool_call', toolCall: { name: 'echo', input: { value: 'recovered' } } } },
  { kind: 'response', response: { finishReason: 'stop', text: 'agent completed after retry' } },
]));
const tools = new ToolRegistry();
tools.register({
  name: 'echo',
  sideEffect: 'PURE',
  idempotency: 'NONE',
  inputSchema: jsonSchema,
  outputSchema: jsonSchema,
  async handler(input) { return input; },
});

const workflow = await runtime.createWorkflow({
  name: 'resilient-agent',
  steps: [{
    id: 'agent',
    kind: 'agent',
    provider: 'deterministic',
    prompt: 'Use the echo tool when requested, then finish.',
    maxIterations: 4,
    allowedTools: ['echo'],
    retry: { maxAttempts: 2, initialDelayMs: 0, backoffMultiplier: 2, maxDelayMs: 0, retryableCodes: ['TRANSIENT_MODEL_FAILURE'] },
  }],
});
const run = await runtime.startRun(workflow.id, { request: 'prove retry recovery' });
const worker = new Worker(
  store,
  new TaskRegistry(),
  tools,
  providers,
  { workerId: 'resilient-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 },
  undefined,
  clock,
  random,
);

for (let guard = 0; guard < 10; guard += 1) {
  const current = await store.getRun(run.id);
  if (current !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.state)) break;
  await worker.tick();
}

const finished = await store.getRun(run.id);
const snapshot = store.snapshot();
if (finished?.state !== 'SUCCEEDED') throw new Error(`resilient-agent finished as ${finished?.state ?? 'missing'}`);
if (snapshot.attempts.length !== 2) throw new Error(`expected two durable attempts, observed ${snapshot.attempts.length}`);
process.stdout.write(`${JSON.stringify({ run: finished, attempts: snapshot.attempts, events: snapshot.events.map((event) => event.type) }, null, 2)}\n`);
