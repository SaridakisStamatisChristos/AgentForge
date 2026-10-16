# Persistence

PostgreSQL is the reference durable store. V1 intentionally uses one durable database for workflow state and queue/lease state rather than adding Redis.

## Main tables

- `workflow_definitions`, `workflow_versions`: immutable versioned workflow plans.
- `workflow_runs`: authoritative workflow lifecycle and per-run event sequence counter.
- `step_runs`: one logical row per workflow step/run pair.
- `queue_tasks`: one durable queue row per logical step, including owner, expiry, generation, attempt number and concurrency key.
- `attempts`: append-only execution-attempt history.
- `checkpoints`: versioned bounded resume payloads.
- `execution_events`: ordered durable history with unique `(run_id, seq)`.
- `tool_invocations`: durable side-effect/tool invocation state.
- `signals`: named deduplicated external inputs.
- `schema_migrations`: applied migration identity.

## Transaction boundaries

Atomicity is used where partial visibility would violate an invariant: run creation with initial step/queue state, queue claim with step transition/event emission, attempt start, fenced completion/failure, signal delivery with wait completion/downstream scheduling, cancellation, and lease recovery.

Claiming uses row locking with `FOR UPDATE SKIP LOCKED`. Commit authority additionally requires the same lease owner/generation and an unexpired lease plus the matching running attempt generation.

## Event ordering

`agentforge_emit_event` increments the run's `next_event_seq` and inserts the corresponding event in the same database transaction. `UNIQUE(run_id, seq)` makes duplicate sequence assignment fail instead of silently corrupting ordering.

## Indexes

The initial migration indexes attempt history by step/time, claim access by queue state/availability/priority, active concurrency keys, checkpoints by step/latest time, ordered events by run/sequence, and signals by run/name/time.

## History ownership

Durable execution history is retained by default. V1 does not add broad `CASCADE` deletion or a retention subsystem. There is no hidden cleanup job that removes run history.

## Migrations

Migrations are ordered SQL files under `packages/persistence/migrations`. V1 follows a **forward-only** migration policy; rollback scripts are not claimed. CI applies migrations to a clean PostgreSQL database and repeats the migration command to prove idempotent upgrade invocation for the current migration set.
