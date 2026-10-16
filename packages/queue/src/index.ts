import { AgentForgeError } from '@agentforge/contracts';

export function assertLeaseConfiguration(leaseMs: number, heartbeatMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 3_600_000) {
    throw new AgentForgeError({ code: 'INVALID_LEASE_DURATION', category: 'VALIDATION', message: 'leaseMs must be an integer in [100,3600000]' });
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs >= leaseMs) {
    throw new AgentForgeError({ code: 'INVALID_HEARTBEAT_INTERVAL', category: 'VALIDATION', message: 'heartbeatMs must be an integer >=10 and < leaseMs' });
  }
}

export const CLAIM_SQL = String.raw`
WITH candidates AS (
  SELECT q.id
  FROM queue_tasks q
  WHERE q.state IN ('READY', 'RETRY_SCHEDULED')
    AND q.available_at <= clock_timestamp()
    AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= clock_timestamp())
    AND NOT EXISTS (
      SELECT 1
      FROM queue_tasks active
      WHERE q.concurrency_key IS NOT NULL
        AND active.concurrency_key = q.concurrency_key
        AND active.id <> q.id
        AND active.state = 'LEASED'
        AND active.lease_expires_at > clock_timestamp()
    )
  ORDER BY q.priority DESC, q.available_at ASC, q.created_at ASC
  FOR UPDATE SKIP LOCKED
  LIMIT :batch
), claimed AS (
  UPDATE queue_tasks q
  SET state = 'LEASED',
      lease_owner = :'worker',
      lease_expires_at = clock_timestamp() + (:'lease_ms' || ' milliseconds')::interval,
      lease_generation = q.lease_generation + 1,
      attempt_no = q.attempt_no + 1,
      updated_at = clock_timestamp()
  FROM candidates c
  WHERE q.id = c.id
  RETURNING q.*
)
SELECT row_to_json(claimed)::text FROM claimed;
`;

export const HEARTBEAT_SQL = String.raw`
UPDATE queue_tasks
SET lease_expires_at = clock_timestamp() + (:'lease_ms' || ' milliseconds')::interval,
    updated_at = clock_timestamp()
WHERE id = :'task_id'
  AND state = 'LEASED'
  AND lease_owner = :'worker'
  AND lease_generation = :'generation'::bigint
  AND lease_expires_at > clock_timestamp()
RETURNING row_to_json(queue_tasks)::text;
`;

export const AUTHORITATIVE_FENCE_PREDICATE = String.raw`
q.state = 'LEASED'
AND q.lease_owner = :'worker'
AND q.lease_generation = :'generation'::bigint
AND q.lease_expires_at > clock_timestamp()
`;
