import { spawn } from 'node:child_process';
import {
  AgentForgeError,
  createId,
  jsonByteLength,
  type Attempt,
  type Checkpoint,
  type ExecutionEvent,
  type JsonValue,
  type LeaseClaim,
  type QueueTask,
  type SerializedAgentForgeError,
  type StepRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowVersion,
} from '@agentforge/contracts';
import { AUTHORITATIVE_FENCE_PREDICATE } from '@agentforge/queue';
import type {
  ExecutionContextSnapshot,
  RuntimeStore,
  SignalResult,
  ToolInvocationRecord,
} from '@agentforge/runtime';
import { buildWorkflowGraph } from '@agentforge/workflows';

export type PsqlVariables = Readonly<Record<string, string | number | boolean>>;

function safeDatabaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}`;
  } catch {
    return '<invalid database url>';
  }
}

export class PostgresCli {
  constructor(readonly databaseUrl: string, readonly executable = 'psql') {}

  async query(sql: string, variables: PsqlVariables = {}): Promise<string[]> {
    const args = [this.databaseUrl, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'];
    for (const [key, value] of Object.entries(variables)) args.push('-v', `${key}=${String(value)}`);
    return new Promise<string[]>((resolve, reject) => {
      const child = spawn(this.executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Uint8Array) => { stdout += new TextDecoder().decode(chunk); });
      child.stderr.on('data', (chunk: Uint8Array) => { stderr += new TextDecoder().decode(chunk); });
      child.on('error', (error: Error) => {
        reject(new AgentForgeError({
          code: 'DATABASE_CLIENT_ERROR',
          category: 'PERSISTENCE',
          message: `Unable to execute psql for ${safeDatabaseLabel(this.databaseUrl)}: ${error.message}`,
          retryable: true,
        }));
      });
      child.on('close', (code: number | null) => {
        if (code !== 0) {
          reject(new AgentForgeError({
            code: 'DATABASE_QUERY_FAILED',
            category: 'PERSISTENCE',
            message: `PostgreSQL command failed for ${safeDatabaseLabel(this.databaseUrl)}: ${stderr.trim().slice(0, 2000)}`,
            retryable: true,
          }));
          return;
        }
        resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0));
      });
      child.stdin.end(sql);
    });
  }

  async json<T>(sql: string, variables: PsqlVariables = {}): Promise<T[]> {
    const lines = await this.query(sql, variables);
    const values: T[] = [];
    for (const line of lines) {
      if (!line.startsWith('{') && !line.startsWith('[')) continue;
      values.push(JSON.parse(line) as T);
    }
    return values;
  }

  async execute(sql: string, variables: PsqlVariables = {}): Promise<void> {
    await this.query(sql, variables);
  }
}

type DbRun = {
  id: string;
  workflow_version_id: string;
  state: WorkflowRun['state'];
  input: JsonValue;
  output: JsonValue | null;
  error: SerializedAgentForgeError | null;
  cancellation_requested: boolean;
  created_at: string;
  updated_at: string;
};

type DbStep = {
  id: string;
  run_id: string;
  step_id: string;
  state: StepRun['state'];
  attempt_count: number;
  output: JsonValue | null;
  error: SerializedAgentForgeError | null;
  wait_signal_name: string | null;
  concurrency_key: string | null;
  created_at: string;
  updated_at: string;
};

type DbVersion = {
  id: string;
  workflow_id: string;
  version: number;
  definition: WorkflowDefinition;
  created_at: string;
};

type DbQueue = {
  id: string;
  run_id: string;
  step_run_id: string;
  state: QueueTask['state'];
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_generation: number;
  attempt_no: number;
  priority: number;
  concurrency_key: string | null;
};

type DbAttempt = {
  id: string;
  step_run_id: string;
  generation: number;
  state: Attempt['state'];
  started_at: string;
  finished_at: string | null;
  error: SerializedAgentForgeError | null;
};

type DbCheckpoint = {
  id: string;
  run_id: string;
  step_run_id: string;
  attempt_id: string;
  version: number;
  payload: JsonValue;
  bytes: number;
  created_at: string;
};

type DbEvent = {
  id: string;
  run_id: string;
  step_run_id: string | null;
  attempt_id: string | null;
  type: ExecutionEvent['type'];
  created_at: string;
  schema_version: 1;
  seq: number;
  payload: ExecutionEvent['payload'];
};

type DbTool = {
  id: string;
  tool_name: string;
  operation_key: string;
  state: ToolInvocationRecord['state'];
  output: JsonValue | null;
  error: SerializedAgentForgeError | null;
};

function mapRun(row: DbRun): WorkflowRun {
  return {
    id: row.id,
    workflowVersionId: row.workflow_version_id,
    state: row.state,
    input: row.input,
    cancellationRequested: row.cancellation_requested,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function mapStep(row: DbStep): StepRun {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.wait_signal_name === null ? {} : { waitSignalName: row.wait_signal_name }),
    ...(row.concurrency_key === null ? {} : { concurrencyKey: row.concurrency_key }),
  };
}

function mapVersion(row: DbVersion): WorkflowVersion {
  return { id: row.id, workflowId: row.workflow_id, version: row.version, definition: row.definition, createdAt: row.created_at };
}

function mapClaim(row: DbQueue): LeaseClaim {
  if (row.state !== 'LEASED' || row.lease_owner === null || row.lease_expires_at === null) {
    throw new AgentForgeError({ code: 'INVALID_LEASE_ROW', category: 'INTERNAL_INVARIANT', message: 'Claim query returned a non-leased row' });
  }
  return {
    id: row.id,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    state: 'LEASED',
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    leaseGeneration: Number(row.lease_generation),
    attemptNo: row.attempt_no,
    priority: row.priority,
    ...(row.concurrency_key === null ? {} : { concurrencyKey: row.concurrency_key }),
  };
}

function mapAttempt(row: DbAttempt): Attempt {
  return {
    id: row.id,
    stepRunId: row.step_run_id,
    generation: Number(row.generation),
    state: row.state,
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function mapCheckpoint(row: DbCheckpoint): Checkpoint {
  return {
    id: row.id,
    runId: row.run_id,
    stepRunId: row.step_run_id,
    attemptId: row.attempt_id,
    version: row.version,
    payload: row.payload,
    bytes: row.bytes,
    createdAt: row.created_at,
  };
}

function mapEvent(row: DbEvent): ExecutionEvent {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.type,
    timestamp: row.created_at,
    schemaVersion: row.schema_version,
    sequence: Number(row.seq),
    payload: row.payload,
    ...(row.step_run_id === null ? {} : { stepRunId: row.step_run_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
  };
}

export class PostgresStore implements RuntimeStore {
  constructor(readonly db: PostgresCli) {}

  async ping(): Promise<boolean> {
    try {
      const rows = await this.db.query('SELECT 1;');
      return rows.includes('1');
    } catch {
      return false;
    }
  }

  async applyMigration(sql: string): Promise<void> {
    await this.db.execute(sql);
  }

  async createWorkflow(definition: WorkflowDefinition): Promise<WorkflowVersion> {
    buildWorkflowGraph(definition);
    const workflowId = createId('wf');
    const versionId = createId('wfv');
    const rows = await this.db.json<DbVersion>(String.raw`
