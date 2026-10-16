# Observability

V1 keeps observability lean and directly connected to executed behavior.

The API emits structured JSON request logs containing request id, method, path, status and duration. Runtime entity IDs (run/step/attempt/worker) are present in durable events and execution records.

`/metrics` exposes API counters. When the API is backed by `PostgresStore`, it also queries durable state for terminal run outcomes, terminal step outcomes, total attempts, inferred retry count, `lease.recovered` event count, and runnable queue depth. The deterministic memory-backed test API intentionally exposes only the API-process counters because it has no PostgreSQL durable metric source.

Liveness and readiness are separate: `/health/live` reports process liveness and `/health/ready` checks the configured store dependency. OpenTelemetry/tracing remains optional rather than a V1 completion checkbox.
