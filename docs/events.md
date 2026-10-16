# Execution events

Consequential lifecycle changes emit typed durable events with run id, optional step/attempt ids, event type, timestamp, schema version, structured JSON payload and monotonic per-run sequence number.

The implemented event vocabulary covers run creation/start/wait/success/failure/cancellation, step readiness/lease/start/wait/retry/completion, attempt failures/lease loss, checkpoint writes, tool invocation lifecycle, signal acceptance/duplicates and lease recovery.

History APIs and SSE read from durable event rows; no in-memory publisher is counted as durable evidence.
