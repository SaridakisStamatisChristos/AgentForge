# ADR 0002: Lease-generation fencing

**Status:** Accepted

## Context

A worker can pause, lose connectivity, or outlive its lease. Worker identity alone cannot prove commit authority after another worker has reclaimed the same logical task.

## Decision

Every queue claim increments a durable `lease_generation`. Authoritative attempt start/heartbeat/completion require the same queue id, worker owner, generation and an unexpired lease; completion also requires the matching running attempt generation. Recovery marks the expired generation's running attempt `LEASE_LOST` before work is reclaimed.

## Consequences

Late results from stale workers fail closed. At-least-once execution attempts remain possible, but only the current generation can mutate authoritative logical completion. Tests must exercise both deterministic and real-PostgreSQL stale-commit rejection.
