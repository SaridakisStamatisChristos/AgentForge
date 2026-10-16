import { AgentForgeError, type ExecutionEvent } from '@agentforge/contracts';

export function assertMonotonicEvents(events: readonly ExecutionEvent[]): void {
  let previous = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || event.sequence <= previous) {
      throw new AgentForgeError({
        code: 'EVENT_ORDER_VIOLATION',
        category: 'INTERNAL_INVARIANT',
        message: `Event sequence ${event.sequence} is not strictly greater than ${previous}`,
      });
    }
    previous = event.sequence;
  }
}

export function nextCursor(events: readonly ExecutionEvent[]): number | undefined {
  return events.length === 0 ? undefined : events[events.length - 1]?.sequence;
}

export interface EventSource {
  listEvents(runId: string, options?: { after?: number; limit?: number }): Promise<ExecutionEvent[]>;
}

export interface EventSink {
  readonly name: string;
  deliver(runId: string, events: readonly ExecutionEvent[]): Promise<void>;
}

export async function pumpEvents(
  source: EventSource,
  sink: EventSink,
  runId: string,
  options: { after?: number; batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  let cursor = options.after ?? 0;
  const batchSize = options.batchSize ?? 100;
  const maxBatches = options.maxBatches ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new AgentForgeError({ code: 'INVALID_EVENT_BATCH_SIZE', category: 'VALIDATION', message: 'Event sink batchSize must be in [1,500]' });
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10_000) {
    throw new AgentForgeError({ code: 'INVALID_EVENT_BATCH_LIMIT', category: 'VALIDATION', message: 'Event sink maxBatches must be in [1,10000]' });
  }
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const events = await source.listEvents(runId, { after: cursor, limit: batchSize });
    if (events.length === 0) return cursor;
    assertMonotonicEvents(events);
    if ((events[0]?.sequence ?? 0) <= cursor) {
      throw new AgentForgeError({ code: 'EVENT_CURSOR_REGRESSION', category: 'INTERNAL_INVARIANT', message: `Event source returned sequence at or before cursor ${cursor}` });
    }
    await sink.deliver(runId, events);
    cursor = nextCursor(events) ?? cursor;
    if (events.length < batchSize) return cursor;
  }
  throw new AgentForgeError({ code: 'EVENT_SINK_DRAIN_LIMIT', category: 'DEPENDENCY', message: `Event sink ${sink.name} exceeded bounded drain batches`, retryable: true });
}
