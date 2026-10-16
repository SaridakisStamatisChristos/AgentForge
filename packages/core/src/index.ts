import {
  AgentForgeError,
  type RetryPolicy,
  type StepRunState,
  type WorkflowRunState,
} from '@agentforge/contracts';

const RUN_TRANSITIONS: Readonly<Record<WorkflowRunState, readonly WorkflowRunState[]>> = {
  QUEUED: ['RUNNING', 'CANCELLING', 'CANCELLED', 'FAILED'],
  RUNNING: ['WAITING', 'SUCCEEDED', 'FAILED', 'CANCELLING'],
  WAITING: ['RUNNING', 'FAILED', 'CANCELLING'],
  CANCELLING: ['CANCELLED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

const STEP_TRANSITIONS: Readonly<Record<StepRunState, readonly StepRunState[]>> = {
  PENDING: ['READY', 'CANCELLED', 'SKIPPED', 'FAILED'],
  READY: ['LEASED', 'CANCELLED', 'FAILED'],
  LEASED: ['RUNNING', 'READY', 'CANCELLED', 'FAILED'],
  RUNNING: ['WAITING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'READY'],
  WAITING: ['READY', 'CANCELLED', 'FAILED'],
  RETRY_SCHEDULED: ['READY', 'LEASED', 'CANCELLED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  SKIPPED: [],
};

export const TERMINAL_RUN_STATES = new Set<WorkflowRunState>(['SUCCEEDED', 'FAILED', 'CANCELLED']);
export const TERMINAL_STEP_STATES = new Set<StepRunState>(['SUCCEEDED', 'FAILED', 'CANCELLED', 'SKIPPED']);

export function canTransitionRun(from: WorkflowRunState, to: WorkflowRunState): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionStep(from: StepRunState, to: StepRunState): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertRunTransition(from: WorkflowRunState, to: WorkflowRunState): void {
  if (!canTransitionRun(from, to)) {
    throw new AgentForgeError({
      code: 'ILLEGAL_RUN_TRANSITION',
      category: 'ILLEGAL_STATE_TRANSITION',
      message: `Illegal workflow-run transition ${from} -> ${to}`,
      httpStatus: 409,
      details: { from, to },
    });
  }
}

export function assertStepTransition(from: StepRunState, to: StepRunState): void {
  if (!canTransitionStep(from, to)) {
    throw new AgentForgeError({
      code: 'ILLEGAL_STEP_TRANSITION',
      category: 'ILLEGAL_STATE_TRANSITION',
      message: `Illegal step-run transition ${from} -> ${to}`,
      httpStatus: 409,
      details: { from, to },
    });
  }
}

export function validateRetryPolicy(policy: RetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1 || policy.maxAttempts > 100) {
    throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'VALIDATION', message: 'maxAttempts must be an integer in [1, 100]', httpStatus: 400 });
  }
  for (const [name, value] of [
    ['initialDelayMs', policy.initialDelayMs],
    ['maxDelayMs', policy.maxDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 86_400_000) {
      throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'VALIDATION', message: `${name} must be an integer in [0, 86400000]`, httpStatus: 400 });
    }
  }
  if (!Number.isFinite(policy.backoffMultiplier) || policy.backoffMultiplier < 1 || policy.backoffMultiplier > 100) {
    throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'VALIDATION', message: 'backoffMultiplier must be finite in [1, 100]', httpStatus: 400 });
  }
  if (policy.maxDelayMs < policy.initialDelayMs) {
    throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'VALIDATION', message: 'maxDelayMs must be >= initialDelayMs', httpStatus: 400 });
  }
  if (policy.jitterRatio !== undefined && (!Number.isFinite(policy.jitterRatio) || policy.jitterRatio < 0 || policy.jitterRatio > 1)) {
    throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'VALIDATION', message: 'jitterRatio must be finite in [0, 1]', httpStatus: 400 });
  }
}

export function computeRetryDelayMs(policy: RetryPolicy, failedAttemptNumber: number, randomUnit = 0.5): number {
  validateRetryPolicy(policy);
  if (!Number.isSafeInteger(failedAttemptNumber) || failedAttemptNumber < 1) {
    throw new AgentForgeError({ code: 'INVALID_ATTEMPT_NUMBER', category: 'VALIDATION', message: 'failedAttemptNumber must be >= 1', httpStatus: 400 });
  }
  if (!Number.isFinite(randomUnit) || randomUnit < 0 || randomUnit > 1) {
    throw new AgentForgeError({ code: 'INVALID_RANDOM_UNIT', category: 'VALIDATION', message: 'randomUnit must be finite in [0,1]', httpStatus: 400 });
  }
  const raw = Math.min(policy.maxDelayMs, policy.initialDelayMs * policy.backoffMultiplier ** (failedAttemptNumber - 1));
  const jitter = policy.jitterRatio ?? 0;
  const multiplier = 1 - jitter + 2 * jitter * randomUnit;
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(raw * multiplier)));
}

export function shouldRetry(policy: RetryPolicy, attemptNumber: number, errorCode: string, retryable: boolean): boolean {
  validateRetryPolicy(policy);
  if (attemptNumber >= policy.maxAttempts) return false;
  if (policy.retryableCodes !== undefined && !policy.retryableCodes.includes(errorCode)) return false;
  return retryable;
}
