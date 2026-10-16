import {
  AgentForgeError,
  asAgentForgeError,
  assertJsonValue,
  createId,
  jsonByteLength,
  type Attempt,
  type Checkpoint,
  type ExecutionEvent,
  type JsonObject,
  type JsonValue,
  type LeaseClaim,
  type RunId,
  type SerializedAgentForgeError,
  type StepRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowVersion,
} from '@agentforge/contracts';
import { computeRetryDelayMs, shouldRetry } from '@agentforge/core';
import { type ModelMessage, ProviderRegistry } from '@agentforge/providers';
import { ToolRegistry } from '@agentforge/tools';
import { getStep, resolveInputMapping, validateWorkflowDefinition } from '@agentforge/workflows';

export type RuntimeClock = { now(): Date; sleep(ms: number, signal?: AbortSignal): Promise<void> };
export type RuntimeRandom = { unit(): number };

export const systemClock: RuntimeClock = {
  now: () => new Date(),
  async sleep(ms, signal) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(new AgentForgeError({ code: 'SLEEP_ABORTED', category: 'CANCELLATION', message: 'Sleep aborted' }));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  },
};
export const systemRandom: RuntimeRandom = { unit: () => Math.random() };

export type ExecutionContextSnapshot = {
  run: WorkflowRun;
  stepRun: StepRun;
  workflowVersion: WorkflowVersion;
  stepOutputs: Readonly<Record<string, JsonValue>>;
};

export type ToolInvocationRecord = {
  id: string;
  toolName: string;
  operationKey: string;
  state: 'STARTED' | 'COMPLETED' | 'FAILED';
  output?: JsonValue;
  error?: SerializedAgentForgeError;
};

export type SignalResult = { status: 'accepted' | 'duplicate'; stepRunId: string };

export interface RuntimeStore {
  ping(): Promise<boolean>;
  createWorkflow(definition: WorkflowDefinition): Promise<WorkflowVersion>;
  getWorkflowVersion(id: string): Promise<WorkflowVersion | null>;
  getWorkflowLatest(workflowId: string): Promise<WorkflowVersion | null>;
  createRun(workflowVersion: WorkflowVersion, input: JsonValue): Promise<WorkflowRun>;
  getRun(id: RunId): Promise<WorkflowRun | null>;
  listStepRuns(runId: RunId): Promise<StepRun[]>;
  listEvents(runId: RunId, options?: { after?: number; limit?: number }): Promise<ExecutionEvent[]>;
  getExecutionContext(stepRunId: string): Promise<ExecutionContextSnapshot>;
  claimTasks(workerId: string, batchSize: number, leaseMs: number): Promise<LeaseClaim[]>;
  beginAttempt(claim: LeaseClaim): Promise<Attempt>;
  heartbeat(claim: LeaseClaim, leaseMs: number): Promise<{ authoritative: boolean; cancellationRequested: boolean; leaseExpiresAt?: string }>;
  finalizeSuccess(claim: LeaseClaim, attemptId: string, output: JsonValue): Promise<void>;
  finalizeFailure(claim: LeaseClaim, attemptId: string, error: SerializedAgentForgeError, retryAt?: string): Promise<void>;
  markWaiting(claim: LeaseClaim, attemptId: string, signalName: string): Promise<void>;
  requestCancellation(runId: RunId): Promise<WorkflowRun>;
  submitSignal(runId: RunId, name: string, payload: JsonValue, dedupeKey: string): Promise<SignalResult>;
  writeCheckpoint(input: { claim: LeaseClaim; attemptId: string; version: number; payload: JsonValue; maxBytes: number }): Promise<Checkpoint>;
  readLatestCheckpoint(stepRunId: string): Promise<Checkpoint | null>;
  getToolInvocation(toolName: string, operationKey: string): Promise<ToolInvocationRecord | null>;
  startToolInvocation(input: { runId: string; stepRunId: string; attemptId: string; toolName: string; operationKey: string; payload: JsonValue }): Promise<ToolInvocationRecord>;
  completeToolInvocation(id: string, output: JsonValue): Promise<void>;
  failToolInvocation(id: string, error: SerializedAgentForgeError): Promise<void>;
  recoverExpiredLeases(): Promise<number>;
}

export type HandlerContext = {
  signal: AbortSignal;
  runId: string;
  stepId: string;
  attemptId: string;
  checkpoint(payload: JsonValue, version?: number): Promise<Checkpoint>;
  latestCheckpoint(): Promise<Checkpoint | null>;
};
export type TaskHandler = (input: JsonObject, context: HandlerContext) => Promise<JsonValue>;

