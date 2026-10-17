# Roadmap and deferred scope

This document records deliberately unsupported product areas so repository readers can distinguish current capabilities from possible future work. Items listed here are not commitments or partially implemented features.

## Not currently implemented

- public-internet identity, authentication or enterprise SSO;
- Kubernetes operators or cluster-native control-plane management;
- multi-region consensus or cross-region execution authority;
- sandboxing for untrusted tool code;
- a production secrets-management subsystem;
- retention/DSAR workflow automation;
- a visual workflow editor;
- an integration marketplace or broad connector catalog;
- n8n compatibility;
- browser automation;
- built-in RAG/vector storage;
- OpenTelemetry tracing;
- production capacity/SLO qualification.

## Integration opportunities

The existing `EventSource` / `EventSink` boundary can support future delivery adapters, but crash-safe asynchronous delivery would require a transactional outbox or equivalent durable consistency boundary. No specific external delivery product is required by AgentForge.

Additional provider adapters can be implemented behind `ModelProvider` without changing runtime semantics, provided their response validation and cancellation behavior preserve the existing provider contract.

## Qualification work outside the repository core

Deployment-specific penetration testing, production load/capacity observation, organization-specific compliance controls and environment-specific disaster-recovery qualification depend on the target operating environment. They should be treated as external qualification work rather than implied capabilities of the current codebase.

## Scope discipline

The current repository prioritizes durable execution semantics, recovery, authority boundaries and verifiability. New hosted-product or UI features should not weaken those contracts or be presented as existing functionality before they are implemented and tested.
