# Evidence status

R7 execution evidence is now established for the V1 candidate rather than assumed from implementation artifacts.

Reference full verification run: GitHub Actions `r7-pr-bootstrap` run `38930189319`, which explicitly checked out implementation commit `adfb21b31113ca1e3012694dfbbdca9383b44f5c` from `r7/finalize-v1`.

That run completed successfully across both jobs and exercised the following gates:

- frozen pnpm lockfile installation;
- formatting, linting, TypeScript typechecking, and placeholder scanning;
- 28 deterministic unit/adversarial tests;
- repeat migration plus database smoke;
- 7 PostgreSQL integration tests covering competing claims, lease fencing/recovery, rollback, restart recovery, durable signals, retry exhaustion, and cancellation races;
- build plus public-export consumer smoke;
- all required executable examples, including transient provider retry/tool-loop recovery and crash/lease recovery;
- internal benchmark smoke (not a superiority benchmark);
- high-severity dependency audit with no known vulnerabilities reported by pnpm;
- Docker Compose validation and PostgreSQL fresh-start smoke;
- production-container build.

The issue-comment bootstrap exists only because connector-authored push/pull-request events did not instantiate Actions runs in this execution environment. It checks out the unmerged candidate explicitly and is used as a falsification harness, not as evidence of a merge. The canonical PR workflow remains in the implementation branch.

After this evidence record and CI-maintenance updates are committed, the final branch head is re-run through the same complete gate. The immutable final run/SHA pair is also recorded on PR #1 so the repository can preserve a tested-head proof without creating another documentation-only commit.

No claim is made here of production readiness, exactly-once execution, external benchmark superiority, or SOTA status.
