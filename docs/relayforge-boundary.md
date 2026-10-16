# Event/output sink boundary

AgentForge V1 has no dependency on RelayForge. Durable execution events remain in AgentForge's PostgreSQL history and are exposed through the API/SSE control plane.

A future reliable-delivery integration should implement an explicit event/output sink adapter that consumes durable AgentForge events and hands them to a delivery system. If asynchronous publication is added, it must use a transactional outbox or equivalent durable consistency boundary; an in-memory fire-and-forget callback is not sufficient evidence of durable delivery.

No RelayForge source code is copied into AgentForge and no RelayForge service is required to execute the V1 test path.