BEGIN;
INSERT INTO workflow_definitions(id, name) VALUES (:'workflow_id', :'name');
INSERT INTO workflow_versions(id, workflow_id, version, definition)
VALUES (:'version_id', :'workflow_id', 1, :'definition'::jsonb);
SELECT row_to_json(v)::text FROM workflow_versions v WHERE v.id = :'version_id';
COMMIT;
`, { workflow_id: workflowId, version_id: versionId, name: definition.name, definition: JSON.stringify(definition) });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'WORKFLOW_CREATE_FAILED', category: 'PERSISTENCE', message: 'Workflow creation returned no row' });
    return mapVersion(row);
  }

  async getWorkflowVersion(id: string): Promise<WorkflowVersion | null> {
    const rows = await this.db.json<DbVersion>('SELECT row_to_json(v)::text FROM workflow_versions v WHERE v.id = :\'id\';', { id });
    return rows[0] === undefined ? null : mapVersion(rows[0]);
  }

  async getWorkflowLatest(workflowId: string): Promise<WorkflowVersion | null> {
    const rows = await this.db.json<DbVersion>(String.raw`
SELECT row_to_json(v)::text FROM workflow_versions v WHERE v.workflow_id = :'id' ORDER BY v.version DESC LIMIT 1;
`, { id: workflowId });
    return rows[0] === undefined ? null : mapVersion(rows[0]);
  }

  async createRun(workflowVersion: WorkflowVersion, input: JsonValue): Promise<WorkflowRun> {
    const graph = buildWorkflowGraph(workflowVersion.definition);
    const roots = new Set(graph.order.filter((id) => (graph.dependencies.get(id) ?? []).length === 0));
    const runId = createId('run');
    const steps = workflowVersion.definition.steps.map((step) => ({
      id: createId('step'),
      step_id: step.id,
      state: roots.has(step.id) ? 'READY' : 'PENDING',
      concurrency_key: step.concurrencyKey ?? null,
      queue_id: roots.has(step.id) ? createId('task') : null,
    }));
    const rows = await this.db.json<DbRun>(String.raw`
BEGIN;
INSERT INTO workflow_runs(id, workflow_version_id, state, input)
VALUES (:'run_id', :'version_id', 'QUEUED', :'input'::jsonb);
SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.created', '{}'::jsonb);
UPDATE workflow_runs SET state = 'RUNNING', updated_at = clock_timestamp() WHERE id = :'run_id';
SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.started', '{}'::jsonb);
WITH s AS (
  SELECT * FROM jsonb_to_recordset(:'steps'::jsonb)
    AS x(id text, step_id text, state text, concurrency_key text, queue_id text)
)
INSERT INTO step_runs(id, run_id, step_id, state, concurrency_key)
SELECT id, :'run_id', step_id, state, concurrency_key FROM s;
WITH s AS (
  SELECT * FROM jsonb_to_recordset(:'steps'::jsonb)
    AS x(id text, step_id text, state text, concurrency_key text, queue_id text)
)
INSERT INTO queue_tasks(id, run_id, step_run_id, state, concurrency_key)
SELECT queue_id, :'run_id', id, 'READY', concurrency_key FROM s WHERE state = 'READY';
SELECT agentforge_emit_event(:'run_id', s.id, NULL, 'step.ready', jsonb_build_object('stepId', s.step_id))
FROM jsonb_to_recordset(:'steps'::jsonb) AS s(id text, step_id text, state text, concurrency_key text, queue_id text)
WHERE s.state = 'READY';
SELECT row_to_json(r)::text FROM workflow_runs r WHERE r.id = :'run_id';
COMMIT;
`, { run_id: runId, version_id: workflowVersion.id, input: JSON.stringify(input), steps: JSON.stringify(steps) });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'RUN_CREATE_FAILED', category: 'PERSISTENCE', message: 'Run creation returned no row' });
    return mapRun(row);
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    const rows = await this.db.json<DbRun>('SELECT row_to_json(r)::text FROM workflow_runs r WHERE r.id = :\'id\';', { id });
    return rows[0] === undefined ? null : mapRun(rows[0]);
  }

  async listStepRuns(runId: string): Promise<StepRun[]> {
    const rows = await this.db.json<DbStep>(String.raw`
SELECT row_to_json(s)::text FROM step_runs s WHERE s.run_id = :'run_id' ORDER BY s.created_at, s.step_id;
`, { run_id: runId });
    return rows.map(mapStep);
  }

  async listEvents(runId: string, options: { after?: number; limit?: number } = {}): Promise<ExecutionEvent[]> {
    const after = options.after ?? 0;
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const rows = await this.db.json<DbEvent>(String.raw`
SELECT row_to_json(e)::text FROM execution_events e
WHERE e.run_id = :'run_id' AND e.seq > :'after'::bigint
ORDER BY e.seq ASC LIMIT :'limit'::integer;
`, { run_id: runId, after, limit });
    return rows.map(mapEvent);
  }

  async getExecutionContext(stepRunId: string): Promise<ExecutionContextSnapshot> {
    const rows = await this.db.json<{ run: DbRun; step: DbStep; version: DbVersion }>(String.raw`
