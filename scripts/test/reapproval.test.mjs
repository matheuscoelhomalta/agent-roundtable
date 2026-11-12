import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { run, reviewSynthesis } from '../roundtable.mjs';
import { HeadlessAgent } from '../headless.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, '..', 'roundtable.mjs');
const IDS = ['claude', 'gemini', 'codex'];
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const logs = (s, id) => read(join(s.dir, `${id}.jsonl`)).trim().split('\n').map(JSON.parse);
async function until(predicate) {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for fixture');
}

async function setup({ plan = 'ok', goal = 'explore' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-review-'));
  const target = join(dir, 'target'); mkdirSync(target);
  const registry = Object.fromEntries(IDS.map(id => {
    const argv = [process.execPath, join(HERE, 'fake-cli.mjs'), '--name', id,
      '--state', join(dir, `${id}.n`), '--log', join(dir, `${id}.jsonl`),
      '--plan', `ok,ok,ok,object,${plan}`];
    return [id, { label: id, headless: { start: argv, resume: [...argv, '--resume', '{session}'], input: 'stdin', output: 'json' } }];
  }));
  const registryPath = join(dir, 'agents.json'); writeFileSync(registryPath, JSON.stringify(registry));
  const brief = join(dir, 'brief.md'); writeFileSync(brief, 'Compare fixture options.');
  const runDir = join(dir, 'run');
  const controller = new AbortController();
  const pending = run({ brief, 'run-dir': runDir, cwd: target, registry: registryPath,
    goal, rounds: '3', 'turn-timeout': '2', 'kill-grace': '0.1', 'wait-timeout': '5' }, { signal: controller.signal })
    .then(state => ({ state }), error => ({ error }));
  try {
    await until(() => existsSync(join(runDir, 'state.json')) && json(join(runDir, 'state.json')).status === 'awaiting_synthesis');
    writeFileSync(join(runDir, 'synthesis.md'), 'Original synthesis.');
    const result = await pending;
    assert.ifError(result.error);
    assert.equal(result.state.review, 'objected');
    const corrected = join(dir, 'corrected.md'); writeFileSync(corrected, 'Corrected synthesis preserving the original veto.');
    return { dir, target, registryPath, runDir, corrected, state: result.state };
  } finally { controller.abort(); await pending; }
}
const options = s => ({ 'run-dir': s.runDir, synthesis: s.corrected, 'turn-timeout': '2', 'kill-grace': '0.1' });

test('explicit reapproval preserves history and resumes the same trio once without changing debate', async () => {
  const s = await setup();
  const names = ['state.json', 'result.json', 'synthesis.md', 'veto.json', ...IDS.flatMap(id => [`veto/${id}.md`, `veto/${id}.prompt.md`])];
  writeFileSync(join(s.runDir, 'final.md'), 'Previous host report.'); names.push('final.md');
  const originals = Object.fromEntries(names.map(name => [name, read(join(s.runDir, name))]));
  const rounds = Object.fromEntries(readdirSync(join(s.runDir, 'rounds')).map(name => [name, read(join(s.runDir, 'rounds', name))]));
  const result = spawnSync(process.execPath, [RUNNER, 'review-synthesis', '--run-dir', s.runDir, '--synthesis', s.corrected], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'done', review: 'approved', reviewRevision: 1, deliveryComplete: true });
  const state = json(join(s.runDir, 'state.json'));
  for (const key of ['round', 'rounds', 'turns', 'outcome', 'result', 'registryProvenance']) assert.deepEqual(state[key], s.state[key]);
  for (const [name, text] of Object.entries(originals)) assert.equal(read(join(s.runDir, 'reviews', '0', name)), text);
  for (const [name, text] of Object.entries(rounds)) assert.equal(read(join(s.runDir, 'rounds', name)), text);
  assert.equal(existsSync(join(s.runDir, 'final.md')), false, 'obsolete host report archived');
  assert.equal(read(join(s.runDir, 'synthesis.md')), read(s.corrected));
  assert.equal(json(join(s.runDir, 'result.json')).deliveryComplete, true);
  for (const id of IDS) {
    const turns = logs(s, id);
    assert.equal(turns.length, 5);
    assert.equal(turns[4].resume, s.state.agents[id].nativeSessionId);
    assert.deepEqual(turns[4].argv, turns[3].argv, 'same resume adapter and flags');
    assert.match(turns[4].prompt, /previousVotes.*Preserve the original veto/);
    assert.match(turns[4].prompt, /Do not run shell commands or read\/write files/);
    for (const peer of IDS) assert.ok(turns[4].prompt.includes(read(join(s.runDir, 'rounds', `r3-${peer}.md`)).trim()));
    assert.equal(state.agents[id].nativeSessionId, s.state.agents[id].nativeSessionId);
    assert.throws(() => process.kill(turns[4].pid, 0), { code: 'ESRCH' });
  }
  assert.equal(existsSync(join(s.runDir, '.review.lock')), false);
});

