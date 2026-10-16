# Durable data flow

1. Workflow JSON is validated and persisted as an immutable workflow version.
2. Run creation creates logical steps and initial root queue tasks in durable state.
3. Workers recover expired leases, then claim bounded runnable tasks transactionally.
4. A claim creates a new lease generation; starting execution creates a separate attempt row.
5. Task/tool/model/agent execution occurs outside the database transaction while heartbeats preserve authority.
6. Completion/failure returns through a generation fence. The same transaction updates logical state, attempt/queue state, schedules newly-ready dependents, and emits ordered lifecycle events where required.
7. API/SDK readers inspect durable rows/events. SSE is replayable from the monotonic event sequence.

External tool/model effects are not part of the PostgreSQL transaction and therefore use the explicit idempotency semantics documented separately.
