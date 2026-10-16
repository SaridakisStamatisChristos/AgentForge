# Reviewer guide

Start with the primary evidence paths rather than reading every file in order:

1. `examples/failure-recovery/src/index.ts` for lease-generation recovery and stale fencing.
2. `tests/runtime.test.ts` for deterministic adversarial semantics.
3. `integration/postgres.test.ts` for independent PostgreSQL concurrency/restart/race evidence.
4. `packages/persistence/src/index.ts` and `0001_initial.sql` for transaction/fencing mechanics.
5. `apps/api/src/index.ts` + `packages/sdk/src/index.ts` for the control plane.
6. `docs/failure-semantics.md`, `docs/idempotency.md`, and `docs/r7-requirements.md` for precise claims and known evidence state.

The PR is intentionally left unmerged for review and CI evidence closure.
