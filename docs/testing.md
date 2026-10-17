# Testing

AgentForge uses multiple verification layers because no single implementation path is allowed to certify every reliability claim.

## Unit and model-level tests

`tests/core.test.ts` exercises state-transition legality, terminal immutability, workflow/DAG validation, fan-out/fan-in topology, retry bounds and invalid numeric policy values.

`tests/runtime.test.ts` runs durable semantics against the deterministic `MemoryStore` oracle with injected time/randomness where timing matters. Coverage includes lease-generation fencing, attempt-history preservation, retry recovery, cancellation monotonicity, concurrency keys, durable wait/signal behavior, side-effect crash boundaries, checkpoint bounds, timeout races and malformed providers.

`tests/api.test.ts` exercises a real Node HTTP listener using the same runtime surfaces: request validation, oversized bodies, liveness/readiness distinction, SDK calls, ordered history, SSE, cancellation/signals, metrics and OpenAPI route drift.

## PostgreSQL integration oracle

The PostgreSQL suite is intentionally independent of the in-memory store.

`integration/postgres.test.ts` covers:

- concurrent `SKIP LOCKED` claims;
- authoritative lease generation and stale-worker fencing;
- expired-lease recovery;
- transaction rollback;
- state survival across store/process replacement;
- durable signal resume;
- retry exhaustion with persistent attempt rows;
- cancellation racing success;
- durable run idempotency;
- side-effect crash/reuse boundaries;
- durable tool definitions and metrics.

`integration/process-recovery.test.ts` launches a real worker child process, kills it during active work, permits the persisted lease to expire, starts a replacement worker and verifies recovery without allowing the stale generation to commit.

## Adversarial coverage

Reliability tests intentionally attack the system rather than only exercising happy paths.

### State and input attacks

- terminal run/step mutation attempts;
- empty workflows, duplicate IDs, missing dependencies and cycles;
- invalid or non-finite retry/timeout/iteration values;
- malformed JSON and oversized HTTP bodies;
- checkpoint overflow and incompatible checkpoint data;
- malformed provider responses;
- side-effect tools without required operation-key semantics.

### Concurrency and lifetime attacks

- competing workers claiming the same logical work;
- stale generation completion after replacement;
- cancellation racing authoritative completion;
- handlers that ignore abort after timeout;
- concurrency-key overlap prevention;
- worker crash after execution before commit;
- worker crash after side-effect invocation before step commit;
- process/store replacement while work is leased or waiting for a signal.

### Persistence and operational attacks

- SQL transaction rollback after intermediate failure;
- lease expiry and reclaim;
- duplicate signal delivery;
- retry exhaustion with history preservation;
- PostgreSQL-unavailable readiness versus process liveness;
- clean-database migration and repeated migration invocation;
- frozen-lockfile install and public-export smoke;
- Compose validation, fresh database startup and container build.

## Executable demonstrations

- `pnpm example:hello` — SDK → HTTP API → runtime → worker → event history.
- `pnpm example:agent` — deterministic agent/provider/tool flow with transient failure and retry.
- `pnpm example:recovery` — lease expiry, replacement-worker recovery and stale-generation rejection.

Examples are demonstrations, not substitutes for tests.

## Benchmark smoke

`pnpm benchmark:smoke` is an internal regression/operability check. It is not a comparative performance benchmark and must not be used as evidence of superiority over another runtime.

## CI gates

The pull-request workflow executes the critical repository gates against PostgreSQL 17:

1. frozen lockfile installation;
2. formatting, linting, typechecking and placeholder scanning;
3. deterministic unit/adversarial tests;
4. migrations and database smoke;
5. PostgreSQL integration tests;
6. build and public-export smoke;
7. required executable examples;
8. benchmark smoke;
9. high-severity dependency audit;
10. Compose validation, fresh PostgreSQL startup and container build.

A check is considered verified only when the corresponding command or CI job actually executes successfully. File presence is not execution evidence.

## Failure policy

Tests and CI gates are not weakened to obtain a green result. A failure should be reduced to the concrete violated invariant, repaired at the smallest coherent surface, and rerun together with dependent gates. PostgreSQL- or container-specific behavior remains unverified until the relevant service/container path actually runs.