SELECT json_build_object(
  'run', row_to_json(r),
  'step', row_to_json(s),
  'version', row_to_json(v)
)::text
FROM step_runs s
JOIN workflow_runs r ON r.id = s.run_id
JOIN workflow_versions v ON v.id = r.workflow_version_id
WHERE s.id = :'step_run_id';
`, { step_run_id: stepRunId });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'STEP_RUN_NOT_FOUND', category: 'PERSISTENCE', message: `Step run not found: ${stepRunId}`, httpStatus: 404 });
    const outputRows = await this.db.json<{ step_id: string; output: JsonValue }>(String.raw`
SELECT json_build_object('step_id', s.step_id, 'output', s.output)::text
FROM step_runs s WHERE s.run_id = :'run_id' AND s.output IS NOT NULL;
`, { run_id: row.run.id });
    return {
      run: mapRun(row.run),
      stepRun: mapStep(row.step),
      workflowVersion: mapVersion(row.version),
      stepOutputs: Object.fromEntries(outputRows.map((item) => [item.step_id, item.output])),
    };
  }

  async claimTasks(workerId: string, batchSize: number, leaseMs: number): Promise<LeaseClaim[]> {
    const claims: LeaseClaim[] = [];
    const bounded = Math.max(1, Math.min(100, batchSize));
    for (let index = 0; index < bounded; index += 1) {
      const rows = await this.db.json<DbQueue>(String.raw`
WITH candidate AS (
  SELECT q.id
  FROM queue_tasks q
  JOIN workflow_runs r ON r.id = q.run_id
  WHERE q.state IN ('READY','RETRY_SCHEDULED')
    AND q.available_at <= clock_timestamp()
    AND (q.lease_expires_at IS NULL OR q.lease_expires_at <= clock_timestamp())
    AND r.state IN ('RUNNING','WAITING')
    AND r.cancellation_requested = false
    AND NOT EXISTS (
      SELECT 1 FROM queue_tasks active
      WHERE q.concurrency_key IS NOT NULL
        AND active.concurrency_key = q.concurrency_key
        AND active.id <> q.id
        AND active.state = 'LEASED'
        AND active.lease_expires_at > clock_timestamp()
    )
  ORDER BY q.priority DESC, q.available_at ASC, q.created_at ASC
  FOR UPDATE OF q SKIP LOCKED
  LIMIT 1
), claimed AS (
  UPDATE queue_tasks q
  SET state = 'LEASED', lease_owner = :'worker',
      lease_expires_at = clock_timestamp() + (:'lease_ms' || ' milliseconds')::interval,
      lease_generation = q.lease_generation + 1,
      attempt_no = q.attempt_no + 1,
      updated_at = clock_timestamp()
  FROM candidate c WHERE q.id = c.id
  RETURNING q.*
), step_update AS (
  UPDATE step_runs s SET state = 'LEASED', updated_at = clock_timestamp()
  FROM claimed c WHERE s.id = c.step_run_id AND s.state IN ('READY','RETRY_SCHEDULED')
  RETURNING s.id
), event_emit AS (
  SELECT agentforge_emit_event(c.run_id, c.step_run_id, NULL, 'step.leased', jsonb_build_object('workerId', :'worker', 'generation', c.lease_generation)) AS seq
  FROM claimed c WHERE EXISTS (SELECT 1 FROM step_update)
)
SELECT row_to_json(c)::text FROM claimed c
WHERE EXISTS (SELECT 1 FROM step_update) AND (SELECT count(*) FROM event_emit) >= 0;
`, { worker: workerId, lease_ms: leaseMs });
      const row = rows[0];
      if (row === undefined) break;
      claims.push(mapClaim(row));
    }
    return claims;
  }

  async beginAttempt(claim: LeaseClaim): Promise<Attempt> {
    const attemptId = createId('attempt');
    const rows = await this.db.json<DbAttempt>(String.raw`
WITH authority AS (
  SELECT q.* FROM queue_tasks q
  WHERE q.id = :'task_id'
    AND q.state = 'LEASED'
    AND q.lease_owner = :'worker'
    AND q.lease_generation = :'generation'::bigint
    AND q.lease_expires_at > clock_timestamp()
  FOR UPDATE
), step_update AS (
  UPDATE step_runs s SET state = 'RUNNING', attempt_count = GREATEST(s.attempt_count + 1, :'attempt_no'::integer), updated_at = clock_timestamp()
  FROM authority a WHERE s.id = a.step_run_id AND s.state = 'LEASED'
  RETURNING s.*
), inserted AS (
  INSERT INTO attempts(id, step_run_id, generation, state)
  SELECT :'attempt_id', a.step_run_id, a.lease_generation, 'RUNNING' FROM authority a
  WHERE EXISTS (SELECT 1 FROM step_update)
  RETURNING *
), event_attempt AS (
  SELECT agentforge_emit_event(a.run_id, a.step_run_id, :'attempt_id', 'attempt.started', jsonb_build_object('generation', a.lease_generation)) AS seq
  FROM authority a WHERE EXISTS (SELECT 1 FROM inserted)
), event_step AS (
  SELECT agentforge_emit_event(a.run_id, a.step_run_id, :'attempt_id', 'step.started', '{}'::jsonb) AS seq
  FROM authority a WHERE EXISTS (SELECT 1 FROM inserted)
)
SELECT row_to_json(i)::text FROM inserted i
WHERE (SELECT count(*) FROM event_attempt) >= 0 AND (SELECT count(*) FROM event_step) >= 0;
`, { task_id: claim.id, worker: claim.leaseOwner, generation: claim.leaseGeneration, attempt_no: claim.attemptNo, attempt_id: attemptId });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Lease was not authoritative when beginning attempt', retryable: true, httpStatus: 409 });
    return mapAttempt(row);
  }

  async heartbeat(claim: LeaseClaim, leaseMs: number): Promise<{ authoritative: boolean; cancellationRequested: boolean; leaseExpiresAt?: string }> {
    const rows = await this.db.json<{ lease_expires_at: string; cancellation_requested: boolean }>(String.raw`
