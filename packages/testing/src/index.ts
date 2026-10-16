import {
  AgentForgeError,
  createId,
  jsonByteLength,
  type Attempt,
  type Checkpoint,
  type ExecutionEvent,
  type JsonValue,
  type LeaseClaim,
  type QueueTask,
  type SerializedAgentForgeError,
  type StepRun,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowVersion,
} from '@agentforge/contracts';
import type {
  ExecutionContextSnapshot,
  RuntimeClock,
  RuntimeStore,
  SignalResult,
  ToolInvocationRecord,
} from '@agentforge/runtime';
import { buildWorkflowGraph } from '@agentforge/workflows';

export class FakeClock implements RuntimeClock {
  private value: number;
  constructor(start = Date.parse('2026-01-01T00:00:00.000Z')) { this.value = start; }
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value += ms; }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new AgentForgeError({ code: 'SLEEP_ABORTED', category: 'CANCELLATION', message: 'Sleep aborted' });
    this.advance(ms);
  }
}

export class SequenceRandom {
  private index = 0;
  constructor(private readonly values: readonly number[] = [0.5]) {}
  unit(): number {
    const value = this.values[this.index % this.values.length] ?? 0.5;
    this.index += 1;
    return value;
  }
}

type StoredRun = WorkflowRun & { nextEventSeq: number };
type StoredSignal = { runId: string; name: string; dedupeKey: string; payload: JsonValue; stepRunId: string };

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryStore implements RuntimeStore {
  private readonly versions = new Map<string, WorkflowVersion>();
  private readonly runs = new Map<string, StoredRun>();
  private readonly steps = new Map<string, StepRun>();
  private readonly queues = new Map<string, QueueTask>();
  private readonly attempts = new Map<string, Attempt>();
  private readonly checkpoints = new Map<string, Checkpoint[]>();
  private readonly events = new Map<string, ExecutionEvent[]>();
  private readonly toolInvocations = new Map<string, ToolInvocationRecord>();
  private readonly signals = new Map<string, StoredSignal>();
  private databaseAvailable = true;

  constructor(private readonly clock: RuntimeClock = new FakeClock()) {}

  setDatabaseAvailable(value: boolean): void { this.databaseAvailable = value; }
  private ensureAvailable(): void {
    if (!this.databaseAvailable) throw new AgentForgeError({ code: 'DATABASE_UNAVAILABLE', category: 'PERSISTENCE', message: 'Synthetic database unavailable', retryable: true });
  }
  async ping(): Promise<boolean> { return this.databaseAvailable; }

  private emit(runId: string, type: ExecutionEvent['type'], payload: ExecutionEvent['payload'] = {}, stepRunId?: string, attemptId?: string): ExecutionEvent {
    const run = this.runs.get(runId);
    if (run === undefined) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'INTERNAL_INVARIANT', message: `Run missing for event: ${runId}` });
    const sequence = run.nextEventSeq;
    run.nextEventSeq += 1;
    const event: ExecutionEvent = {
      id: `${runId}:event:${sequence}`,
      runId,
      type,
      timestamp: this.clock.now().toISOString(),
      schemaVersion: 1,
      sequence,
      payload: copy(payload),
      ...(stepRunId === undefined ? {} : { stepRunId }),
      ...(attemptId === undefined ? {} : { attemptId }),
    };
    const list = this.events.get(runId) ?? [];
    list.push(event);
    this.events.set(runId, list);
    return event;
  }

  async createWorkflow(definition: WorkflowDefinition): Promise<WorkflowVersion> {
    this.ensureAvailable();
    buildWorkflowGraph(definition);
    const workflowId = createId('wf');
    const version: WorkflowVersion = {
      id: createId('wfv'),
      workflowId,
      version: 1,
      definition: copy(definition),
      createdAt: this.clock.now().toISOString(),
    };
    this.versions.set(version.id, version);
    return copy(version);
  }

  async getWorkflowVersion(id: string): Promise<WorkflowVersion | null> {
    this.ensureAvailable();
    const value = this.versions.get(id);
    return value === undefined ? null : copy(value);
  }

  async getWorkflowLatest(workflowId: string): Promise<WorkflowVersion | null> {
    this.ensureAvailable();
    const matches = [...this.versions.values()].filter((version) => version.workflowId === workflowId).sort((a, b) => b.version - a.version);
    return matches[0] === undefined ? null : copy(matches[0]);
  }

  async createRun(workflowVersion: WorkflowVersion, input: JsonValue): Promise<WorkflowRun> {
    this.ensureAvailable();
    const now = this.clock.now().toISOString();
    const run: StoredRun = {
      id: createId('run'),
      workflowVersionId: workflowVersion.id,
      state: 'QUEUED',
      input: copy(input),
      cancellationRequested: false,
      createdAt: now,
      updatedAt: now,
      nextEventSeq: 1,
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.emit(run.id, 'workflow.created');
    run.state = 'RUNNING';
    this.emit(run.id, 'workflow.started');
    const graph = buildWorkflowGraph(workflowVersion.definition);
    for (const step of workflowVersion.definition.steps) {
      const ready = (graph.dependencies.get(step.id) ?? []).length === 0;
      const stepRun: StepRun = {
        id: createId('step'),
        runId: run.id,
        stepId: step.id,
        state: ready ? 'READY' : 'PENDING',
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
        ...(step.concurrencyKey === undefined ? {} : { concurrencyKey: step.concurrencyKey }),
      };
      this.steps.set(stepRun.id, stepRun);
      if (ready) {
        this.queues.set(stepRun.id, {
          id: createId('task'),
          runId: run.id,
          stepRunId: stepRun.id,
          state: 'READY',
          availableAt: now,
          leaseGeneration: 0,
          attemptNo: 0,
          priority: 0,
          ...(step.concurrencyKey === undefined ? {} : { concurrencyKey: step.concurrencyKey }),
        });
        this.emit(run.id, 'step.ready', { stepId: step.id }, stepRun.id);
      }
    }
    return copy(run);
  }

  async getRun(id: string): Promise<WorkflowRun | null> {
    this.ensureAvailable();
    const run = this.runs.get(id);
    if (run === undefined) return null;
    const { nextEventSeq: _seq, ...publicRun } = run;
    return copy(publicRun);
  }

  async listStepRuns(runId: string): Promise<StepRun[]> {
    this.ensureAvailable();
    return [...this.steps.values()].filter((step) => step.runId === runId).map(copy);
  }

  async listEvents(runId: string, options: { after?: number; limit?: number } = {}): Promise<ExecutionEvent[]> {
    this.ensureAvailable();
    const after = options.after ?? 0;
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    return (this.events.get(runId) ?? []).filter((event) => event.sequence > after).slice(0, limit).map(copy);
  }

  async getExecutionContext(stepRunId: string): Promise<ExecutionContextSnapshot> {
    this.ensureAvailable();
    const step = this.steps.get(stepRunId);
    if (step === undefined) throw new AgentForgeError({ code: 'STEP_RUN_NOT_FOUND', category: 'PERSISTENCE', message: `Step not found: ${stepRunId}` });
    const run = await this.getRun(step.runId);
    if (run === null) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'PERSISTENCE', message: `Run not found: ${step.runId}` });
    const version = this.versions.get(run.workflowVersionId);
    if (version === undefined) throw new AgentForgeError({ code: 'WORKFLOW_VERSION_NOT_FOUND', category: 'PERSISTENCE', message: 'Pinned workflow version missing' });
    const outputs: Record<string, JsonValue> = {};
    for (const candidate of this.steps.values()) {
      if (candidate.runId === run.id && candidate.output !== undefined) outputs[candidate.stepId] = copy(candidate.output);
    }
    return { run, stepRun: copy(step), workflowVersion: copy(version), stepOutputs: outputs };
  }

  private isAuthoritative(claim: LeaseClaim): boolean {
    const queue = this.queues.get(claim.stepRunId);
    return queue !== undefined && queue.id === claim.id && queue.state === 'LEASED' && queue.leaseOwner === claim.leaseOwner && queue.leaseGeneration === claim.leaseGeneration && queue.leaseExpiresAt !== undefined && Date.parse(queue.leaseExpiresAt) > this.clock.now().getTime();
  }

  async claimTasks(workerId: string, batchSize: number, leaseMs: number): Promise<LeaseClaim[]> {
    this.ensureAvailable();
    const claims: LeaseClaim[] = [];
    const nowMs = this.clock.now().getTime();
    const candidates = [...this.queues.values()]
      .filter((queue) => {
        const run = this.runs.get(queue.runId);
        if (run === undefined || run.cancellationRequested || !['RUNNING', 'WAITING'].includes(run.state)) return false;
        if (!['READY', 'RETRY_SCHEDULED'].includes(queue.state) || Date.parse(queue.availableAt) > nowMs) return false;
        if (queue.concurrencyKey !== undefined) {
          const activeSameKey = [...this.queues.values()].some((other) => other.id !== queue.id && other.concurrencyKey === queue.concurrencyKey && other.state === 'LEASED' && other.leaseExpiresAt !== undefined && Date.parse(other.leaseExpiresAt) > nowMs);
          if (activeSameKey) return false;
        }
        return true;
      })
      .sort((a, b) => b.priority - a.priority || Date.parse(a.availableAt) - Date.parse(b.availableAt) || a.id.localeCompare(b.id));
    for (const queue of candidates) {
      if (claims.length >= Math.max(0, batchSize)) break;
      if (queue.concurrencyKey !== undefined) {
        const activeSameKey = [...this.queues.values()].some((other) => other.id !== queue.id && other.concurrencyKey === queue.concurrencyKey && other.state === 'LEASED' && other.leaseExpiresAt !== undefined && Date.parse(other.leaseExpiresAt) > nowMs);
        if (activeSameKey) continue;
      }
      queue.state = 'LEASED';
      queue.leaseOwner = workerId;
      queue.leaseGeneration += 1;
      queue.attemptNo += 1;
      queue.leaseExpiresAt = new Date(nowMs + leaseMs).toISOString();
      const step = this.steps.get(queue.stepRunId);
      if (step === undefined || !['READY', 'RETRY_SCHEDULED'].includes(step.state)) continue;
      step.state = 'LEASED';
      step.updatedAt = this.clock.now().toISOString();
      this.emit(queue.runId, 'step.leased', { workerId, generation: queue.leaseGeneration }, step.id);
      claims.push(copy(queue as LeaseClaim));
    }
    return claims;
  }

  async beginAttempt(claim: LeaseClaim): Promise<Attempt> {
    this.ensureAvailable();
    if (!this.isAuthoritative(claim)) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Stale lease at attempt start', retryable: true });
    const step = this.steps.get(claim.stepRunId);
    if (step === undefined || step.state !== 'LEASED') throw new AgentForgeError({ code: 'ILLEGAL_STEP_TRANSITION', category: 'ILLEGAL_STATE_TRANSITION', message: 'Step must be LEASED before RUNNING' });
    step.state = 'RUNNING';
    step.attemptCount = Math.max(step.attemptCount + 1, claim.attemptNo);
    step.updatedAt = this.clock.now().toISOString();
    const attempt: Attempt = {
      id: createId('attempt'),
      stepRunId: step.id,
      generation: claim.leaseGeneration,
      state: 'RUNNING',
      startedAt: this.clock.now().toISOString(),
    };
    this.attempts.set(attempt.id, attempt);
    this.emit(claim.runId, 'attempt.started', { generation: claim.leaseGeneration }, step.id, attempt.id);
    this.emit(claim.runId, 'step.started', {}, step.id, attempt.id);
    return copy(attempt);
  }

  async heartbeat(claim: LeaseClaim, leaseMs: number): Promise<{ authoritative: boolean; cancellationRequested: boolean; leaseExpiresAt?: string }> {
    this.ensureAvailable();
    if (!this.isAuthoritative(claim)) return { authoritative: false, cancellationRequested: false };
    const queue = this.queues.get(claim.stepRunId);
    const run = this.runs.get(claim.runId);
    if (queue === undefined || run === undefined) return { authoritative: false, cancellationRequested: false };
    queue.leaseExpiresAt = new Date(this.clock.now().getTime() + leaseMs).toISOString();
    return { authoritative: true, cancellationRequested: run.cancellationRequested, leaseExpiresAt: queue.leaseExpiresAt };
  }

  private requireAttempt(claim: LeaseClaim, attemptId: string): Attempt {
    const attempt = this.attempts.get(attemptId);
    if (!this.isAuthoritative(claim) || attempt === undefined || attempt.stepRunId !== claim.stepRunId || attempt.generation !== claim.leaseGeneration || attempt.state !== 'RUNNING') {
      throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Stale worker commit rejected', retryable: true, httpStatus: 409 });
    }
    return attempt;
  }

  private scheduleNewlyReady(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined || run.cancellationRequested || run.state !== 'RUNNING') return;
    const version = this.versions.get(run.workflowVersionId);
    if (version === undefined) throw new AgentForgeError({ code: 'WORKFLOW_VERSION_NOT_FOUND', category: 'INTERNAL_INVARIANT', message: 'Pinned workflow version missing' });
    const graph = buildWorkflowGraph(version.definition);
    const stepByLogical = new Map([...this.steps.values()].filter((item) => item.runId === runId).map((item) => [item.stepId, item]));
    for (const candidate of stepByLogical.values()) {
      if (candidate.state !== 'PENDING') continue;
      const deps = graph.dependencies.get(candidate.stepId) ?? [];
      if (deps.every((dep) => stepByLogical.get(dep)?.state === 'SUCCEEDED')) {
        candidate.state = 'READY';
        candidate.updatedAt = this.clock.now().toISOString();
        this.queues.set(candidate.id, {
          id: createId('task'), runId, stepRunId: candidate.id, state: 'READY', availableAt: this.clock.now().toISOString(), leaseGeneration: 0, attemptNo: 0, priority: 0,
          ...(candidate.concurrencyKey === undefined ? {} : { concurrencyKey: candidate.concurrencyKey }),
        });
        this.emit(runId, 'step.ready', { stepId: candidate.stepId }, candidate.id);
      }
    }
  }

  private maybeSucceedRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run === undefined || run.cancellationRequested || !['RUNNING', 'WAITING'].includes(run.state)) return;
    const steps = [...this.steps.values()].filter((step) => step.runId === runId);
    if (steps.length > 0 && steps.every((step) => ['SUCCEEDED', 'SKIPPED'].includes(step.state))) {
      run.state = 'SUCCEEDED';
      run.output = { status: 'succeeded' };
      run.updatedAt = this.clock.now().toISOString();
      this.emit(runId, 'workflow.succeeded');
    }
  }

  async finalizeSuccess(claim: LeaseClaim, attemptId: string, output: JsonValue): Promise<void> {
    this.ensureAvailable();
    const run = this.runs.get(claim.runId);
    if (run?.cancellationRequested) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Cancellation revoked commit authority', retryable: true });
    const attempt = this.requireAttempt(claim, attemptId);
    const queue = this.queues.get(claim.stepRunId);
    const step = this.steps.get(claim.stepRunId);
    if (queue === undefined || step === undefined || step.state !== 'RUNNING') throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Step no longer accepts completion', retryable: true });
    queue.state = 'SUCCEEDED'; delete queue.leaseOwner; delete queue.leaseExpiresAt;
    step.state = 'SUCCEEDED'; step.output = copy(output); step.updatedAt = this.clock.now().toISOString(); delete step.error;
    attempt.state = 'SUCCEEDED'; attempt.finishedAt = this.clock.now().toISOString();
    this.emit(claim.runId, 'step.succeeded', {}, step.id, attempt.id);
    this.scheduleNewlyReady(claim.runId);
    this.maybeSucceedRun(claim.runId);
  }

  async finalizeFailure(claim: LeaseClaim, attemptId: string, error: SerializedAgentForgeError, retryAt?: string): Promise<void> {
    this.ensureAvailable();
    const attempt = this.requireAttempt(claim, attemptId);
    const queue = this.queues.get(claim.stepRunId);
    const step = this.steps.get(claim.stepRunId);
    if (queue === undefined || step === undefined) throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Queue or step missing' });
    attempt.state = error.category === 'TIMEOUT' ? 'TIMED_OUT' : 'FAILED';
    attempt.error = copy(error); attempt.finishedAt = this.clock.now().toISOString();
    this.emit(claim.runId, 'attempt.failed', error as unknown as ExecutionEvent['payload'], step.id, attempt.id);
    delete queue.leaseOwner; delete queue.leaseExpiresAt;
    step.error = copy(error); step.updatedAt = this.clock.now().toISOString();
    if (retryAt !== undefined) {
      queue.state = 'RETRY_SCHEDULED'; queue.availableAt = retryAt;
      step.state = 'RETRY_SCHEDULED';
      this.emit(claim.runId, 'step.retry_scheduled', error as unknown as ExecutionEvent['payload'], step.id, attempt.id);
      return;
    }
    queue.state = 'FAILED'; step.state = 'FAILED';
    this.emit(claim.runId, 'step.failed', error as unknown as ExecutionEvent['payload'], step.id, attempt.id);
    const run = this.runs.get(claim.runId);
    if (run !== undefined && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) {
      run.state = 'FAILED'; run.error = copy(error); run.updatedAt = this.clock.now().toISOString();
      for (const candidate of this.queues.values()) {
        if (candidate.runId === run.id && ['READY', 'RETRY_SCHEDULED', 'LEASED'].includes(candidate.state) && candidate.id !== queue.id) {
          candidate.state = 'CANCELLED'; delete candidate.leaseOwner; delete candidate.leaseExpiresAt;
        }
      }
      for (const candidate of this.steps.values()) {
        if (candidate.runId === run.id && candidate.id !== step.id && ['PENDING', 'READY', 'LEASED', 'RUNNING', 'WAITING', 'RETRY_SCHEDULED'].includes(candidate.state)) candidate.state = 'CANCELLED';
      }
      this.emit(run.id, 'workflow.failed', error as unknown as ExecutionEvent['payload']);
    }
  }

  async markWaiting(claim: LeaseClaim, attemptId: string, signalName: string): Promise<void> {
    this.ensureAvailable();
    const attempt = this.requireAttempt(claim, attemptId);
    const queue = this.queues.get(claim.stepRunId);
    const step = this.steps.get(claim.stepRunId);
    const run = this.runs.get(claim.runId);
    if (queue === undefined || step === undefined || run === undefined || step.state !== 'RUNNING') throw new AgentForgeError({ code: 'LEASE_LOST', category: 'LEASE_LOST', message: 'Wait authority lost' });
    queue.state = 'SUCCEEDED'; delete queue.leaseOwner; delete queue.leaseExpiresAt;
    step.state = 'WAITING'; step.waitSignalName = signalName; step.updatedAt = this.clock.now().toISOString();
    attempt.state = 'SUCCEEDED'; attempt.finishedAt = this.clock.now().toISOString();
    run.state = 'WAITING'; run.updatedAt = this.clock.now().toISOString();
    this.emit(run.id, 'step.waiting', { signal: signalName }, step.id, attempt.id);
    this.emit(run.id, 'workflow.waiting', { signal: signalName });
  }

  async requestCancellation(runId: string): Promise<WorkflowRun> {
    this.ensureAvailable();
    const run = this.runs.get(runId);
    if (run === undefined) throw new AgentForgeError({ code: 'RUN_NOT_FOUND', category: 'VALIDATION', message: 'Run not found', httpStatus: 404 });
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.state)) return copy(run);
    run.state = 'CANCELLING'; run.cancellationRequested = true; run.updatedAt = this.clock.now().toISOString();
    this.emit(run.id, 'workflow.cancellation_requested');
    for (const queue of this.queues.values()) {
      if (queue.runId === runId && ['READY', 'RETRY_SCHEDULED', 'LEASED'].includes(queue.state)) {
        queue.state = 'CANCELLED'; delete queue.leaseOwner; delete queue.leaseExpiresAt;
      }
    }
    for (const step of this.steps.values()) {
      if (step.runId === runId && ['PENDING', 'READY', 'LEASED', 'RUNNING', 'WAITING', 'RETRY_SCHEDULED'].includes(step.state)) {
        step.state = 'CANCELLED'; step.updatedAt = this.clock.now().toISOString();
        this.emit(run.id, 'step.cancelled', {}, step.id);
      }
    }
    run.state = 'CANCELLED'; run.updatedAt = this.clock.now().toISOString();
    this.emit(run.id, 'workflow.cancelled');
    return copy(run);
  }

  async submitSignal(runId: string, name: string, payload: JsonValue, dedupeKey: string): Promise<SignalResult> {
    this.ensureAvailable();
    const key = `${runId}:${name}:${dedupeKey}`;
    const existing = this.signals.get(key);
    if (existing !== undefined) {
      this.emit(runId, 'signal.duplicate', { name, dedupeKey }, existing.stepRunId);
      return { status: 'duplicate', stepRunId: existing.stepRunId };
    }
    const step = [...this.steps.values()].find((candidate) => candidate.runId === runId && candidate.state === 'WAITING' && candidate.waitSignalName === name);
    const run = this.runs.get(runId);
    if (step === undefined || run === undefined || run.state !== 'WAITING') throw new AgentForgeError({ code: 'INVALID_OR_LATE_SIGNAL', category: 'VALIDATION', message: `No waiting step accepts ${name}`, httpStatus: 409 });
    this.signals.set(key, { runId, name, dedupeKey, payload: copy(payload), stepRunId: step.id });
    step.state = 'SUCCEEDED'; step.output = copy(payload); delete step.waitSignalName; step.updatedAt = this.clock.now().toISOString();
    run.state = 'RUNNING'; run.updatedAt = this.clock.now().toISOString();
    this.emit(runId, 'signal.accepted', { name, dedupeKey }, step.id);
    this.emit(runId, 'step.succeeded', { resumedBySignal: name }, step.id);
    this.emit(runId, 'workflow.started', { resumedBySignal: name });
    this.scheduleNewlyReady(runId);
    this.maybeSucceedRun(runId);
    return { status: 'accepted', stepRunId: step.id };
  }

  async writeCheckpoint(input: { claim: LeaseClaim; attemptId: string; version: number; payload: JsonValue; maxBytes: number }): Promise<Checkpoint> {
    this.ensureAvailable();
    this.requireAttempt(input.claim, input.attemptId);
    const bytes = jsonByteLength(input.payload);
    if (bytes > input.maxBytes) throw new AgentForgeError({ code: 'CHECKPOINT_TOO_LARGE', category: 'CHECKPOINT', message: 'Checkpoint too large' });
    const checkpoint: Checkpoint = { id: createId('cp'), runId: input.claim.runId, stepRunId: input.claim.stepRunId, attemptId: input.attemptId, version: input.version, payload: copy(input.payload), bytes, createdAt: this.clock.now().toISOString() };
    const list = this.checkpoints.get(input.claim.stepRunId) ?? [];
    list.push(checkpoint); this.checkpoints.set(input.claim.stepRunId, list);
    this.emit(input.claim.runId, 'checkpoint.written', { version: input.version, bytes }, input.claim.stepRunId, input.attemptId);
    return copy(checkpoint);
  }

  async readLatestCheckpoint(stepRunId: string): Promise<Checkpoint | null> {
    this.ensureAvailable();
    const list = this.checkpoints.get(stepRunId) ?? [];
    const value = list[list.length - 1];
    return value === undefined ? null : copy(value);
  }

  async getToolInvocation(toolName: string, operationKey: string): Promise<ToolInvocationRecord | null> {
    this.ensureAvailable();
    const value = this.toolInvocations.get(`${toolName}:${operationKey}`);
    return value === undefined ? null : copy(value);
  }

  async startToolInvocation(input: { runId: string; stepRunId: string; attemptId: string; toolName: string; operationKey: string; payload: JsonValue }): Promise<ToolInvocationRecord> {
    this.ensureAvailable();
    const key = `${input.toolName}:${input.operationKey}`;
    const existing = this.toolInvocations.get(key);
    if (existing !== undefined) return copy(existing);
    const record: ToolInvocationRecord = { id: createId('toolinv'), toolName: input.toolName, operationKey: input.operationKey, state: 'STARTED' };
    this.toolInvocations.set(key, record);
    this.emit(input.runId, 'tool.started', { tool: input.toolName, operationKey: input.operationKey }, input.stepRunId, input.attemptId);
    return copy(record);
  }

  async completeToolInvocation(id: string, output: JsonValue): Promise<void> {
    this.ensureAvailable();
    const entry = [...this.toolInvocations.entries()].find(([, value]) => value.id === id);
    if (entry === undefined) throw new AgentForgeError({ code: 'TOOL_INVOCATION_NOT_FOUND', category: 'PERSISTENCE', message: 'Tool invocation not found' });
    entry[1].state = 'COMPLETED'; entry[1].output = copy(output); delete entry[1].error;
  }

  async failToolInvocation(id: string, error: SerializedAgentForgeError): Promise<void> {
    this.ensureAvailable();
    const entry = [...this.toolInvocations.entries()].find(([, value]) => value.id === id);
    if (entry === undefined) throw new AgentForgeError({ code: 'TOOL_INVOCATION_NOT_FOUND', category: 'PERSISTENCE', message: 'Tool invocation not found' });
    entry[1].state = 'FAILED'; entry[1].error = copy(error);
  }

  async recoverExpiredLeases(): Promise<number> {
    this.ensureAvailable();
    let count = 0;
    const now = this.clock.now().getTime();
    for (const queue of this.queues.values()) {
      if (queue.state !== 'LEASED' || queue.leaseExpiresAt === undefined || Date.parse(queue.leaseExpiresAt) > now) continue;
      const generation = queue.leaseGeneration;
      queue.state = 'READY'; delete queue.leaseOwner; delete queue.leaseExpiresAt;
      const step = this.steps.get(queue.stepRunId);
      if (step !== undefined && ['LEASED', 'RUNNING'].includes(step.state)) step.state = 'READY';
      for (const attempt of this.attempts.values()) {
        if (attempt.stepRunId === queue.stepRunId && attempt.generation === generation && attempt.state === 'RUNNING') {
          attempt.state = 'LEASE_LOST'; attempt.finishedAt = this.clock.now().toISOString();
          attempt.error = { name: 'AgentForgeError', code: 'LEASE_EXPIRED', category: 'LEASE_LOST', message: 'Lease expired before authoritative completion', retryable: true, httpStatus: 409 };
          this.emit(queue.runId, 'attempt.lease_lost', { generation }, queue.stepRunId, attempt.id);
        }
      }
      this.emit(queue.runId, 'lease.recovered', { generation }, queue.stepRunId);
      count += 1;
    }
    return count;
  }

  snapshot(): {
    runs: WorkflowRun[];
    steps: StepRun[];
    queues: QueueTask[];
    attempts: Attempt[];
    events: ExecutionEvent[];
  } {
    return {
      runs: [...this.runs.values()].map((run) => { const { nextEventSeq: _seq, ...publicRun } = run; return copy(publicRun); }),
      steps: [...this.steps.values()].map(copy),
      queues: [...this.queues.values()].map(copy),
      attempts: [...this.attempts.values()].map(copy),
      events: [...this.events.values()].flat().map(copy),
    };
  }
}
