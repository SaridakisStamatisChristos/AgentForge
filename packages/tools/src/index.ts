import {
  AgentForgeError,
  asAgentForgeError,
  assertJsonValue,
  jsonByteLength,
  type JsonValue,
  type SideEffectClass,
} from '@agentforge/contracts';

export type ToolContext = {
  signal: AbortSignal;
  runId: string;
  stepId: string;
  attemptId: string;
  idempotencyKey?: string;
};

export type ToolSchema = {
  validate(value: unknown): JsonValue;
  description?: string;
};

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema: ToolSchema;
  outputSchema?: ToolSchema;
  sideEffect: SideEffectClass;
  timeoutMs?: number;
  idempotency: 'NONE' | 'OPERATION_KEY';
  handler(input: JsonValue, context: ToolContext): Promise<JsonValue>;
};

export const jsonSchema: ToolSchema = {
  validate(value: unknown): JsonValue {
    assertJsonValue(value, 'tool payload');
    return value;
  },
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (definition.name.length === 0 || this.tools.has(definition.name)) {
      throw new AgentForgeError({ code: 'TOOL_REGISTRATION_ERROR', category: 'VALIDATION', message: `Tool already registered or invalid: ${definition.name}` });
    }
    if (definition.sideEffect === 'SIDE_EFFECTING' && definition.idempotency !== 'OPERATION_KEY') {
      throw new AgentForgeError({
        code: 'SIDE_EFFECT_IDEMPOTENCY_REQUIRED',
        category: 'VALIDATION',
        message: `SIDE_EFFECTING tool ${definition.name} must declare OPERATION_KEY idempotency`,
      });
    }
    this.tools.set(definition.name, definition);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new AgentForgeError({ code: 'TOOL_NOT_FOUND', category: 'TOOL', message: `Tool not registered: ${name}` });
    return tool;
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()];
  }

  async invoke(name: string, input: unknown, context: ToolContext, maxOutputBytes = 1_048_576): Promise<JsonValue> {
    const tool = this.get(name);
    const parsed = tool.inputSchema.validate(input);
    if (tool.sideEffect === 'SIDE_EFFECTING' && (context.idempotencyKey === undefined || context.idempotencyKey.length === 0)) {
      throw new AgentForgeError({ code: 'IDEMPOTENCY_KEY_REQUIRED', category: 'TOOL', message: `Tool ${name} requires an idempotency key` });
    }
    let output: JsonValue;
    try {
      output = await tool.handler(parsed, context);
    } catch (error) {
      throw asAgentForgeError(error, { code: 'TOOL_EXECUTION_FAILED', category: 'TOOL' });
    }
    const validated = tool.outputSchema?.validate(output) ?? jsonSchema.validate(output);
    if (jsonByteLength(validated) > maxOutputBytes) {
      throw new AgentForgeError({ code: 'TOOL_OUTPUT_TOO_LARGE', category: 'TOOL', message: `Tool output exceeded ${maxOutputBytes} bytes`, retryable: false });
    }
    return validated;
  }
}
