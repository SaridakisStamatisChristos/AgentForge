from pathlib import Path
import re
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 match, found {count}')
    return text.replace(old, new, 1)

migration = root / 'packages/persistence/migrations/0001_initial.sql'
text = migration.read_text()
pattern = re.compile(r"CREATE OR REPLACE FUNCTION agentforge_emit_event\(.*?\n\$\$;", re.S)
replacement = """CREATE TABLE IF NOT EXISTS run_event_sequences (
  run_id text PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq > 0)
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
  INSERT INTO run_event_sequences(run_id, next_seq)
  VALUES (p_run_id, 2)
  ON CONFLICT (run_id) DO UPDATE
  SET next_seq = run_event_sequences.next_seq + 1
  RETURNING run_event_sequences.next_seq - 1 INTO v_seq;
  INSERT INTO execution_events(id, run_id, step_run_id, attempt_id, seq, type, schema_version, payload)
  VALUES (p_run_id || ':event:' || v_seq::text, p_run_id, p_step_run_id, p_attempt_id, v_seq, p_type, 1, COALESCE(p_payload, '{}'::jsonb));
  RETURN v_seq;
END;
$$;"""
text, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f'event function: expected 1 match, found {count}')
migration.write_text(text)

persistence = root / 'packages/persistence/src/index.ts'
text = persistence.read_text()

start = text.index('  async finalizeSuccess(')
end = text.index('  async finalizeFailure(', start)
segment = text[start:end]
segment = replace_once(segment,
    "WHERE wr.id = sr.run_id AND js->>'id' = sr.step_id AND d.state <> 'SUCCEEDED'",
    "WHERE wr.id = sr.run_id AND js->>'id' = sr.step_id AND d.state <> 'SUCCEEDED' AND d.id <> :'step_run_id'",
    'finalize dependency visibility')
segment = replace_once(segment,
    "AND NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id = r.id AND s.state NOT IN ('SUCCEEDED','SKIPPED'))",
    "AND NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id = r.id AND s.id <> :'step_run_id' AND s.state NOT IN ('SUCCEEDED','SKIPPED'))",
    'finalize terminal visibility')
segment = replace_once(segment,
    "      run_id: claim.runId,\n    });",
    "      run_id: claim.runId,\n      step_run_id: claim.stepRunId,\n    });",
    'finalize step parameter')
text = text[:start] + segment + text[end:]

start = text.index('  async submitSignal(')
end = text.index('  async writeCheckpoint(', start)
segment = text[start:end]
old_signal_prefix = """WITH existing AS (
  SELECT id, delivered_step_run_id FROM signals WHERE run_id = :'run_id' AND name = :'name' AND dedupe_key = :'dedupe_key'
), inserted AS (
  INSERT INTO signals(id, run_id, name, payload, dedupe_key)
  SELECT :'signal_id', :'run_id', :'name', :'payload'::jsonb, :'dedupe_key'
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  ON CONFLICT DO NOTHING
  RETURNING *
), target AS (
  UPDATE step_runs s SET state = 'SUCCEEDED', wait_signal_name = NULL, output = :'payload'::jsonb, updated_at = clock_timestamp()
  WHERE s.run_id = :'run_id' AND s.state = 'WAITING' AND s.wait_signal_name = :'name' AND EXISTS (SELECT 1 FROM inserted)
  RETURNING s.*
), signal_update AS (
  UPDATE signals SET delivered_at = clock_timestamp(), delivered_step_run_id = (SELECT id FROM target LIMIT 1)
  WHERE id = :'signal_id' AND EXISTS (SELECT 1 FROM target) RETURNING *
), cleanup AS (
  DELETE FROM signals WHERE id = :'signal_id' AND EXISTS (SELECT 1 FROM inserted) AND NOT EXISTS (SELECT 1 FROM target) RETURNING id
), run_update AS ("""
new_signal_prefix = """WITH existing AS (
  SELECT id, delivered_step_run_id FROM signals WHERE run_id = :'run_id' AND name = :'name' AND dedupe_key = :'dedupe_key'
), waiting AS (
  SELECT s.id FROM step_runs s
  WHERE s.run_id = :'run_id' AND s.state = 'WAITING' AND s.wait_signal_name = :'name'
    AND NOT EXISTS (SELECT 1 FROM existing)
  ORDER BY s.created_at, s.id
  FOR UPDATE
  LIMIT 1
), inserted AS (
  INSERT INTO signals(id, run_id, name, payload, dedupe_key, delivered_at, delivered_step_run_id)
  SELECT :'signal_id', :'run_id', :'name', :'payload'::jsonb, :'dedupe_key', clock_timestamp(), w.id
  FROM waiting w
  ON CONFLICT DO NOTHING
  RETURNING *
), target AS (
  UPDATE step_runs s SET state = 'SUCCEEDED', wait_signal_name = NULL, output = :'payload'::jsonb, updated_at = clock_timestamp()
  FROM inserted i
  WHERE s.id = i.delivered_step_run_id AND s.run_id = :'run_id' AND s.state = 'WAITING' AND s.wait_signal_name = :'name'
  RETURNING s.*
), run_update AS ("""
segment = replace_once(segment, old_signal_prefix, new_signal_prefix, 'signal durable delivery record')
segment = replace_once(segment,
    "WHERE wr.id = sr.run_id AND js->>'id' = sr.step_id AND d.state <> 'SUCCEEDED'",
    "WHERE wr.id = sr.run_id AND js->>'id' = sr.step_id AND d.state <> 'SUCCEEDED' AND d.id NOT IN (SELECT id FROM target)",
    'signal dependency visibility')
