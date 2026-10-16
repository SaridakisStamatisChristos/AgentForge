import {
  AgentForgeError,
  assertJsonValue,
  assertNonEmptyString,
  type JsonObject,
  type JsonValue,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@agentforge/contracts';
import { validateRetryPolicy } from '@agentforge/core';

const ALLOWED_STEP_KINDS = new Set(['task', 'tool', 'model', 'wait', 'agent']);

export type WorkflowGraph = {
  order: string[];
  dependencies: Map<string, string[]>;
  dependents: Map<string, string[]>;
};

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AgentForgeError({ code: 'INVALID_WORKFLOW', category: 'WORKFLOW_DEFINITION', message: `${field} must be an object`, httpStatus: 400 });
  }
  return value as Record<string, unknown>;
}

function parseRetry(value: unknown): NonNullable<WorkflowStep['retry']> {
  if (value === undefined) throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'WORKFLOW_DEFINITION', message: 'Retry policy is missing', httpStatus: 400 });
  const raw = objectValue(value, 'retry');
  const policy = {
    maxAttempts: raw.maxAttempts,
    initialDelayMs: raw.initialDelayMs,
    backoffMultiplier: raw.backoffMultiplier,
    maxDelayMs: raw.maxDelayMs,
    ...(raw.jitterRatio === undefined ? {} : { jitterRatio: raw.jitterRatio }),
    ...(Array.isArray(raw.retryableCodes) ? { retryableCodes: raw.retryableCodes } : {}),
  };
  if (
    typeof policy.maxAttempts !== 'number' ||
    typeof policy.initialDelayMs !== 'number' ||
    typeof policy.backoffMultiplier !== 'number' ||
    typeof policy.maxDelayMs !== 'number' ||
    (policy.jitterRatio !== undefined && typeof policy.jitterRatio !== 'number') ||
    (policy.retryableCodes !== undefined && !policy.retryableCodes.every((item) => typeof item === 'string'))
  ) {
    throw new AgentForgeError({ code: 'INVALID_RETRY_POLICY', category: 'WORKFLOW_DEFINITION', message: 'Retry policy has invalid field types', httpStatus: 400 });
  }
  validateRetryPolicy(policy as NonNullable<WorkflowStep['retry']>);
  return policy as NonNullable<WorkflowStep['retry']>;
}