test('a second rejection stops; only a new explicit call can submit another revision', async () => {
  const s = await setup({ plan: 'object,ok' });
  const first = await reviewSynthesis(options(s));
  assert.equal(first.review, 'objected'); assert.equal(first.deliveryComplete, false);
  for (const id of IDS) assert.equal(logs(s, id).length, 5);
  const rejected = read(join(s.runDir, 'state.json'));
  writeFileSync(s.corrected, 'Second corrected synthesis.');
  const second = await reviewSynthesis(options(s));
  assert.equal(second.reviewRevision, 2); assert.equal(second.deliveryComplete, true);
  assert.equal(read(join(s.runDir, 'reviews', '1', 'state.json')), rejected);
  assert.equal(read(join(s.runDir, 'reviews', '0', 'synthesis.md')), 'Original synthesis.');
  for (const id of IDS) assert.equal(logs(s, id).length, 6);
  await assert.rejects(reviewSynthesis(options(s)), /Only a finished run/);
});

test('malformed review cannot approve delivery and CLI exits nonzero without retrying', async () => {
  const s = await setup({ plan: 'invalid-status,ok' });
  const result = spawnSync(process.execPath, [RUNNER, 'review-synthesis', '--run-dir', s.runDir, '--synthesis', s.corrected], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1, result.stderr);
  const state = json(join(s.runDir, 'state.json'));
  assert.equal(state.status, 'done');
  assert.equal(state.review, 'missing'); assert.equal(state.deliveryComplete, false);
  assert.ok(state.veto.every(vote => !vote.parsed));
  for (const id of IDS) assert.equal(logs(s, id).length, 5);
  assert.equal((await reviewSynthesis(options(s))).deliveryComplete, true, 'missing review can be explicitly resubmitted');
  assert.equal(read(join(s.runDir, 'reviews', '1', 'veto', 'codex.md')), 'No status');
});

for (const plan of ['fail', 'wrong-session', 'hang']) {
  test(`resume ${plan} fails closed with no substitute sessions`, async () => {
    const s = await setup({ plan });
    await assert.rejects(reviewSynthesis({ ...options(s), 'turn-timeout': '0.3' }));
    const state = json(join(s.runDir, 'state.json'));
    assert.equal(state.status, 'failed'); assert.equal(state.review, 'missing'); assert.equal(state.deliveryComplete, false);
    for (const id of IDS) {
      const turns = logs(s, id);
      assert.equal(turns.length, 5);
      assert.equal(turns[4].resume, s.state.agents[id].nativeSessionId);
      assert.equal(state.agents[id].nativeSessionId, null);
      const failure = state.veto.find(vote => vote.agent === id);
      assert.ok(failure.error);
      if (plan === 'wrong-session') assert.match(failure.partialText, /wrong-native-session/);
      assert.throws(() => process.kill(turns[4].pid, 0), { code: 'ESRCH' });
    }
    assert.equal(existsSync(join(s.runDir, '.review.lock')), false);
    assert.equal(read(join(s.runDir, 'reviews', '0', 'synthesis.md')), 'Original synthesis.');
  });
}

test('preflight guards reject changed adapters, sessions, cwd, draft or active state before any model call', async () => {
  const s = await setup();
  const statePath = join(s.runDir, 'state.json'), original = read(statePath), registry = read(s.registryPath);
  const cases = [
    [() => writeFileSync(s.registryPath, registry.replace('claude', 'different')), {}, /Registry changed/],
    [() => { const state = JSON.parse(original); state.agents.codex.nativeSessionId = null; writeFileSync(statePath, JSON.stringify(state)); }, {}, /no healthy native session/],
    [() => { const state = JSON.parse(original); state.status = 'veto'; writeFileSync(statePath, JSON.stringify(state)); }, {}, /Only a finished run/],
    [() => {}, { cwd: s.dir }, /working directory/],
    [() => {}, { synthesis: join(s.runDir, 'synthesis.md') }, /separate corrected/],
    [() => symlinkSync(join(s.runDir, 'synthesis.md'), join(s.dir, 'alias.md')), { synthesis: join(s.dir, 'alias.md') }, /separate corrected/],
    [() => writeFileSync(join(s.runDir, 'synthesis.md'), 'Tampered'), {}, /changed since its review/],
    [() => writeFileSync(s.corrected, '  '), {}, /must not be empty/],
  ];
  for (const [mutate, overrides, error] of cases) {
    writeFileSync(statePath, original); writeFileSync(s.registryPath, registry);
    writeFileSync(join(s.runDir, 'synthesis.md'), 'Original synthesis.');
    mutate();
    const before = read(statePath), result = read(join(s.runDir, 'result.json'));
    await assert.rejects(reviewSynthesis({ ...options(s), ...overrides }), error);
    assert.equal(read(statePath), before); assert.equal(read(join(s.runDir, 'result.json')), result);
    assert.equal(existsSync(join(s.runDir, 'reviews')), false);
    assert.equal(existsSync(join(s.runDir, '.review.lock')), false);
    for (const id of IDS) assert.equal(logs(s, id).length, 4);
  }
});

