# Evidence status

AgentForge V1 closure evidence is execution-based rather than inferred from repository structure.

The reference implementation verification is GitHub Actions run `38939208029` on head `8e25c32f980feaa7a73c023aa644aba81c59c1b6`. Both `verify` and `compose-smoke` completed successfully.

Observed evidence from that run:

- frozen pnpm lockfile installation;
- formatting, linting, TypeScript typechecking and placeholder scanning;
- **41/41 deterministic and adversarial unit tests**;
- state-aware application of `0001_initial.sql` and `0002_tool_definitions.sql`, followed by a second migration pass that skipped both applied versions;
- database smoke;
- **13/13 PostgreSQL integration tests**, including durable API idempotency across restart, side-effect crash/reuse, durable tool definitions, metrics, competing claims, generation fencing, transaction rollback, store recreation, durable signals, retry exhaustion, cancellation race, and a real worker-process `SIGKILL` followed by reclaim/recovery;
- build and public-export consumer smoke;
- required executable hello, resilient-agent and recovery examples;
- internal benchmark smoke, explicitly not a superiority benchmark;
- high-severity dependency audit with no known vulnerabilities reported by pnpm;
- Docker Compose validation, fresh PostgreSQL startup and production-container build.

The successful process-kill test launches a PostgreSQL-backed worker in a child process, waits for an active attempt, kills it with `SIGKILL`, expires the persisted lease, starts a replacement worker, and verifies `LEASE_LOST`, successful replacement completion and a `lease.recovered` event.

This document is part of the final documentation/currentness repair after the reference implementation run. To avoid invalidating the final tested head with an evidence-only commit, the immutable **final exact-head run/SHA pair is recorded on PR #2** after this documentation commit is rerun through the permanent workflow.

No claim is made here of production readiness, arbitrary exactly-once external effects, external benchmark superiority, or SOTA status.