function parseStep(value: unknown): WorkflowStep {
  const raw = objectValue(value, 'step');
  assertNonEmptyString(raw.id, 'step.id', 128);
  assertNonEmptyString(raw.kind, 'step.kind', 32);
  if (!ALLOWED_STEP_KINDS.has(raw.kind)) {
    throw new AgentForgeError({ code: 'INVALID_STEP_KIND', category: 'WORKFLOW_DEFINITION', message: `Unsupported step kind: ${raw.kind}`, httpStatus: 400 });
  }
  const dependsOn = raw.dependsOn === undefined ? undefined : raw.dependsOn;
  if (dependsOn !== undefined && (!Array.isArray(dependsOn) || !dependsOn.every((item) => typeof item === 'string' && item.length > 0))) {
    throw new AgentForgeError({ code: 'INVALID_DEPENDENCIES', category: 'WORKFLOW_DEFINITION', message: `Step ${raw.id} has invalid dependsOn`, httpStatus: 400 });
  }
  const timeout = raw.timeout === undefined ? undefined : objectValue(raw.timeout, 'timeout');
  if (timeout !== undefined && (!Number.isSafeInteger(timeout.timeoutMs) || (timeout.timeoutMs as number) < 1 || (timeout.timeoutMs as number) > 86_400_000)) {
    throw new AgentForgeError({ code: 'INVALID_TIMEOUT', category: 'WORKFLOW_DEFINITION', message: 'timeoutMs must be an integer in [1, 86400000]', httpStatus: 400 });
  }
  if (raw.input !== undefined) {
    assertJsonValue(raw.input, 'step.input');
    if (Array.isArray(raw.input) || raw.input === null || typeof raw.input !== 'object') {
      throw new AgentForgeError({ code: 'INVALID_STEP_INPUT', category: 'WORKFLOW_DEFINITION', message: 'step.input must be a JSON object', httpStatus: 400 });
    }
  }
  if (raw.concurrencyKey !== undefined) assertNonEmptyString(raw.concurrencyKey, 'step.concurrencyKey', 128);

  const base = {
    id: raw.id,
    ...(dependsOn === undefined ? {} : { dependsOn: [...dependsOn] as string[] }),
    ...(raw.retry === undefined ? {} : { retry: parseRetry(raw.retry) }),
    ...(timeout === undefined ? {} : { timeout: { timeoutMs: timeout.timeoutMs as number } }),
    ...(raw.concurrencyKey === undefined ? {} : { concurrencyKey: raw.concurrencyKey }),
    ...(raw.input === undefined ? {} : { input: raw.input as JsonObject }),
  };

  switch (raw.kind) {
    case 'task':
      assertNonEmptyString(raw.handler, `step ${raw.id}.handler`, 128);
      return { ...base, kind: 'task', handler: raw.handler, ...(raw.resumeFromCheckpoint === true ? { resumeFromCheckpoint: true } : {}) };
    case 'tool':
      assertNonEmptyString(raw.tool, `step ${raw.id}.tool`, 128);
      if (raw.operationKey !== undefined) assertNonEmptyString(raw.operationKey, `step ${raw.id}.operationKey`, 256);
      return { ...base, kind: 'tool', tool: raw.tool, ...(raw.operationKey === undefined ? {} : { operationKey: raw.operationKey }) };
    case 'model':
      assertNonEmptyString(raw.provider, `step ${raw.id}.provider`, 128);
      assertNonEmptyString(raw.prompt, `step ${raw.id}.prompt`, 65_536);
      return { ...base, kind: 'model', provider: raw.provider, prompt: raw.prompt };
    case 'wait':
      assertNonEmptyString(raw.signal, `step ${raw.id}.signal`, 128);
      return { ...base, kind: 'wait', signal: raw.signal };
    case 'agent':
      assertNonEmptyString(raw.provider, `step ${raw.id}.provider`, 128);
      assertNonEmptyString(raw.prompt, `step ${raw.id}.prompt`, 65_536);
      if (!Number.isSafeInteger(raw.maxIterations) || (raw.maxIterations as number) < 1 || (raw.maxIterations as number) > 100) {
        throw new AgentForgeError({ code: 'INVALID_AGENT_ITERATIONS', category: 'WORKFLOW_DEFINITION', message: 'maxIterations must be in [1,100]', httpStatus: 400 });
      }
      if (raw.allowedTools !== undefined && (!Array.isArray(raw.allowedTools) || !raw.allowedTools.every((item) => typeof item === 'string'))) {
        throw new AgentForgeError({ code: 'INVALID_AGENT_TOOLS', category: 'WORKFLOW_DEFINITION', message: 'allowedTools must be a string array', httpStatus: 400 });
      }
      if (raw.maxToolOutputBytes !== undefined && (!Number.isSafeInteger(raw.maxToolOutputBytes) || (raw.maxToolOutputBytes as number) < 1 || (raw.maxToolOutputBytes as number) > 1_048_576)) {
        throw new AgentForgeError({ code: 'INVALID_AGENT_TOOL_LIMIT', category: 'WORKFLOW_DEFINITION', message: 'maxToolOutputBytes must be in [1,1048576]', httpStatus: 400 });
      }
      return {
        ...base,
        kind: 'agent',
        provider: raw.provider,
        prompt: raw.prompt,
        maxIterations: raw.maxIterations as number,
        ...(raw.allowedTools === undefined ? {} : { allowedTools: [...raw.allowedTools] as string[] }),
        ...(raw.maxToolOutputBytes === undefined ? {} : { maxToolOutputBytes: raw.maxToolOutputBytes as number }),
      };
    default:
      throw new AgentForgeError({ code: 'INVALID_STEP_KIND', category: 'WORKFLOW_DEFINITION', message: 'Unsupported step kind', httpStatus: 400 });
  }
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const raw = objectValue(value, 'workflow');
  assertNonEmptyString(raw.name, 'workflow.name', 256);
  if (raw.description !== undefined) assertNonEmptyString(raw.description, 'workflow.description', 4096);
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > 1000) {
    throw new AgentForgeError({ code: 'INVALID_WORKFLOW_STEPS', category: 'WORKFLOW_DEFINITION', message: 'Workflow must contain 1..1000 steps', httpStatus: 400 });
  }
  const steps = raw.steps.map(parseStep);
  const definition: WorkflowDefinition = {
    name: raw.name,
    steps,
    failurePolicy: 'FAIL_FAST',
    ...(raw.description === undefined ? {} : { description: raw.description }),
  };
  buildWorkflowGraph(definition);
  return definition;
}

