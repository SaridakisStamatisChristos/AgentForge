# Observability

V1 keeps observability lean and directly connected to executed behavior.

The API emits structured JSON request logs containing request id, method, path, status and duration. Runtime entity IDs (run/step/attempt/worker) are present in durable events and execution records. `/metrics` exposes API counters and, with the PostgreSQL adapter, durable counts for run/step outcomes, attempts, retries, lease recovery and ready queue depth.

Liveness and readiness are separate. OpenTelemetry/tracing is deliberately optional rather than a completion checkbox.
