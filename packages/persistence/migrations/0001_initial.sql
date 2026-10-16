BEGIN;

CREATE TABLE IF NOT EXISTS workflow_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS workflow_versions (
  id text PRIMARY KEY,
  workflow_id text NOT NULL REFERENCES workflow_definitions(id),
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id text PRIMARY KEY,
  workflow_version_id text NOT NULL REFERENCES workflow_versions(id),
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLING','CANCELLED')),
  input jsonb NOT NULL,
  output jsonb,
  error jsonb,
  cancellation_requested boolean NOT NULL DEFAULT false,
  next_event_seq bigint NOT NULL DEFAULT 1 CHECK (next_event_seq > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS step_runs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id),
  step_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','READY','LEASED','RUNNING','WAITING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','SKIPPED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  output jsonb,
  error jsonb,
  wait_signal_name text,
  concurrency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, step_id)
);

CREATE TABLE IF NOT EXISTS attempts (
  id text PRIMARY KEY,
  step_run_id text NOT NULL REFERENCES step_runs(id),
  generation bigint NOT NULL CHECK (generation > 0),
  state text NOT NULL CHECK (state IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','LEASE_LOST','TIMED_OUT')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  error jsonb
);
CREATE INDEX IF NOT EXISTS attempts_step_idx ON attempts(step_run_id, started_at);

CREATE TABLE IF NOT EXISTS queue_tasks (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id),
  step_run_id text NOT NULL REFERENCES step_runs(id),
  state text NOT NULL CHECK (state IN ('READY','LEASED','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  lease_generation bigint NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  priority integer NOT NULL DEFAULT 0,
  concurrency_key text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (step_run_id)
);
CREATE INDEX IF NOT EXISTS queue_claim_idx ON queue_tasks(state, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS queue_concurrency_idx ON queue_tasks(concurrency_key, state, lease_expires_at) WHERE concurrency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkpoints (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id),
  step_run_id text NOT NULL REFERENCES step_runs(id),
  attempt_id text NOT NULL REFERENCES attempts(id),
  version integer NOT NULL CHECK (version > 0),
  payload jsonb NOT NULL,
  bytes integer NOT NULL CHECK (bytes >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS checkpoints_step_idx ON checkpoints(step_run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS execution_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id),
  step_run_id text REFERENCES step_runs(id),
  attempt_id text REFERENCES attempts(id),
  seq bigint NOT NULL CHECK (seq > 0),
  type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS events_run_seq_idx ON execution_events(run_id, seq);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id),
  step_run_id text NOT NULL REFERENCES step_runs(id),
  attempt_id text NOT NULL REFERENCES attempts(id),
  tool_name text NOT NULL,
  operation_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('STARTED','COMPLETED','FAILED')),
  input jsonb NOT NULL,
  output jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tool_name, operation_key)
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  operation_key text PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('STARTED','COMPLETED','FAILED')),
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS signals (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workflow_runs(id),
  name text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL,
  delivered_at timestamptz,
  delivered_step_run_id text REFERENCES step_runs(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, name, dedupe_key)
);
CREATE INDEX IF NOT EXISTS signals_run_name_idx ON signals(run_id, name, created_at);

CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_id text PRIMARY KEY,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION agentforge_emit_event(
  p_run_id text,
  p_step_run_id text,
  p_attempt_id text,
  p_type text,
  p_payload jsonb
) RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_seq bigint;
BEGIN
  UPDATE workflow_runs
  SET next_event_seq = next_event_seq + 1
  WHERE id = p_run_id
  RETURNING next_event_seq - 1 INTO v_seq;
  IF v_seq IS NULL THEN
    RAISE EXCEPTION 'run not found for event: %', p_run_id;
  END IF;
  INSERT INTO execution_events(id, run_id, step_run_id, attempt_id, seq, type, schema_version, payload)
  VALUES (p_run_id || ':event:' || v_seq::text, p_run_id, p_step_run_id, p_attempt_id, v_seq, p_type, 1, COALESCE(p_payload, '{}'::jsonb));
  RETURN v_seq;
END;
$$;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO schema_migrations(version) VALUES ('0001_initial') ON CONFLICT DO NOTHING;

COMMIT;
