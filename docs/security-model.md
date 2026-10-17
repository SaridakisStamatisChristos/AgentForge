# Security and trust model

AgentForge focuses on runtime integrity, bounded untrusted input and explicit trust boundaries. It does not claim enterprise identity, remote-code sandboxing or public-internet hardening.

## Untrusted API input

JSON request bodies and workflow definitions are parsed and validated before they reach durable semantics. Workflow JSON cannot contain executable JavaScript. Registered task/tool handlers are host code selected by stable names; `eval` and uploaded executable strings are not part of the execution model.

Payload, checkpoint, agent-iteration, retry, timeout and worker-concurrency values are bounded. API errors return stable code/category/message/retryable/request-id fields and do not expose stack traces by default. Request IDs are bounded and sanitized before reflection.

## Database boundary

Database credentials come from `DATABASE_URL`. PostgreSQL values are supplied through the persistence adapter's parameter mechanism rather than concatenating untrusted workflow values into SQL. Queue authority comes from database transactions and row locks rather than client-provided state.

## Tool boundary

A registered tool runs with the operating-system privileges of its worker process. AgentForge does **not** sandbox tool code. Operators must register only trusted host code and should isolate workers at the process/container/deployment layer when tool privilege requires it.

Side-effecting tools require a durable operation-key contract, but this is not a universal exactly-once guarantee. See `idempotency.md`.

## Provider boundary

The deterministic provider is local and network-free. The optional OpenAI-compatible adapter uses generic HTTP and does not require a vendor SDK. Provider tokens are optional environment values; they are not committed, required by tests or printed by the default configuration path.

## API deployment boundary

The reference API does not include a public-internet authentication layer. It is intended for local/private deployment behind an appropriate trusted or authenticated boundary. Do not expose it directly to an untrusted network and do not interpret the absence of authentication as a security feature.

## Event delivery boundary

Durable execution history remains in PostgreSQL. Optional `EventSink` implementations are integration adapters, not automatic crash-safe delivery guarantees. Asynchronous external delivery requires a transactional outbox or equivalent durable consistency mechanism before making a crash-safe publication claim.

## Supply chain and licensing

CI pins the Node/pnpm/TypeScript toolchain used by the repository and performs a high-severity dependency audit. Third-party dependencies and container images retain their own licenses.

AgentForge itself is distributed under the proprietary root `LICENSE`. Public source visibility does not make the project open source. See `licensing.md`.
