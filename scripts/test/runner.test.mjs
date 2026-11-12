// npm test (from scripts/). Runs roundtable.mjs end to end against fake agents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from 'node:crypto';
import { doctor } from '../roundtable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, "..", "roundtable.mjs");
const FAKE_CLI = join(HERE, "fake-cli.mjs");
const CONVERGED = '{"stance":"converged"}';

// Each required native participant receives its own resumable fixture session.
function setup(agents) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-run-'));
  const registry = {};
  for (const id of ['claude', 'gemini', 'codex']) {
    const a = agents[id] ?? {};
    const cli = ['node', FAKE_CLI, '--name', id, '--plan', a.cliPlan ?? 'ok', '--state', join(dir, `${id}.cli.n`), '--log', join(dir, `${id}.cli.jsonl`), '--status', a.status ?? CONVERGED];
    registry[id] = { label: id, headless: { start: cli, resume: [...cli, '--resume', '{session}'], input: 'stdin', output: 'json' } };
  }
  writeFileSync(join(dir, 'agents.json'), JSON.stringify(registry));
  writeFileSync(join(dir, 'brief.md'), 'Audit nothing in particular.');
  const target = join(dir, 'target'); mkdirSync(target);
  return { dir, target, runDir: join(dir, 'run') };
}

function run({ dir, target, runDir }, args = []) {
  const r = spawnSync("node", [RUNNER, "run", "--registry", join(dir, "agents.json"), "--brief", join(dir, "brief.md"),
    "--run-dir", runDir, "--cwd", target, "--no-veto", "--turn-timeout", "1",
    "--kill-grace", "0.3", "--wait-timeout", "1", ...args], { encoding: "utf8", timeout: 60_000 });
  const state = existsSync(join(runDir, "state.json")) ? JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) : null;
  return { ...r, state };
}
const prompts = (dir, file) => readFileSync(join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("healthy run reaches consensus and is not degraded", () => {
  const s = setup({ claude: {}, gemini: {} });
  const r = run(s);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.state.result, "consensus");
  assert.equal(r.state.review, 'skipped'); assert.equal(r.state.deliveryComplete, true);
  assert.match(r.state.stopReason, /^consensus/);
  assert.ok(r.state.turns.every((t) => t.stopReason === "end_turn"));
  const registry = JSON.parse(readFileSync(join(s.dir, 'agents.json'), 'utf8'));
  assert.deepEqual(r.state.registryProvenance, { kind: 'file', path: join(s.dir, 'agents.json'),
    sha256: createHash('sha256').update(JSON.stringify(registry)).digest('hex') });
  const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
  assert.deepEqual(result.registryProvenance, r.state.registryProvenance);
});

test("a reused run dir is refused", () => {
  const s = setup({ claude: {}, gemini: {} });
  assert.equal(run(s).status, 0);
  const again = run(s);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already used/);
});

test("edit detection: a further edit to an already dirty file is caught; run files are not", () => {
  const s = setup({ claude: {}, gemini: {} });
  s.runDir = join(s.target, "docs", "run"); // run dir inside the target repo
  execFileSync("git", ["init", "-q"], { cwd: s.target });
  writeFileSync(join(s.target, "f.txt"), "one");
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], { cwd: s.target });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: s.target });
  writeFileSync(join(s.target, "f.txt"), "two"); // dirty before the run starts
  const clean = run(s);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.state.warnings, [], "the run's own files never warn");

  // Agent a writes to the already dirty file during its first turn.
  const s2 = setup({ claude: {}, gemini: {} });
  s2.target = s.target; s2.runDir = join(s.target, "docs", "run2");
  const reg = JSON.parse(readFileSync(join(s2.dir, "agents.json"), "utf8"));
  reg.claude.headless.start.push("--touch", `${join(s.target, "f.txt")}=three`);
  writeFileSync(join(s2.dir, "agents.json"), JSON.stringify(reg));
  const touched = run(s2);
  assert.equal(touched.status, 0, touched.stderr);
  assert.match(touched.state.warnings.join("\n"), /round 1: working tree content changed/);
});

