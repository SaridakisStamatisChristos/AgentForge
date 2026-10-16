# Provider and agent model

`ModelProvider.invoke` is the only model-runtime dependency. `DeterministicProvider` scripts responses, retryable errors and delays with no network. The optional OpenAI-compatible adapter uses standard HTTP and remains outside the critical deterministic completion path.

The built-in agent loop is deliberately minimal: input -> model -> optional tool call -> tool result -> model -> terminal text. Iterations are bounded, tool allow-lists are optional, tool outputs are size bounded, provider responses are validated, cancellation uses the step `AbortSignal`, and runtime-owned history is checkpointed after each tool turn.

Runtime retries and agent iterations are distinct: a provider/tool failure may end an execution attempt and later create a new attempt, while agent iterations occur within one authoritative step attempt until terminal response or the iteration bound is reached.
