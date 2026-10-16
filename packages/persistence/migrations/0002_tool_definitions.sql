BEGIN;

CREATE TABLE IF NOT EXISTS tool_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  description text,
  side_effect text NOT NULL CHECK (side_effect IN ('PURE','IDEMPOTENT','SIDE_EFFECTING')),
  idempotency text NOT NULL CHECK (idempotency IN ('NONE','OPERATION_KEY')),
  input_schema_description text,
  output_schema_description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (name, version)
);
CREATE INDEX IF NOT EXISTS tool_definitions_name_version_idx ON tool_definitions(name, version DESC);

INSERT INTO schema_migrations(version) VALUES ('0002_tool_definitions') ON CONFLICT DO NOTHING;

COMMIT;
