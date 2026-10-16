# ADR 0003: At-least-once execution and explicit idempotency

**Status:** Accepted

## Context

A crash may occur after application work or an external effect but before authoritative workflow completion. Arbitrary external systems cannot be transactionally committed together with AgentForge's PostgreSQL state.

## Decision

Describe execution honestly as at least once over time. `SIDE_EFFECTING` tools require stable operation-key idempotency and a durable invocation record. Recovered attempts reuse a known completed invocation result. External exactly-once effects require the external service to honor the same key.

## Consequences

AgentForge can make strong claims about its own logical commits and cannot make a universal exactly-once marketing claim. Documentation and fault tests must preserve that distinction.
