import { randomUUID } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type WorkflowId = string;
export type WorkflowVersionId = string;
export type RunId = string;
export type StepRunId = string;
export type AttemptId = string;
export type QueueTaskId = string;
export type EventId = string;
export type CheckpointId = string;
export type ToolInvocationId = string;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export const WORKFLOW_RUN_STATES = ['QUEUED','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLING','CANCELLED'] as const;
export type WorkflowRunState = (typeof WORKFLOW_RUN_STATES)[number];
export const STEP_RUN_STATES = ['PENDING','READY','LEASED','RUNNING','WAITING','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED','SKIPPED'] as const;
export type StepRunState = (typeof STEP_RUN_STATES)[number];
export const ATTEMPT_STATES = ['RUNNING','SUCCEEDED','FAILED','CANCELLED','LEASE_LOST','TIMED_OUT'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export const QUEUE_TASK_STATES = ['READY','LEASED','RETRY_SCHEDULED','SUCCEEDED','FAILED','CANCELLED'] as const;
export type QueueTaskState = (typeof QUEUE_TASK_STATES)[number];
export type SideEffectClass = 'PURE' | 'IDEMPOTENT' | 'SIDE_EFFECTING';

export type RetryPolicy = { maxAttempts: number; initialDelayMs: number; backoffMultiplier: number; maxDelayMs: number; jitterRatio?: number; retryableCodes?: string[] };
export type TimeoutPolicy = { timeoutMs: number };
export type BaseStep = { id: string; dependsOn?: string[]; retry?: RetryPolicy; timeout?: TimeoutPolicy; concurrencyKey?: string; input?: JsonObject };
export type TaskStep = BaseStep & { kind: 'task'; handler: string; resumeFromCheckpoint?: boolean };
export type ToolStep = BaseStep & { kind: 'tool'; tool: string; operationKey?: string };
export type ModelStep = BaseStep & { kind: 'model'; provider: string; prompt: string };
export type WaitStep = BaseStep & { kind: 'wait'; signal: string };
export type AgentStep = BaseStep & { kind: 'agent'; provider: string; prompt: string; maxIterations: number; allowedTools?: string[]; maxToolOutputBytes?: number };
export type WorkflowStep = TaskStep | ToolStep | ModelStep | WaitStep | AgentStep;
export type WorkflowDefinition = { name: string; description?: string; failurePolicy?: 'FAIL_FAST'; steps: WorkflowStep[] };
export type WorkflowVersion = { id: WorkflowVersionId; workflowId: WorkflowId; version: number; definition: WorkflowDefinition; createdAt: string };
export type WorkflowRun = { id: RunId; workflowVersionId: WorkflowVersionId; state: WorkflowRunState; input: JsonValue; output?: JsonValue; error?: SerializedAgentForgeError; cancellationRequested: boolean; createdAt: string; updatedAt: string };
export type StepRun = { id: StepRunId; runId: RunId; stepId: string; state: StepRunState; attemptCount: number; output?: JsonValue; error?: SerializedAgentForgeError; waitSignalName?: string; concurrencyKey?: string; createdAt: string; updatedAt: string };
export type Attempt = { id: AttemptId; stepRunId: StepRunId; generation: number; state: AttemptState; startedAt: string; finishedAt?: string; error?: SerializedAgentForgeError };
export type QueueTask = { id: QueueTaskId; runId: RunId; stepRunId: StepRunId; state: QueueTaskState; availableAt: string; leaseOwner?: string; leaseExpiresAt?: string; leaseGeneration: number; attemptNo: number; priority: number; concurrencyKey?: string };
export type LeaseClaim = QueueTask & { state: 'LEASED'; leaseOwner: string; leaseExpiresAt: string };
export type Checkpoint = { id: CheckpointId; runId: RunId; stepRunId: StepRunId; attemptId: AttemptId; version: number; payload: JsonValue; bytes: number; createdAt: string };

export type ExecutionEventType =
  | 'workflow.created' | 'workflow.started' | 'workflow.waiting' | 'workflow.cancellation_requested' | 'workflow.succeeded' | 'workflow.failed' | 'workflow.cancelled'
  | 'step.ready' | 'step.leased' | 'step.started' | 'step.waiting' | 'step.retry_scheduled' | 'step.succeeded' | 'step.failed' | 'step.cancelled'
  | 'attempt.started' | 'attempt.failed' | 'attempt.lease_lost' | 'checkpoint.written' | 'tool.started' | 'tool.completed' | 'tool.failed' | 'signal.accepted' | 'signal.duplicate' | 'lease.recovered';
export type ExecutionEvent = { id: EventId; runId: RunId; stepRunId?: StepRunId; attemptId?: AttemptId; type: ExecutionEventType; timestamp: string; schemaVersion: 1; sequence: number; payload: JsonObject };

export type ErrorCategory = 'VALIDATION' | 'WORKFLOW_DEFINITION' | 'ILLEGAL_STATE_TRANSITION' | 'HANDLER' | 'TOOL' | 'PROVIDER' | 'DEPENDENCY' | 'TIMEOUT' | 'CANCELLATION' | 'LEASE_LOST' | 'CHECKPOINT' | 'PERSISTENCE' | 'INTERNAL_INVARIANT';
export type SerializedAgentForgeError = { name: 'AgentForgeError'; code: string; category: ErrorCategory; message: string; retryable: boolean; httpStatus: number; details?: JsonObject };

export class AgentForgeError extends Error {
  readonly code: string; readonly category: ErrorCategory; readonly retryable: boolean; readonly httpStatus: number; readonly details?: JsonObject;
  constructor(input: { code: string; category: ErrorCategory; message: string; retryable?: boolean; httpStatus?: number; details?: JsonObject }) {
    super(input.message); this.name = 'AgentForgeError'; this.code = input.code; this.category = input.category; this.retryable = input.retryable ?? false; this.httpStatus = input.httpStatus ?? 500; if (input.details !== undefined) this.details = input.details;
  }
  serialize(): SerializedAgentForgeError {
    const base: SerializedAgentForgeError = { name: 'AgentForgeError', code: this.code, category: this.category, message: this.message, retryable: this.retryable, httpStatus: this.httpStatus };
    return this.details === undefined ? base : { ...base, details: this.details };
  }
}
export function asAgentForgeError(error: unknown, fallback: Partial<SerializedAgentForgeError> = {}): AgentForgeError {
  if (error instanceof AgentForgeError) return error;
  const message = error instanceof Error ? error.message : 'Unknown error';
  return new AgentForgeError({ code: fallback.code ?? 'INTERNAL_ERROR', category: fallback.category ?? 'INTERNAL_INVARIANT', message, retryable: fallback.retryable ?? false, httpStatus: fallback.httpStatus ?? 500, ...(fallback.details === undefined ? {} : { details: fallback.details }) });
}
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}
export function jsonByteLength(value: JsonValue): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
export function assertJsonValue(value: unknown, field = 'value'): asserts value is JsonValue {
  if (!isJsonValue(value)) throw new AgentForgeError({ code: 'INVALID_JSON', category: 'VALIDATION', message: `${field} must be finite JSON`, httpStatus: 400 });
}
export function assertNonEmptyString(value: unknown, field: string, max = 256): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw new AgentForgeError({ code: 'INVALID_STRING', category: 'VALIDATION', message: `${field} must be a non-empty string up to ${max} characters`, httpStatus: 400 });
}
export function assertBoundedInteger(value: unknown, field: string, min: number, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new AgentForgeError({ code: 'INVALID_INTEGER', category: 'VALIDATION', message: `${field} must be an integer in [${min}, ${max}]`, httpStatus: 400 });
}
