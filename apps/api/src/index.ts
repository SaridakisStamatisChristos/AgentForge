import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  AgentForgeError,
  asAgentForgeError,
  createId,
  type JsonValue,
} from '@agentforge/contracts';
import { PostgresCli, PostgresStore } from '@agentforge/persistence';
import {
  DEFAULT_LIMITS,
  RuntimeService,
  type RuntimeStore,
} from '@agentforge/runtime';
import { OPENAPI_DOCUMENT } from './openapi.ts';

export type ApiConfig = {
  databaseUrl: string;
  host: string;
  port: number;
  maxBodyBytes: number;
  eventPollMs: number;
};

export type ApiDependencies = {
  store?: RuntimeStore;
  runtime?: RuntimeService;
  config?: Partial<ApiConfig>;
  log?: (record: Readonly<Record<string, unknown>>) => void;
};

type ApiMetrics = {
  httpRequests: number;
  httpErrors: number;
  workflowsCreated: number;
  runsStarted: number;
  cancellationRequests: number;
  signalsAccepted: number;
  signalsDuplicate: number;
};

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AgentForgeError({
      code: 'INVALID_CONFIG',
      category: 'VALIDATION',
      message: `${name} must be an integer in [${min},${max}]`,
    });
  }
  return parsed;
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgresql://agentforge:agentforge@localhost:5432/agentforge',
    host: env.AGENTFORGE_API_HOST ?? '127.0.0.1',
    port: integer(env.AGENTFORGE_API_PORT, 8787, 0, 65_535, 'AGENTFORGE_API_PORT'),
    maxBodyBytes: integer(env.AGENTFORGE_MAX_PAYLOAD_BYTES, DEFAULT_LIMITS.maxPayloadBytes, 1024, 16_777_216, 'AGENTFORGE_MAX_PAYLOAD_BYTES'),
    eventPollMs: integer(env.AGENTFORGE_EVENT_POLL_MS, 250, 25, 60_000, 'AGENTFORGE_EVENT_POLL_MS'),
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function requestId(request: IncomingMessage): string {
  const supplied = headerValue(request.headers['x-request-id']);
  if (supplied !== undefined && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return createId('req');
}

function commonHeaders(response: ServerResponse, id: string): void {
  response.setHeader('x-request-id', id);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
}

function sendJson(response: ServerResponse, id: string, status: number, body: unknown): void {
  commonHeaders(response, id);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, id: string, error: unknown): void {
  const normalized = asAgentForgeError(error);
  const status = normalized.httpStatus >= 400 && normalized.httpStatus <= 599 ? normalized.httpStatus : 500;
  sendJson(response, id, status, {
    error: {
      code: normalized.code,
      category: normalized.category,
      message: normalized.message,
      retryable: normalized.retryable,
      requestId: id,
    },
  });
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let bytes = 0;
    let body = '';
    const decoder = new TextDecoder();
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    request.on('error', fail);
    request.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        fail(new AgentForgeError({
          code: 'PAYLOAD_TOO_LARGE',
          category: 'VALIDATION',
          message: `Request body exceeds ${maxBytes} bytes`,
          httpStatus: 413,
        }));
        return;
      }
      body += decoder.decode(chunk, { stream: true });
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      body += decoder.decode();
      if (body.trim().length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as unknown);
      } catch {
        reject(new AgentForgeError({
          code: 'INVALID_JSON_BODY',
          category: 'VALIDATION',
          message: 'Request body must be valid JSON',
          httpStatus: 400,
        }));
      }
    });
  });
}

function bodyObject(value: unknown, message = 'Request body must be an object'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentForgeError({ code: 'INVALID_REQUEST_BODY', category: 'VALIDATION', message, httpStatus: 400 });
  }
  return value as Record<string, unknown>;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AgentForgeError({ code: 'INVALID_PATH_PARAMETER', category: 'VALIDATION', message: 'Path parameter is not valid URI encoding', httpStatus: 400 });
  }
}

function queryInteger(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AgentForgeError({ code: 'INVALID_QUERY_PARAMETER', category: 'VALIDATION', message: `${name} must be an integer in [${min},${max}]`, httpStatus: 400 });
  }
  return value;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function durableMetrics(store: RuntimeStore): Promise<Readonly<Record<string, number>>> {
  if (!(store instanceof PostgresStore)) return {};
  const rows = await store.db.json<Record<string, number>>(String.raw`
SELECT json_build_object(
  'runs_succeeded', (SELECT count(*)::int FROM workflow_runs WHERE state='SUCCEEDED'),
  'runs_failed', (SELECT count(*)::int FROM workflow_runs WHERE state='FAILED'),
  'runs_cancelled', (SELECT count(*)::int FROM workflow_runs WHERE state='CANCELLED'),
  'steps_succeeded', (SELECT count(*)::int FROM step_runs WHERE state='SUCCEEDED'),
  'steps_failed', (SELECT count(*)::int FROM step_runs WHERE state='FAILED'),
  'attempts_total', (SELECT count(*)::int FROM attempts),
  'retries_total', (SELECT count(*)::int FROM execution_events WHERE type='step.retry_scheduled'),
  'lease_recoveries_total', (SELECT count(*)::int FROM execution_events WHERE type='lease.recovered'),
  'queue_ready', (SELECT count(*)::int FROM queue_tasks WHERE state IN ('READY','RETRY_SCHEDULED'))
)::text;
`);
  return rows[0] ?? {};
}

