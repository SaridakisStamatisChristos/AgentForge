# R7 requirement and evidence ledger

This ledger tracks the hard V1 requirements from the AgentForge handoff. `VERIFIED` means the behavior was observed in canonical GitHub Actions or an executable test exercised by that workflow; file presence alone is not evidence.

Reference implementation verification: GitHub Actions run `38939208029` on implementation head `8e25c32f980feaa7a73c023aa644aba81c59c1b6` completed successfully. That run is the evidence basis for the states below. Because this ledger and final documentation are committed after that implementation run, the closing exact-head run/SHA is recorded on PR #2 rather than by another post-verification commit.

| ID | Requirement / invariant | Primary evidence | State |
|---|---|---|---|
| INV-001 | terminal run/step immutability | exhaustive transition tests | VERIFIED |
| INV-002 | one authoritative lease generation | memory + PostgreSQL competing-claim tests | VERIFIED |
| INV-003 | stale worker fencing | memory + PostgreSQL stale-generation tests + recovery example | VERIFIED |
| INV-004 | attempt history preserved | retry unit tests + PostgreSQL retry-exhaustion rows | VERIFIED |
| INV-005 | dependency ordering | fan-out/fan-in DAG execution test | VERIFIED |
| INV-006 | cycles rejected before execution | workflow validator tests | VERIFIED |
| INV-007 | cancellation monotonicity | cancellation tests + PostgreSQL cancel-vs-complete race | VERIFIED |
| INV-008 | durable restart recovery | store recreation + real worker `SIGKILL`/reclaim integration test | VERIFIED |
| INV-009 | per-run event ordering | memory/PostgreSQL monotonic sequence assertions + SSE pagination | VERIFIED |
| INV-010 | no false exactly-once claim | side-effect crash/reuse tests + idempotency documentation | VERIFIED |
| INV-011 | workflow version pinning | immutable cloned workflow-version test | VERIFIED |
| INV-012 | bounded execution/resources | numeric, payload, checkpoint, worker-concurrency and event-sink bounds | VERIFIED |
| GATE-A | clean install, build, typecheck, exports | frozen install, static gates, build + consumer smoke | VERIFIED |
| GATE-B | DAG/retry/timeout/cancel/signal/checkpoint semantics | 41-test deterministic/adversarial unit suite | VERIFIED |
| GATE-C | PostgreSQL migrations/claims/leases/restart | migration smoke + 13-test PostgreSQL suite | VERIFIED |
| GATE-D | deterministic provider/tool/agent/idempotency | unit/examples + PG side-effect crash/reuse + API idempotency restart test | VERIFIED |
| GATE-E | API/SDK/history/SSE/health/OpenAPI | runtime-router/OpenAPI conformance + SDK/API tests | VERIFIED |
| GATE-F | adversarial faults/races/oversized/malformed | unit + PG + real process-kill campaign | VERIFIED |
| GATE-G | actual CI executes critical gates | canonical GitHub Actions `verify` + `compose-smoke` | VERIFIED |
| GATE-H | executable/current docs and honest limitations | placeholder scan + documentation review; final exact-head rerun recorded on PR #2 | VERIFIED SUBJECT TO FINAL EXACT-HEAD CI |

## Assumptions

| A-ID | Assumption | Criticality | Invalidation trigger |
|---|---|---|---|
| A-001 | Node 22 is the declared V1 runtime target. | MEDIUM | supported-runtime policy changes |
| A-002 | PostgreSQL 17 is the CI/reference target; SQL uses generally available PostgreSQL primitives. | MEDIUM | compatibility evidence requires older major versions |
| A-003 | V1 API is local/private and does not implement public-internet identity. | HIGH | deployment scope changes to untrusted public access |
| A-004 | Registered local tools are trusted host code and are not sandboxed by AgentForge. | HIGH | product promises untrusted-code execution |
| A-005 | Forward-only migrations are acceptable for V1. | MEDIUM | rollback becomes a product requirement |

## Failure / repair ledger

| F-ID | Failure | Earliest invalidated phase | Repair | Reverification |
|---|---|---|---|---|
| F-001 | retry jitter could exceed configured `maxDelayMs` | SPEC/GENERATE | clamp final jittered delay; regression assertion | canonical CI |
| F-002 | fresh install did not guarantee workspace links | SCAFFOLD/INTEGRATE | postinstall workspace linker | frozen-install CI |
| F-003 | worker lacked a direct contracts dependency | INTEGRATE | declare workspace dependency | frozen-install/build CI |
| F-004 | earlier transport wrote scaffold files before branch isolation | PACKAGE/AUTHORITY | restore base and isolate implementation branch | repository history check |
| F-005 | OpenAPI route list could drift from the runtime router | CONTRACT | implement missing workflow route and add runtime-router conformance test | 41-test unit suite |
| F-006 | sink boundary, durable tool definitions, SDK validation, durable metrics and run idempotency were incomplete | INTEGRATE | implement explicit interfaces/stores/contracts and PG-backed behavior | unit + PG integration suite |
| F-007 | SDK dependency change made frozen lockfile fail | PACKAGE | update lockfile to declared workspace dependencies | frozen install green |
| F-008 | closure tests had an invalid `.ts` import and tool return typing | TEST | package export + JSON return typing | typecheck green |
| F-009 | root test environment did not link `@agentforge/worker` | PACKAGE | export and link worker workspace | unit suite green |
| F-010 | early `psql` exit could surface uncaught `EPIPE` | PERSISTENCE | single-settlement PostgreSQL process transport with stdin/spawn/close error handling | dependency-failure unit test green |
| F-011 | source barrel used emitted `.js` relative import under Node type stripping | PACKAGE | explicit package subpath exports for source-development and emitted JS | full canonical CI green |

## Claim ledger

- `production-ready`: **not claimed**.
- `SOTA` or performance superiority: **not claimed**.
- arbitrary external-effect `exactly once`: **explicitly rejected**.
- `VERIFIED FOR DECLARED LOCAL TARGET`: permitted only when the final exact-head canonical CI run recorded on PR #2 is green.