export function buildWorkflowGraph(definition: WorkflowDefinition): WorkflowGraph {
  const ids = new Set<string>();
  for (const step of definition.steps) {
    if (ids.has(step.id)) {
      throw new AgentForgeError({ code: 'DUPLICATE_STEP_ID', category: 'WORKFLOW_DEFINITION', message: `Duplicate step id: ${step.id}`, httpStatus: 400 });
    }
    ids.add(step.id);
  }
  const dependencies = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const step of definition.steps) {
    const deps = [...(step.dependsOn ?? [])];
    for (const dep of deps) {
      if (!ids.has(dep)) {
        throw new AgentForgeError({ code: 'MISSING_DEPENDENCY', category: 'WORKFLOW_DEFINITION', message: `Step ${step.id} depends on missing step ${dep}`, httpStatus: 400 });
      }
      if (dep === step.id) {
        throw new AgentForgeError({ code: 'WORKFLOW_CYCLE', category: 'WORKFLOW_DEFINITION', message: `Step ${step.id} depends on itself`, httpStatus: 400 });
      }
    }
    dependencies.set(step.id, deps);
    dependents.set(step.id, []);
  }
  for (const [stepId, deps] of dependencies) {
    for (const dep of deps) dependents.get(dep)?.push(stepId);
  }

  const indegree = new Map<string, number>();
  for (const [id, deps] of dependencies) indegree.set(id, deps.length);
  const queue = definition.steps.map((step) => step.id).filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  if (order.length !== definition.steps.length) {
    throw new AgentForgeError({ code: 'WORKFLOW_CYCLE', category: 'WORKFLOW_DEFINITION', message: 'Workflow contains a cycle', httpStatus: 400 });
  }
  return { order, dependencies, dependents };
}

export function rootStepIds(definition: WorkflowDefinition): string[] {
  return definition.steps.filter((step) => (step.dependsOn ?? []).length === 0).map((step) => step.id);
}

export function getStep(definition: WorkflowDefinition, stepId: string): WorkflowStep {
  const step = definition.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined) {
    throw new AgentForgeError({ code: 'STEP_NOT_FOUND', category: 'INTERNAL_INVARIANT', message: `Step not found: ${stepId}`, httpStatus: 500 });
  }
  return step;
}

function pathGet(value: JsonValue, path: string[]): JsonValue {
  let current: JsonValue = value;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || current[index] === undefined) return null;
      current = current[index] as JsonValue;
    } else if (current !== null && typeof current === 'object') {
      const next = current[key];
      if (next === undefined) return null;
      current = next;
    } else {
      return null;
    }
  }
  return current;
}

export function resolveInputMapping(
  mapping: JsonObject | undefined,
  runInput: JsonValue,
  stepOutputs: Readonly<Record<string, JsonValue>>,
): JsonObject {
  const source = mapping ?? {};
  const resolve = (value: JsonValue): JsonValue => {
    if (typeof value === 'string' && value.startsWith('$run.input')) {
      const suffix = value.slice('$run.input'.length).replace(/^\./, '');
      return suffix.length === 0 ? runInput : pathGet(runInput, suffix.split('.'));
    }
    if (typeof value === 'string' && value.startsWith('$steps.')) {
      const parts = value.split('.');
      const stepId = parts[1];
      if (stepId === undefined || parts[2] !== 'output') return value;
      const output = stepOutputs[stepId];
      if (output === undefined) return null;
      return pathGet(output, parts.slice(3));
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)]));
    }
    return value;
  };
  return resolve(source) as JsonObject;
}