function prometheus(metrics: ApiMetrics, durable: Readonly<Record<string, number>>): string {
  const lines = [
    '# HELP agentforge_http_requests_total HTTP requests served by this API process.',
    '# TYPE agentforge_http_requests_total counter',
    `agentforge_http_requests_total ${metrics.httpRequests}`,
    '# TYPE agentforge_http_errors_total counter',
    `agentforge_http_errors_total ${metrics.httpErrors}`,
    '# TYPE agentforge_workflows_created_total counter',
    `agentforge_workflows_created_total ${metrics.workflowsCreated}`,
    '# TYPE agentforge_runs_started_total counter',
    `agentforge_runs_started_total ${metrics.runsStarted}`,
    '# TYPE agentforge_cancellation_requests_total counter',
    `agentforge_cancellation_requests_total ${metrics.cancellationRequests}`,
    '# TYPE agentforge_signals_accepted_total counter',
    `agentforge_signals_accepted_total ${metrics.signalsAccepted}`,
    '# TYPE agentforge_signals_duplicate_total counter',
    `agentforge_signals_duplicate_total ${metrics.signalsDuplicate}`,
  ];
  for (const [key, value] of Object.entries(durable)) {
    if (Number.isFinite(value)) lines.push(`agentforge_${key} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function routeParts(pathname: string): string[] {
  return pathname.split('/').filter((item) => item.length > 0);
}

export function createApi(dependencies: ApiDependencies = {}): {
  server: Server;
  store: RuntimeStore;
  runtime: RuntimeService;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
} {
  const defaults = loadApiConfig();
  const config: ApiConfig = { ...defaults, ...dependencies.config };
  const store = dependencies.store ?? new PostgresStore(new PostgresCli(config.databaseUrl));
  const runtime = dependencies.runtime ?? new RuntimeService(store, {
    ...DEFAULT_LIMITS,
    maxPayloadBytes: config.maxBodyBytes,
  });
  const log = dependencies.log ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const metrics: ApiMetrics = {
    httpRequests: 0,
    httpErrors: 0,
    workflowsCreated: 0,
    runsStarted: 0,
    cancellationRequests: 0,
    signalsAccepted: 0,
    signalsDuplicate: 0,
  };

  const server = createServer(async (request, response) => {
    const id = requestId(request);
    const started = Date.now();
    metrics.httpRequests += 1;
    const method = request.method ?? 'GET';
    let pathname = '/';
    let statusForLog = 500;
    try {
      const url = new URL(request.url ?? '/', 'http://agentforge.local');
      pathname = url.pathname;
      const parts = routeParts(pathname);

      if (method === 'GET' && pathname === '/health/live') {
        statusForLog = 200;
        sendJson(response, id, 200, { status: 'live' });
        return;
      }
      if (method === 'GET' && pathname === '/health/ready') {
        const ready = await store.ping();
        statusForLog = ready ? 200 : 503;
        sendJson(response, id, statusForLog, { status: ready ? 'ready' : 'not_ready', database: ready ? 'available' : 'unavailable' });
        return;
      }
      if (method === 'GET' && pathname === '/openapi.json') {
        statusForLog = 200;
        sendJson(response, id, 200, OPENAPI_DOCUMENT);
        return;
      }
      if (method === 'GET' && pathname === '/metrics') {
        const durable = await durableMetrics(store);
        commonHeaders(response, id);
        response.statusCode = 200;
        response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        response.end(prometheus(metrics, durable));
        statusForLog = 200;
        return;
      }

      if (method === 'POST' && pathname === '/v1/workflows') {
        const body = await readJson(request, config.maxBodyBytes);
        const created = await runtime.createWorkflow(body);
        metrics.workflowsCreated += 1;
        statusForLog = 200;
        sendJson(response, id, 200, created);
        return;
      }
      if (method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'workflows') {
        const workflowId = decodeSegment(parts[2] ?? '');
        const version = (await store.getWorkflowVersion(workflowId)) ?? (await store.getWorkflowLatest(workflowId));
        if (version === null) throw new AgentForgeError({ code: 'WORKFLOW_NOT_FOUND', category: 'VALIDATION', message: 'Workflow not found', httpStatus: 404 });
        statusForLog = 200;
        sendJson(response, id, 200, version);
        return;
      }
      if (method === 'POST' && pathname === '/v1/runs') {
        const body = bodyObject(await readJson(request, config.maxBodyBytes));
        if (typeof body.workflowVersionId !== 'string' || body.workflowVersionId.length === 0) {
          throw new AgentForgeError({ code: 'INVALID_WORKFLOW_VERSION_ID', category: 'VALIDATION', message: 'workflowVersionId is required', httpStatus: 400 });
        }
        const run = await runtime.startRun(body.workflowVersionId, body.input ?? null);
        metrics.runsStarted += 1;
        statusForLog = 200;
        sendJson(response, id, 200, run);
        return;
      }
      if (method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'runs') {
        const run = await store.getRun(decodeSegment(parts[2] ?? ''));
        if (run === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        statusForLog = 200;
        sendJson(response, id, 200, run);
        return;
      }
      if (method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'runs' && parts[3] === 'steps') {
        const runId = decodeSegment(parts[2] ?? '');
        if ((await store.getRun(runId)) === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        statusForLog = 200;
        sendJson(response, id, 200, await store.listStepRuns(runId));
        return;
      }
      if (method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'runs' && parts[3] === 'events') {
        const runId = decodeSegment(parts[2] ?? '');
        if ((await store.getRun(runId)) === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        const after = queryInteger(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
        const limit = queryInteger(url, 'limit', 100, 1, 500);
        const events = await store.listEvents(runId, { after, limit });
        const last = events[events.length - 1];
        statusForLog = 200;
        sendJson(response, id, 200, { events, ...(last === undefined ? {} : { nextAfter: last.sequence }) });
        return;
      }
      if (method === 'GET' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'runs' && parts[3] === 'events' && parts[4] === 'stream') {
        const runId = decodeSegment(parts[2] ?? '');
        if ((await store.getRun(runId)) === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        let cursor = queryInteger(url, 'after', 0, 0, Number.MAX_SAFE_INTEGER);
        let closed = false;
        request.on('close', () => { closed = true; });
        commonHeaders(response, id);
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream; charset=utf-8');
        response.setHeader('connection', 'keep-alive');
        response.write(': agentforge-stream\n\n');
        statusForLog = 200;
        while (!closed) {
          const events = await store.listEvents(runId, { after: cursor, limit: 100 });
          for (const event of events) {
            response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.sequence;
          }
          const run = await store.getRun(runId);
          if (events.length === 0 && run !== null && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) break;
          if (!closed) await sleep(config.eventPollMs);
        }
        if (!closed) response.end();
        return;
      }
      if (method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'runs' && parts[3] === 'cancel') {
        const runId = decodeSegment(parts[2] ?? '');
        await readJson(request, config.maxBodyBytes);
        const run = await runtime.cancelRun(runId);
        metrics.cancellationRequests += 1;
        statusForLog = 200;
        sendJson(response, id, 200, run);
        return;
      }
      if (method === 'POST' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'runs' && parts[3] === 'signals') {
        const runId = decodeSegment(parts[2] ?? '');
        const signalName = decodeSegment(parts[4] ?? '');
        const body = bodyObject(await readJson(request, config.maxBodyBytes));
        const dedupeKey = body.dedupeKey;
        if (dedupeKey !== undefined && (typeof dedupeKey !== 'string' || dedupeKey.length === 0 || dedupeKey.length > 256)) {
          throw new AgentForgeError({ code: 'INVALID_DEDUPE_KEY', category: 'VALIDATION', message: 'dedupeKey must be a non-empty string up to 256 characters', httpStatus: 400 });
        }
        const result = await runtime.signal(runId, signalName, body.payload ?? null, dedupeKey as string | undefined);
        if (result.status === 'accepted') metrics.signalsAccepted += 1;
        else metrics.signalsDuplicate += 1;
        statusForLog = 200;
        sendJson(response, id, 200, result);
        return;
      }

      statusForLog = 404;
      sendError(response, id, new AgentForgeError({ code: 'ROUTE_NOT_FOUND', category: 'VALIDATION', message: 'Route not found', httpStatus: 404 }));
    } catch (error) {
      metrics.httpErrors += 1;
      const normalized = asAgentForgeError(error);
      statusForLog = normalized.httpStatus >= 400 && normalized.httpStatus <= 599 ? normalized.httpStatus : 500;
      sendError(response, id, normalized);
    } finally {
      log({
        level: statusForLog >= 500 ? 'error' : 'info',
        message: 'http_request',
        requestId: id,
        method,
        path: pathname,
        status: statusForLog,
        durationMs: Math.max(0, Date.now() - started),
      });
    }
  });

  return {
    server,
    store,
    runtime,
    start: async () => {
      await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new AgentForgeError({ code: 'API_LISTEN_FAILED', category: 'DEPENDENCY', message: 'API server did not expose a TCP address' });
      }
      return { host: address.address, port: address.port };
    },
    stop: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  };
}

async function main(): Promise<void> {
  const api = createApi();
  const address = await api.start();
  process.stdout.write(`${JSON.stringify({ level: 'info', message: 'api_started', ...address })}\n`);
  const stop = () => void api.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1]?.endsWith('/apps/api/src/index.ts') || process.argv[1]?.endsWith('/apps/api/dist/index.js')) void main();