test('concurrent submission is locked and pending review never reports delivery complete', async () => {
  const s = await setup({ plan: 'slow' });
  const pending = reviewSynthesis(options(s));
  await until(() => IDS.every(id => logs(s, id).length === 5));
  try {
    const current = json(join(s.runDir, 'result.json'));
    assert.equal(current.review, 'pending'); assert.equal(current.deliveryComplete, false);
    await assert.rejects(reviewSynthesis(options(s)), /review is active/);
    assert.equal((await pending).deliveryComplete, true);
    for (const id of IDS) assert.equal(logs(s, id).length, 5);
  } finally { await pending; }
});

test('interrupt preserves votes and stops owned processes before releasing the review lock', async () => {
  const s = await setup({ plan: 'hang' });
  const controller = new AbortController();
  const pending = reviewSynthesis(options(s), { signal: controller.signal });
  const rejection = assert.rejects(pending, /fixture interruption/);
  try {
    await until(() => IDS.every(id => logs(s, id).length === 5));
    controller.abort(new Error('fixture interruption'));
    await rejection;
    const state = json(join(s.runDir, 'state.json'));
    assert.equal(state.status, 'interrupted'); assert.equal(state.deliveryComplete, false);
    assert.deepEqual(json(join(s.runDir, 'veto.json')), state.veto);
    for (const id of IDS) assert.throws(() => process.kill(logs(s, id)[4].pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(join(s.runDir, '.review.lock')), false);
  } finally { controller.abort(); await rejection; }
});

test('changed draft during review invalidates all approvals', async () => {
  const s = await setup({ plan: 'slow' });
  const pending = reviewSynthesis(options(s));
  const rejection = assert.rejects(pending, /Synthesis changed during/);
  await until(() => IDS.every(id => logs(s, id).length === 5));
  writeFileSync(join(s.runDir, 'synthesis.md'), 'Another unreviewed draft');
  await rejection;
  const state = json(join(s.runDir, 'state.json'));
  assert.equal(state.review, 'missing'); assert.equal(state.deliveryComplete, false);
});

test('cleanup failure invalidates approval and retains the lock instead of permitting overlap', async () => {
  const s = await setup();
  const close = HeadlessAgent.prototype.close;
  // Stop real fixture processes, then inject a cleanup error without leaking them.
  HeadlessAgent.prototype.close = async function () { await close.call(this); throw new Error('fixture cleanup failure'); };
  try { await assert.rejects(reviewSynthesis(options(s)), /cleanup failed/); }
  finally { HeadlessAgent.prototype.close = close; }
  const state = json(join(s.runDir, 'state.json'));
  assert.equal(state.status, 'failed'); assert.equal(state.review, 'missing'); assert.equal(state.deliveryComplete, false);
  assert.equal(existsSync(join(s.runDir, '.review.lock')), true);
  await assert.rejects(reviewSynthesis(options(s)), /review is active/);
  for (const id of IDS) {
    const turns = logs(s, id); assert.equal(turns.length, 5);
    assert.throws(() => process.kill(turns[4].pid, 0), { code: 'ESRCH' });
  }
});

test('fidelity approval cannot complete an incomplete debate', async () => {
  const s = await setup({ goal: 'audit' });
  assert.equal(s.state.outcome.complete, false);
  const state = await reviewSynthesis(options(s));
  assert.equal(state.review, 'approved'); assert.equal(state.deliveryComplete, false);
  assert.deepEqual(state.outcome, s.state.outcome);
});

test('older runs require explicit original cwd and archive their original records unchanged', async () => {
  const s = await setup();
  const path = join(s.runDir, 'state.json'), state = json(path);
  for (const key of ['cwd', 'reviewRevision', 'synthesisSha256']) delete state[key];
  writeFileSync(path, JSON.stringify(state));
  const original = read(path);
  await assert.rejects(reviewSynthesis(options(s)), /Older run: supply --cwd/);
  const updated = await reviewSynthesis({ ...options(s), cwd: s.target });
  assert.equal(updated.deliveryComplete, true); assert.equal(updated.cwd, s.target);
  assert.equal(read(join(s.runDir, 'reviews', '0', 'state.json')), original);
});
