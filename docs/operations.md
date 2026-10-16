# Operations

## Configuration

Configuration is environment-based and validated at process startup where it controls bounded execution.

| Variable | Default | Purpose |
|---|---:|---|
| `DATABASE_URL` | local PostgreSQL URL | durable store |
| `AGENTFORGE_API_HOST` | `127.0.0.1` | API bind host |
| `AGENTFORGE_API_PORT` | `8787` | API port |
| `AGENTFORGE_WORKER_ID` | process-derived | worker identity |
| `AGENTFORGE_WORKER_CONCURRENCY` | `4` | max active worker tasks |
| `AGENTFORGE_CLAIM_BATCH_SIZE` | up to `4` | bounded claim size |
| `AGENTFORGE_POLL_MS` | `250` | idle poll interval |
| `AGENTFORGE_LEASE_MS` | `10000` | lease duration |
| `AGENTFORGE_HEARTBEAT_MS` | `2500` | lease renewal interval |
| `AGENTFORGE_GRACEFUL_SHUTDOWN_MS` | `5000` | shutdown drain bound |
| `AGENTFORGE_MAX_PAYLOAD_BYTES` | `1048576` | run/signal/output bound |
| `AGENTFORGE_MAX_CHECKPOINT_BYTES` | `262144` | checkpoint bound |

`.env.example` contains no real credentials.

## Startup

```bash
pnpm install --frozen-lockfile
pnpm dev:infra
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
```

`pnpm dev` is the combined local development launcher.

## Health

- `/health/live` verifies the API process is serving.
- `/health/ready` verifies the durable store can answer a ping.
- PostgreSQL unavailability may make readiness fail while liveness remains healthy.

## Worker shutdown

Shutdown stops new claims, aborts active handler signals, and waits only up to the configured graceful-shutdown bound. Uncommitted leased work is recovered after lease expiry by another worker. Shutdown never converts a missing authoritative commit into a fabricated success.

## Recovery

Workers invoke expired-lease recovery before claims. A recovered lease returns the logical step to ready state and records any matching running attempt as `LEASE_LOST`. Normal execution then creates a new attempt under a later lease generation.

## PostgreSQL loss

The API remains live but not ready. Persistence operations fail. Workers abort active authority if heartbeat persistence cannot be confirmed and rely on later lease recovery after the database returns.

## Reference deployment trust boundary

The included Compose/Docker setup is a local/reference deployment, not an internet-hardened identity layer. Put the API behind an appropriate authenticated/private boundary before exposing it to untrusted networks.
