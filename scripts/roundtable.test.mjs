import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HeadlessAgent } from './headless.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { run, AGENTS, REGISTRY } from './roundtable.mjs';
import { atomicWrite } from './safeguards.mjs';

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'roundtable-run-test-'));
  const git = args => execFileSync('git', args, { cwd, stdio: 'ignore' });
  git(['init']); git(['config', 'user.email', 'test@localhost']); git(['config', 'user.name', 'test']);
  writeFileSync(join(cwd, 'target'), 'original'); git(['add', 'target']); git(['commit', '-m', 'fixture']);
  const runDir = join(cwd, 'run'); mkdirSync(runDir); const brief = join(runDir, 'brief.md'); writeFileSync(brief, 'Audit target');
  const registry = Object.fromEntries(AGENTS.map(id => [id, { label: id }]));
  return { cwd, runDir, registry, options: { cwd, brief, 'run-dir': runDir, rounds: '3', 'no-veto': true, 'wait-timeout': '2', 'turn-timeout': '1' } };
}
const answer = (stance = 'converged', blocking = []) => ({ text: 'Audit\n```roundtable-status\n' + JSON.stringify({ stance, blocking, new_issues: [], resolved: [] }) + '\n```', stopReason: 'end_turn' });
async function until(predicate, ms = 3000) { const deadline = Date.now() + ms; while (Date.now() < deadline) { if (predicate()) return; await delay(10); } throw new Error('test observer timed out'); }
const stateAt = s => JSON.parse(readFileSync(join(s.runDir, 'state.json'), 'utf8'));

test('run reports requested identity separately and records default, inline and file registry provenance', async () => {
  for (const kind of ['default', 'inline', 'file']) {
    const s = setup();
    s.registry.claude.model = 'requested-alias';
    const path = join(s.cwd, 'custom-agents.json');
    writeFileSync(path, JSON.stringify(s.registry, null, 2));
    const registry = kind === 'default' ? REGISTRY : s.registry;
    const options = kind === 'file' ? { ...s.options, registry: path } : s.options;
    const dependencies = { createAgent: () => ({ model: 'unconfirmed-alias',
      async start() {}, async ask() { return answer(); }, async close() {},
    }) };
    if (kind === 'inline') dependencies.registry = registry;
    const state = await run({ ...options, rounds: '1' }, dependencies);
    assert.deepEqual(state.registryProvenance, { kind,
      path: kind === 'default' ? fileURLToPath(new URL('../agents.json', import.meta.url)) : kind === 'file' ? path : null,
      sha256: createHash('sha256').update(JSON.stringify(registry)).digest('hex') });
    for (const id of AGENTS) {
      assert.equal(state.agents[id].requestedModel, registry[id].model ?? null);
      assert.equal(state.agents[id].effectiveModel, null);
      assert.equal(Object.hasOwn(state.agents[id], 'model'), false);
    }
    const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
    assert.deepEqual(result.registryProvenance, state.registryProvenance);
  }
});

test('registry provenance and requested models describe the loaded snapshot even if the caller mutates its object', async () => {
  const s = setup();
  for (const id of AGENTS) s.registry[id].model = 'requested-before-start';
  const sha256 = createHash('sha256').update(JSON.stringify(s.registry)).digest('hex');
  const state = await run({ ...s.options, rounds: '1' }, { registry: s.registry, createAgent(id) {
    s.registry[id].model = 'changed-after-load';
    return { async start() {}, async ask() { return answer(); }, async close() {} };
  } });
  assert.equal(state.registryProvenance.sha256, sha256);
  assert.ok(AGENTS.every(id => state.agents[id].requestedModel === 'requested-before-start'));
});

test('runner completes rounds and veto, exposes peer positions, atomic outputs do not trip edit guard', async () => {
  const s = setup(); let vetoPrompt; let closes = 0;
  const work = run({ ...s.options, 'no-veto': false }, { registry: s.registry, createAgent(id) { return {
    async start() {}, async ask(prompt) { if (prompt.includes('final review')) vetoPrompt = prompt; return answer(); }, async close() { closes++; },
  }; } });
  await until(() => existsSync(join(s.runDir, 'state.json')) && stateAt(s).status === 'awaiting_synthesis');
  atomicWrite(join(s.runDir, 'synthesis.md'), 'Complete synthesis');
  const state = await work;
  assert.equal(state.status, 'done'); assert.equal(state.result, 'consensus'); assert.match(state.stopReason, /^consensus:/);
  assert.ok(vetoPrompt.includes('finalPositions')); assert.ok(vetoPrompt.includes('"agent":"claude"')); assert.ok(vetoPrompt.includes('"round":3'));
  assert.ok(state.veto.every(vote => vote.approve)); assert.equal(closes, 3);
  assert.equal(state.review, 'approved'); assert.equal(state.deliveryComplete, true);
  const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
  assert.equal(result.review, 'approved'); assert.equal(result.deliveryComplete, true);
  assert.ok(!state.warnings.some(w => w.includes('content changed')));
  assert.equal(state.editDetection.checks.at(-1).phase, 'after veto/cleanup');
  assert.ok(stateAt(s).finishedAt);
});

