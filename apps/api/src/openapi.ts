export const API_ROUTE_KEYS = [
  'POST /v1/workflows',
  'GET /v1/workflows/{id}',
  'POST /v1/runs',
  'GET /v1/runs/{id}',
  'GET /v1/runs/{id}/steps',
  'GET /v1/runs/{id}/events',
  'GET /v1/runs/{id}/events/stream',
  'POST /v1/runs/{id}/cancel',
  'POST /v1/runs/{id}/signals/{name}',
  'GET /health/live',
  'GET /health/ready',
  'GET /metrics',
  'GET /openapi.json',
] as const;

const errorSchema = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'category', 'message', 'retryable', 'requestId'],
      properties: {
        code: { type: 'string' },
        category: { type: 'string' },
        message: { type: 'string' },
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
} as const;

export const OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'AgentForge API',
    version: '0.1.0',
    description: 'Durable local/reference control plane for AgentForge V1.',
  },
  paths: {
    '/v1/workflows': { post: { summary: 'Create an immutable workflow version', responses: { '200': { description: 'Created' }, '400': { description: 'Invalid workflow', content: { 'application/json': { schema: errorSchema } } } } } },
    '/v1/workflows/{id}': { get: { summary: 'Get a workflow version or latest version by workflow id', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Workflow version' }, '404': { description: 'Not found' } } } },
    '/v1/runs': { post: { summary: 'Start a durable run', responses: { '200': { description: 'Run created' }, '400': { description: 'Invalid request' } } } },
    '/v1/runs/{id}': { get: { summary: 'Get run state', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Run' }, '404': { description: 'Not found' } } } },
    '/v1/runs/{id}/steps': { get: { summary: 'List durable step runs', responses: { '200': { description: 'Steps' } } } },
    '/v1/runs/{id}/events': { get: { summary: 'List ordered run events', parameters: [{ name: 'after', in: 'query', schema: { type: 'integer', minimum: 0 } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }], responses: { '200': { description: 'Events' } } } },
    '/v1/runs/{id}/events/stream': { get: { summary: 'Consume run events as Server-Sent Events', responses: { '200': { description: 'text/event-stream' } } } },
    '/v1/runs/{id}/cancel': { post: { summary: 'Persist a cancellation request and revoke ordinary future work', responses: { '200': { description: 'Updated run' } } } },
    '/v1/runs/{id}/signals/{name}': { post: { summary: 'Deliver a named durable signal', responses: { '200': { description: 'Signal accepted or duplicate' }, '409': { description: 'Late or invalid signal' } } } },
    '/health/live': { get: { summary: 'Process liveness', responses: { '200': { description: 'Process alive' } } } },
    '/health/ready': { get: { summary: 'Readiness including PostgreSQL dependency', responses: { '200': { description: 'Ready' }, '503': { description: 'Dependency unavailable' } } } },
    '/metrics': { get: { summary: 'Prometheus text metrics', responses: { '200': { description: 'Metrics text' } } } },
    '/openapi.json': { get: { summary: 'OpenAPI contract', responses: { '200': { description: 'OpenAPI document' } } } },
  },
} as const;
