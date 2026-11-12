import test from 'node:test';
import assert from 'node:assert/strict';
import { assessOutcome } from './outcomes.mjs';
import { parseStatus, openingPrompt } from './prompts.mjs';

const claim = (changes = {}) => ({ id: 'A-1', statement: 'Option A reduces latency', status: 'supported', evidence: ['benchmark.txt:2'], ...changes });
const status = (agent, changes = {}) => ({ agent, parsed: true, stance: 'open', blocking: ['A-1'],
  resolved: [], new_issues: [], outcome: 'complete', claims: [claim()], ...changes });
const context = (goal) => ({ goal, round: 3, minRounds: 2, expectedAgents: ['a', 'b'] });

test('usable exploration completes while preserving dissent', () => {
  const verdict = assessOutcome([status('a'), status('b')], context('explore'));
  assert.equal(verdict.complete, true);
  assert.equal(verdict.consensus, false);
});
test('decision needs references for supported claims', () => {
  const verdict = assessOutcome([status('a', { claims: [claim({ evidence: [] })] }), status('b')], context('decide'));
  assert.equal(verdict.complete, false);
});
test('audit permits explicit uncertainty with a bounded verification step', () => {
  const unresolved = claim({ status: 'unverified', evidence: [], next_step: 'Run the empty-input test' });
  assert.equal(assessOutcome([status('a', { claims: [unresolved] }), status('b')], context('audit')).complete, true);
  delete unresolved.next_step;
  assert.equal(assessOutcome([status('a', { claims: [unresolved] }), status('b')], context('audit')).complete, false);
});
test('reported agreement without claims cannot complete a decision', () => {
  const votes = ['a', 'b'].map(agent => status(agent, { stance: 'converged', blocking: [], claims: [] }));
  assert.equal(assessOutcome(votes, context('decide')).complete, false);
});
test('missing participant or minimum rounds cannot complete', () => {
  assert.equal(assessOutcome([status('a')], context('explore')).complete, false);
  assert.equal(assessOutcome([status('a'), status('b')], { ...context('explore'), minRounds: 4 }).complete, false);
});
test('malformed or duplicate claims fail status validation', () => {
  const parse = value => parseStatus('```roundtable-status\n' + JSON.stringify(value) + '\n```');
  assert.equal(parse(status('a')).parsed, true);
  assert.equal(parse(status('a', { claims: [claim(), claim()] })).parsed, false);
  assert.equal(parse(status('a', { claims: [claim({ evidence: [''] })] })).parsed, false);
});
test('exploration opening does not demand a software audit', () => {
  assert.doesNotMatch(openingPrompt({ brief: 'Explore an idea', prefix: 'A', goal: 'explore' }), /numbered findings with severity/);
  assert.match(openingPrompt({ brief: 'Audit a module', prefix: 'A', goal: 'audit' }), /numbered findings with severity/);
});
