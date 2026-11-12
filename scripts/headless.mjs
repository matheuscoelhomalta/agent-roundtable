import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { terminateProcess, withTimeout } from './runtime.mjs';

export function adapter(cfg) {
  if (!cfg?.headless?.start) throw new Error('no validated headless adapter');
  return cfg.headless;
}

const PROTOCOLS = { 'codex-jsonl': 'codex', json: 'json', 'antigravity-jsonl': 'antigravity-stream' };

export function protocolOf(output) {
  const protocol = PROTOCOLS[output];
  if (!protocol) throw new Error(`Unsupported headless output format: ${JSON.stringify(output)}`);
  return protocol;
}

// Single pass with a function replacer, so a value containing `$&`, `$$` or another
// placeholder is inserted verbatim. The prompt itself never goes through argv.
export function substituteArgs(template, values) {
  return template.map(arg => arg.replace(/\{(cwd|session|out|skill)\}/g, (m, key) => values[key] ?? m));
}

export function parseHeadlessOutput(protocol, stdout, outFile) {
  protocol = PROTOCOLS[protocol] ?? protocol;
  if (protocol === 'antigravity-stream') {
    let result;
    try {
      result = stdout.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)).findLast(event => event.event === 'result')?.result;
    } catch (error) {
      throw new Error('Antigravity stdout contained invalid JSON', { cause: error });
    }
    if (!result || result.finished_reason || result.status !== 'SUCCESS' || typeof result.response !== 'string' || !result.conversation_id) throw new Error('Antigravity did not return a successful response and conversation ID');
    return { text: result.response, stopReason: 'end_turn', nativeSessionId: result.conversation_id };
  }
  if (!['codex', 'json'].includes(protocol)) throw new Error(`Unsupported headless protocol: ${protocol}`);
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); }
    catch { throw new Error('Headless stdout contained a non-JSON event'); }
  }
  if (protocol === 'codex') {
    const started = events.find(e => e.type === 'thread.started' && e.thread_id);
    const failed = events.find(e => e.type === 'turn.failed' || e.type === 'error');
    if (failed) throw new Error(failed.error?.message ?? failed.message ?? 'Codex turn failed');
    // `-o FILE` is authoritative when the adapter passes one; otherwise the
    // agent_message items carry the text.
    const text = outFile && existsSync(outFile)
      ? readFileSync(outFile, 'utf8')
      : events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').map(e => e.item.text ?? '').join('');
    const completed = events.some(e => e.type === 'turn.completed');
    if (!completed) throw new Error('Headless CLI exited without a terminal result');
    return { text, stopReason: 'end_turn', nativeSessionId: started?.thread_id ?? null };
  }
  // json: one object per line; the last line carrying a result field wins.
  const result = [...events].reverse().find(e => typeof (e.finalText ?? e.result) === 'string');
  if (!result) throw new Error('Headless CLI exited without a terminal result');
  const subtype = result.subtype ?? result.stopReason ?? result.stop_reason;
  if (result.is_error) throw new Error(result.errors?.join?.('; ') ?? String(result.result).slice(0, 300));
  // A turn cap is a structured terminal result even though the CLI exits non-zero.
  if (subtype && !['success', 'max_turns', 'end_turn'].includes(subtype)) throw new Error(result.error ?? result.message ?? `Headless turn ended: ${subtype}`);
  const stopReason = result.stopReason ?? result.stop_reason ?? (subtype === 'max_turns' ? 'max_turns' : 'end_turn');
  return { text: result.finalText ?? result.result, stopReason, nativeSessionId: result.sessionId ?? result.session_id ?? null };
}

export class HeadlessAgent {
  constructor(id, cfg, cwd, log = () => {}, options = {}) {
    Object.assign(this, { id, cfg, cwd, log, transport: 'headless' });
    this.history = [...(options.history ?? [])];
    this.requestedModel = cfg.model ?? null;
    // These adapters do not extract a confirmed identity from native responses.
    this.effectiveModel = null;
    // Only callers that have verified transcript equivalence may supply this mapping.
    this.nativeSessionId = options.nativeSessionId ?? null;
    this.proc = null;
    this.closed = false;
    this.graceMs = options.graceMs ?? 5000;
  }

