import { AgentForgeError } from '@agentforge/contracts';
import { PostgresStore } from '@agentforge/persistence';
import type { RuntimeStore } from '@agentforge/runtime';

export type ApiIdempotencyReservation =
  | { kind: 'reserved' }
  | { kind: 'replay'; statusCode: number; body: unknown }
  | { kind: 'conflict' }
  | { kind: 'in_progress' };

export interface ApiIdempotencyStore {
  reserve(key: string, fingerprint: string): Promise<ApiIdempotencyReservation>;
  complete(key: string, fingerprint: string, statusCode: number, body: unknown): Promise<void>;
  release(key: string, fingerprint: string): Promise<void>;
}

type PersistedResult = {
  fingerprint?: string;
  statusCode?: number;
  body?: unknown;
};

type PersistedReservation = {
  inserted: boolean;
  state: 'STARTED' | 'COMPLETED' | 'FAILED';
  result: PersistedResult | null;
};

class MemoryApiIdempotencyStore implements ApiIdempotencyStore {
  private readonly records = new Map<string, { fingerprint: string; state: 'STARTED' | 'COMPLETED'; statusCode?: number; body?: unknown }>();

  async reserve(key: string, fingerprint: string): Promise<ApiIdempotencyReservation> {
    const existing = this.records.get(key);
    if (existing === undefined) {
      this.records.set(key, { fingerprint, state: 'STARTED' });
      return { kind: 'reserved' };
    }
    if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
    if (existing.state === 'COMPLETED' && existing.statusCode !== undefined) {
      return { kind: 'replay', statusCode: existing.statusCode, body: existing.body };
    }
    return { kind: 'in_progress' };
  }

  async complete(key: string, fingerprint: string, statusCode: number, body: unknown): Promise<void> {
    const existing = this.records.get(key);
    if (existing === undefined || existing.fingerprint !== fingerprint || existing.state !== 'STARTED') {
      throw new AgentForgeError({ code: 'IDEMPOTENCY_STATE_LOST', category: 'INTERNAL_INVARIANT', message: 'API idempotency reservation is no longer authoritative' });
    }
    this.records.set(key, { fingerprint, state: 'COMPLETED', statusCode, body });
  }

  async release(key: string, fingerprint: string): Promise<void> {
    const existing = this.records.get(key);
    if (existing?.fingerprint === fingerprint && existing.state === 'STARTED') this.records.delete(key);
  }
}

class PostgresApiIdempotencyStore implements ApiIdempotencyStore {
  constructor(private readonly store: PostgresStore) {}

  private operationKey(key: string): string {
    return `api:run:${key}`;
  }

  async reserve(key: string, fingerprint: string): Promise<ApiIdempotencyReservation> {
    const operationKey = this.operationKey(key);
    const seed = JSON.stringify({ fingerprint });
    const rows = await this.store.db.json<PersistedReservation>(String.raw`
WITH inserted AS (
  INSERT INTO idempotency_records(operation_key, state, result)
  VALUES (:'operation_key', 'STARTED', :'seed'::jsonb)
  ON CONFLICT (operation_key) DO NOTHING
  RETURNING state, result
), chosen AS (
  SELECT true AS inserted, state, result FROM inserted
  UNION ALL
  SELECT false AS inserted, state, result
  FROM idempotency_records
  WHERE operation_key = :'operation_key' AND NOT EXISTS (SELECT 1 FROM inserted)
  LIMIT 1
)
SELECT json_build_object('inserted', inserted, 'state', state, 'result', result)::text FROM chosen;
`, { operation_key: operationKey, seed });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'IDEMPOTENCY_RESERVATION_FAILED', category: 'PERSISTENCE', message: 'Unable to read API idempotency reservation', retryable: true });
    const storedFingerprint = row.result?.fingerprint;
    if (storedFingerprint !== fingerprint) return { kind: 'conflict' };
    if (row.inserted) return { kind: 'reserved' };
    if (row.state === 'COMPLETED' && typeof row.result?.statusCode === 'number') {
      return { kind: 'replay', statusCode: row.result.statusCode, body: row.result.body };
    }
    return { kind: 'in_progress' };
  }

  async complete(key: string, fingerprint: string, statusCode: number, body: unknown): Promise<void> {
    const result = JSON.stringify({ fingerprint, statusCode, body });
    const rows = await this.store.db.query(String.raw`
UPDATE idempotency_records
SET state = 'COMPLETED', result = :'result'::jsonb, updated_at = clock_timestamp()
WHERE operation_key = :'operation_key' AND state = 'STARTED' AND result->>'fingerprint' = :'fingerprint'
RETURNING operation_key;
`, { operation_key: this.operationKey(key), fingerprint, result });
    if (rows.length !== 1) throw new AgentForgeError({ code: 'IDEMPOTENCY_STATE_LOST', category: 'PERSISTENCE', message: 'API idempotency reservation was not authoritative at completion', retryable: true });
  }

  async release(key: string, fingerprint: string): Promise<void> {
    await this.store.db.execute(String.raw`
DELETE FROM idempotency_records
WHERE operation_key = :'operation_key' AND state = 'STARTED' AND result->>'fingerprint' = :'fingerprint';
`, { operation_key: this.operationKey(key), fingerprint });
  }
}

export function createApiIdempotencyStore(store: RuntimeStore): ApiIdempotencyStore {
  return store instanceof PostgresStore ? new PostgresApiIdempotencyStore(store) : new MemoryApiIdempotencyStore();
}