WITH updated AS (
  UPDATE queue_tasks q
  SET lease_expires_at = clock_timestamp() + (:'lease_ms' || ' milliseconds')::interval,
      updated_at = clock_timestamp()
  WHERE q.id = :'task_id' AND q.state = 'LEASED' AND q.lease_owner = :'worker'
    AND q.lease_generation = :'generation'::bigint AND q.lease_expires_at > clock_timestamp()
  RETURNING q.*
)
SELECT json_build_object('lease_expires_at', u.lease_expires_at, 'cancellation_requested', r.cancellation_requested)::text
FROM updated u JOIN workflow_runs r ON r.id = u.run_id;
`, { task_id: claim.id, worker: claim.leaseOwner, generation: claim.leaseGeneration, lease_ms: leaseMs });
    const row = rows[0];
    if (row === undefined) return { authoritative: false, cancellationRequested: false };
    return { authoritative: true, cancellationRequested: row.cancellation_requested, leaseExpiresAt: row.lease_expires_at };
  }

  async finalizeSuccess(claim: LeaseClaim, attemptId: string, output: JsonValue): Promise<void> {
    const rows = await this.db.json<{ committed: boolean }>(String.raw`
WITH authority AS (
  UPDATE queue_tasks q
  SET state = 'SUCCEEDED', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
  FROM workflow_runs r
  WHERE q.id = :'task_id' AND r.id = q.run_id
    AND ${AUTHORITATIVE_FENCE_PREDICATE}
    AND r.cancellation_requested = false AND r.state IN ('RUNNING','WAITING')
    AND EXISTS (SELECT 1 FROM step_runs s WHERE s.id=q.step_run_id AND s.state='RUNNING')
    AND EXISTS (SELECT 1 FROM attempts a WHERE a.id=:'attempt_id' AND a.step_run_id=q.step_run_id AND a.generation=q.lease_generation AND a.state='RUNNING')
  RETURNING q.*
), step_done AS (
  UPDATE step_runs s SET state = 'SUCCEEDED', output = :'output'::jsonb, error = NULL, updated_at = clock_timestamp()
  FROM authority a WHERE s.id = a.step_run_id AND s.state = 'RUNNING'
  RETURNING s.*
), attempt_done AS (
  UPDATE attempts a SET state = 'SUCCEEDED', finished_at = clock_timestamp(), error = NULL
  FROM authority q WHERE a.id = :'attempt_id' AND a.step_run_id = q.step_run_id AND a.generation = q.lease_generation AND a.state = 'RUNNING'
  RETURNING a.*
), event_step AS (
  SELECT agentforge_emit_event(q.run_id, q.step_run_id, :'attempt_id', 'step.succeeded', '{}'::jsonb) AS seq
  FROM authority q WHERE EXISTS (SELECT 1 FROM step_done) AND EXISTS (SELECT 1 FROM attempt_done)
), newly_ready AS (
  UPDATE step_runs sr SET state = 'READY', updated_at = clock_timestamp()
  WHERE sr.run_id = :'run_id' AND sr.state = 'PENDING' AND EXISTS (SELECT 1 FROM authority)
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_runs wr
      JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
      CROSS JOIN LATERAL jsonb_array_elements(wv.definition->'steps') js
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(js->'dependsOn', '[]'::jsonb)) dep
      JOIN step_runs d ON d.run_id = sr.run_id AND d.step_id = dep.value
      WHERE wr.id = sr.run_id AND js->>'id' = sr.step_id AND d.state <> 'SUCCEEDED'
    )
  RETURNING sr.*
), queued AS (
  INSERT INTO queue_tasks(id, run_id, step_run_id, state, concurrency_key)
  SELECT 'task_' || md5(n.id || clock_timestamp()::text || random()::text), n.run_id, n.id, 'READY', n.concurrency_key
  FROM newly_ready n ON CONFLICT (step_run_id) DO NOTHING
  RETURNING *
), event_ready AS (
  SELECT agentforge_emit_event(n.run_id, n.id, NULL, 'step.ready', jsonb_build_object('stepId', n.step_id)) AS seq FROM newly_ready n
), terminal AS (
  UPDATE workflow_runs r SET state = 'SUCCEEDED', output = jsonb_build_object('status','succeeded'), updated_at = clock_timestamp()
  WHERE r.id = :'run_id' AND r.state IN ('RUNNING','WAITING') AND r.cancellation_requested = false
    AND EXISTS (SELECT 1 FROM authority)
    AND NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id = r.id AND s.state NOT IN ('SUCCEEDED','SKIPPED'))
  RETURNING r.*
), event_terminal AS (
  SELECT agentforge_emit_event(t.id, NULL, NULL, 'workflow.succeeded', '{}'::jsonb) AS seq FROM terminal t
)
SELECT json_build_object(
  'committed', EXISTS (SELECT 1 FROM authority) AND EXISTS (SELECT 1 FROM step_done) AND EXISTS (SELECT 1 FROM attempt_done),
  'events', (SELECT count(*) FROM event_step) + (SELECT count(*) FROM event_ready) + (SELECT count(*) FROM event_terminal),
  'queued', (SELECT count(*) FROM queued)
)::text;
`, {
      task_id: claim.id,
      worker: claim.leaseOwner,
      generation: claim.leaseGeneration,
      attempt_id: attemptId,
      output: JSON.stringify(output),
      run_id: claim.runId,
    });
    if (rows[0]?.committed !== true) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Stale worker completion rejected by lease fence', retryable: true, httpStatus: 409 });
  }

  async finalizeFailure(claim: LeaseClaim, attemptId: string, error: SerializedAgentForgeError, retryAt?: string): Promise<void> {
    const retrying = retryAt !== undefined;
    const rows = await this.db.json<{ committed: boolean }>(String.raw`
