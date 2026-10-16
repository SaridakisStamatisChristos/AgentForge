# ADR 0005: Durable ordered execution history

**Status:** Accepted

## Context

Execution history is part of AgentForge's reliability contract. In-memory event publication can lose transitions around crashes and cannot prove ordering after restart.

## Decision

Persist consequential execution events in PostgreSQL. Each run owns a monotonic `next_event_seq`; event emission increments it and inserts a unique `(run_id, seq)` record inside the same transaction as the associated lifecycle change where atomicity matters. The API reads history directly and SSE replays from a caller-supplied sequence cursor.

## Consequences

History survives API/worker restart and remains inspectable. Heartbeat chatter is intentionally omitted unless it is semantically useful. A future external publisher should use an outbox/equivalent durable boundary rather than an in-memory fire-and-forget path.
