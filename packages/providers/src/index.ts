import { AgentForgeError, assertJsonValue, type JsonObject, type JsonValue } from '@agentforge/contracts';

export type ModelMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; name?: string };
export type ModelRequest = { prompt?: string; messages?: ModelMessage[]; metadata?: JsonObject };
export type ToolCallRequest = { name: string; input: JsonValue };
export type ModelResponse = { text?: string; toolCall?: ToolCallRequest; finishReason: 'stop' | 'tool_call' };
export type ProviderContext = { signal: AbortSignal; runId: string; stepId: string; iteration?: number };

export interface ModelProvider {
  invoke(request: ModelRequest, context: ProviderContext): Promise<ModelResponse>;
}

export type ScriptedProviderItem =
  | { kind: 'response'; response: ModelResponse; delayMs?: number }
  | { kind: 'error'; code?: string; message: string; retryable?: boolean; delayMs?: number };

function validateResponse(value: ModelResponse): ModelResponse {
  if (value.finishReason === 'stop') {
    if (typeof value.text !== 'string') {
      throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'stop response requires text', retryable: false });
    }
    return { finishReason: 'stop', text: value.text };
  }
  if (value.finishReason === 'tool_call') {
    if (value.toolCall === undefined || typeof value.toolCall.name !== 'string' || value.toolCall.name.length === 0) {
      throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'tool_call response requires a named tool call', retryable: false });
    }
    assertJsonValue(value.toolCall.input, 'provider.toolCall.input');
    return { finishReason: 'tool_call', toolCall: value.toolCall };
  }
  throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'Unknown finishReason', retryable: false });
}

async function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AgentForgeError({ code: 'PROVIDER_CANCELLED', category: 'CANCELLATION', message: 'Provider invocation cancelled' }));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class DeterministicProvider implements ModelProvider {
  private index = 0;
  constructor(private readonly script: readonly ScriptedProviderItem[]) {
    if (script.length === 0) {
      throw new AgentForgeError({ code: 'EMPTY_PROVIDER_SCRIPT', category: 'VALIDATION', message: 'DeterministicProvider script cannot be empty' });
    }
  }

  async invoke(_request: ModelRequest, context: ProviderContext): Promise<ModelResponse> {
    const item = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (item === undefined) {
      throw new AgentForgeError({ code: 'PROVIDER_SCRIPT_EXHAUSTED', category: 'PROVIDER', message: 'No scripted provider item available' });
    }
    await abortableDelay(item.delayMs ?? 0, context.signal);
    if (item.kind === 'error') {
      throw new AgentForgeError({
        code: item.code ?? 'DETERMINISTIC_PROVIDER_ERROR',
        category: 'PROVIDER',
        message: item.message,
        retryable: item.retryable ?? false,
      });
    }
    return validateResponse(item.response);
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(
    private readonly options: { baseUrl: string; token?: string; model: string; fetchImpl?: typeof fetch },
  ) {}

  async invoke(request: ModelRequest, context: ProviderContext): Promise<ModelResponse> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      signal: context.signal,
      headers: {
        'content-type': 'application/json',
        ...(this.options.token === undefined ? {} : { authorization: `Bearer ${this.options.token}` }),
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: request.messages ?? [{ role: 'user', content: request.prompt ?? '' }],
      }),
    });
    if (!response.ok) {
      throw new AgentForgeError({
        code: 'PROVIDER_HTTP_ERROR',
        category: 'PROVIDER',
        message: `Provider returned HTTP ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
      });
    }
    const payload = (await response.json()) as unknown;
    if (typeof payload !== 'object' || payload === null) {
      throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'Provider response is not an object' });
    }
    const choices = (payload as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'Provider response has no choices' });
    }
    const first = choices[0] as { message?: { content?: unknown } };
    if (typeof first.message?.content !== 'string') {
      throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'Provider choice has no textual content' });
    }
    return { finishReason: 'stop', text: first.message.content };
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  register(name: string, provider: ModelProvider): void {
    if (name.length === 0 || this.providers.has(name)) {
      throw new AgentForgeError({ code: 'PROVIDER_REGISTRATION_ERROR', category: 'VALIDATION', message: `Provider already registered or invalid: ${name}` });
    }
    this.providers.set(name, provider);
  }
  get(name: string): ModelProvider {
    const provider = this.providers.get(name);
    if (provider === undefined) {
      throw new AgentForgeError({ code: 'PROVIDER_NOT_FOUND', category: 'PROVIDER', message: `Provider not registered: ${name}` });
    }
    return provider;
  }
}