test('veto edits detected after cleanup and non-end_turn cannot approve', async () => {
  const s = setup();
  const work = run({ ...s.options, 'no-veto': false }, { registry: s.registry, createAgent(id) { return {
    async start() {}, async ask(prompt) {
      if (prompt.includes('final review')) { writeFileSync(join(s.cwd, 'target'), 'changed by veto'); if (id === 'claude') return { ...answer(), stopReason: 'cancelled' }; }
      return answer();
    }, async close() {},
  }; } });
  await until(() => existsSync(join(s.runDir, 'state.json')) && stateAt(s).status === 'awaiting_synthesis');
  atomicWrite(join(s.runDir, 'synthesis.md'), 'Draft');
  await assert.rejects(work, /fewer than the required agents remain after veto/);
  assert.equal(stateAt(s).veto.find(v => v.agent === 'claude').approve, null);
  assert.equal(stateAt(s).review, 'missing'); assert.equal(stateAt(s).deliveryComplete, false);
  assert.ok(stateAt(s).warnings.some(w => w.includes('content changed')));
});

test('abort interrupts synthesis wait, records interrupted state and closes agents', async () => {
  const s = setup(); const controller = new AbortController(); let closed = 0;
  const work = run({ ...s.options, 'no-veto': false }, { registry: s.registry, signal: controller.signal, createAgent() { return {
    async start() {}, async ask() { return answer(); }, async close() { closed++; },
  }; } });
  await until(() => existsSync(join(s.runDir, 'state.json')) && stateAt(s).status === 'awaiting_synthesis');
  controller.abort(new Error('test abort'));
  await assert.rejects(work, /abort/i); assert.equal(stateAt(s).status, 'interrupted'); assert.ok(closed >= 3);
  assert.equal(stateAt(s).review, 'missing'); assert.equal(stateAt(s).deliveryComplete, false);
});

test('fresh-run rejection happens before spawning or overwriting state', async () => {
  const s = setup(); const prior = '{"prior":true}'; writeFileSync(join(s.runDir, 'state.json'), prior); let created = false;
  await assert.rejects(run(s.options, { registry: s.registry, createAgent() { created = true; } }), /already used/);
  assert.equal(created, false); assert.equal(readFileSync(join(s.runDir, 'state.json'), 'utf8'), prior);
});


test('missing required synthesis cannot mark delivery complete even after debate consensus', async () => {
  const s = setup();
  const state = await run({ ...s.options, 'no-veto': false, 'wait-timeout': '0.01' }, {
    registry: s.registry, createAgent: () => ({ async start() {}, async ask() { return answer(); }, async close() {} }),
  });
  assert.equal(state.result, 'consensus');
  assert.equal(state.review, 'missing'); assert.equal(state.deliveryComplete, false);
  assert.ok(state.warnings.some(w => w.includes('required review missing')));
  const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
  assert.equal(result.review, 'missing'); assert.equal(result.deliveryComplete, false);
  assert.equal(result.outcome.complete, true);
});

for (const [kind, review] of [['rejected', 'objected'], ['invalid', 'missing']]) {
  test(`${kind} draft review preserves debate consensus without completing delivery`, async () => {
    const s = setup();
    const work = run({ ...s.options, 'no-veto': false }, { registry: s.registry, createAgent: () => ({
      async start() {}, async ask(prompt) {
        if (!prompt.includes('final review')) return answer();
        return kind === 'invalid' ? { text: 'No structured review', stopReason: 'end_turn' }
          : answer('open', ['A-1: the draft omits my objection']);
      }, async close() {},
    }) });
    await until(() => existsSync(join(s.runDir, 'state.json')) && stateAt(s).status === 'awaiting_synthesis');
    atomicWrite(join(s.runDir, 'synthesis.md'), 'Draft');
    const state = await work;
    assert.equal(state.result, 'consensus'); assert.equal(state.review, review);
    assert.equal(state.deliveryComplete, false);
    const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
    assert.equal(result.review, review); assert.equal(result.deliveryComplete, false);
  });
}