WITH authority AS (
  UPDATE queue_tasks q
  SET state = CASE WHEN :'retrying'::boolean THEN 'RETRY_SCHEDULED' ELSE 'FAILED' END,
      available_at = CASE WHEN :'retrying'::boolean THEN :'retry_at'::timestamptz ELSE q.available_at END,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE q.id = :'task_id' AND ${AUTHORITATIVE_FENCE_PREDICATE}
    AND EXISTS (SELECT 1 FROM step_runs s WHERE s.id=q.step_run_id AND s.state='RUNNING')
    AND EXISTS (SELECT 1 FROM attempts a WHERE a.id=:'attempt_id' AND a.step_run_id=q.step_run_id AND a.generation=q.lease_generation AND a.state='RUNNING')
  RETURNING q.*
), step_update AS (
  UPDATE step_runs s
  SET state = CASE WHEN :'retrying'::boolean THEN 'RETRY_SCHEDULED' ELSE 'FAILED' END,
      error = :'error'::jsonb, updated_at = clock_timestamp()
  FROM authority a WHERE s.id = a.step_run_id AND s.state = 'RUNNING'
  RETURNING s.*
), attempt_update AS (
  UPDATE attempts a SET state = CASE WHEN :'category' = 'TIMEOUT' THEN 'TIMED_OUT' ELSE 'FAILED' END,
      finished_at = clock_timestamp(), error = :'error'::jsonb
  FROM authority q WHERE a.id = :'attempt_id' AND a.step_run_id = q.step_run_id AND a.generation = q.lease_generation AND a.state = 'RUNNING'
  RETURNING a.*
), event_attempt AS (
  SELECT agentforge_emit_event(q.run_id, q.step_run_id, :'attempt_id', 'attempt.failed', :'error'::jsonb) AS seq FROM authority q WHERE EXISTS (SELECT 1 FROM attempt_update)
), event_step AS (
  SELECT agentforge_emit_event(q.run_id, q.step_run_id, :'attempt_id', CASE WHEN :'retrying'::boolean THEN 'step.retry_scheduled' ELSE 'step.failed' END, :'error'::jsonb) AS seq
  FROM authority q WHERE EXISTS (SELECT 1 FROM step_update)
), failed_run AS (
  UPDATE workflow_runs r SET state = 'FAILED', error = :'error'::jsonb, updated_at = clock_timestamp()
  WHERE r.id = :'run_id' AND NOT :'retrying'::boolean AND r.state NOT IN ('SUCCEEDED','FAILED','CANCELLED') AND EXISTS (SELECT 1 FROM authority)
  RETURNING r.*
), cancelled_queue AS (
  UPDATE queue_tasks q SET state = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE q.run_id = :'run_id' AND NOT :'retrying'::boolean AND q.state IN ('READY','RETRY_SCHEDULED','LEASED') AND q.id <> :'task_id' AND EXISTS (SELECT 1 FROM failed_run)
  RETURNING q.step_run_id
), cancelled_steps AS (
  UPDATE step_runs s SET state = 'CANCELLED', updated_at = clock_timestamp()
  WHERE s.run_id = :'run_id' AND NOT :'retrying'::boolean AND s.state IN ('PENDING','READY','LEASED','RUNNING','WAITING','RETRY_SCHEDULED') AND s.id <> :'step_run_id' AND EXISTS (SELECT 1 FROM failed_run)
  RETURNING s.id
), event_failed_run AS (
  SELECT agentforge_emit_event(f.id, NULL, NULL, 'workflow.failed', :'error'::jsonb) AS seq FROM failed_run f
)
SELECT json_build_object(
  'committed', EXISTS (SELECT 1 FROM authority) AND EXISTS (SELECT 1 FROM step_update) AND EXISTS (SELECT 1 FROM attempt_update),
  'events', (SELECT count(*) FROM event_attempt) + (SELECT count(*) FROM event_step) + (SELECT count(*) FROM event_failed_run),
  'cancelled', (SELECT count(*) FROM cancelled_queue) + (SELECT count(*) FROM cancelled_steps)
)::text;
`, {
      task_id: claim.id,
      worker: claim.leaseOwner,
      generation: claim.leaseGeneration,
      retrying,
      retry_at: retryAt ?? new Date(0).toISOString(),
      error: JSON.stringify(error),
      category: error.category,
      attempt_id: attemptId,
      run_id: claim.runId,
      step_run_id: claim.stepRunId,
    });
    if (rows[0]?.committed !== true) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Failure commit rejected by lease fence', retryable: true, httpStatus: 409 });
  }

  async markWaiting(claim: LeaseClaim, attemptId: string, signalName: string): Promise<void> {
    const rows = await this.db.json<{ committed: boolean }>(String.raw`
