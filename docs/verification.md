# Verification

AgentForge treats execution evidence as distinct from repository structure. A test file, workflow definition or benchmark harness demonstrates intent; only successful execution demonstrates that the corresponding gate passed for a specific commit.

## Verification principles

- Repository hashes and commit identifiers come from Git/GitHub object data rather than guessed values.
- Deterministic in-memory tests verify domain/runtime semantics but do not certify PostgreSQL behavior.
- PostgreSQL-specific claims require the PostgreSQL integration suite.
- Docker/Compose claims require actual container execution.
- Benchmark results are scoped to their harness and environment and are not converted into comparative superiority claims.
- A failing required gate keeps the candidate change unverified until the defect is repaired and the affected gates rerun.
- Required assertions are not disabled or made optional to obtain a passing status.

## Local verification

The normal non-database verification bundle is:

```bash
pnpm verify
```

Its component commands are:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm build
pnpm consumer:check
pnpm check:placeholders
```

PostgreSQL verification requires a real database:

```bash
pnpm db:migrate
pnpm db:smoke
pnpm test:integration
```

Executable behavior demonstrations and the benchmark smoke are also part of the repository's CI contract:

```bash
pnpm example:hello
pnpm example:agent
pnpm example:recovery
pnpm benchmark:smoke
```

## CI verification

`.github/workflows/ci.yml` is the canonical pull-request workflow. It contains two independent jobs:

- `verify` — toolchain/install, static gates, unit/adversarial tests, migrations, database smoke, PostgreSQL integration tests, build/export smoke, examples, benchmark smoke and dependency audit;
- `compose-smoke` — Compose configuration validation, fresh PostgreSQL startup and container build.

The workflow uses PostgreSQL 17 and the declared Node/pnpm/TypeScript toolchain.

## Reliability invariants represented by the suite

The current suite is designed to protect these durable invariants:

- terminal run/step states do not mutate back into ordinary execution;
- a single lease generation is authoritative for completion;
- stale worker generations are fenced;
- retry attempts remain inspectable rather than overwriting earlier failures;
- workflow dependencies and cycles are validated before execution;
- cancellation is monotonic;
- process loss can be recovered after lease expiry;
- run event sequence is ordered and durable;
- workflow versions are pinned per run;
- side-effect semantics do not imply universal exactly-once execution;
- bounded payload, checkpoint, retry, timeout and concurrency policies are enforced.

These are repository contracts, not a claim that the software is production-qualified for every deployment environment.

## Claims boundary

Green repository CI supports the behavior exercised by those checks for the tested commit and environment. It does not by itself establish internet-facing security hardening, organization-specific compliance, production capacity/SLOs, multi-region resilience, arbitrary exactly-once external effects or performance superiority over another system.
