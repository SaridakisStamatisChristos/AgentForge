# Event delivery boundary

AgentForge keeps durable execution history separate from optional external event delivery.

Durable run events are stored in PostgreSQL and exposed through the HTTP/SSE control plane. This history is part of AgentForge's execution authority and remains available independently of any external sink.

`@agentforge/events` defines `EventSource` and `EventSink` interfaces plus a bounded `pumpEvents` cursor helper. These interfaces are integration points for downstream delivery systems without coupling the runtime to a specific transport or product.

## Consistency boundary

An `EventSink` implementation does **not** automatically provide crash-safe cross-service delivery. If publication is asynchronous and delivery must survive a process crash between durable state change and external publish, the integration needs a transactional outbox or another durable consistency mechanism tied to the authoritative state transition.

An in-memory callback, fire-and-forget HTTP request or best-effort process hook is insufficient evidence for a crash-safe delivery guarantee.

## Ownership

- PostgreSQL execution history remains authoritative for AgentForge run state and ordered events.
- The source/sink layer may transform or forward events, but it must not redefine runtime state-machine semantics.
- Downstream acknowledgements or retries belong to the external delivery adapter unless they are explicitly incorporated into a durable AgentForge transaction boundary.

This separation keeps the core runtime independent of external brokers, webhook systems and portfolio-specific services.