WITH authority AS (
  UPDATE queue_tasks q SET state = 'SUCCEEDED', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
  FROM workflow_runs r
  WHERE q.id = :'task_id' AND r.id=q.run_id AND ${AUTHORITATIVE_FENCE_PREDICATE}
    AND r.cancellation_requested=false AND r.state IN ('RUNNING','WAITING')
    AND EXISTS (SELECT 1 FROM step_runs s WHERE s.id=q.step_run_id AND s.state='RUNNING')
    AND EXISTS (SELECT 1 FROM attempts a WHERE a.id=:'attempt_id' AND a.step_run_id=q.step_run_id AND a.generation=q.lease_generation AND a.state='RUNNING')
  RETURNING q.*
), step_update AS (
  UPDATE step_runs s SET state = 'WAITING', wait_signal_name = :'signal', updated_at = clock_timestamp()
  FROM authority a WHERE s.id = a.step_run_id AND s.state = 'RUNNING' RETURNING s.*
), attempt_update AS (
  UPDATE attempts a SET state = 'SUCCEEDED', finished_at = clock_timestamp()
  FROM authority q WHERE a.id = :'attempt_id' AND a.step_run_id = q.step_run_id AND a.generation = q.lease_generation AND a.state = 'RUNNING'
  RETURNING a.*
), run_update AS (
  UPDATE workflow_runs r SET state = 'WAITING', updated_at = clock_timestamp()
  WHERE r.id = :'run_id' AND r.state = 'RUNNING' AND EXISTS (SELECT 1 FROM step_update)
  RETURNING r.*
), event_step AS (
  SELECT agentforge_emit_event(:'run_id', :'step_run_id', :'attempt_id', 'step.waiting', jsonb_build_object('signal', :'signal')) AS seq WHERE EXISTS (SELECT 1 FROM step_update)
), event_run AS (
  SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.waiting', jsonb_build_object('signal', :'signal')) AS seq WHERE EXISTS (SELECT 1 FROM run_update)
)
SELECT json_build_object(
  'committed', EXISTS (SELECT 1 FROM authority) AND EXISTS (SELECT 1 FROM step_update) AND EXISTS (SELECT 1 FROM attempt_update),
  'events', (SELECT count(*) FROM event_step) + (SELECT count(*) FROM event_run)
)::text;
`, { task_id: claim.id, worker: claim.leaseOwner, generation: claim.leaseGeneration, attempt_id: attemptId, run_id: claim.runId, step_run_id: claim.stepRunId, signal: signalName });
    if (rows[0]?.committed !== true) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Wait transition rejected by lease fence', retryable: true, httpStatus: 409 });
  }

  async requestCancellation(runId: string): Promise<WorkflowRun> {
    const rows = await this.db.json<DbRun>(String.raw`
BEGIN;
WITH run_update AS (
  UPDATE workflow_runs r
  SET state = CASE WHEN r.state IN ('QUEUED','RUNNING','WAITING') THEN 'CANCELLING' ELSE r.state END,
      cancellation_requested = CASE WHEN r.state IN ('QUEUED','RUNNING','WAITING','CANCELLING') THEN true ELSE r.cancellation_requested END,
      updated_at = clock_timestamp()
  WHERE r.id = :'run_id' RETURNING r.*
)
SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.cancellation_requested', '{}'::jsonb)
WHERE EXISTS (SELECT 1 FROM run_update WHERE state = 'CANCELLING');
UPDATE queue_tasks SET state = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()
WHERE run_id = :'run_id' AND state IN ('READY','RETRY_SCHEDULED','LEASED');
UPDATE step_runs SET state = 'CANCELLED', updated_at = clock_timestamp()
WHERE run_id = :'run_id' AND state IN ('PENDING','READY','LEASED','RUNNING','WAITING','RETRY_SCHEDULED');
WITH terminal AS (
  UPDATE workflow_runs SET state = 'CANCELLED', updated_at = clock_timestamp()
  WHERE id = :'run_id' AND state = 'CANCELLING'
  RETURNING *
)
SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.cancelled', '{}'::jsonb) WHERE EXISTS (SELECT 1 FROM terminal);
SELECT row_to_json(r)::text FROM workflow_runs r WHERE r.id = :'run_id';
COMMIT;
`, { run_id: runId });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: `Run not found: ${runId}`, httpStatus: 404 });
    return mapRun(row);
  }

  async submitSignal(runId: string, name: string, payload: JsonValue, dedupeKey: string): Promise<SignalResult> {
    const signalId = createId('signal');
    const rows = await this.db.json<{ status: 'accepted' | 'duplicate' | 'invalid'; step_run_id: string | null }>(String.raw`
