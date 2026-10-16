import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../apps/api/src/index.ts';
import { API_ROUTE_KEYS, OPENAPI_DOCUMENT } from '../apps/api/src/openapi.ts';
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

test('liveness remains healthy while readiness reports durable-store outage', async () => {
  const store = new MemoryStore();
  store.setDatabaseAvailable(false);
  await withApi(store, async (baseUrl) => {
    const live = await fetch(`${baseUrl}/health/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${baseUrl}/health/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_ready', database: 'unavailable' });
  });
});

test('API validates malformed and oversized JSON without leaking stack traces', async () => {
  const store = new MemoryStore();
  await withApi(store, async (baseUrl) => {
    const malformed = await fetch(`${baseUrl}/v1/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not-json' });
    assert.equal(malformed.status, 400);
    const malformedBody = await malformed.json() as { error: Record<string, unknown> };
    assert.equal(malformedBody.error.code, 'INVALID_JSON_BODY');
    assert.equal('stack' in malformedBody.error, false);
    assert.equal(typeof malformed.headers.get('x-request-id'), 'string');

    const oversized = await fetch(`${baseUrl}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workflowVersionId: 'x', input: { data: 'x'.repeat(2000) } }) });
    assert.equal(oversized.status, 413);
  }, 1024);
});

test('SDK exercises create, run, history and live event replay through the HTTP API', async () => {
  const store = new MemoryStore();
  await withApi(store, async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl, requestIdFactory: () => 'sdk-api-test' });
    const workflow = await client.createWorkflow({ name: 'api-sdk', steps: [{ id: 'a', kind: 'task', handler: 'echo' }] });
    const run = await client.startRun(workflow.id, { hello: 'world' });
    const tasks = new TaskRegistry();
    tasks.register('echo', async (input) => input);
    const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'api-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
    await worker.tick();
    assert.equal((await client.getRun(run.id)).state, 'SUCCEEDED');
    assert.equal((await client.listSteps(run.id))[0]?.state, 'SUCCEEDED');
    const page = await client.listEvents(run.id, { limit: 500 });
    assert.ok(page.events.some((event) => event.type === 'workflow.succeeded'));
    const streamed = [];
    for await (const event of client.liveEvents(run.id)) streamed.push(event);
    assert.deepEqual(streamed.map((event) => event.sequence), page.events.map((event) => event.sequence));
  });
});

test('cancel and signal endpoints preserve runtime semantics', async () => {
  const store = new MemoryStore();
  await withApi(store, async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl });
    const waitWorkflow = await client.createWorkflow({ name: 'approval', steps: [
      { id: 'wait', kind: 'wait', signal: 'approved' },
      { id: 'after', kind: 'task', handler: 'echo', dependsOn: ['wait'] },
    ] });
    const waitRun = await client.startRun(waitWorkflow.id, null);
    const tasks = new TaskRegistry();
    tasks.register('echo', async (input) => input);
    const worker = new Worker(store, tasks, new ToolRegistry(), new ProviderRegistry(), { workerId: 'signal-worker', concurrency: 1, claimBatchSize: 1, leaseMs: 1000, heartbeatMs: 100, pollMs: 10, gracefulShutdownMs: 100 });
    await worker.tick();
    assert.equal((await client.getRun(waitRun.id)).state, 'WAITING');
    assert.equal((await client.sendSignal(waitRun.id, 'approved', { reviewer: 'alice' }, 'approval-key')).status, 'accepted');
    assert.equal((await client.sendSignal(waitRun.id, 'approved', { reviewer: 'alice' }, 'approval-key')).status, 'duplicate');
    await worker.tick();
    assert.equal((await client.getRun(waitRun.id)).state, 'SUCCEEDED');

    const cancelWorkflow = await client.createWorkflow({ name: 'cancel-api', steps: [{ id: 'a', kind: 'task', handler: 'echo' }] });
    const cancelRun = await client.startRun(cancelWorkflow.id, null);
    assert.equal((await client.cancelRun(cancelRun.id)).state, 'CANCELLED');
    assert.equal((await client.getRun(cancelRun.id)).state, 'CANCELLED');
  });
});

test('OpenAPI route inventory stays aligned with runtime route surface', () => {
  const actual: string[] = [];
  for (const [path, operations] of Object.entries(OPENAPI_DOCUMENT.paths)) {
    for (const method of Object.keys(operations)) actual.push(`${method.toUpperCase()} ${path}`);
  }
  assert.deepEqual(actual.sort(), [...API_ROUTE_KEYS].sort());
});

test('metrics endpoint exposes lean runtime counters', async () => {
  const store = new MemoryStore();
  await withApi(store, async (baseUrl) => {
    const metrics = await fetch(`${baseUrl}/metrics`);
    assert.equal(metrics.status, 200);
    const body = await metrics.text();
    assert.match(body, /agentforge_http_requests_total/);
    assert.match(body, /agentforge_http_errors_total/);
  });
});