segment = replace_once(segment,
    "), run_update AS (\n  UPDATE workflow_runs SET state = 'RUNNING', updated_at = clock_timestamp()\n  WHERE id = :'run_id' AND state = 'WAITING' AND EXISTS (SELECT 1 FROM target) RETURNING *\n), newly_ready AS (",
    "), run_update AS (\n  UPDATE workflow_runs r\n  SET state = CASE\n        WHEN NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id=r.id AND s.id NOT IN (SELECT id FROM target) AND s.state NOT IN ('SUCCEEDED','SKIPPED')) THEN 'SUCCEEDED'\n        ELSE 'RUNNING'\n      END,\n      output = CASE\n        WHEN NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id=r.id AND s.id NOT IN (SELECT id FROM target) AND s.state NOT IN ('SUCCEEDED','SKIPPED')) THEN jsonb_build_object('status','succeeded')\n        ELSE r.output\n      END,\n      updated_at = clock_timestamp()\n  WHERE r.id = :'run_id' AND r.state = 'WAITING' AND EXISTS (SELECT 1 FROM target)\n  RETURNING r.*\n), newly_ready AS (",
    'signal run transition')
segment = replace_once(segment,
    "SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.started', jsonb_build_object('resumedBySignal', :'name')) AS seq WHERE EXISTS (SELECT 1 FROM run_update)",
    "SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.started', jsonb_build_object('resumedBySignal', :'name')) AS seq WHERE EXISTS (SELECT 1 FROM run_update WHERE state='RUNNING')",
    'signal resumed event')
old_terminal = """), terminal AS (
  UPDATE workflow_runs r SET state='SUCCEEDED', output=jsonb_build_object('status','succeeded'), updated_at=clock_timestamp()
  WHERE r.id=:'run_id' AND r.state='RUNNING' AND EXISTS (SELECT 1 FROM target)
    AND NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id=r.id AND s.state NOT IN ('SUCCEEDED','SKIPPED'))
  RETURNING r.*
), event_terminal AS (
  SELECT agentforge_emit_event(t.id, NULL, NULL, 'workflow.succeeded', '{}'::jsonb) AS seq FROM terminal t
)"""
new_terminal = """), event_terminal AS (
  SELECT agentforge_emit_event(r.id, NULL, NULL, 'workflow.succeeded', '{}'::jsonb) AS seq
  FROM run_update r WHERE r.state='SUCCEEDED'
)"""
segment = replace_once(segment, old_terminal, new_terminal, 'signal terminal transition')
segment = replace_once(segment,
    "  'queued', (SELECT count(*) FROM queued),\n  'signal_updated', (SELECT count(*) FROM signal_update),\n  'cleaned', (SELECT count(*) FROM cleanup)",
    "  'queued', (SELECT count(*) FROM queued)",
    'signal obsolete sibling counters')
text = text[:start] + segment + text[end:]
persistence.write_text(text)