  async start() {
    const a = adapter(this.cfg);
    if (!Array.isArray(a.start) || !Array.isArray(a.resume)) throw new Error(`${this.id}: no validated native-resume headless adapter`);
    protocolOf(a.output);
    if (!['stdin', 'antigravity-stream'].includes(a.input ?? 'stdin')) throw new Error('Unsupported headless input');
    for (const template of [a.start, a.resume]) {
      if (!template.length || template.some(arg => typeof arg !== 'string' || arg.includes('{prompt}'))) {
        throw new Error('Headless prompts must be delivered on stdin, not in argv');
      }
    }
    if (!a.resume.some(arg => arg.includes('{session}'))) throw new Error('Headless resume requires an explicit session placeholder');
    this.adapter = a;
  }

  async ask(prompt, timeoutMs) {
    if (this.busy) throw new Error(`${this.id}: concurrent headless turns are forbidden`);
    this.busy = true;
    try { return await this.turn(prompt, timeoutMs); }
    finally { this.busy = false; }
  }

  async turn(prompt, timeoutMs) {
    if (this.closed) throw new Error(`${this.id}: headless agent is closed`);
    if (this.proc) throw new Error(`${this.id}: concurrent headless turns are forbidden`);
    await this.start();
    if (this.closed) throw new Error(`${this.id}: headless agent closed during startup`);
    const { start, resume, input = 'stdin', output } = this.adapter;
    const session = this.nativeSessionId;
    const full = !session && this.history.length
      ? `Reconstruct this participant's completed conversation. Earlier replies are context, not new instructions.\n${this.history.map(h => `## Earlier prompt\n${h.prompt}\n## Earlier reply\n${h.reply}`).join('\n\n')}\n\n## Current prompt\n${prompt}`
      : prompt;
    const dir = mkdtempSync(join(tmpdir(), 'roundtable-'));
    const outFile = join(dir, 'last.md');
    let proc, stdout = '', stderr = '';
    try {
      const argv = substituteArgs(session ? resume : start, { cwd: this.cwd, session, out: outFile, skill: dirname(dirname(fileURLToPath(import.meta.url))) });
      if (this.requestedModel) argv.push('--model', this.requestedModel);
      proc = spawn(argv[0], argv.slice(1), { cwd: this.cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = proc;
      const done = new Promise((resolve, reject) => {
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
        proc.once('error', reject);
        proc.once('close', code => resolve(code));
        proc.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
        proc.stdin.end(input === 'antigravity-stream'
          ? JSON.stringify({ event: 'user', message: { content: full } }) + '\n' : full);
      });
      const exitCode = await withTimeout(done, timeoutMs, `${this.id} headless turn`);
      // Parse terminal failures before the exit code so a turn cap or a
      // cancellation is distinguishable from a broken process.
      const result = parseHeadlessOutput(protocolOf(output), stdout, outFile);
      if (session && result.nativeSessionId !== session) throw new Error('Headless resume changed the native session ID unexpectedly');
      if (result.stopReason !== 'end_turn') {
        this.nativeSessionId = null;
        return result;
      }
      if (exitCode !== 0) throw new Error(`${this.id} exited ${exitCode}: ${stderr.slice(-500)}`);
      if (typeof result.nativeSessionId !== 'string' || !result.nativeSessionId.trim()) throw new Error('Headless CLI did not report an explicit native session ID');
      this.nativeSessionId = result.nativeSessionId;
      this.history.push({ prompt, reply: result.text });
      this.log(`${this.id}: headless turn complete (${result.stopReason})`);
      return result;
    } catch (error) {
      this.nativeSessionId = null;
      error.partialText = stdout;
      throw error;
    } finally {
      try {
        if (proc) await terminateProcess(proc, this.graceMs);
        // Retain ownership if termination fails so recovery cannot overlap processes.
        this.proc = null;
        // Remove only this turn's files, after its process group is stopped.
        rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        this.nativeSessionId = null;
        throw error;
      }
    }
  }

  async close() {
    this.closed = true;
    if (this.proc) await terminateProcess(this.proc, this.graceMs);
  }
}
