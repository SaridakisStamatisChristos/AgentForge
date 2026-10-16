import {
  AgentForgeError,
  type ExecutionEvent,
  type JsonValue,
  type StepRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowVersion,
} from '@agentforge/contracts';

export function defineWorkflow(definition: WorkflowDefinition): WorkflowDefinition {
  return definition;
}

export type ClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestIdFactory?: () => string;
};

type ApiErrorBody = {
  error?: { code?: string; category?: string; message?: string; retryable?: boolean; requestId?: string };
};

export class AgentForgeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestIdFactory: () => string;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestIdFactory = options.requestIdFactory ?? (() => `sdk_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-request-id': this.requestIdFactory(),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      let body: ApiErrorBody = {};
      try { body = (await response.json()) as ApiErrorBody; } catch { body = {}; }
      throw new AgentForgeError({
        code: body.error?.code ?? 'HTTP_ERROR',
        category: 'DEPENDENCY',
        message: body.error?.message ?? `AgentForge API returned ${response.status}`,
        retryable: body.error?.retryable ?? response.status >= 500,
        httpStatus: response.status,
      });
    }
    return (await response.json()) as T;
  }

  async createWorkflow(definition: WorkflowDefinition): Promise<WorkflowVersion> {
    return this.request('/v1/workflows', { method: 'POST', body: JSON.stringify(definition) });
  }

  async startRun(workflowVersionId: string, input: JsonValue): Promise<WorkflowRun> {
    return this.request('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowVersionId, input }) });
  }

  async getRun(runId: string): Promise<WorkflowRun> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}`);
  }

  async listSteps(runId: string): Promise<StepRun[]> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/steps`);
  }

  async listEvents(runId: string, options: { after?: number; limit?: number } = {}): Promise<{ events: ExecutionEvent[]; nextAfter?: number }> {
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set('after', String(options.after));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    const suffix = query.size > 0 ? `?${query}` : '';
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/events${suffix}`);
  }

  async cancelRun(runId: string): Promise<WorkflowRun> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' });
  }

  async sendSignal(runId: string, name: string, payload: JsonValue, dedupeKey?: string): Promise<{ status: 'accepted' | 'duplicate'; stepRunId: string }> {
    return this.request(`/v1/runs/${encodeURIComponent(runId)}/signals/${encodeURIComponent(name)}`, {
      method: 'POST',
      body: JSON.stringify({ payload, ...(dedupeKey === undefined ? {} : { dedupeKey }) }),
    });
  }

  async *liveEvents(runId: string, after = 0, signal?: AbortSignal): AsyncGenerator<ExecutionEvent, void, void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events/stream?after=${after}`, {
      headers: { accept: 'text/event-stream', 'x-request-id': this.requestIdFactory() },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok || response.body === null) throw new AgentForgeError({ code: 'EVENT_STREAM_FAILED', category: 'DEPENDENCY', message: `Event stream returned ${response.status}`, retryable: true });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
          if (data !== undefined && data.length > 0) yield JSON.parse(data) as ExecutionEvent;
          boundary = buffer.indexOf('\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