test("veto: a slowly written synthesis is read whole, and every veto prompt lists all agents' final status", async () => {
  const s = setup({ claude: {}, gemini: { status: '{"stance":"converged","blocking":[],"resolved":["A-1"]}' } });
  const { spawn } = await import("node:child_process");
  const p = spawn("node", [RUNNER, "run", "--registry", join(s.dir, "agents.json"), "--brief", join(s.dir, "brief.md"),
    "--run-dir", s.runDir, "--cwd", s.target, "--turn-timeout", "5", "--wait-timeout", "20"], { stdio: "ignore" });
  const exited = new Promise((r) => p.on("exit", r));
  const synth = join(s.runDir, "synthesis.md");
  for (let i = 0; i < 200; i++) {
    const st = existsSync(join(s.runDir, "state.json")) && JSON.parse(readFileSync(join(s.runDir, "state.json"), "utf8"));
    if (st?.status === "awaiting_synthesis") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { appendFileSync } = await import("node:fs");
  appendFileSync(synth, "# Draft part one\n");
  await new Promise((r) => setTimeout(r, 200));
  appendFileSync(synth, "## Part two END\n");
  assert.equal(await exited, 0);
  const vetoPrompt = prompts(s.dir, "claude.cli.jsonl").at(-1).prompt;
  assert.match(vetoPrompt, /Part two END/, "the whole synthesis was read");
  assert.match(vetoPrompt, /### claude \(CLAUDE\)\nFinal-round status: \{"stance":"converged"/);
  assert.match(vetoPrompt, /### gemini \(GEMINI\)\nFinal-round status/);
  const state = JSON.parse(readFileSync(join(s.runDir, "state.json"), "utf8"));
  assert.deepEqual(state.veto.map((v) => [v.agent, v.approve, v.stopReason]), [['claude', true, 'end_turn'], ['gemini', true, 'end_turn'], ['codex', true, 'end_turn']]);
  assert.equal(state.review, 'approved'); assert.equal(state.deliveryComplete, true);
});


test('three-model panel forwards both actual peer replies for three rounds with native resume', () => {
  const s=setup({claude:{},gemini:{},codex:{}});
  const r=run(s,['--rounds','3']);
  assert.equal(r.status,0,r.stderr);
  assert.equal(r.state.round,3);
  for(const id of ['claude','gemini','codex']) {
    const turns=prompts(s.dir,`${id}.cli.jsonl`);
    assert.equal(turns.length,3);
    assert.equal(turns[0].resume,null);
    assert.ok(turns.slice(1).every(turn=>turn.resume===`fake-native-${id}`));
    for(const turn of turns.slice(1)) {
      for(const peer of ['claude','gemini','codex'].filter(peer=>peer!==id)) {
        assert.match(turn.prompt,new RegExp(`### ${peer}`));
        const prior = readFileSync(join(s.runDir, 'rounds', `r${turn.n}-${peer}.md`), 'utf8').trim();
        assert.ok(turn.prompt.includes(prior), `${id} received the full previous reply from ${peer}`);
        assert.ok(turn.prompt.includes(`headless reply ${turn.n-1} from ${peer}`));
      }
      assert.ok(!turn.prompt.includes(`headless reply ${turn.n-1} from ${id}`), 'own history is not relayed as a peer');
    }
  }
});

test('CLI doctor probes all three fixture CLIs and closes their processes', () => {
  const s = setup({ claude: { cliPlan: 'probe' }, gemini: { cliPlan: 'probe' }, codex: { cliPlan: 'probe' } });
  const result = spawnSync(process.execPath, [RUNNER, 'doctor', '--registry', join(s.dir, 'agents.json'), '--cwd', s.target],
    { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.deepEqual(rows, ['claude', 'gemini', 'codex'].map(agent => ({ agent, result: 'prompt OK' })));
  for (const id of ['claude', 'gemini', 'codex']) {
    const turns = prompts(s.dir, `${id}.cli.jsonl`);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].resume, null);
    assert.match(turns[0].prompt, /Reply exactly OK/);
    assert.throws(() => process.kill(turns[0].pid, 0), { code: 'ESRCH' });
  }
});

test('CLI doctor exits 1 for probe failure or unexpected reply, preserving the complete JSON report', () => {
  for (const cliPlan of ['fail', 'ok']) {
    const s = setup({ claude: { cliPlan: 'probe' }, gemini: { cliPlan }, codex: { cliPlan: 'probe' } });
    const result = spawnSync(process.execPath, [RUNNER, 'doctor', '--registry', join(s.dir, 'agents.json'), '--cwd', s.target],
      { encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1, result.stderr);
    const rows = JSON.parse(result.stdout);
    assert.deepEqual(rows.map(row => row.agent), ['claude', 'gemini', 'codex']);
    assert.equal(rows[0].result, 'prompt OK');
    assert.match(rows[1].result, /^FAIL:/);
    assert.equal(rows[2].result, 'prompt OK');
    for (const id of ['claude', 'gemini', 'codex']) {
      const turns = prompts(s.dir, `${id}.cli.jsonl`);
      assert.equal(turns.length, 1);
      assert.throws(() => process.kill(turns[0].pid, 0), { code: 'ESRCH' });
    }
  }
});

test('doctor reports a failed fixture without skipping the other required agents', async () => {
  const s = setup({ claude: { cliPlan: 'fail' }, gemini: { cliPlan: 'probe' }, codex: { cliPlan: 'probe' } });
  const rows = await doctor({ registry: JSON.parse(readFileSync(join(s.dir, 'agents.json'), 'utf8')), cwd: s.target });
  assert.match(rows[0].result, /^FAIL:/);
  assert.deepEqual(rows.slice(1), [{ agent: 'gemini', result: 'prompt OK' }, { agent: 'codex', result: 'prompt OK' }]);
  for (const id of ['claude', 'gemini', 'codex']) {
    const turns = prompts(s.dir, `${id}.cli.jsonl`);
    assert.equal(turns.length, 1);
    assert.throws(() => process.kill(turns[0].pid, 0), { code: 'ESRCH' });
  }
});

test('required trio fails when one participant drops instead of reporting two-model success', () => {
  const s=setup({claude:{},gemini:{},codex:{cliPlan:'fail'}});
  const r=run(s,[]);
  assert.equal(r.status,1);
  assert.equal(r.state.status,'failed');
  assert.match(r.state.stopReason,/fewer than the required/);
});

test('audit completes three rounds and final review with an unclosed Codex status fence', async () => {
  const status = JSON.stringify({ stance: 'converged', outcome: 'complete', claims: [
    { id: 'A-1', statement: 'Fixture audited', status: 'supported', evidence: ['brief.md:1'] },
  ] });
  const s = setup({ claude: { status }, gemini: { status },
    codex: { status, cliPlan: 'unclosed-status' } });
  const { spawn } = await import('node:child_process');
  const proc = spawn(process.execPath, [RUNNER, 'run', '--registry', join(s.dir, 'agents.json'),
    '--brief', join(s.dir, 'brief.md'), '--run-dir', s.runDir, '--cwd', s.target,
    '--goal', 'audit',
    '--rounds', '3', '--turn-timeout', '5', '--wait-timeout', '10'], { stdio: 'ignore' });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  try {
    let ready = false;
    for (let i = 0; i < 200; i++) {
      const path = join(s.runDir, 'state.json');
      if (existsSync(path) && JSON.parse(readFileSync(path, 'utf8')).status === 'awaiting_synthesis') {
        ready = true; break;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(ready, true, 'runner reached synthesis after all three rounds');
    writeFileSync(join(s.runDir, 'synthesis.md'), 'All three fixture agents completed the audit.');
    assert.equal(await exited, 0);
    const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
    const state = JSON.parse(readFileSync(join(s.runDir, 'state.json'), 'utf8'));
    assert.equal(result.result, 'consensus');
    assert.equal(result.review, 'approved');
    assert.equal(result.deliveryComplete, true);
    assert.equal(state.round, 3);
    assert.equal(state.turns.length, 9);
    assert.ok(state.turns.every(turn => turn.outcome === 'answered'));
    assert.ok(result.veto.every(vote => vote.parsed && vote.approve));
    const turns = prompts(s.dir, 'codex.cli.jsonl');
    assert.equal(turns.length, 4);
    assert.ok(turns.slice(1).every(turn => turn.resume === 'fake-native-codex'));
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) { proc.kill('SIGKILL'); await exited; }
  }
});

test('unclosed Codex fences cannot complete an audit with truncated JSON or missing claims', () => {
  const valid = JSON.stringify({ stance: 'converged', outcome: 'complete', claims: [
    { id: 'A-1', statement: 'Fixture audited', status: 'supported', evidence: ['brief.md:1'] },
  ] });
  for (const status of [valid.slice(0, -1), '{"stance":"converged","outcome":"complete","claims":[]}']) {
    const s = setup({ claude: { status: valid }, gemini: { status: valid },
      codex: { status, cliPlan: 'unclosed-status' } });
    const r = run(s, ['--goal', 'audit', '--rounds', '1']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.state.result, 'incomplete');
    assert.equal(r.state.deliveryComplete, false);
  }
});

for (const flags of [[], ['--preserve-symlinks-main']]) {
  test(`CLI runs through an installed skill symlink ${flags.join(' ')}`, () => {
    const s = setup({ claude: {}, gemini: {} });
    const link = join(s.dir, 'installed-skill');
    symlinkSync(dirname(dirname(RUNNER)), link, 'dir');
    const r = spawnSync(process.execPath, [...flags, join(link, 'scripts', 'roundtable.mjs'), 'run',
      '--registry', join(s.dir, 'agents.json'), '--brief', join(s.dir, 'brief.md'), '--run-dir', s.runDir,
      '--cwd', s.target, '--rounds', '1', '--no-veto'],
    { encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(join(s.runDir, 'result.json')), true, 'zero exit must include an actual run');
    const result = JSON.parse(readFileSync(join(s.runDir, 'result.json'), 'utf8'));
    assert.equal(result.review, 'skipped'); assert.equal(result.deliveryComplete, true);
  });
}
