# ADR 0006: Provider-neutral model boundary

**Status:** Accepted

## Context

AgentForge must prove durable agent execution without forcing users or CI to hold credentials for a specific model vendor.

## Decision

Define a small `ModelProvider` interface. The required implementation is `DeterministicProvider`, which is local, scripted and reproducible. An optional OpenAI-compatible HTTP adapter demonstrates an external-provider boundary without introducing a vendor SDK or credential requirement into core tests.

## Consequences

Runtime retry/cancellation/checkpoint semantics can be verified deterministically. Provider integrations remain adapters rather than architectural dependencies. No API key is required by the core project, CI, or recovery examples.
