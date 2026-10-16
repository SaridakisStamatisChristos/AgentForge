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
