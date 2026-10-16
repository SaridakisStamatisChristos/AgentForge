# Event/output sink boundary

AgentForge V1 has no runtime dependency on RelayForge. Durable execution events remain in AgentForge's PostgreSQL history and are exposed through the API/SSE control plane.

`@agentforge/events` now defines an explicit `EventSource` / `EventSink` boundary plus the bounded `pumpEvents` cursor helper. This is the extension point for a future RelayForge adapter or another delivery system; the interface is implemented without coupling AgentForge to RelayForge itself.

The V1 sink helper deliberately does **not** claim durable cross-service delivery. If asynchronous publication is added, the integration must add a transactional outbox or another durable consistency boundary before claiming crash-safe delivery. An in-memory fire-and-forget callback is not sufficient evidence.

No RelayForge source code is copied into AgentForge and no RelayForge service is required to execute the V1 test path.
