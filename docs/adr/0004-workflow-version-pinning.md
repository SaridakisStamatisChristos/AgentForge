# ADR 0004: Workflow version pinning

**Status:** Accepted

## Context

A long-running execution must not silently change because a workflow definition is edited while the run is waiting, retrying or recovering.

## Decision

Persist immutable `WorkflowVersion` rows. Every run stores one `workflow_version_id`; scheduling and execution load that exact version for the lifetime of the run. Creating or editing a workflow produces another version rather than mutating the plan referenced by existing runs.

## Consequences

Historical execution is interpretable against the definition that actually ran. Schema/storage cost is accepted in exchange for reproducibility and recovery correctness.
