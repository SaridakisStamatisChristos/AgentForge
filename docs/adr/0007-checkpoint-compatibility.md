# ADR 0007: Checkpoint compatibility ownership

**Status:** Accepted

## Context

Checkpoint payloads are application state. Silently consuming an incompatible payload can corrupt recovery, while the generic runtime cannot understand every task handler's private schema.

## Decision

Checkpoints are always versioned and size bounded. Generic task handlers own validation of their own checkpoint versions/shapes when they opt into resume. Runtime-owned checkpoint formats must be validated by the runtime. The built-in agent loop accepts only V1 agent checkpoints with a bounded integer iteration and structurally valid message history; unsupported or malformed payloads fail explicitly as `CHECKPOINT_INCOMPATIBLE`.

## Consequences

No claim is made that every arbitrary handler is automatically resumable. Runtime-owned recovery does not silently discard corrupted state, and application handlers receive the raw versioned checkpoint needed to implement their own compatibility policy.
