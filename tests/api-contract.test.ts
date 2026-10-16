import test from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '@agentforge/api';
import { API_ROUTE_KEYS } from '@agentforge/api/openapi';
import { AgentForgeClient } from '@agentforge/sdk';
import { MemoryStore } from '@agentforge/testing';

async function withApi<T>(store: MemoryStore, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const api = createApi({ store, config: { host: '127.0.0.1', port: 0, eventPollMs: 10, maxBodyBytes: 1_048_576 }, log: () => undefined });
  const address = await api.start();
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await api.stop();
  }
}

function materializeRoute(path: string): string {
  return path.replace('{id}', 'missing').replace('{name}', 'signal');
}

test('every OpenAPI route is recognized by the runtime router', async () => {
  await withApi(new MemoryStore(), async (baseUrl) => {
    for (const route of API_ROUTE_KEYS) {
      const separator = route.indexOf(' ');
      const method = route.slice(0, separator);
      const path = materializeRoute(route.slice(separator + 1));
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('application/json')) {
        const body = await response.json() as { error?: { code?: string } };
        assert.ok(body.error?.code !== 'ROUTE_NOT_FOUND', `${route} is declared but not routed`);
      }
    }
  });
});

test('workflow lookup contract supports version id and workflow id', async () => {
  await withApi(new MemoryStore(), async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl });
    const workflow = await client.createWorkflow({ name: 'lookup', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const byVersion = await fetch(`${baseUrl}/v1/workflows/${encodeURIComponent(workflow.id)}`);
    const byWorkflow = await fetch(`${baseUrl}/v1/workflows/${encodeURIComponent(workflow.workflowId)}`);
    assert.equal(byVersion.status, 200);
    assert.equal(byWorkflow.status, 200);
    assert.equal(((await byVersion.json()) as { id: string }).id, workflow.id);
    assert.equal(((await byWorkflow.json()) as { id: string }).id, workflow.id);
  });
});

test('duplicate run submission is idempotent and conflicting reuse fails closed', async () => {
  await withApi(new MemoryStore(), async (baseUrl) => {
    const client = new AgentForgeClient({ baseUrl });
    const workflow = await client.createWorkflow({ name: 'idempotent-run', steps: [{ id: 'x', kind: 'task', handler: 'echo' }] });
    const first = await client.startRun(workflow.id, { request: 1 }, { idempotencyKey: 'run-key-1' });
    const second = await client.startRun(workflow.id, { request: 1 }, { idempotencyKey: 'run-key-1' });
    assert.equal(second.id, first.id);

    const conflict = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'run-key-1' },
      body: JSON.stringify({ workflowVersionId: workflow.id, input: { request: 2 } }),
    });
    assert.equal(conflict.status, 409);
    const body = await conflict.json() as { error: { code: string } };
    assert.equal(body.error.code, 'IDEMPOTENCY_KEY_CONFLICT');
  });
});
