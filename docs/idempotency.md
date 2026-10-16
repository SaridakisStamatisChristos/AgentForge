# Idempotency and delivery guarantees

AgentForge models durable execution as **at least once over time**. It does not claim arbitrary exactly-once delivery or exactly-once effects.

## Internal logical completion

Within AgentForge's own PostgreSQL transaction boundaries, logical step state, queue state, lease generation, attempt generation and downstream scheduling are updated with fencing checks. A stale worker cannot authoritatively finalize the same logical task after its lease has been replaced.

## External effects

Tools declare one of three side-effect classes:

- `PURE`: safe to recompute without an external effect.
- `IDEMPOTENT`: effect is expected to be safe when repeated according to the tool's domain contract.
- `SIDE_EFFECTING`: requires an explicit stable operation/idempotency key.

A `SIDE_EFFECTING` tool cannot be registered with `idempotency: 'NONE'`.

The runtime stores a durable tool invocation keyed by tool name and operation key. If a completed invocation record exists on retry/recovery, the stored output is reused instead of calling the tool handler again.

## What this does and does not guarantee

AgentForge can prevent duplicate authoritative commits in its own database and can avoid deliberately re-invoking a tool after a completed invocation has been durably recorded.

It cannot prove that an arbitrary external service performed an effect exactly once. Consider:

```text
external service accepts effect
        |
worker loses connectivity or process crashes
        |
AgentForge has not durably recorded COMPLETED yet
```

The only robust way to deduplicate that uncertainty window is for the external service to accept and honor the same stable idempotency key. AgentForge exposes that key through `ToolContext.idempotencyKey`.

The required fault test intentionally crashes after a side-effecting tool has returned/completed its durable invocation record but before the workflow step commit, then verifies recovery reuses the record. Documentation and evidence must not generalize that result into an unsupported exactly-once claim.
