#!/usr/bin/env node
// File-mediated audit runner. Importable without parsing argv or spawning agents.
import { existsSync, mkdirSync, readFileSync, appendFileSync, realpathSync, openSync, closeSync, unlinkSync, copyFileSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { HeadlessAgent } from './headless.mjs';
import { Participant } from './recovery.mjs';
import { atomicWrite, assertFreshRun, waitForFile, fingerprint } from './safeguards.mjs';
import { openingPrompt, critiquePrompt, vetoPrompt, parseStatus } from './prompts.mjs';
import { assessOutcome, GOALS } from './outcomes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = join(HERE, '..', 'agents.json');
export const REGISTRY = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
export const AGENTS = ['claude', 'gemini', 'codex'];
const now = () => new Date().toISOString();
export const DEFAULTS = { goal: 'explore', rounds: '3', cwd: process.cwd(),
  'turn-timeout': '900', 'kill-grace': '5', 'budget-min': '60', 'wait-timeout': '3600', 'no-veto': false };

function loadRegistry(value) {
  const kind = typeof value === 'string' ? 'file' : value === REGISTRY ? 'default' : 'inline';
  const path = kind === 'file' ? resolve(value) : kind === 'default' ? REGISTRY_PATH : null;
  const serialized = JSON.stringify(kind === 'file' ? JSON.parse(readFileSync(path, 'utf8')) : value);
  // Hash and use the same snapshot, rather than re-reading a mutable source later.
  return { registry: JSON.parse(serialized), provenance: { kind, path,
    sha256: createHash('sha256').update(serialized).digest('hex') } };
}

function writeResult(runDir, state) {
  atomicWrite(join(runDir, 'result.json'), JSON.stringify({ status: state.status, result: state.result, stopReason: state.stopReason,
    review: state.review, deliveryComplete: state.deliveryComplete, registryProvenance: state.registryProvenance,
    cwd: state.cwd, reviewRevision: state.reviewRevision, synthesisSha256: state.synthesisSha256,
    goal: state.goal, outcome: state.outcome, veto: state.veto ?? null, degradedAgents: state.degradedAgents,
    warnings: state.warnings, editCoverage: state.editDetection.checks.at(-1)?.coverage, agents: state.agents }, null, 2));
}
const synthesisHash = text => createHash('sha256').update(text).digest('hex');

function validate(options, registry) {
  for (const id of AGENTS) if (!Object.hasOwn(registry, id)) throw new Error(`Missing required agent: ${id}`);
  if (!GOALS.includes(options.goal)) throw new Error(`Invalid goal: ${options.goal}`);
  for (const key of ['rounds', 'turn-timeout', 'kill-grace', 'budget-min', 'wait-timeout']) {
    const n = Number(options[key]);
    if (!Number.isFinite(n) || n <= 0 || (key === 'rounds' && !Number.isInteger(n))) throw new Error(`Invalid ${key}`);
  }
  return AGENTS;
}

export async function run(input, { registry = REGISTRY, createAgent, signal } = {}) {
  const selected = loadRegistry(input.registry ?? registry);
  registry = selected.registry;
  const opt = { ...DEFAULTS, ...input };
  if (!opt.brief || !opt['run-dir']) throw new Error('run needs --brief and --run-dir');
  const ids = validate(opt, registry);
  const cwd = resolve(opt.cwd), runDir = resolve(opt['run-dir']);
  assertFreshRun(runDir); // before directories, output, baseline or any subprocess
  const brief = readFileSync(opt.brief, 'utf8');
  const baseline = fingerprint(cwd, runDir); // includes startup-phase edits
  for (const folder of ['rounds', 'veto']) mkdirSync(join(runDir, folder), { recursive: true });
  const log = message => {
    const line = `${now()} ${String(message).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 1000)}`;
    appendFileSync(join(runDir, 'events.log'), line + '\n');
    console.error(line);
  };
  atomicWrite(join(runDir, 'brief.md'), brief);
  const state = { status: 'starting', result: 'full', goal: opt.goal, maxRounds: Number(opt.rounds), round: 0,
    registryProvenance: selected.provenance, cwd, reviewRevision: 0,
    review: opt['no-veto'] ? 'skipped' : 'pending', deliveryComplete: false,
    agents: {}, rounds: [], turns: [], degraded: [], warnings: [],
    degradedAgents: [], stopReason: null, editDetection: { baseline, checks: [] } };
  const save = () => atomicWrite(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  const warn = message => { if (!state.warnings.includes(message)) { state.warnings.push(message); log(message); } };
  if (baseline.errors.length) warn(`Baseline edit coverage ${baseline.coverage.status}: ${baseline.errors.join('; ')}`);
  save();
  const participants = {}, latest = {};
  const turnMs = Number(opt['turn-timeout']) * 1000, waitMs = Number(opt['wait-timeout']) * 1000;
  const deadline = Date.now() + Number(opt['budget-min']) * 60_000;
  const checkAbort = () => signal?.throwIfAborted();
  const live = () => ids.filter(id => participants[id] && !participants[id].state.dropped);
  const degradedLabel = () => state.result === 'degraded' ? `degraded: ${state.degraded.map(d => `${d.agent} ${d.what}`).join(', ')}` : 'all original participants';
  const checkEdits = phase => {
    const after = fingerprint(cwd, runDir);
    state.editDetection.checks.push({ phase, ...after });
    if (after.coverage.status !== 'complete') warn(`${phase}: edit detection ${after.coverage.status}: ${after.errors.join('; ')}`);
    if (baseline.hash !== null && after.hash !== null && baseline.hash !== after.hash) warn(`${phase}: working tree content changed during audit`);
    save();
  };
  // On a signal, interrupt in-flight subprocesses as well as file waits. finally
  // awaits the same idempotent close operations before returning to the CLI.
  let interruptCleanup;
  const interrupt = () => { interruptCleanup = Promise.allSettled(Object.values(participants).map(p => p.close())); };
  signal?.addEventListener('abort', interrupt, { once: true });
  let scope = 'startup';
  try {
    checkAbort();
    for (const id of ids) {
      participants[id] = new Participant({ id, signal,
        factory: (transport, context) => createAgent ? createAgent(id, transport, context) :
          new HeadlessAgent(id, registry[id], cwd, log, { graceMs: Number(opt['kill-grace']) * 1000, ...context }),
        onUpdate: health => {
          state.agents[id] = { ...state.agents[id], ...health, live: !health.dropped, requestedModel: registry[id].model ?? null };
          if (!health.ok && latest[id]) latest[id].status = null;
          for (const what of health.degradedWhat ?? []) {
            if (state.degraded.some(d => d.agent === id && d.what === what)) continue;
            state.degraded.push({ agent: id, what });
            if (!state.degradedAgents.includes(id)) state.degradedAgents.push(id);
            warn(`${id}: ${what}`);
          }
          state.result = state.degraded.length ? 'degraded' : state.result;
          save();
        },
        onAttempt: attempt => {
          atomicWrite(join(runDir, 'rounds', `${scope}-${id}.attempt-${attempt.failedAttempts}.json`), JSON.stringify(attempt, null, 2));
          // Each failed attempt is its own turn record, so a turn that recovered
          // internally still shows the failure that caused the recovery.
          state.turns.push({ round: state.round || null, agent: id, outcome: 'failed', phase: attempt.phase,
            transport: attempt.transport, stopReason: attempt.stopReason ?? null, error: attempt.error, recovered: true });
          log(`${id} ${scope} failed attempt ${attempt.failedAttempts}: ${attempt.error}`);
        },
      });
      state.agents[id] = { ...participants[id].state, requestedModel: registry[id].model ?? null, live: true };
    }
    const started = await Promise.allSettled(ids.map(id => participants[id].start()));
    started.forEach((result, i) => { if (result.status === 'rejected') warn(`${ids[i]} startup failed: ${result.reason.message}`); });
    checkAbort();
    if (live().length < ids.length) throw new Error('fewer than the required agents available after recovery');

    const turn = async (round, id, prompt) => {
      const began = Date.now();
      atomicWrite(join(runDir, 'rounds', `r${round}-${id}.prompt.md`), prompt);
      try {
        const result = await participants[id].ask(prompt, turnMs);
        const status = parseStatus(result.text);
        latest[id] = { text: result.text, status, round, stopReason: result.stopReason };
        state.agents[id].lastReplyStatus = status;
        atomicWrite(join(runDir, 'rounds', `r${round}-${id}.md`), result.text);
        state.rounds.push({ round, agent: id, durationMs: Date.now() - began, outcome: status.parsed ? 'answered' : 'invalid_status', transport: participants[id].state.transport, stopReason: result.stopReason });
        state.turns.push({ round, agent: id, durationMs: Date.now() - began, outcome: status.parsed ? 'answered' : 'invalid_status', transport: participants[id].state.transport, stopReason: result.stopReason });
        if (!status.parsed) log(`${id} r${round}: invalid status (${status.error})`);
        save();
        return { agent: id, ...status };
      } catch (error) {
        if (latest[id]) latest[id].status = null;
        // Failed attempts are recorded by onAttempt as they happen, one turn record
        // each, so an internally recovered turn does not double-count.
        warn(`${id} r${round}: ${error.message}`);
        save();
        return null;
      }
    };
    for (let round = 1; round <= state.maxRounds; round++) {
      checkAbort();
      if (Date.now() > deadline) { state.stopReason = 'budget exhausted'; break; }
      state.round = round; state.status = 'debating'; scope = `r${round}`; delete state.waitingFor; save();
      const speakers = live();
      // Snapshot every peer before starting any parallel turn.
      const peerSnapshot = Object.fromEntries(speakers.map(id => [id, ids.filter(p => p !== id && latest[p]).map(p => ({ label: registry[p].label ?? p, prefix: p.toUpperCase(), text: latest[p].text,
        round: latest[p].round, state: participants[p].state.dropped ? 'dropped' : 'live' }))]));
      const results = await Promise.all(speakers.map(id => {
        const parts = [];
        if (!latest[id]) parts.push(openingPrompt({ brief, prefix: id.toUpperCase(), goal: opt.goal }));
        if (peerSnapshot[id].length) parts.push(critiquePrompt({ round, peers: peerSnapshot[id], prefix: id.toUpperCase(), goal: opt.goal }));
        return turn(round, id, parts.join('\n\n'));
      }));
      checkAbort(); checkEdits(`round ${round}`);
      const expected = live();
      const statuses = expected.filter(id => latest[id]?.status).map(id => ({ agent: id, ...latest[id].status }));
      const verdict = expected.length < ids.length ? { complete: false, consensus: false, reason: 'fewer than the required agents remain' } :
        assessOutcome(statuses, { goal: opt.goal, round, maxRounds: state.maxRounds, minRounds: state.maxRounds, expectedAgents: expected });
      // The verdict reason stays plain; degradation is stated once, in the stop reason.
      const reason = state.result === 'degraded' ? `${degradedLabel()}; ${verdict.reason}` : verdict.reason;
      atomicWrite(join(runDir, 'rounds', `r${round}.summary.json`), JSON.stringify({ round, answered: results.filter(Boolean).length, statuses, expectedAgents: expected, degraded: state.degraded, reason }, null, 2));
      state.outcome = verdict;
      log(`round ${round}: ${reason}`);
      if (expected.length < ids.length) throw new Error('fewer than the required agents remain after recovery');
      if (verdict.complete) {
        state.stopReason = state.result === 'degraded' ? `degraded convergence: ${reason}` :
          verdict.consensus ? `consensus: ${reason}` : `completed: ${reason}`;
        break;
      }
      if (round === state.maxRounds) { state.stopReason = 'round limit'; break; }
    }
    delete state.waitingFor;
    state.stopReason ??= 'round limit';
    checkAbort();
    if (!opt['no-veto']) {
      const path = join(runDir, 'synthesis.md');
      state.status = 'awaiting_synthesis'; state.waitingFor = path; save();
      const synthesis = await waitForFile(path, waitMs, { signal });
      delete state.waitingFor;
      if (synthesis === null) {
        state.review = 'missing';
        warn('no synthesis written; required review missing; delivery incomplete');
      } else {
        state.synthesisSha256 = synthesisHash(synthesis);
        state.status = 'veto'; scope = 'veto'; save();
        const finalPositions = ids.map(id => ({ agent: id, round: latest[id]?.round ?? null, status: latest[id]?.status ?? null,
          lastKnownStatus: state.agents[id].lastReplyStatus ?? null, health: state.agents[id], text: latest[id]?.text ?? 'No completed reply' }));
        const context = { result: state.result, degradedAgents: state.degradedAgents, warnings: state.warnings, finalPositions };
        // Panel overview in the documented per-agent shape, so a veto message shows
        // every agent's status and its own reply text.
        const panel = ids.map(id => ({ label: registry[id].label ?? id, prefix: id.toUpperCase(),
          status: latest[id]?.status ?? null, state: participants[id]?.state.dropped ? 'dropped' : 'live',
          text: latest[id]?.text ?? null }));
        const votes = await Promise.all(live().map(async id => {
          try {
            const prompt = vetoPrompt({ synthesis, prefix: id.toUpperCase(), context, panel });
            atomicWrite(join(runDir, 'veto', `${id}.prompt.md`), prompt);
            const { text, stopReason } = await participants[id].ask(prompt, turnMs);
            atomicWrite(join(runDir, 'veto', `${id}.md`), text);
            const s = parseStatus(text);
            return { agent: id, approve: stopReason === 'end_turn' && s.parsed && s.stance === 'converged' && s.blocking.length === 0, stopReason, ...s };
          } catch (error) { warn(`${id} veto failed: ${error.message}`); return { agent: id, approve: null, error: error.message }; }
        }));
        checkAbort();
        atomicWrite(join(runDir, 'veto.json'), JSON.stringify(votes, null, 2));
        state.veto = votes;
        state.review = votes.some(v => !v.parsed || v.approve === null) ? 'missing'
          : votes.every(v => v.approve) ? 'approved' : 'objected';
        if (live().length < ids.length) throw new Error('fewer than the required agents remain after veto recovery');
      }
    }
    state.status = 'done';
    // Outcome completion and agreement are separate signals.
    if (state.result !== 'degraded') state.result = state.outcome?.complete
      ? (state.outcome.consensus ? 'consensus' : 'completed_with_disagreement') : 'incomplete';
  } catch (error) {
    state.status = signal?.aborted ? 'interrupted' : 'failed';
    state.stopReason = error.message;
    state.result = 'degraded';
    throw error;
  } finally {
    signal?.removeEventListener('abort', interrupt);
    const closed = await Promise.allSettled(Object.values(participants).map(p => p.close()));
    await interruptCleanup;
    closed.forEach(result => { if (result.status === 'rejected') { state.status = 'failed'; state.result = 'degraded'; state.stopReason = `cleanup failed: ${result.reason.message}`; warn(state.stopReason); } });
    delete state.waitingFor;
    checkEdits('after veto/cleanup');
    if (state.review === 'pending') state.review = 'missing';
    state.deliveryComplete = state.status === 'done' && !!state.outcome?.complete &&
      ['approved', 'skipped'].includes(state.review);
    state.finishedAt = now(); save();
    writeResult(runDir, state);
  }
  if (state.status === 'failed') throw new Error(state.stopReason ?? 'cleanup failed');
  return state;
}

// One explicit fidelity submission. Never restart a participant or rerun debate.
export async function reviewSynthesis(input, { registry, signal } = {}) {
  if (!input['run-dir'] || !input.synthesis) throw new Error('review-synthesis needs --run-dir and --synthesis');
  if (input['no-veto']) throw new Error('review-synthesis cannot skip the required reviewers');
  const runDir = resolve(input['run-dir']);
  const lockPath = join(runDir, '.review.lock');
  let lock;
  try { lock = openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('A synthesis review is active or an interrupted review lock remains'); throw error; }
  let state, started = false, keepLock = false;
  const agents = [];
  let interruptedCleanup;
  const interrupt = () => { interruptedCleanup = Promise.allSettled(agents.map(agent => agent.close())); };
  try {
    signal?.throwIfAborted();
    state = JSON.parse(readFileSync(join(runDir, 'state.json'), 'utf8'));
    const previousResult = JSON.parse(readFileSync(join(runDir, 'result.json'), 'utf8'));
    if (state.status !== 'done' || !['objected', 'missing'].includes(state.review) ||
        previousResult.status !== state.status || previousResult.review !== state.review) {
      throw new Error('Only a finished run with an objected or missing review can be resubmitted');
    }
    const source = input.registry ?? registry ?? state.registryProvenance?.path;
    if (!source) throw new Error('Supply the original --registry for this inline run');
    const selected = loadRegistry(source);
    if (selected.provenance.sha256 !== state.registryProvenance?.sha256) throw new Error('Registry changed: original adapters and permission flags are required');
    if (!state.cwd && !input.cwd) throw new Error('Older run: supply --cwd with the original working directory');
    const cwd = resolve(state.cwd ?? input.cwd);
    if (state.cwd && input.cwd && resolve(input.cwd) !== cwd) throw new Error('Cannot change the original working directory');
    const opt = { ...DEFAULTS, ...input, goal: state.goal, rounds: String(state.maxRounds) };
    validate(opt, selected.registry);
    const synthesis = readFileSync(input.synthesis, 'utf8');
    if (!synthesis.trim()) throw new Error('Corrected synthesis must not be empty');
    const current = join(runDir, 'synthesis.md');
    if (existsSync(current) && realpathSync(input.synthesis) === realpathSync(current)) throw new Error('Supply a separate corrected synthesis file; preserve the current draft');
    if (state.synthesisSha256 && (!existsSync(current) || synthesisHash(readFileSync(current, 'utf8')) !== state.synthesisSha256)) {
      throw new Error('Current synthesis changed since its review; restore it before resubmitting');
    }
    const panel = AGENTS.map(id => {
      const health = state.agents[id];
      if (!health?.ok || health.dropped || typeof health.nativeSessionId !== 'string' || !health.nativeSessionId.trim()) throw new Error(`${id}: no healthy native session to resume`);
      const text = readFileSync(join(runDir, 'rounds', `r${state.round}-${id}.md`), 'utf8');
      return { label: selected.registry[id].label ?? id, prefix: id.toUpperCase(), status: parseStatus(text), state: 'live', text };
    });
    for (const id of AGENTS) agents.push(new HeadlessAgent(id, selected.registry[id], cwd, () => {},
      { nativeSessionId: state.agents[id].nativeSessionId, graceMs: Number(opt['kill-grace']) * 1000 }));
    await Promise.all(agents.map(agent => agent.start())); // validate all adapters before changing records
    signal?.throwIfAborted();
    const previousRevision = state.reviewRevision ?? 0;
    if (!Number.isSafeInteger(previousRevision) || previousRevision < 0) throw new Error('Invalid saved review revision');
    const archive = join(runDir, 'reviews', String(previousRevision));
    mkdirSync(join(runDir, 'reviews'), { recursive: true });
    mkdirSync(archive); // exclusive: never overwrite an earlier review
    for (const name of ['state.json', 'result.json', 'synthesis.md', 'veto.json']) {
      if (existsSync(join(runDir, name))) copyFileSync(join(runDir, name), join(archive, name));
    }
    if (existsSync(join(runDir, 'veto'))) renameSync(join(runDir, 'veto'), join(archive, 'veto'));
    if (existsSync(join(runDir, 'final.md'))) renameSync(join(runDir, 'final.md'), join(archive, 'final.md'));
    const previousVotes = state.veto ?? [];
    state.cwd = cwd;
    state.reviewRevision = previousRevision + 1;
    state.status = 'veto'; state.review = 'pending'; state.deliveryComplete = false; state.veto = [];
    state.synthesisSha256 = synthesisHash(synthesis);
    delete state.finishedAt;
    started = true;
    atomicWrite(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
    writeResult(runDir, state); // invalidate old approval before replacing the draft
    atomicWrite(current, synthesis);
    atomicWrite(join(runDir, 'veto.json'), '[]');
    mkdirSync(join(runDir, 'veto'));
    appendFileSync(join(runDir, 'events.log'), `${now()} explicit synthesis review ${state.reviewRevision} started\n`);
    signal?.addEventListener('abort', interrupt, { once: true });
    state.veto = await Promise.all(agents.map(async agent => {
      const id = agent.id;
      try {
        const context = { reviewRevision: state.reviewRevision, previousVotes, outcome: state.outcome };
        const prompt = vetoPrompt({ synthesis, prefix: id.toUpperCase(), context, panel });
        atomicWrite(join(runDir, 'veto', `${id}.prompt.md`), prompt);
        signal?.throwIfAborted();
        const reply = await agent.ask(prompt, Number(opt['turn-timeout']) * 1000);
        atomicWrite(join(runDir, 'veto', `${id}.md`), reply.text);
        if (reply.stopReason !== 'end_turn') throw new Error(`${id} review stopped: ${reply.stopReason}`);
        const status = parseStatus(reply.text);
        return { agent: id, approve: status.parsed && status.stance === 'converged' && status.blocking.length === 0, stopReason: reply.stopReason, ...status };
      } catch (error) {
        Object.assign(state.agents[id], { ok: false, nativeSessionId: null, lastError: error.message });
        state.agents[id].failedAttempts++;
        state.agents[id].failedTurns++;
        return { agent: id, approve: null, error: error.message, partialText: error.partialText ?? '' };
      }
    }));
    atomicWrite(join(runDir, 'veto.json'), JSON.stringify(state.veto, null, 2));
    signal?.throwIfAborted();
    if (synthesisHash(readFileSync(current, 'utf8')) !== state.synthesisSha256) throw new Error('Synthesis changed during its review');
    state.review = state.veto.some(v => !v.parsed || v.approve === null) ? 'missing' : state.veto.every(v => v.approve) ? 'approved' : 'objected';
    state.status = state.veto.some(v => v.approve === null) ? 'failed' : 'done';
    if (state.status === 'failed') state.stopReason = 'synthesis review failed without session replacement';
  } catch (error) {
    if (started) { state.status = signal?.aborted ? 'interrupted' : 'failed'; state.review = 'missing'; state.stopReason = error.message; }
    throw error;
  } finally {
    signal?.removeEventListener('abort', interrupt);
    const closed = await Promise.allSettled(agents.map(agent => agent.close()));
    await interruptedCleanup;
    const failures = closed.filter(result => result.status === 'rejected');
    keepLock = failures.length > 0;
    try {
      if (started) {
        if (keepLock) { state.status = 'failed'; state.review = 'missing'; state.stopReason = 'synthesis review cleanup failed; lock retained'; }
        const after = fingerprint(state.cwd, runDir);
        state.editDetection.checks.push({ phase: `synthesis review ${state.reviewRevision}`, ...after });
        const warning = after.hash !== null && state.editDetection.baseline.hash !== null && after.hash !== state.editDetection.baseline.hash
          ? 'working tree content changed during synthesis review' : after.coverage.status !== 'complete' ? 'synthesis review edit coverage unavailable or partial' : null;
        if (warning && !state.warnings.includes(warning)) state.warnings.push(warning);
        state.deliveryComplete = state.status === 'done' && !!state.outcome?.complete && state.review === 'approved';
        state.finishedAt = now();
        atomicWrite(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
        writeResult(runDir, state);
        appendFileSync(join(runDir, 'events.log'), `${now()} synthesis review ${state.reviewRevision}: ${state.review}\n`);
      }
    } finally { closeSync(lock); if (!keepLock) unlinkSync(lockPath); }
  }
  if (state.status === 'failed') throw new Error(state.stopReason);
  return state;
}

export async function doctor({ registry = REGISTRY, signal, cwd = process.cwd() } = {}) {
  registry = loadRegistry(registry).registry;
  const rows = [];
  for (const id of AGENTS) {
    if (!registry[id]) throw new Error(`Missing required agent: ${id}`);
    const agent = new HeadlessAgent(id, registry[id], cwd);
    const row = { agent: id };
    const abort = () => { void agent.close().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      const reply = await agent.ask('Reply exactly OK. Do not use tools or change files.', 60_000);
      row.result = reply.stopReason === 'end_turn' && reply.text.trim() === 'OK' ? 'prompt OK' : 'FAIL: unexpected probe reply';
    } catch (error) { row.result = `FAIL: ${error.message}`; }
    finally { signal?.removeEventListener('abort', abort); await agent.close(); }
    rows.push(row);
  }
  return rows;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = Object.fromEntries(Object.entries(DEFAULTS).map(([key, value]) => [key, { type: typeof value === 'boolean' ? 'boolean' : 'string', default: value }]));
  for (const key of ['brief', 'run-dir', 'registry', 'synthesis']) options[key] = { type: 'string' };
  options.cwd = { type: 'string' };
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options });
  if (positionals.length !== 1) throw new Error('Expected one command: run, doctor or review-synthesis');
  const controller = new AbortController();
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(name => [name, () => controller.abort(new Error(`interrupted by ${name}`))]));
  for (const [name, handler] of Object.entries(handlers)) process.on(name, handler);
  try {
    if (positionals[0] === 'review-synthesis') {
      const state = await reviewSynthesis(values, { ...dependencies, signal: controller.signal });
      console.log(JSON.stringify({ status: state.status, review: state.review, reviewRevision: state.reviewRevision, deliveryComplete: state.deliveryComplete }, null, 2));
      if (!state.deliveryComplete) process.exitCode = 1;
      return state;
    }
    // An injected registry (tests, embedding) wins over the file on disk.
    const loaded = dependencies.registry ?? values.registry ?? REGISTRY;
    if (positionals[0] === 'run') return await run({ ...values, cwd: values.cwd ?? DEFAULTS.cwd, registry: loaded }, { ...dependencies, signal: controller.signal });
    if (positionals[0] === 'doctor') {
      const rows = await doctor({ ...dependencies, registry: loaded, signal: controller.signal, cwd: values.cwd });
      console.log(JSON.stringify(rows, null, 2));
      if (rows.some(row => row.result.startsWith('FAIL:'))) process.exitCode = 1;
      return;
    }
    throw new Error('usage: roundtable.mjs run --brief FILE --run-dir DIR [--rounds N] [--goal explore|decide|audit] | doctor | review-synthesis --run-dir DIR --synthesis FILE');
  } finally { for (const [name, handler] of Object.entries(handlers)) process.off(name, handler); }
}
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
}