WITH existing AS (
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
), run_update AS (
  UPDATE workflow_runs SET state = 'RUNNING', updated_at = clock_timestamp()
  WHERE id = :'run_id' AND state = 'WAITING' AND EXISTS (SELECT 1 FROM target) RETURNING *
), newly_ready AS (
  UPDATE step_runs sr SET state = 'READY', updated_at = clock_timestamp()
  WHERE sr.run_id = :'run_id' AND sr.state = 'PENDING' AND EXISTS (SELECT 1 FROM target)
    AND NOT EXISTS (
      SELECT 1
      FROM workflow_runs wr
      JOIN workflow_versions wv ON wv.id = wr.workflow_version_id
      CROSS JOIN LATERAL jsonb_array_elements(wv.definition->'steps') js
      CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(js->'dependsOn', '[]'::jsonb)) dep
      JOIN step_runs d ON d.run_id = sr.run_id AND d.step_id = dep.value
      WHERE wr.id = sr.run_id AND js->>'id' = sr.step_id AND d.state <> 'SUCCEEDED'
    )
  RETURNING sr.*
), queued AS (
  INSERT INTO queue_tasks(id, run_id, step_run_id, state, concurrency_key)
  SELECT 'task_' || md5(n.id || clock_timestamp()::text || random()::text), n.run_id, n.id, 'READY', n.concurrency_key FROM newly_ready n
  ON CONFLICT (step_run_id) DO UPDATE SET state='READY', available_at=clock_timestamp(), lease_owner=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
  RETURNING *
), event_signal AS (
  SELECT agentforge_emit_event(:'run_id', t.id, NULL, 'signal.accepted', jsonb_build_object('name', :'name', 'dedupeKey', :'dedupe_key')) AS seq FROM target t
), event_duplicate AS (
  SELECT agentforge_emit_event(:'run_id', e.delivered_step_run_id, NULL, 'signal.duplicate', jsonb_build_object('name', :'name', 'dedupeKey', :'dedupe_key')) AS seq
  FROM existing e WHERE e.delivered_step_run_id IS NOT NULL
), event_step AS (
  SELECT agentforge_emit_event(:'run_id', t.id, NULL, 'step.succeeded', jsonb_build_object('resumedBySignal', :'name')) AS seq FROM target t
), event_ready AS (
  SELECT agentforge_emit_event(:'run_id', n.id, NULL, 'step.ready', jsonb_build_object('stepId', n.step_id)) AS seq FROM newly_ready n
), event_run AS (
  SELECT agentforge_emit_event(:'run_id', NULL, NULL, 'workflow.started', jsonb_build_object('resumedBySignal', :'name')) AS seq WHERE EXISTS (SELECT 1 FROM run_update)
), terminal AS (
  UPDATE workflow_runs r SET state='SUCCEEDED', output=jsonb_build_object('status','succeeded'), updated_at=clock_timestamp()
  WHERE r.id=:'run_id' AND r.state='RUNNING' AND EXISTS (SELECT 1 FROM target)
    AND NOT EXISTS (SELECT 1 FROM step_runs s WHERE s.run_id=r.id AND s.state NOT IN ('SUCCEEDED','SKIPPED'))
  RETURNING r.*
), event_terminal AS (
  SELECT agentforge_emit_event(t.id, NULL, NULL, 'workflow.succeeded', '{}'::jsonb) AS seq FROM terminal t
)
SELECT json_build_object(
  'status', CASE WHEN EXISTS (SELECT 1 FROM existing) THEN 'duplicate' WHEN EXISTS (SELECT 1 FROM target) THEN 'accepted' ELSE 'invalid' END,
  'step_run_id', COALESCE((SELECT id FROM target LIMIT 1), (SELECT delivered_step_run_id FROM existing LIMIT 1)),
  'events', (SELECT count(*) FROM event_signal) + (SELECT count(*) FROM event_duplicate) + (SELECT count(*) FROM event_step) + (SELECT count(*) FROM event_ready) + (SELECT count(*) FROM event_run) + (SELECT count(*) FROM event_terminal),
  'queued', (SELECT count(*) FROM queued),
  'signal_updated', (SELECT count(*) FROM signal_update),
  'cleaned', (SELECT count(*) FROM cleanup)
)::text;
`, { run_id: runId, name, dedupe_key: dedupeKey, signal_id: signalId, payload: JSON.stringify(payload) });
    const row = rows[0];
    if (row === undefined || row.status === 'invalid' || row.step_run_id === null) {
      throw new AgentForgeError({ code: 'INVALID_OR_LATE_SIGNAL', category: 'VALIDATION', message: `No waiting step accepts signal ${name}`, httpStatus: 409 });
    }
    return { status: row.status, stepRunId: row.step_run_id };
  }

  async writeCheckpoint(input: { claim: LeaseClaim; attemptId: string; version: number; payload: JsonValue; maxBytes: number }): Promise<Checkpoint> {
    const bytes = jsonByteLength(input.payload);
    if (bytes > input.maxBytes) throw new AgentForgeError({ code: 'CHECKPOINT_TOO_LARGE', category: 'CHECKPOINT', message: `Checkpoint exceeds ${input.maxBytes} bytes`, httpStatus: 413 });
    if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 1_000_000) throw new AgentForgeError({ code: 'INVALID_CHECKPOINT_VERSION', category: 'CHECKPOINT', message: 'Checkpoint version must be a positive integer' });
    const id = createId('cp');
    const rows = await this.db.json<DbCheckpoint>(String.raw`
WITH authority AS (
  SELECT q.* FROM queue_tasks q
  WHERE q.id = :'task_id' AND ${AUTHORITATIVE_FENCE_PREDICATE}
    AND EXISTS (SELECT 1 FROM attempts a WHERE a.id=:'attempt_id' AND a.step_run_id=q.step_run_id AND a.generation=q.lease_generation AND a.state='RUNNING')
), inserted AS (
  INSERT INTO checkpoints(id, run_id, step_run_id, attempt_id, version, payload, bytes)
  SELECT :'id', a.run_id, a.step_run_id, :'attempt_id', :'version'::integer, :'payload'::jsonb, :'bytes'::integer FROM authority a
  RETURNING *
), event_emit AS (
  SELECT agentforge_emit_event(i.run_id, i.step_run_id, i.attempt_id, 'checkpoint.written', jsonb_build_object('version', i.version, 'bytes', i.bytes)) AS seq FROM inserted i
)
SELECT row_to_json(i)::text FROM inserted i WHERE (SELECT count(*) FROM event_emit) >= 0;
`, { task_id: input.claim.id, worker: input.claim.leaseOwner, generation: input.claim.leaseGeneration, id, attempt_id: input.attemptId, version: input.version, payload: JSON.stringify(input.payload), bytes });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Checkpoint rejected because lease is stale', retryable: true, httpStatus: 409 });
    return mapCheckpoint(row);
  }

  async readLatestCheckpoint(stepRunId: string): Promise<Checkpoint | null> {
    const rows = await this.db.json<DbCheckpoint>(String.raw`
SELECT row_to_json(c)::text FROM checkpoints c WHERE c.step_run_id = :'step_run_id' ORDER BY c.created_at DESC LIMIT 1;
`, { step_run_id: stepRunId });
    return rows[0] === undefined ? null : mapCheckpoint(rows[0]);
  }

  async getToolInvocation(toolName: string, operationKey: string): Promise<ToolInvocationRecord | null> {
    const rows = await this.db.json<DbTool>(String.raw`
SELECT row_to_json(t)::text FROM tool_invocations t WHERE t.tool_name = :'tool' AND t.operation_key = :'key';
`, { tool: toolName, key: operationKey });
    const row = rows[0];
    if (row === undefined) return null;
    return { id: row.id, toolName: row.tool_name, operationKey: row.operation_key, state: row.state, ...(row.output === null ? {} : { output: row.output }), ...(row.error === null ? {} : { error: row.error }) };
  }

  async startToolInvocation(input: { runId: string; stepRunId: string; attemptId: string; toolName: string; operationKey: string; payload: JsonValue }): Promise<ToolInvocationRecord> {
    const id = createId('toolinv');
    const rows = await this.db.json<DbTool>(String.raw`
