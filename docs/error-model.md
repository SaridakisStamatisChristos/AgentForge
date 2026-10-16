# Error model

`AgentForgeError` crosses package/API boundaries as a safe structured error with stable code, category, message, retryability, HTTP status and optional JSON details.

Categories distinguish validation, workflow definition, illegal state transition, handler, tool, provider, retryable dependency, timeout, cancellation, lease loss, checkpoint incompatibility, persistence and internal invariant failures.

Unknown thrown values are normalized before persistence/API serialization. Stack traces and secret-bearing process state are not included in default public error envelopes.
