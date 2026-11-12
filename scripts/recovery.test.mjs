import test from 'node:test';
import assert from 'node:assert/strict';
import { Participant } from './recovery.mjs';
const success = text => ({ text, stopReason: 'end_turn' });
function harness(plans, options = {}) {
  const created = [], attempts = [];
  const participant = new Participant({ id: 'fake', onAttempt: attempt => attempts.push(attempt), ...options,
    factory(transport, { history }) {
      const plan = plans.shift(); assert.ok(plan, 'recovery exceeded its lifetime budget');
      const record = { transport, history, prompts: [], closed: false }; created.push(record);
      return { async start() { if (plan.startError) throw new Error(plan.startError); },
        async ask(prompt) { record.prompts.push(prompt); const result = plan.turns.shift(); if (result instanceof Error) throw result; return result; },
        async close() { record.closed = true; } };
    } });
  return { participant, created, attempts };
}
test('one native recovery preserves completed history and excludes partial replies', async () => {
  const partial = Object.assign(new Error('crash'), { partialText: 'INCOMPLETE' });
  const h = harness([{ turns: [success('accepted'), partial] }, { turns: [success('recovered'), new Error('again')] }]);
  await h.participant.ask('completed', 100); await h.participant.ask('interrupted', 100);
  assert.deepEqual(h.created[1].history, [{ prompt: 'completed', reply: 'accepted' }]);
  assert.deepEqual(h.created[1].prompts, ['interrupted']);
  assert.deepEqual(h.participant.history, [{ prompt: 'completed', reply: 'accepted' }, { prompt: 'interrupted', reply: 'recovered' }]);
  await assert.rejects(h.participant.ask('later', 100), /dropped/);
  assert.equal(h.created.length, 2); assert.equal(h.participant.state.failedAttempts, 2);
  assert.ok(h.created.every(agent => agent.closed));
});
test('startup failures share the same one-retry lifetime budget', async () => {
  const h = harness([{ startError: 'initial' }, { startError: 'retry' }]);
  await assert.rejects(h.participant.start(), /dropped/);
  assert.equal(h.created.length, 2); assert.equal(h.participant.state.failedTurns, 0);
  assert.ok(h.attempts.every(attempt => attempt.phase === 'startup'));
});
test('nonterminal response triggers recovery without committing partial history', async () => {
  const h = harness([{ turns: [{ text: 'partial', stopReason: 'max_tokens' }] }, { turns: [success('complete')] }]);
  assert.equal((await h.participant.ask('task', 100)).text, 'complete');
  assert.equal(h.attempts[0].stopReason, 'max_tokens');
  assert.deepEqual(h.participant.history, [{ prompt: 'task', reply: 'complete' }]);
});
test('abort prevents replacement', async () => {
  const controller = new AbortController();
  const h = harness([{ turns: [new Error('crash')] }], { signal: controller.signal, onAttempt() { controller.abort(new Error('user cancelled')); } });
  await assert.rejects(h.participant.ask('task', 100), /user cancelled/);
  assert.equal(h.created.length, 1); assert.equal(h.created[0].closed, true);
});
test('cleanup failure retains ownership and blocks replacement', async () => {
  let created = 0, closes = 0;
  const p = new Participant({ id: 'unsafe', factory() {
    created++; return { async start() {}, async ask() { throw new Error('crash'); }, async close() { closes++; throw new Error('cannot terminate'); } };
  } });
  await assert.rejects(p.ask('task', 100), /cannot terminate/);
  assert.equal(created, 1); assert.equal(p.state.dropped, true);
  await assert.rejects(p.close(), /cleanup failed/); assert.equal(closes, 2);
});
