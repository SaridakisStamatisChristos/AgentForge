import { PostgresStore } from '@agentforge/persistence';
import type { RuntimeStore } from '@agentforge/runtime';

export type ApiMetrics = {
  httpRequests: number;
  httpErrors: number;
  workflowsCreated: number;
  runsStarted: number;
  cancellationRequests: number;
  signalsAccepted: number;
  signalsDuplicate: number;
};

type DurableMetricRow = {
  runs_succeeded: number;
  runs_failed: number;
  runs_cancelled: number;
  steps_succeeded: number;
  steps_failed: number;
  steps_cancelled: number;
  attempts_total: number;
  retries_total: number;
  lease_recoveries_total: number;
  queue_ready_depth: number;
};

async function durableMetrics(store: RuntimeStore): Promise<DurableMetricRow | null> {
  if (!(store instanceof PostgresStore)) return null;
  const rows = await store.db.json<DurableMetricRow>(String.raw`
SELECT json_build_object(
  'runs_succeeded', (SELECT count(*)::integer FROM workflow_runs WHERE state = 'SUCCEEDED'),
  'runs_failed', (SELECT count(*)::integer FROM workflow_runs WHERE state = 'FAILED'),
  'runs_cancelled', (SELECT count(*)::integer FROM workflow_runs WHERE state = 'CANCELLED'),
  'steps_succeeded', (SELECT count(*)::integer FROM step_runs WHERE state = 'SUCCEEDED'),
  'steps_failed', (SELECT count(*)::integer FROM step_runs WHERE state = 'FAILED'),
  'steps_cancelled', (SELECT count(*)::integer FROM step_runs WHERE state = 'CANCELLED'),
  'attempts_total', (SELECT count(*)::integer FROM attempts),
  'retries_total', (SELECT COALESCE(sum(GREATEST(attempt_count - 1, 0)), 0)::integer FROM step_runs),
  'lease_recoveries_total', (SELECT count(*)::integer FROM execution_events WHERE type = 'lease.recovered'),
  'queue_ready_depth', (SELECT count(*)::integer FROM queue_tasks WHERE state IN ('READY','RETRY_SCHEDULED') AND available_at <= clock_timestamp())
)::text;
`);
  return rows[0] ?? null;
}

export async function prometheus(store: RuntimeStore, metrics: ApiMetrics): Promise<string> {
  const lines = [
    '# HELP agentforge_http_requests_total Total HTTP requests handled.',
    '# TYPE agentforge_http_requests_total counter',
    `agentforge_http_requests_total ${metrics.httpRequests}`,
    '# HELP agentforge_http_errors_total Total HTTP error responses.',
    '# TYPE agentforge_http_errors_total counter',
    `agentforge_http_errors_total ${metrics.httpErrors}`,
    '# HELP agentforge_workflows_created_total Total workflow versions created through the API.',
    '# TYPE agentforge_workflows_created_total counter',
    `agentforge_workflows_created_total ${metrics.workflowsCreated}`,
    '# HELP agentforge_runs_started_total Total workflow runs started through the API.',
    '# TYPE agentforge_runs_started_total counter',
    `agentforge_runs_started_total ${metrics.runsStarted}`,
    '# HELP agentforge_cancellation_requests_total Total cancellation requests.',
    '# TYPE agentforge_cancellation_requests_total counter',
    `agentforge_cancellation_requests_total ${metrics.cancellationRequests}`,
    '# HELP agentforge_signals_accepted_total Total accepted durable signals.',
    '# TYPE agentforge_signals_accepted_total counter',
    `agentforge_signals_accepted_total ${metrics.signalsAccepted}`,
    '# HELP agentforge_signals_duplicate_total Total deduplicated durable signals.',
    '# TYPE agentforge_signals_duplicate_total counter',
    `agentforge_signals_duplicate_total ${metrics.signalsDuplicate}`,
  ];

  const durable = await durableMetrics(store);
  if (durable !== null) {
    lines.push(
      '# HELP agentforge_runs_outcome_total Durable workflow run terminal outcomes.',
      '# TYPE agentforge_runs_outcome_total gauge',
      `agentforge_runs_outcome_total{state="SUCCEEDED"} ${Number(durable.runs_succeeded)}`,
      `agentforge_runs_outcome_total{state="FAILED"} ${Number(durable.runs_failed)}`,
      `agentforge_runs_outcome_total{state="CANCELLED"} ${Number(durable.runs_cancelled)}`,
      '# HELP agentforge_steps_outcome_total Durable step terminal outcomes.',
      '# TYPE agentforge_steps_outcome_total gauge',
      `agentforge_steps_outcome_total{state="SUCCEEDED"} ${Number(durable.steps_succeeded)}`,
      `agentforge_steps_outcome_total{state="FAILED"} ${Number(durable.steps_failed)}`,
      `agentforge_steps_outcome_total{state="CANCELLED"} ${Number(durable.steps_cancelled)}`,
      '# HELP agentforge_attempts_total Durable execution attempts.',
      '# TYPE agentforge_attempts_total gauge',
      `agentforge_attempts_total ${Number(durable.attempts_total)}`,
      '# HELP agentforge_retries_total Durable retries inferred from step attempt counts.',
      '# TYPE agentforge_retries_total gauge',
      `agentforge_retries_total ${Number(durable.retries_total)}`,
      '# HELP agentforge_lease_recoveries_total Durable lease recovery events.',
      '# TYPE agentforge_lease_recoveries_total gauge',
      `agentforge_lease_recoveries_total ${Number(durable.lease_recoveries_total)}`,
      '# HELP agentforge_queue_ready_depth Runnable durable queue depth.',
      '# TYPE agentforge_queue_ready_depth gauge',
      `agentforge_queue_ready_depth ${Number(durable.queue_ready_depth)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
