import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '@agentforge/api';
import { API_ROUTE_KEYS, OPENAPI_DOCUMENT } from '@agentforge/api/openapi';
import { ProviderRegistry } from '@agentforge/providers';
import { TaskRegistry, Worker } from '@agentforge/runtime';
import { AgentForgeClient } from '@agentforge/sdk';
import { MemoryStore } from '@agentforge/testing';
import { ToolRegistry } from '@agentforge/tools';

async function withApi<T>(store: MemoryStore, fn: (baseUrl: string) => Promise<T>, maxBodyBytes = 1_048_576): Promise<T> {
  const api = createApi({ store, config: { host: '127.0.0.1', port: 0, eventPollMs: 10, maxBodyBytes }, log: () => undefined });
  const address = await api.start();
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await api.stop();
  }
}

test('health liveness is independent from readiness', async () => {
  const store = new MemoryStore();
  store.setDatabaseAvailable(false);
  await withApi(store, async (baseUrl) => {
    const live = await fetch(`${baseUrl}/health/live`);
    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(live.status, 200);
    assert.equal(ready.status, 503);
  });
});

test('stable API error envelope echoes caller request id', async () => {
  const store = new MemoryStore();
  await withApi(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/runs/missing`, { headers: { 'x-request-id': 'req-test' } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-request-id'), 'req-test');
    const body = await response.json() as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'RUN_NOT_FOUND');
    assert.equal(body.error.requestId, 'req-test');
  });
});

test('SDK exercises public HTTP workflow and run lifecycle', async () => {
  const store = new MemoryStore();
  const tasks = new TaskRegistry();
  tasks.register('echo', async (input) => input);
  const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'sdk-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await withApi(store, async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl, requestIdFactory: () => 'sdk-request' });
    const workflow = await client.createWorkflow({ name: 'sdk', steps: [{ id: 'echo', kind: 'task', handler: 'echo', input: { value: '$run.input.value' } }] });
    const run = await client.startRun(workflow.id, { value: 'hello' });
    await worker.tick();
    assert.equal((await client.getRun(run.id)).state, 'SUCCEEDED');
    assert.equal((await client.listSteps(run.id))[0]?.state, 'SUCCEEDED');
    assert.ok((await client.listEvents(run.id, { limit: 100 })).events.length > 0);
  });
});

test('durable signal endpoint deduplicates and resumes the workflow', async () => {
  const store = new MemoryStore();
  const worker = new Worker(store, new TaskRegistry(), new ToolRegistry(), new ProviderRegistry(), { workerId: 'signal-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await withApi(store, async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl });
    const workflow = await client.createWorkflow({ name: 'wait', steps: [{ id: 'approval', kind: 'wait', signal: 'approved' }] });
    const run = await client.startRun(workflow.id, null);
    await worker.tick();
    assert.equal((await client.getRun(run.id)).state, 'WAITING');
    assert.equal((await client.sendSignal(run.id, 'approved', { ok: true }, 'dedupe')).status, 'accepted');
    assert.equal((await client.sendSignal(run.id, 'approved', { ok: true }, 'dedupe')).status, 'duplicate');
    assert.equal((await client.getRun(run.id)).state, 'SUCCEEDED');
  });
});

test('event history pagination returns monotonic pages', async () => {
  const store = new MemoryStore();
  const tasks = new TaskRegistry();
  tasks.register('echo', async (input) => input);
  const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'page-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await withApi(store, async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl });
    const workflow = await client.createWorkflow({ name: 'events', steps: [{ id: 'a', kind: 'task', handler: 'echo' }] });
    const run = await client.startRun(workflow.id, null);
    await worker.tick();
    const first = await client.listEvents(run.id, { limit: 2 });
    assert.equal(first.events.length, 2);
    assert.ok(first.nextAfter);
    const second = await client.listEvents(run.id, { after: first.nextAfter, limit: 100 });
    assert.ok(second.events.length > 0);
    assert.ok((second.events[0]?.sequence ?? 0) > (first.events.at(-1)?.sequence ?? 0));
  });
});

test('SSE replays ordered durable events', async () => {
  const store = new MemoryStore();
  const tasks = new TaskRegistry();
  tasks.register('echo', async (input) => input);
  const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'sse-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
  await withApi(store, async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl });
    const workflow = await client.createWorkflow({ name: 'sse', steps: [{ id: 'a', kind: 'task', handler: 'echo' }] });
    const run = await client.startRun(workflow.id, null);
    await worker.tick();
    const events = [];
    for await (const event of client.liveEvents(run.id)) events.push(event);
    assert.ok(events.length > 0);
    for (let index = 1; index < events.length; index += 1) assert.ok((events[index]?.sequence ?? 0) > (events[index - 1]?.sequence ?? 0));
  });
});

test('payload limit rejects oversized API requests', async () => {
  const store = new MemoryStore();
  await withApi(store, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(500) }) });
    assert.equal(response.status, 413);
  }, 128);
});

test('OpenAPI contract lists every required V1 route', () => {
  const paths = OPENAPI_DOCUMENT.paths as Record<string, unknown>;
  for (const route of API_ROUTE_KEYS) assert.ok(paths[route] !== undefined, `missing OpenAPI route ${route}`);
});