export class TaskRegistry {
  private readonly handlers = new Map<string, TaskHandler>();
  register(name: string, handler: TaskHandler): void {
    if (name.length === 0 || this.handlers.has(name)) {
      throw new AgentForgeError({ code: 'HANDLER_REGISTRATION_ERROR', category: 'VALIDATION', message: `Handler already registered or invalid: ${name}` });
    }
    this.handlers.set(name, handler);
  }
  get(name: string): TaskHandler {
    const handler = this.handlers.get(name);
    if (handler === undefined) throw new AgentForgeError({ code: 'HANDLER_NOT_FOUND', category: 'HANDLER', message: `Handler not registered: ${name}` });
    return handler;
  }
}

export type RuntimeLimits = {
  maxPayloadBytes: number;
  maxCheckpointBytes: number;
  maxToolOutputBytes: number;
};

export const DEFAULT_LIMITS: RuntimeLimits = {
  maxPayloadBytes: 1_048_576,
  maxCheckpointBytes: 262_144,
  maxToolOutputBytes: 1_048_576,
};

export class RuntimeService {
  constructor(
    readonly store: RuntimeStore,
    readonly limits: RuntimeLimits = DEFAULT_LIMITS,
  ) {}

  async createWorkflow(input: unknown): Promise<WorkflowVersion> {
    const definition = validateWorkflowDefinition(input);
    return this.store.createWorkflow(definition);
  }

  async startRun(workflowVersionId: string, input: unknown): Promise<WorkflowRun> {
    assertJsonValue(input, 'run.input');
    if (jsonByteLength(input) > this.limits.maxPayloadBytes) {
      throw new AgentForgeError({ code: 'PAYLOAD_TOO_LARGE', category: 'VALIDATION', message: `Run input exceeds ${this.limits.maxPayloadBytes} bytes`, httpStatus: 413 });
    }
    const version = await this.store.getWorkflowVersion(workflowVersionId);
    if (version === null) throw new AgentForgeError({ code: 'WORKFLOW_VERSION_NOT_FOUND', category: 'VALIDATION', message: `Unknown workflow version: ${workflowVersionId}`, httpStatus: 404 });
    return this.store.createRun(version, input);
  }

  async cancelRun(runId: string): Promise<WorkflowRun> {
    return this.store.requestCancellation(runId);
  }

  async signal(runId: string, name: string, payload: unknown, dedupeKey?: string): Promise<SignalResult> {
    assertJsonValue(payload, 'signal.payload');
    if (jsonByteLength(payload) > this.limits.maxPayloadBytes) {
      throw new AgentForgeError({ code: 'PAYLOAD_TOO_LARGE', category: 'VALIDATION', message: 'Signal payload too large', httpStatus: 413 });
    }
    if (name.length === 0 || name.length > 128) throw new AgentForgeError({ code: 'INVALID_SIGNAL_NAME', category: 'VALIDATION', message: 'Signal name must be 1..128 chars', httpStatus: 400 });
    return this.store.submitSignal(runId, name, payload, dedupeKey ?? createId('sig'));
  }
}

export type WorkerOptions = {
  workerId: string;
  concurrency: number;
  claimBatchSize: number;
  leaseMs: number;
  heartbeatMs: number;
  pollMs: number;
  gracefulShutdownMs: number;
};

export type WorkerHooks = {
  afterExecutionBeforeCommit?: (input: { claim: LeaseClaim; output: JsonValue }) => Promise<void>;
  afterToolInvocationBeforeStepCommit?: (input: { claim: LeaseClaim; output: JsonValue; toolName: string }) => Promise<void>;
};

export class SimulatedWorkerCrash extends Error {
  constructor(message = 'Simulated worker crash') {
    super(message);
    this.name = 'SimulatedWorkerCrash';
  }
}