BEGIN;
INSERT INTO tool_invocations(id, run_id, step_run_id, attempt_id, tool_name, operation_key, state, input)
VALUES (:'id', :'run_id', :'step_run_id', :'attempt_id', :'tool', :'key', 'STARTED', :'payload'::jsonb)
ON CONFLICT (tool_name, operation_key) DO NOTHING;
SELECT agentforge_emit_event(:'run_id', :'step_run_id', :'attempt_id', 'tool.started', jsonb_build_object('tool', :'tool', 'operationKey', :'key'))
WHERE EXISTS (SELECT 1 FROM tool_invocations WHERE id = :'id');
SELECT row_to_json(t)::text FROM tool_invocations t WHERE t.tool_name = :'tool' AND t.operation_key = :'key';
COMMIT;
`, { id, run_id: input.runId, step_run_id: input.stepRunId, attempt_id: input.attemptId, tool: input.toolName, key: input.operationKey, payload: JSON.stringify(input.payload) });
    const row = rows[0];
    if (row === undefined) throw new AgentForgeError({ code: 'TOOL_INVOCATION_RECORD_FAILED', category: 'PERSISTENCE', message: 'Unable to persist tool invocation' });
    return { id: row.id, toolName: row.tool_name, operationKey: row.operation_key, state: row.state, ...(row.output === null ? {} : { output: row.output }), ...(row.error === null ? {} : { error: row.error }) };
  }

  async completeToolInvocation(id: string, output: JsonValue): Promise<void> {
    await this.db.execute(String.raw`
WITH updated AS (
  UPDATE tool_invocations SET state='COMPLETED', output=:'output'::jsonb, error=NULL, updated_at=clock_timestamp()
  WHERE id=:'id' RETURNING *
)
SELECT agentforge_emit_event(u.run_id, u.step_run_id, u.attempt_id, 'tool.completed', jsonb_build_object('tool', u.tool_name, 'operationKey', u.operation_key)) FROM updated u;
`, { id, output: JSON.stringify(output) });
  }

  async failToolInvocation(id: string, error: SerializedAgentForgeError): Promise<void> {
    await this.db.execute(String.raw`
WITH updated AS (
  UPDATE tool_invocations SET state='FAILED', error=:'error'::jsonb, updated_at=clock_timestamp() WHERE id=:'id' RETURNING *
)
SELECT agentforge_emit_event(u.run_id, u.step_run_id, u.attempt_id, 'tool.failed', :'error'::jsonb) FROM updated u;
`, { id, error: JSON.stringify(error) });
  }

  async recoverExpiredLeases(): Promise<number> {
    const rows = await this.db.json<DbQueue>(String.raw`
BEGIN;
CREATE TEMP TABLE recovered_tasks ON COMMIT DROP AS
WITH expired AS (
  UPDATE queue_tasks q SET state='READY', lease_owner=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
  WHERE q.state='LEASED' AND q.lease_expires_at <= clock_timestamp()
  RETURNING q.*
)
SELECT * FROM expired;
UPDATE step_runs s SET state='READY', updated_at=clock_timestamp()
FROM recovered_tasks r WHERE s.id=r.step_run_id AND s.state IN ('LEASED','RUNNING');
UPDATE attempts a SET state='LEASE_LOST', finished_at=clock_timestamp(),
  error=jsonb_build_object('name','AgentForgeError','code','LEASE_EXPIRED','category','LEASE_LOST','message','Lease expired before authoritative completion','retryable',true,'httpStatus',409)
FROM recovered_tasks r WHERE a.step_run_id=r.step_run_id AND a.generation=r.lease_generation AND a.state='RUNNING';
SELECT agentforge_emit_event(r.run_id, r.step_run_id, NULL, 'lease.recovered', jsonb_build_object('generation', r.lease_generation)) FROM recovered_tasks r;
SELECT row_to_json(r)::text FROM recovered_tasks r;
COMMIT;
`);
    return rows.length;
  }
}

export type PersistenceMetricsSnapshot = {
  queueReady: number;
  queueLeased: number;
  runsSucceeded: number;
  runsFailed: number;
  runsCancelled: number;
  stepsSucceeded: number;
  stepsFailed: number;
  retryScheduled: number;
  leaseRecoveries: number;
};

export async function readPersistenceMetrics(db: PostgresCli): Promise<PersistenceMetricsSnapshot> {
  const rows = await db.json<{
    queue_ready: number;
    queue_leased: number;
    runs_succeeded: number;
    runs_failed: number;
    runs_cancelled: number;
    steps_succeeded: number;
    steps_failed: number;
    retry_scheduled: number;
    lease_recoveries: number;
  }>(String.raw`
SELECT json_build_object(
  'queue_ready', (SELECT count(*)::integer FROM queue_tasks WHERE state IN ('READY','RETRY_SCHEDULED') AND available_at <= clock_timestamp()),
  'queue_leased', (SELECT count(*)::integer FROM queue_tasks WHERE state='LEASED' AND lease_expires_at > clock_timestamp()),
  'runs_succeeded', (SELECT count(*)::integer FROM workflow_runs WHERE state='SUCCEEDED'),
  'runs_failed', (SELECT count(*)::integer FROM workflow_runs WHERE state='FAILED'),
  'runs_cancelled', (SELECT count(*)::integer FROM workflow_runs WHERE state='CANCELLED'),
  'steps_succeeded', (SELECT count(*)::integer FROM step_runs WHERE state='SUCCEEDED'),
  'steps_failed', (SELECT count(*)::integer FROM step_runs WHERE state='FAILED'),
  'retry_scheduled', (SELECT count(*)::integer FROM execution_events WHERE type='step.retry_scheduled'),
  'lease_recoveries', (SELECT count(*)::integer FROM execution_events WHERE type='lease.recovered')
)::text;
`);
  const row = rows[0];
  if (row === undefined) throw new AgentForgeError({ code: 'METRICS_QUERY_FAILED', category: 'PERSISTENCE', message: 'Metrics query returned no row' });
  return {
    queueReady: row.queue_ready,
    queueLeased: row.queue_leased,
    runsSucceeded: row.runs_succeeded,
    runsFailed: row.runs_failed,
    runsCancelled: row.runs_cancelled,
    stepsSucceeded: row.steps_succeeded,
    stepsFailed: row.steps_failed,
    retryScheduled: row.retry_scheduled,
    leaseRecoveries: row.lease_recoveries,
  };
}
