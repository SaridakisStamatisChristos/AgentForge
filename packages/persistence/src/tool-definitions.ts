import { AgentForgeError, createId, type SideEffectClass } from '@agentforge/contracts';
import { PostgresCli } from '@agentforge/persistence';

export type DurableToolDefinitionInput = {
  name: string;
  version?: number;
  description?: string;
  sideEffect: SideEffectClass;
  idempotency: 'NONE' | 'OPERATION_KEY';
  inputSchemaDescription?: string;
  outputSchemaDescription?: string;
};

export type DurableToolDefinition = {
  id: string;
  name: string;
  version: number;
  sideEffect: SideEffectClass;
  idempotency: 'NONE' | 'OPERATION_KEY';
  createdAt: string;
  description?: string;
  inputSchemaDescription?: string;
  outputSchemaDescription?: string;
};

type DbToolDefinition = {
  id: string;
  name: string;
  version: number;
  description: string | null;
  side_effect: SideEffectClass;
  idempotency: 'NONE' | 'OPERATION_KEY';
  input_schema_description: string | null;
  output_schema_description: string | null;
  created_at: string;
};

function map(row: DbToolDefinition): DurableToolDefinition {
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    sideEffect: row.side_effect,
    idempotency: row.idempotency,
    createdAt: row.created_at,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.input_schema_description === null ? {} : { inputSchemaDescription: row.input_schema_description }),
    ...(row.output_schema_description === null ? {} : { outputSchemaDescription: row.output_schema_description }),
  };
}

function equivalent(existing: DurableToolDefinition, input: DurableToolDefinitionInput, version: number): boolean {
  return existing.name === input.name
    && existing.version === version
    && existing.sideEffect === input.sideEffect
    && existing.idempotency === input.idempotency
    && (existing.description ?? '') === (input.description ?? '')
    && (existing.inputSchemaDescription ?? '') === (input.inputSchemaDescription ?? '')
    && (existing.outputSchemaDescription ?? '') === (input.outputSchemaDescription ?? '');
}

export class ToolDefinitionStore {
  constructor(readonly db: PostgresCli) {}

  async get(name: string, version = 1): Promise<DurableToolDefinition | null> {
    const rows = await this.db.json<DbToolDefinition>(String.raw`
SELECT row_to_json(t)::text FROM tool_definitions t WHERE t.name = :'name' AND t.version = :'version'::integer;
`, { name, version });
    return rows[0] === undefined ? null : map(rows[0]);
  }

  async latest(name: string): Promise<DurableToolDefinition | null> {
    const rows = await this.db.json<DbToolDefinition>(String.raw`
SELECT row_to_json(t)::text FROM tool_definitions t WHERE t.name = :'name' ORDER BY t.version DESC LIMIT 1;
`, { name });
    return rows[0] === undefined ? null : map(rows[0]);
  }

  async list(): Promise<DurableToolDefinition[]> {
    const rows = await this.db.json<DbToolDefinition>('SELECT row_to_json(t)::text FROM tool_definitions t ORDER BY t.name, t.version;');
    return rows.map(map);
  }

  async register(input: DurableToolDefinitionInput): Promise<DurableToolDefinition> {
    if (input.name.length === 0 || input.name.length > 256) throw new AgentForgeError({ code: 'INVALID_TOOL_DEFINITION', category: 'VALIDATION', message: 'Tool definition name must be 1..256 characters' });
    const version = input.version ?? 1;
    if (!Number.isSafeInteger(version) || version < 1) throw new AgentForgeError({ code: 'INVALID_TOOL_DEFINITION_VERSION', category: 'VALIDATION', message: 'Tool definition version must be a positive safe integer' });
    if (input.sideEffect === 'SIDE_EFFECTING' && input.idempotency !== 'OPERATION_KEY') {
      throw new AgentForgeError({ code: 'SIDE_EFFECT_IDEMPOTENCY_REQUIRED', category: 'VALIDATION', message: `SIDE_EFFECTING tool ${input.name} must declare OPERATION_KEY idempotency` });
    }
    const current = await this.get(input.name, version);
    if (current !== null) {
      if (!equivalent(current, input, version)) throw new AgentForgeError({ code: 'TOOL_DEFINITION_VERSION_CONFLICT', category: 'VALIDATION', message: `Tool definition ${input.name}@${version} already exists with different metadata` });
      return current;
    }
    await this.db.execute(String.raw`
INSERT INTO tool_definitions(
  id, name, version, description, side_effect, idempotency, input_schema_description, output_schema_description
) VALUES (
  :'id', :'name', :'version'::integer, NULLIF(:'description',''), :'side_effect', :'idempotency', NULLIF(:'input_schema',''), NULLIF(:'output_schema','')
)
ON CONFLICT (name, version) DO NOTHING;
`, {
      id: createId('tooldef'),
      name: input.name,
      version,
      description: input.description ?? '',
      side_effect: input.sideEffect,
      idempotency: input.idempotency,
      input_schema: input.inputSchemaDescription ?? '',
      output_schema: input.outputSchemaDescription ?? '',
    });
    const inserted = await this.get(input.name, version);
    if (inserted === null) throw new AgentForgeError({ code: 'TOOL_DEFINITION_CREATE_FAILED', category: 'PERSISTENCE', message: `Tool definition ${input.name}@${version} was not persisted`, retryable: true });
    if (!equivalent(inserted, input, version)) throw new AgentForgeError({ code: 'TOOL_DEFINITION_VERSION_CONFLICT', category: 'VALIDATION', message: `Concurrent tool definition ${input.name}@${version} differs from requested metadata` });
    return inserted;
  }

  async registerMany(inputs: readonly DurableToolDefinitionInput[]): Promise<DurableToolDefinition[]> {
    const results: DurableToolDefinition[] = [];
    for (const input of inputs) results.push(await this.register(input));
    return results;
  }
}
