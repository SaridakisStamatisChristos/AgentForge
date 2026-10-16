import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentForgeError, STEP_RUN_STATES, WORKFLOW_RUN_STATES } from '@agentforge/contracts';
import {
  assertRunTransition,
  assertStepTransition,
  computeRetryDelayMs,
  TERMINAL_RUN_STATES,
  TERMINAL_STEP_STATES,
} from '@agentforge/core';
import { buildWorkflowGraph, validateWorkflowDefinition } from '@agentforge/workflows';

test('terminal run and step states are immutable under every candidate transition', () => {
  for (const from of TERMINAL_RUN_STATES) {
    for (const to of WORKFLOW_RUN_STATES) assert.throws(() => assertRunTransition(from, to), AgentForgeError);
  }
  for (const from of TERMINAL_STEP_STATES) {
    for (const to of STEP_RUN_STATES) assert.throws(() => assertStepTransition(from, to), AgentForgeError);
  }
});

test('documented active state transitions remain legal', () => {
  assertRunTransition('QUEUED', 'RUNNING');
  assertRunTransition('RUNNING', 'WAITING');
  assertRunTransition('WAITING', 'RUNNING');
  assertRunTransition('CANCELLING', 'CANCELLED');
  assertStepTransition('READY', 'LEASED');
  assertStepTransition('LEASED', 'RUNNING');
  assertStepTransition('RUNNING', 'RETRY_SCHEDULED');
  assertStepTransition('WAITING', 'READY');
});

test('workflow validator rejects empty, duplicate, missing and cyclic graphs', () => {
  assert.throws(() => validateWorkflowDefinition({ name: 'empty', steps: [] }), /1\.\.1000/);
  assert.throws(() => validateWorkflowDefinition({ name: 'duplicate', steps: [
    { id: 'x', kind: 'task', handler: 'echo' },
    { id: 'x', kind: 'task', handler: 'echo' },
  ] }), /Duplicate step id/);
  assert.throws(() => validateWorkflowDefinition({ name: 'missing', steps: [
    { id: 'x', kind: 'task', handler: 'echo', dependsOn: ['nope'] },
  ] }), /missing step/);
  assert.throws(() => validateWorkflowDefinition({ name: 'cycle', steps: [
    { id: 'a', kind: 'task', handler: 'echo', dependsOn: ['b'] },
    { id: 'b', kind: 'task', handler: 'echo', dependsOn: ['a'] },
  ] }), /cycle/i);
});

test('DAG topological model preserves fan-out and fan-in dependencies', () => {
  const workflow = validateWorkflowDefinition({
    name: 'diamond',
    steps: [
      { id: 'a', kind: 'task', handler: 'echo' },
      { id: 'b', kind: 'task', handler: 'echo', dependsOn: ['a'] },
      { id: 'c', kind: 'task', handler: 'echo', dependsOn: ['a'] },
      { id: 'd', kind: 'task', handler: 'echo', dependsOn: ['b', 'c'] },
    ],
  });
  const graph = buildWorkflowGraph(workflow);
  assert.deepEqual(graph.dependencies.get('d'), ['b', 'c']);
  assert.deepEqual(new Set(graph.dependents.get('a')), new Set(['b', 'c']));
  assert.ok((graph.order.indexOf('a') < graph.order.indexOf('b')) && (graph.order.indexOf('a') < graph.order.indexOf('c')));
  assert.ok(graph.order.indexOf('d') > graph.order.indexOf('b') && graph.order.indexOf('d') > graph.order.indexOf('c'));
});

test('retry schedule is bounded and deterministic with injected randomness', () => {
  const policy = { maxAttempts: 5, initialDelayMs: 100, backoffMultiplier: 2, maxDelayMs: 350, jitterRatio: 0.2 };
  assert.equal(computeRetryDelayMs(policy, 1, 0.5), 100);
  assert.equal(computeRetryDelayMs(policy, 2, 0.5), 200);
  assert.equal(computeRetryDelayMs(policy, 3, 0.5), 350);
  assert.equal(computeRetryDelayMs(policy, 3, 0), 280);
  assert.equal(computeRetryDelayMs(policy, 3, 1), 350);
});

test('numeric workflow policy rejects non-finite and unbounded values', () => {
  assert.throws(() => validateWorkflowDefinition({ name: 'bad-retry', steps: [{
    id: 'x', kind: 'task', handler: 'echo', retry: { maxAttempts: 2, initialDelayMs: 1, backoffMultiplier: Number.POSITIVE_INFINITY, maxDelayMs: 10 },
  }] }), /backoffMultiplier/);
  assert.throws(() => validateWorkflowDefinition({ name: 'bad-timeout', steps: [{ id: 'x', kind: 'task', handler: 'echo', timeout: { timeoutMs: 0 } }] }), /timeoutMs/);
  assert.throws(() => validateWorkflowDefinition({ name: 'bad-agent', steps: [{ id: 'x', kind: 'agent', provider: 'p', prompt: 'x', maxIterations: 101 }] }), /maxIterations/);
});
