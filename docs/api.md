# HTTP API

The control plane is intentionally small and exists to exercise durable runtime semantics rather than to become a general automation UI.

| Method | Route | Purpose |
|---|---|---|
| POST | `/v1/workflows` | validate and persist an immutable workflow version |
| GET | `/v1/workflows/:id` | fetch exact version id or latest version for a workflow id |
| POST | `/v1/runs` | start a durable run pinned to a workflow version |
| GET | `/v1/runs/:id` | inspect run state |
| GET | `/v1/runs/:id/steps` | inspect logical step state |
| GET | `/v1/runs/:id/events` | ordered paginated history |
| GET | `/v1/runs/:id/events/stream` | SSE history/live stream |
| POST | `/v1/runs/:id/cancel` | persist cancellation |
| POST | `/v1/runs/:id/signals/:name` | deliver a named durable signal |
| GET | `/health/live` | liveness |
| GET | `/health/ready` | PostgreSQL-backed readiness |
| GET | `/metrics` | Prometheus text metrics |
| GET | `/openapi.json` | OpenAPI contract |

Request bodies are bounded, malformed JSON returns a stable error envelope, and request IDs are echoed through `x-request-id`. Event pagination supports `after` and `limit`; limit is capped at 500.

SSE uses durable event sequence numbers as event IDs and accepts an `after` cursor. It validates that the run exists before opening the stream and exits after the run is terminal and all currently visible events have been emitted.

V1 intentionally uses SSE rather than WebSocket because the stream is server-to-client ordered history and control actions already have explicit HTTP endpoints. This keeps the transport smaller without weakening the execution contract.