function parseAgentCheckpoint(checkpoint: Checkpoint, maxIterations: number): { iteration: number; messages: ModelMessage[] } {
  if (checkpoint.version !== 1) {
    throw new AgentForgeError({ code: 'CHECKPOINT_INCOMPATIBLE', category: 'CHECKPOINT', message: `Agent checkpoint version ${checkpoint.version} is not supported`, retryable: false });
  }
  const payload = checkpoint.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new AgentForgeError({ code: 'CHECKPOINT_INCOMPATIBLE', category: 'CHECKPOINT', message: 'Agent checkpoint payload must be an object', retryable: false });
  }
  const rawIteration = payload.iteration;
  const rawMessages = payload.messages;
  if (!Number.isSafeInteger(rawIteration) || (rawIteration as number) < 0 || (rawIteration as number) > maxIterations || !Array.isArray(rawMessages)) {
    throw new AgentForgeError({ code: 'CHECKPOINT_INCOMPATIBLE', category: 'CHECKPOINT', message: 'Agent checkpoint iteration/messages are invalid', retryable: false });
  }
  const messages: ModelMessage[] = rawMessages.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new AgentForgeError({ code: 'CHECKPOINT_INCOMPATIBLE', category: 'CHECKPOINT', message: `Agent checkpoint message ${index} is not an object`, retryable: false });
    }
    const role = value.role;
    const content = value.content;
    const name = value.name;
    if (!['system', 'user', 'assistant', 'tool'].includes(typeof role === 'string' ? role : '') || typeof content !== 'string' || (name !== undefined && typeof name !== 'string')) {
      throw new AgentForgeError({ code: 'CHECKPOINT_INCOMPATIBLE', category: 'CHECKPOINT', message: `Agent checkpoint message ${index} has an invalid shape`, retryable: false });
    }
    return { role: role as ModelMessage['role'], content, ...(name === undefined ? {} : { name }) };
  });
  return { iteration: rawIteration as number, messages };
}

