# R7 falsification campaign

The completion campaign intentionally attacks the reliability claims rather than only running happy paths.

## State and input attacks

- terminal run/step transition mutation;
- empty workflow, duplicate IDs, nonexistent dependency, cycle;
- invalid/non-finite retry/timeout/iteration values;
- malformed JSON and oversized HTTP body;
- checkpoint size overflow, unsupported agent checkpoint version and malformed agent message history;
- malformed provider response;
- side-effect tool without operation-key idempotency.

## Concurrency and lifetime attacks

- two PostgreSQL workers simultaneously claiming one logical task;
- stale G1 completion after G2 lease replacement;
- cancellation racing authoritative success;
- handler that ignores abort after timeout;
- concurrency-key overlap prevention;
- worker crash after execution before commit;
- worker crash after side-effect invocation before step commit;
- store/process replacement while work is leased or waiting for a signal.

## Persistence and operational attacks

- SQL transaction failure between operations and rollback observation;
- lease expiry/reclaim;
- duplicate signal delivery;
- retry exhaustion with attempt-history preservation;
- PostgreSQL unavailable readiness vs process liveness;
- migration on a clean database and repeated forward-only migration invocation;
- frozen-lockfile install, package export smoke, Compose validation/fresh database startup and container build.

Every observed failure enters `docs/r7-requirements.md` with its earliest invalidated phase and repair. CI is the authoritative oracle for PostgreSQL/Compose behavior in the available environment.
