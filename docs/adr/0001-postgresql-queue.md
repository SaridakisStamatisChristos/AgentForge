# ADR 0001: PostgreSQL-backed durable queue

**Status:** Accepted for V1

## Context

AgentForge needs durable job state, transactional step scheduling, lease recovery and ordered execution history. Adding Redis would introduce another failure domain and coordination surface.

## Decision

Use PostgreSQL for both authoritative execution state and the V1 durable queue. Runnable tasks are claimed transactionally with row locks and `FOR UPDATE SKIP LOCKED`. Bounded batch claims and indexes support the intended local/reference workload.

## Consequences

State transition plus scheduling can share database transactions and V1 requires only one durable service. This is not a claim that PostgreSQL is the optimal queue for every scale. If future evidence shows a hard invariant or capacity requirement PostgreSQL cannot reasonably meet, a separate queue can be introduced behind the runtime store/queue boundary with equivalent fencing semantics.
