# State machines

Illegal transitions fail closed in `packages/core`; terminal states have no outgoing ordinary transitions.

## WorkflowRun

```mermaid
stateDiagram-v2
  [*] --> QUEUED
  QUEUED --> RUNNING
  QUEUED --> CANCELLING
  QUEUED --> CANCELLED
  QUEUED --> FAILED
  RUNNING --> WAITING
  RUNNING --> SUCCEEDED
  RUNNING --> FAILED
  RUNNING --> CANCELLING
  WAITING --> RUNNING
  WAITING --> FAILED
  WAITING --> CANCELLING
  CANCELLING --> CANCELLED
  CANCELLING --> FAILED
  SUCCEEDED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

Terminal: `SUCCEEDED`, `FAILED`, `CANCELLED`.

## StepRun

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> READY
  PENDING --> CANCELLED
  PENDING --> SKIPPED
  PENDING --> FAILED
  READY --> LEASED
  READY --> CANCELLED
  READY --> FAILED
  LEASED --> RUNNING
  LEASED --> READY: lost/recovered lease
  LEASED --> CANCELLED
  LEASED --> FAILED
  RUNNING --> WAITING
  RUNNING --> RETRY_SCHEDULED
  RUNNING --> SUCCEEDED
  RUNNING --> FAILED
  RUNNING --> CANCELLED
  RUNNING --> READY: recovered lease
  WAITING --> READY: generic resume boundary
  WAITING --> CANCELLED
  WAITING --> FAILED
  RETRY_SCHEDULED --> READY
  RETRY_SCHEDULED --> LEASED
  RETRY_SCHEDULED --> CANCELLED
  RETRY_SCHEDULED --> FAILED
  SUCCEEDED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
  SKIPPED --> [*]
```

For the implemented signal path, accepted signal delivery moves the waiting logical step directly to `SUCCEEDED`, returns the workflow run to `RUNNING`, and schedules dependents. The `WAITING -> READY` transition remains available to recovery semantics but is not used to re-execute a signal-wait instruction.

## Attempt

Attempts are immutable historical executions except for their one-way completion from `RUNNING` to `SUCCEEDED`, `FAILED`, `TIMED_OUT`, `CANCELLED`, or `LEASE_LOST`. A retry allocates another attempt identity; it does not reuse or overwrite the old one.
