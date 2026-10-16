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
import { OPENAPI_DOCUMENT } from './openapi.js';

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

const DEFAULT_CONFIG: ApiConfig = {
  databaseUrl: 'postgresql://agentforge:agentforge@localhost:5432/agentforge',
  host: '127.0.0.1',
  port: 3000,
  maxBodyBytes: DEFAULT_LIMITS.maxPayloadBytes,
  eventPollMs: 250,
};

function parsePositiveInt(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AgentForgeError({ code: 'INVALID_CONFIG', category: 'VALIDATION', message: `${name} must be an integer in [${min},${max}]` });
  }
  return parsed;
}

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_CONFIG.databaseUrl,
    host: env.AGENTFORGE_API_HOST ?? DEFAULT_CONFIG.host,
    port: parsePositiveInt(env.AGENTFORGE_API_PORT, DEFAULT_CONFIG.port, 0, 65535, 'AGENTFORGE_API_PORT'),
    maxBodyBytes: parsePositiveInt(env.AGENTFORGE_MAX_PAYLOAD_BYTES, DEFAULT_CONFIG.maxBodyBytes, 1024, 16_777_216, 'AGENTFORGE_MAX_PAYLOAD_BYTES'),
    eventPollMs: parsePositiveInt(env.AGENTFORGE_EVENT_POLL_MS, DEFAULT_CONFIG.eventPollMs, 10, 60_000, 'AGENTFORGE_EVENT_POLL_MS'),
  };
}

function requestId(request: IncomingMessage): string {
  const raw = request.headers['x-request-id'];
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 128) return raw;
  return createId('req');
}

function jsonResponse(response: ServerResponse, statusCode: number, body: unknown, id: string): void {
  const serialized = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('x-request-id', id);
  response.setHeader('content-length', Buffer.byteLength(serialized));
  response.end(serialized);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(new AgentForgeError({ code: 'PAYLOAD_TOO_LARGE', category: 'VALIDATION', message: `Request body exceeds ${maxBytes} bytes`, httpStatus: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', resolve);
    request.on('error', reject);
  });
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown;
  } catch {
    throw new AgentForgeError({ code: 'INVALID_JSON', category: 'VALIDATION', message: 'Request body must be valid JSON', httpStatus: 400 });
  }
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentForgeError({ code: 'INVALID_REQUEST', category: 'VALIDATION', message: `${name} must be an object`, httpStatus: 400 });
  }
  return value as Record<string, unknown>;
}

