# Checkpoints and resumability

Checkpoints are durable, versioned and size-bounded records associated with a run, logical step and concrete attempt.

## Generic task handlers

A task handler opts into resumability explicitly by calling `context.checkpoint(payload, version)` and later reading `context.latestCheckpoint()`. AgentForge does not pretend arbitrary handler/tool execution can resume from the middle. A handler that does not implement resume semantics restarts according to its handler contract on retry/recovery.

Generic task checkpoint payload compatibility is owned by the registered handler because the runtime cannot know the application's schema. The handler must reject an unsupported checkpoint version or payload shape rather than interpreting it as valid state.

## Runtime-owned agent checkpoint

The built-in agent loop owns its checkpoint schema and therefore validates its own version/shape before restoring. The V1 agent checkpoint version is `1` and contains the next iteration plus a validated message history. An unsupported version or malformed runtime-owned payload is a `CHECKPOINT_INCOMPATIBLE` failure rather than a silent reset.

## Bounds

Checkpoint JSON must be finite/serializable and is rejected when it exceeds the configured byte limit. The default maximum is 256 KiB.
