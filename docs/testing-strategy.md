# Testing strategy

AgentForge uses multiple verification layers because no single implementation is allowed to certify every reliability claim.

## Pure/unit and model tests

`tests/core.test.ts` attacks state transition legality, terminal immutability, workflow/DAG validation, fan-out/fan-in topology, retry bounds and invalid numeric policy values.

`tests/runtime.test.ts` runs the durable semantics against the deterministic `MemoryStore` oracle with an injected fake clock/randomness where timing matters. It covers lease-generation fencing, attempt-history preservation, retry recovery, cancellation monotonicity, concurrency keys, wait/signal behavior, side-effect crash boundaries, checkpoint bounds, timeout races and malformed providers.

`tests/api.test.ts` exercises a real Node HTTP listener with the same runtime surfaces: request validation, oversized bodies, liveness/readiness distinction, SDK calls, ordered history, SSE, cancel/signal behavior, metrics and OpenAPI route drift.

## PostgreSQL integration oracle

`integration/postgres.test.ts` runs against a real PostgreSQL service. It is intentionally independent of the in-memory store and covers:

- concurrent `SKIP LOCKED` claims;
- authoritative lease generation/fencing;
- expired-lease recovery;
- transaction rollback;
- state survival across store/process replacement;
- durable signal resume;
- retry exhaustion and persistent attempt rows;
- cancellation racing success.

CI, not file presence, determines whether these gates are `VERIFIED`.

## End-to-end demonstrations

- `pnpm example:hello`: SDK -> HTTP API -> runtime -> worker -> event stream.
- `pnpm example:agent`: deterministic agent/provider/tool flow with a transient provider failure recovered by retry.
- `pnpm example:recovery`: worker crash, lease expiry, G2 recovery and explicit rejection of a stale G1 completion.

## Falsification philosophy

Tests are not weakened to make CI green. A failing gate is recorded, diagnosed at the earliest invalidated phase, repaired at the smallest coherent surface, and rerun with dependent gates. Reliability-critical fixes should have a second path when practical—for example memory-store fencing plus PostgreSQL fencing.

Unavailable PostgreSQL/Docker execution is not a local pass. It remains `UNVERIFIED` until the CI service/container actually executes it.