export class Worker {
  private stopping = false;
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly store: RuntimeStore,
    private readonly tasks: TaskRegistry,
    private readonly tools: ToolRegistry,
    private readonly providers: ProviderRegistry,
    readonly options: WorkerOptions,
    private readonly limits: RuntimeLimits = DEFAULT_LIMITS,
    private readonly clock: RuntimeClock = systemClock,
    private readonly random: RuntimeRandom = systemRandom,
    private readonly hooks: WorkerHooks = {},
  ) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 1024) {
      throw new AgentForgeError({ code: 'INVALID_WORKER_CONCURRENCY', category: 'VALIDATION', message: 'Worker concurrency must be in [1,1024]' });
    }
    if (options.claimBatchSize < 1 || options.claimBatchSize > options.concurrency) {
      throw new AgentForgeError({ code: 'INVALID_CLAIM_BATCH', category: 'VALIDATION', message: 'claimBatchSize must be in [1, concurrency]' });
    }
    if (options.heartbeatMs >= options.leaseMs) {
      throw new AgentForgeError({ code: 'INVALID_HEARTBEAT', category: 'VALIDATION', message: 'heartbeatMs must be smaller than leaseMs' });
    }
  }

  async tick(): Promise<number> {
    if (this.stopping) return 0;
    await this.store.recoverExpiredLeases();
    const capacity = this.options.concurrency - this.active.size;
    if (capacity <= 0) return 0;
    const claims = await this.store.claimTasks(this.options.workerId, Math.min(capacity, this.options.claimBatchSize), this.options.leaseMs);
    await Promise.all(claims.map((claim) => this.processClaim(claim)));
    return claims.length;
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!this.stopping && !signal?.aborted) {
      const count = await this.tick();
      if (count === 0) await this.clock.sleep(this.options.pollMs, signal);
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort('worker shutdown');
    const deadline = Date.now() + this.options.gracefulShutdownMs;
    while (this.active.size > 0 && Date.now() < deadline) await this.clock.sleep(10);
  }

  private async processClaim(claim: LeaseClaim): Promise<void> {
    const controller = new AbortController();
    this.active.set(claim.id, controller);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let currentAttemptId: string | undefined;
    try {
      const attempt = await this.store.beginAttempt(claim);
      currentAttemptId = attempt.id;
      const context = await this.store.getExecutionContext(claim.stepRunId);
      const step = getStep(context.workflowVersion.definition, context.stepRun.stepId);
      const heartbeat = async () => {
        try {
          const state = await this.store.heartbeat(claim, this.options.leaseMs);
          if (!state.authoritative || state.cancellationRequested) controller.abort(state.cancellationRequested ? 'run cancellation' : 'lease lost');
        } catch {
          controller.abort('heartbeat dependency failure');
        }
      };
      heartbeatTimer = setInterval(() => void heartbeat(), this.options.heartbeatMs);

      if (context.run.cancellationRequested || context.run.state === 'CANCELLING') {
        controller.abort('run cancellation');
        throw new AgentForgeError({ code: 'RUN_CANCELLED', category: 'CANCELLATION', message: 'Run is cancelling', retryable: false });
      }

      if (step.kind === 'wait') {
        await this.store.markWaiting(claim, attempt.id, step.signal);
        return;
      }

      const input = resolveInputMapping(step.input, context.run.input, context.stepOutputs);
      const execute = this.executeStep(step, input, context, attempt, claim, controller.signal);
      const output = await this.withTimeout(execute, step.timeout?.timeoutMs, controller);
      assertJsonValue(output, 'step.output');
      if (jsonByteLength(output) > this.limits.maxPayloadBytes) {
        throw new AgentForgeError({ code: 'STEP_OUTPUT_TOO_LARGE', category: 'VALIDATION', message: 'Step output exceeds configured payload limit', retryable: false });
      }
      await this.hooks.afterExecutionBeforeCommit?.({ claim, output });
      await this.store.finalizeSuccess(claim, attempt.id, output);
    } catch (error) {
      if (error instanceof SimulatedWorkerCrash) return;
      const normalized = asAgentForgeError(error, { code: 'STEP_EXECUTION_FAILED', category: 'HANDLER' });
      if (this.stopping && normalized.category === 'CANCELLATION') return;
      if (currentAttemptId === undefined) return;
      try {
        const context = await this.store.getExecutionContext(claim.stepRunId);
        const step = getStep(context.workflowVersion.definition, context.stepRun.stepId);
        const policy = step.retry ?? { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1, maxDelayMs: 0 };
        const retry = shouldRetry(policy, claim.attemptNo, normalized.code, normalized.retryable);
        const retryAt = retry
          ? new Date(this.clock.now().getTime() + computeRetryDelayMs(policy, claim.attemptNo, this.random.unit())).toISOString()
          : undefined;
        await this.store.finalizeFailure(claim, currentAttemptId, normalized.serialize(), retryAt);
      } catch (commitError) {
        const commit = asAgentForgeError(commitError);
        if (commit.category !== 'LEASE_LOST' && commit.category !== 'ILLEGAL_STATE_TRANSITION') throw commit;
      }
    } finally {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      this.active.delete(claim.id);
    }
  }

  private async executeStep(
    step: Exclude<ReturnType<typeof getStep>, { kind: 'wait' }>,
    input: JsonObject,
    snapshot: ExecutionContextSnapshot,
    attempt: Attempt,
    claim: LeaseClaim,
    signal: AbortSignal,
  ): Promise<JsonValue> {
    const handlerContext: HandlerContext = {
      signal,
      runId: snapshot.run.id,
      stepId: step.id,
      attemptId: attempt.id,
      checkpoint: async (payload, version = 1) => {
        assertJsonValue(payload, 'checkpoint.payload');
        if (!Number.isSafeInteger(version) || version < 1) {
          throw new AgentForgeError({ code: 'CHECKPOINT_INCOMPATIBLE', category: 'CHECKPOINT', message: 'Checkpoint version must be a positive integer', retryable: false });
        }
        return this.store.writeCheckpoint({ claim, attemptId: attempt.id, version, payload, maxBytes: this.limits.maxCheckpointBytes });
      },
      latestCheckpoint: () => this.store.readLatestCheckpoint(snapshot.stepRun.id),
    };

    switch (step.kind) {
      case 'task':
        return this.tasks.get(step.handler)(input, handlerContext);
      case 'model': {
        const response = await this.providers.get(step.provider).invoke({ prompt: step.prompt, metadata: input }, { signal, runId: snapshot.run.id, stepId: step.id });
        if (response.finishReason !== 'stop' || response.text === undefined) {
          throw new AgentForgeError({ code: 'UNEXPECTED_MODEL_TOOL_CALL', category: 'PROVIDER', message: 'Model step expected a terminal text response', retryable: false });
        }
        return { text: response.text };
      }
      case 'tool':
        return this.invokeToolWithDurableIdempotency(step.tool, step.operationKey ?? `${snapshot.run.id}:${step.id}`, input, snapshot, attempt, claim, signal);
      case 'agent':
        return this.runAgentLoop(step, input, snapshot, attempt, claim, signal, handlerContext);
      default:
        throw new AgentForgeError({ code: 'UNSUPPORTED_STEP', category: 'INTERNAL_INVARIANT', message: 'Unsupported step kind' });
    }
  }

  private async invokeToolWithDurableIdempotency(
    toolName: string,
    operationKey: string,
    input: JsonValue,
    snapshot: ExecutionContextSnapshot,
    attempt: Attempt,
    claim: LeaseClaim,
    signal: AbortSignal,
    maxOutputBytes = this.limits.maxToolOutputBytes,
  ): Promise<JsonValue> {
    const tool = this.tools.get(toolName);
    if (tool.sideEffect === 'SIDE_EFFECTING') {
      const existing = await this.store.getToolInvocation(toolName, operationKey);
      if (existing?.state === 'COMPLETED' && existing.output !== undefined) return existing.output;
      const record = existing ?? (await this.store.startToolInvocation({
        runId: snapshot.run.id,
        stepRunId: snapshot.stepRun.id,
        attemptId: attempt.id,
        toolName,
        operationKey,
        payload: input,
      }));
      try {
        const output = await this.tools.invoke(toolName, input, { signal, runId: snapshot.run.id, stepId: snapshot.stepRun.stepId, attemptId: attempt.id, idempotencyKey: operationKey }, maxOutputBytes);
        await this.store.completeToolInvocation(record.id, output);
        await this.hooks.afterToolInvocationBeforeStepCommit?.({ claim, output, toolName });
        return output;
      } catch (error) {
        if (error instanceof SimulatedWorkerCrash) throw error;
        const normalized = asAgentForgeError(error, { code: 'TOOL_FAILED', category: 'TOOL' });
        await this.store.failToolInvocation(record.id, normalized.serialize());
        throw normalized;
      }
    }
    return this.tools.invoke(toolName, input, { signal, runId: snapshot.run.id, stepId: snapshot.stepRun.stepId, attemptId: attempt.id }, maxOutputBytes);
  }

  private async runAgentLoop(
    step: Extract<ReturnType<typeof getStep>, { kind: 'agent' }>,
    input: JsonObject,
    snapshot: ExecutionContextSnapshot,
    attempt: Attempt,
    claim: LeaseClaim,
    signal: AbortSignal,
    handlerContext: HandlerContext,
  ): Promise<JsonValue> {
    const provider = this.providers.get(step.provider);
    const messages: ModelMessage[] = [
      { role: 'user', content: `${step.prompt}\nINPUT:${JSON.stringify(input)}` },
    ];
    const restored = await handlerContext.latestCheckpoint();
    let startIteration = 0;
    if (restored !== null) {
      const parsed = parseAgentCheckpoint(restored, step.maxIterations);
      startIteration = parsed.iteration;
      messages.splice(0, messages.length, ...parsed.messages);
    }
    for (let iteration = startIteration; iteration < step.maxIterations; iteration += 1) {
      if (signal.aborted) throw new AgentForgeError({ code: 'AGENT_CANCELLED', category: 'CANCELLATION', message: 'Agent loop cancelled' });
      const response = await provider.invoke({ messages }, { signal, runId: snapshot.run.id, stepId: step.id, iteration });
      if (response.finishReason === 'stop' && response.text !== undefined) return { text: response.text, iterations: iteration + 1 };
      if (response.finishReason !== 'tool_call' || response.toolCall === undefined) {
        throw new AgentForgeError({ code: 'MALFORMED_PROVIDER_RESPONSE', category: 'PROVIDER', message: 'Agent provider returned malformed response' });
      }
      if (step.allowedTools !== undefined && !step.allowedTools.includes(response.toolCall.name)) {
        throw new AgentForgeError({ code: 'AGENT_TOOL_NOT_ALLOWED', category: 'TOOL', message: `Agent requested disallowed tool ${response.toolCall.name}` });
      }
      const operationKey = `${snapshot.run.id}:${step.id}:iteration:${iteration}:tool:${response.toolCall.name}`;
      const toolOutput = await this.invokeToolWithDurableIdempotency(
        response.toolCall.name,
        operationKey,
        response.toolCall.input,
        snapshot,
        attempt,
        claim,
        signal,
        step.maxToolOutputBytes ?? this.limits.maxToolOutputBytes,
      );
      messages.push({ role: 'assistant', content: `TOOL_CALL:${response.toolCall.name}:${JSON.stringify(response.toolCall.input)}` });
      messages.push({ role: 'tool', name: response.toolCall.name, content: JSON.stringify(toolOutput) });
      await handlerContext.checkpoint({ iteration: iteration + 1, messages: messages as unknown as JsonValue }, 1);
    }
    throw new AgentForgeError({ code: 'AGENT_ITERATION_LIMIT', category: 'PROVIDER', message: `Agent exceeded ${step.maxIterations} iterations`, retryable: false });
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number | undefined, controller: AbortController): Promise<T> {
    if (timeoutMs === undefined) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort('timeout');
        reject(new AgentForgeError({ code: 'STEP_TIMEOUT', category: 'TIMEOUT', message: `Step exceeded timeout of ${timeoutMs}ms`, retryable: true }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      void operation.catch(() => undefined);
    }
  }
}
