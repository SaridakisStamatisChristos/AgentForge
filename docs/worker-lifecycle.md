# Worker lifecycle

A worker identifies itself, recovers expired leases, claims only up to bounded available capacity, begins a durable attempt, starts lease heartbeats, executes with `AbortSignal`, writes checkpoints/tool invocation state as needed, then attempts a fenced success/failure commit.

Heartbeat loss or run cancellation aborts the handler signal. Graceful shutdown stops new claims and aborts active local handlers; unfinished authoritative work is left for normal lease-expiry recovery rather than being fabricated as successful.

Worker-global concurrency and claim batch size are bounded. Concurrency keys prevent simultaneous authoritative leases for ready work sharing the same key.