function parseRunId(pathname: string, suffix = ''): string | null {
  const escapedSuffix = suffix.replaceAll('/', '\\/');
  const match = pathname.match(new RegExp(`^/v1/runs/([^/]+)${escapedSuffix}$`));
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

function parseSignalPath(pathname: string): { runId: string; name: string } | null {
  const match = pathname.match(/^\/v1\/runs\/([^/]+)\/signals\/([^/]+)$/);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { runId: decodeURIComponent(match[1]), name: decodeURIComponent(match[2]) };
}

function prometheus(metrics: ApiMetrics): string {
  return [
    '# HELP agentforge_http_requests_total Total HTTP requests handled.',
    '# TYPE agentforge_http_requests_total counter',
    `agentforge_http_requests_total ${metrics.httpRequests}`,
    '# HELP agentforge_http_errors_total Total HTTP error responses.',
    '# TYPE agentforge_http_errors_total counter',
    `agentforge_http_errors_total ${metrics.httpErrors}`,
    '# HELP agentforge_workflows_created_total Total workflow versions created through the API.',
    '# TYPE agentforge_workflows_created_total counter',
    `agentforge_workflows_created_total ${metrics.workflowsCreated}`,
    '# HELP agentforge_runs_started_total Total workflow runs started through the API.',
    '# TYPE agentforge_runs_started_total counter',
    `agentforge_runs_started_total ${metrics.runsStarted}`,
    '# HELP agentforge_cancellation_requests_total Total cancellation requests.',
    '# TYPE agentforge_cancellation_requests_total counter',
    `agentforge_cancellation_requests_total ${metrics.cancellationRequests}`,
    '# HELP agentforge_signals_accepted_total Total accepted durable signals.',
    '# TYPE agentforge_signals_accepted_total counter',
    `agentforge_signals_accepted_total ${metrics.signalsAccepted}`,
    '# HELP agentforge_signals_duplicate_total Total deduplicated durable signals.',
    '# TYPE agentforge_signals_duplicate_total counter',
    `agentforge_signals_duplicate_total ${metrics.signalsDuplicate}`,
  ].join('\n') + '\n';
}

export function createApi(dependencies: ApiDependencies = {}): {
  readonly runtime: RuntimeService;
  readonly store: RuntimeStore;
  readonly server: Server;
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
} {
  const config: ApiConfig = { ...loadApiConfig(), ...(dependencies.config ?? {}) };
  const store = dependencies.store ?? new PostgresStore(new PostgresCli(config.databaseUrl));
  const runtime = dependencies.runtime ?? new RuntimeService(store, { ...DEFAULT_LIMITS, maxPayloadBytes: config.maxBodyBytes });
  const log = dependencies.log ?? ((record) => process.stdout.write(`${JSON.stringify(record)}\n`));
  const metrics: ApiMetrics = { httpRequests: 0, httpErrors: 0, workflowsCreated: 0, runsStarted: 0, cancellationRequests: 0, signalsAccepted: 0, signalsDuplicate: 0 };

  const server = createServer(async (request, response) => {
    const id = requestId(request);
    const startedAt = Date.now();
    metrics.httpRequests += 1;
    try {
      const method = request.method ?? 'GET';
      const url = new URL(request.url ?? '/', 'http://agentforge.local');
      const pathname = url.pathname;

      if (method === 'GET' && pathname === '/health/live') {
        jsonResponse(response, 200, { status: 'live' }, id);
        return;
      }
      if (method === 'GET' && pathname === '/health/ready') {
        const ready = await store.ping();
        jsonResponse(response, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' }, id);
        return;
      }
      if (method === 'GET' && pathname === '/metrics') {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        response.setHeader('x-request-id', id);
        response.end(prometheus(metrics));
        return;
      }
      if (method === 'GET' && pathname === '/openapi.json') {
        jsonResponse(response, 200, OPENAPI_DOCUMENT, id);
        return;
      }
      if (method === 'POST' && pathname === '/v1/workflows') {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const created = await runtime.createWorkflow(body);
        metrics.workflowsCreated += 1;
        jsonResponse(response, 201, created, id);
        return;
      }
      if (method === 'GET' && pathname.startsWith('/v1/workflows/') && pathname.endsWith('/latest')) {
        const workflowId = decodeURIComponent(pathname.slice('/v1/workflows/'.length, -'/latest'.length));
        const latest = await store.getWorkflowLatest(workflowId);
        if (latest === null) throw new AgentForgeError({ code: 'WORKFLOW_NOT_FOUND', category: 'VALIDATION', message: 'Workflow not found', httpStatus: 404 });
        jsonResponse(response, 200, latest, id);
        return;
      }
      if (method === 'GET' && pathname.startsWith('/v1/workflow-versions/')) {
        const versionId = decodeURIComponent(pathname.slice('/v1/workflow-versions/'.length));
        const version = await store.getWorkflowVersion(versionId);
        if (version === null) throw new AgentForgeError({ code: 'WORKFLOW_VERSION_NOT_FOUND', category: 'VALIDATION', message: 'Workflow version not found', httpStatus: 404 });
        jsonResponse(response, 200, version, id);
        return;
      }
      if (method === 'POST' && pathname === '/v1/runs') {
        const body = requireObject(await readJsonBody(request, config.maxBodyBytes), 'run request');
        const versionId = body.workflowVersionId;
        if (typeof versionId !== 'string' || versionId.length === 0) throw new AgentForgeError({ code: 'INVALID_WORKFLOW_VERSION_ID', category: 'VALIDATION', message: 'workflowVersionId is required', httpStatus: 400 });
        const run = await runtime.startRun(versionId, body.input ?? null);
        metrics.runsStarted += 1;
        jsonResponse(response, 201, run, id);
        return;
      }
      const directRunId = parseRunId(pathname);
      if (method === 'GET' && directRunId !== null) {
        const run = await store.getRun(directRunId);
        if (run === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        jsonResponse(response, 200, run, id);
        return;
      }
      const stepRunId = parseRunId(pathname, '/steps');
      if (method === 'GET' && stepRunId !== null) {
        const run = await store.getRun(stepRunId);
        if (run === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        jsonResponse(response, 200, await store.listStepRuns(stepRunId), id);
        return;
      }
      const cancelRunId = parseRunId(pathname, '/cancel');
      if (method === 'POST' && cancelRunId !== null) {
        metrics.cancellationRequests += 1;
        jsonResponse(response, 200, await runtime.cancelRun(cancelRunId), id);
        return;
      }
      const eventsRunId = parseRunId(pathname, '/events');
      if (method === 'GET' && eventsRunId !== null) {
        const after = Number(url.searchParams.get('after') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '100');
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
          throw new AgentForgeError({ code: 'INVALID_PAGINATION', category: 'VALIDATION', message: 'after must be >=0 and limit must be 1..500', httpStatus: 400 });
        }
        const events = await store.listEvents(eventsRunId, { after, limit });
        const nextAfter = events.at(-1)?.sequence;
        jsonResponse(response, 200, nextAfter === undefined ? { events } : { events, nextAfter }, id);
        return;
      }
      const streamRunId = parseRunId(pathname, '/events/stream');
      if (method === 'GET' && streamRunId !== null) {
        const run = await store.getRun(streamRunId);
        if (run === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
        let cursor = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(cursor) || cursor < 0) throw new AgentForgeError({ code: 'INVALID_EVENT_CURSOR', category: 'VALIDATION', message: 'after must be >= 0', httpStatus: 400 });
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-request-id': id,
        });
        let closed = false;
        request.on('close', () => { closed = true; });
        while (!closed) {
          const events = await store.listEvents(streamRunId, { after: cursor, limit: 100 });
          for (const event of events) {
            response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
            cursor = event.sequence;
          }
          const current = await store.getRun(streamRunId);
          if (current === null || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.state)) break;
          await new Promise<void>((resolve) => setTimeout(resolve, config.eventPollMs));
        }
        response.end();
        return;
      }
      const signal = parseSignalPath(pathname);
      if (method === 'POST' && signal !== null) {
        const body = requireObject(await readJsonBody(request, config.maxBodyBytes), 'signal request');
        const dedupeKey = body.dedupeKey;
        if (dedupeKey !== undefined && (typeof dedupeKey !== 'string' || dedupeKey.length === 0 || dedupeKey.length > 256)) {
          throw new AgentForgeError({ code: 'INVALID_DEDUPE_KEY', category: 'VALIDATION', message: 'dedupeKey must be 1..256 chars', httpStatus: 400 });
        }
        const result = await runtime.signal(signal.runId, signal.name, body.payload ?? null, dedupeKey as string | undefined);
        if (result.status === 'accepted') metrics.signalsAccepted += 1;
        else metrics.signalsDuplicate += 1;
        jsonResponse(response, 200, result, id);
        return;
      }

      throw new AgentForgeError({ code: 'ROUTE_NOT_FOUND', category: 'VALIDATION', message: `No route for ${method} ${pathname}`, httpStatus: 404 });
    } catch (error) {
      metrics.httpErrors += 1;
      const normalized = asAgentForgeError(error, { code: 'INTERNAL_ERROR', category: 'INTERNAL_INVARIANT' });
      jsonResponse(response, normalized.httpStatus, { error: { ...normalized.serialize(), requestId: id } }, id);
    } finally {
      log({ level: 'info', requestId: id, method: request.method ?? 'GET', url: request.url ?? '/', durationMs: Date.now() - startedAt, statusCode: response.statusCode });
    }
  });

  return {
    runtime,
    store,
    server,
    async start() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(config.port, config.host, () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new AgentForgeError({ code: 'API_LISTEN_FAILED', category: 'INTERNAL_INVARIANT', message: 'API did not expose an address' });
      return { host: address.address, port: address.port };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    },
  };
}

async function main(): Promise<void> {
  const api = createApi();
  const address = await api.start();
  process.stdout.write(`${JSON.stringify({ event: 'api.started', ...address })}\n`);
  const stop = async () => {
    await api.stop();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

if (process.argv[1]?.endsWith('/apps/api/src/index.ts') || process.argv[1]?.endsWith('/apps/api/dist/index.js')) void main();