test('explicitly skipped review completes a usable transcript, not an incomplete debate', async () => {
  for (const [stance, complete] of [['converged', true], ['open', false]]) {
    const s = setup();
    const state = await run(s.options, { registry: s.registry, createAgent: () => ({
      async start() {}, async ask() { return answer(stance); }, async close() {},
    }) });
    assert.equal(state.review, 'skipped'); assert.equal(state.deliveryComplete, complete);
    assert.equal(JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8')).deliveryComplete, complete);
  }
});

test('faithful draft can be approved after a completed audit with substantive dissent', async () => {
  const s = setup();
  const dissent = { text: 'Audit\n```roundtable-status\n' + JSON.stringify({ stance: 'open', blocking: ['A-1: disagree'],
    outcome: 'complete', claims: [{ id: 'A-1', statement: 'Keep this disagreement', status: 'disputed', evidence: [], next_step: 'Run the bounded check' }] }) + '\n```', stopReason: 'end_turn' };
  const work = run({ ...s.options, goal: 'audit', 'no-veto': false }, { registry: s.registry, createAgent: () => ({
    async start() {}, async ask(prompt) { return prompt.includes('final review') ? answer() : dissent; }, async close() {},
  }) });
  await until(() => existsSync(join(s.runDir, 'state.json')) && stateAt(s).status === 'awaiting_synthesis');
  atomicWrite(join(s.runDir, 'synthesis.md'), 'The participants disagree; bounded check remains pending.');
  const state = await work;
  assert.equal(state.result, 'completed_with_disagreement');
  assert.equal(state.review, 'approved'); assert.equal(state.deliveryComplete, true);
});


test('dropping one required participant fails and closes all owned agents', async () => {
  const s = setup(); const closed = [];
  await assert.rejects(run(s.options, { registry: s.registry, createAgent(id) { return {
    async start() {}, async ask() { if (id === 'claude') throw new Error('dead'); return answer(); }, async close() { closed.push(id); },
  }; } }), /fewer than the required/);
  const state = stateAt(s);
  assert.equal(state.status, 'failed'); assert.equal(state.deliveryComplete, false);
  assert.equal(state.agents.claude.failedAttempts, 2);
  assert.ok(AGENTS.every(id => closed.includes(id)));
});

test('default registry blocks shell, file writes, external integrations and approvals on start and resume', () => {
  assert.deepEqual(Object.keys(REGISTRY), AGENTS);
  for (const phase of ['start', 'resume']) {
    const claude = REGISTRY.claude.headless[phase];
    assert.equal(claude[claude.indexOf('--tools') + 1], '');
    for (const flag of ['--safe-mode', '--restricted', '--strict-mcp-config']) assert.ok(claude.includes(flag));
    assert.equal(claude[claude.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    const codex = REGISTRY.codex.headless[phase];
    assert.ok(codex.includes('approval_policy="never"'));
    assert.ok(codex.includes('--ignore-user-config'));
    assert.ok(codex.includes('--ignore-rules'));
    for (const flag of ['shell_tool', 'shell_snapshot', 'code_mode_host', 'code_mode', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent']) {
      assert.ok(codex.some((value, i) => value === '--disable' && codex[i + 1] === flag));
    }
    assert.ok(codex.includes('read-only') || codex.includes('sandbox_mode="read-only"'));
    const gemini = REGISTRY.gemini.headless[phase];
    assert.equal(gemini[gemini.indexOf('--settings') + 1], '{skill}/gemini-permissions.json');
    assert.ok(gemini.includes('--disable-slash-commands'));
  }
  const policy = JSON.parse(readFileSync(new URL('../gemini-permissions.json', import.meta.url), 'utf8'));
  assert.equal(policy.toolPermission, 'strict');
  assert.deepEqual(policy.permissions.allow, []);
  for (const rule of ['command(*)', 'unsandboxed(*)', 'write_file(*)', 'mcp(*)', 'read_file(*)', 'read_url(*)', 'execute_url(*)']) assert.ok(policy.permissions.deny.includes(rule));
});

for (const name of ['SIGINT', 'SIGTERM']) test(`CLI ${name} closes native subprocesses without recovery`, { timeout: 8000 }, async t => {
  const s = setup();
  const runnerUrl = new URL('./roundtable.mjs', import.meta.url).href;
  const headlessUrl = new URL('./headless.mjs', import.meta.url).href;
  const pidPath = join(s.runDir, 'agent-pids.txt');
  const fixture = `require('fs').appendFileSync(${JSON.stringify(pidPath)},String(process.pid)+',');process.stdin.resume();process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const registry = Object.fromEntries(AGENTS.map(id => [id, { headless: {
    start: [process.execPath, '-e', fixture], resume: [process.execPath, '-e', fixture, '{session}'], output: 'json',
  } }]));
  const argv = ['run', '--brief', s.options.brief, '--run-dir', s.runDir, '--cwd', s.cwd, '--no-veto'];
  const code = `import {main} from ${JSON.stringify(runnerUrl)}; import {HeadlessAgent} from ${JSON.stringify(headlessUrl)};
    try { await main(${JSON.stringify(argv)}, {registry:${JSON.stringify(registry)}, createAgent(id) {
      return new HeadlessAgent(id,${JSON.stringify(registry)}[id],${JSON.stringify(s.cwd)},()=>{},{graceMs:30});
    }}); } catch(e) { process.exitCode=1; }`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  await until(() => existsSync(pidPath) && readFileSync(pidPath, 'utf8').split(',').filter(Boolean).length === 3);
  child.kill(name);
  const exit = await done;
  assert.equal(exit.code, 1, stderr); assert.equal(exit.signal, null);
  const state = stateAt(s);
  assert.equal(state.status, 'interrupted'); assert.equal(state.agents.claude.failedAttempts, 0);
  for (const pid of readFileSync(pidPath, 'utf8').split(',').filter(Boolean).map(Number)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
