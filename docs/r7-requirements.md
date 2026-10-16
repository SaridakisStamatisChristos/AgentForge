# R7 requirement and evidence ledger

This ledger tracks the hard V1 requirements from the AgentForge handoff. Evidence states are updated only from observed commands/CI; file presence alone is not a pass.

| ID | Requirement / invariant | Primary artifacts | Verification path | State before CI |
|---|---|---|---|---|
| INV-001 | terminal run/step immutability | `packages/core`, `tests/core.test.ts` | unit exhaustive transition rejection | UNVERIFIED |
| INV-002 | one authoritative lease generation | queue/persistence/runtime | memory + PostgreSQL contention tests | UNVERIFIED |
| INV-003 | stale worker fencing | persistence/runtime | recovery example + memory + PostgreSQL stale commit tests | UNVERIFIED |
| INV-004 | attempt history preserved | attempts schema/runtime | retry unit + PostgreSQL exhaustion test | UNVERIFIED |
| INV-005 | dependency ordering | workflows/runtime | diamond DAG test | UNVERIFIED |
| INV-006 | cycles rejected before execution | workflows | validator test | UNVERIFIED |
| INV-007 | cancellation monotonicity | runtime/store | memory + PostgreSQL cancel race | UNVERIFIED |
| INV-008 | durable restart recovery | PostgreSQL store | store replacement/expired lease integration test | UNVERIFIED |
| INV-009 | per-run event ordering | event sequence/schema | memory + PostgreSQL monotonic sequence assertions | UNVERIFIED |
| INV-010 | no false exactly-once claim | tools/runtime/docs | side-effect crash test + idempotency docs | UNVERIFIED |
| INV-011 | workflow version pinning | schema/store/runtime | immutable-clone/pinned-version test | UNVERIFIED |
| INV-012 | bounded execution/resources | validators/runtime/API | numeric/payload/checkpoint/concurrency tests | UNVERIFIED |
| GATE-A | clean install, build, typecheck, exports | lockfile/build/consumer check | CI verify job | UNVERIFIED |
| GATE-B | DAG/retry/timeout/cancel/signal/checkpoint semantics | core/workflows/runtime | unit/adversarial suites | UNVERIFIED |
| GATE-C | PostgreSQL migrations/claims/leases/restart | persistence/integration | PostgreSQL CI service | UNVERIFIED |
| GATE-D | deterministic provider/tool/agent/idempotency | providers/tools/runtime/examples | unit + resilient agent + side-effect fault test | UNVERIFIED |
| GATE-E | API/SDK/history/SSE/health/OpenAPI | apps/api/sdk | API suite + SDK example | UNVERIFIED |
| GATE-F | adversarial faults/races/oversized/malformed | tests/integration/examples | unit + PostgreSQL CI | UNVERIFIED |
| GATE-G | actual CI executes critical gates | GitHub Actions | inspect workflow jobs/checks | UNVERIFIED |
| GATE-H | executable/current docs and honest limitations | README/docs/ADRs | placeholder scan + review | UNVERIFIED |

## Assumptions

| A-ID | Assumption | Criticality | Invalidation trigger |
|---|---|---|---|
| A-001 | Node 22 is the declared V1 runtime target. | MEDIUM | supported-runtime policy changes |
| A-002 | PostgreSQL 17 is the CI/reference test target; SQL should remain on generally available PostgreSQL primitives. | MEDIUM | compatibility evidence requires older major versions |
| A-003 | V1 API is local/private and does not implement public-internet identity. | HIGH | deployment scope changes to untrusted public access |
| A-004 | Registered local tools are trusted host code and are not sandboxed by AgentForge. | HIGH | product promises untrusted-code execution |
| A-005 | Forward-only migrations are acceptable for V1. | MEDIUM | rollback becomes a product requirement |

## Failure / repair ledger

| F-ID | Failure | Earliest invalidated phase | Repair | Reverification |
|---|---|---|---|---|
| F-001 | retry jitter could exceed configured `maxDelayMs` | SPEC/GENERATE | clamp the final jittered delay to `maxDelayMs`; regression assertion added | pending CI |
| F-002 | root commands did not guarantee internal workspace links after a fresh install | SCAFFOLD/INTEGRATE | add postinstall workspace linker; align lockfile | pending frozen-install CI |
| F-003 | worker imported contracts without declaring the direct workspace dependency | INTEGRATE | add `@agentforge/contracts` to worker manifest | pending frozen-install/build CI |
| F-004 | stalled transport wrote scaffold files to `main` before branch isolation | PACKAGE/AUTHORITY | restore main working tree and keep implementation on `r7/finalize-v1` | pending repository check |

## Claim ledger

- `production-ready`: **not claimed**.
- `SOTA` or performance superiority: **not claimed**.
- arbitrary `exactly once`: **explicitly rejected**.
- `VERIFIED FOR DECLARED LOCAL TARGET`: may be used only after actual CI/PostgreSQL/Compose evidence closes all critical gates.
