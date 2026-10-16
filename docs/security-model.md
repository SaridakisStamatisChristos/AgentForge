# Security and trust model

V1 focuses on runtime integrity, bounded untrusted input and explicit trust boundaries. It does not claim enterprise identity, remote code sandboxing or internet-hardening.

## Untrusted API input

JSON request bodies and workflow definitions are parsed and validated before they reach durable semantics. Workflow JSON cannot contain executable JavaScript. Registered task/tool handlers are host code selected by stable names; `eval` and uploaded executable strings are forbidden. Payload, checkpoint, agent-iteration, retry, timeout and worker-concurrency values are bounded.

API errors return stable code/category/message/retryable/request-id fields and do not expose stack traces by default. Request IDs are bounded and sanitized before reflection.

## Database boundary

Database credentials come from `DATABASE_URL`. PostgreSQL values are supplied through the persistence adapter's parameter mechanism rather than concatenating untrusted workflow values into SQL. The queue uses database transactions and row locks for authority rather than client-provided state.

## Tool boundary

A registered tool runs with the operating-system privileges of its worker process. AgentForge V1 does **not** sandbox tool code. Operators must register only trusted host code and should isolate workers at the process/container/deployment layer when tool privilege requires it.

Side-effecting tools require a durable operation-key contract but this is not a universal exactly-once guarantee; see `idempotency.md`.

## Provider boundary

The deterministic provider is local and network-free. The optional OpenAI-compatible adapter is generic HTTP and does not require a vendor SDK. Provider tokens are optional environment values; they are not committed, required by tests, or printed by the default configuration path.

## API deployment boundary

The reference API contains no V1 public-internet authentication layer. It is intended for local/private/reference deployment behind an appropriate trusted/authenticated boundary. Do not expose it directly to an untrusted network and interpret the absence of auth as a security feature.

## Supply chain

The runtime has no registry runtime dependency. CI pins the Node/pnpm/TypeScript toolchain and performs a dependency audit. No third-party source is copied into the repository. The repository intentionally has no owner-selected open-source license at this stage.
