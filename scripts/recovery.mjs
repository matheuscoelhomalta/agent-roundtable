// Owns accepted context and one lifetime native-session recovery attempt.
export class Participant {
  constructor({ id, factory, onUpdate = () => {}, onAttempt = () => {}, signal }) {
    Object.assign(this, { id, factory, onUpdate, onAttempt, signal });
    this.history = [];
    this.ownedAgents = new Set();
    this.state = { ok: false, transport: 'headless', recoveryStage: 0, failedAttempts: 0, failedTurns: 0,
      recoveryFailures: 0, nativeSessionId: null, effectiveModel: null,
      lastError: null, dropped: false, degraded: false, degradedWhat: [], stopReason: null };
  }
  update() { this.onUpdate({ ...this.state }); }
  checkOpen() {
    if (this.closed || this.signal?.aborted) throw this.signal?.reason ?? new Error(`${this.id} closed`);
    if (this.state.dropped) throw new Error(`${this.id} dropped`);
  }
  async ensure() {
    this.checkOpen();
    if (this.agent) return;
    this.agent = this.factory(this.state.transport, { history: this.history.map(pair => ({ ...pair })) });
    this.ownedAgents.add(this.agent);
    await this.agent.start();
    this.state.ok = true;
    this.state.effectiveModel = this.agent.effectiveModel ?? null;
    this.update();
  }
  async fail(error, phase) {
    this.state.ok = false;
    this.state.lastError = error.message;
    this.state.stopReason = error.stopReason ?? (error.code === 'TURN_TIMEOUT' ? 'timeout' : 'error');
    this.state.failedAttempts++;
    // The replacement gets no further retry, even after successful turns.
    if (phase === 'turn') this.state.failedTurns++;
    if (this.state.recoveryStage > 0) this.state.recoveryFailures++;
    this.state.nativeSessionId = null;
    this.state.effectiveModel = null;
    this.update(); // invalidate health/vote before cleanup or a retry
    await this.onAttempt({ phase, error: error.message, partialText: error.partialText ?? '', ...this.state });
    const old = this.agent;
    this.agent = null;
    try { await old?.close(); }
    catch (cleanupError) {
      // Starting a replacement while the old process may run is unsafe.
      this.state.dropped = true;
      this.state.lastError += `; cleanup failed: ${cleanupError.message}`;
      this.update();
      throw cleanupError;
    }
    this.checkOpen();
    if (this.state.recoveryStage === 0) this.state.recoveryStage = 1;
    else {
      this.state.dropped = true;
      this.state.degraded = true;
      this.state.degradedWhat.push('dropped');
    }
    this.update();
    if (this.state.dropped) throw Object.assign(new Error(`${this.id} dropped after bounded recovery: ${error.message}`), { cause: error });
  }
  async start() {
    for (;;) {
      try { await this.ensure(); return; }
      catch (error) {
        if (this.closed || this.signal?.aborted || this.state.dropped) throw error;
        await this.fail(error, 'startup');
      }
    }
  }
  async ask(prompt, timeoutMs) {
    this.checkOpen();
    if (this.busy) throw new Error(`${this.id} already has a turn`);
    this.busy = true;
    try {
      for (;;) {
        try {
          await this.ensure();
          const result = await this.agent.ask(prompt, timeoutMs);
          if (result.stopReason !== 'end_turn') throw Object.assign(new Error(`${this.id} stopped: ${result.stopReason}`), { stopReason: result.stopReason, partialText: result.text });
          this.history.push({ prompt, reply: result.text });
          this.state.ok = true;
          this.state.stopReason = result.stopReason;
          this.state.nativeSessionId = this.agent.nativeSessionId ?? null;
          this.state.effectiveModel = this.agent.effectiveModel ?? null;
          this.update();
          return result;
        } catch (error) {
          if (this.closed || this.signal?.aborted || this.state.dropped) throw error;
          await this.fail(error, 'turn');
        }
      }
    } finally { this.busy = false; }
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.ownedAgents].map(agent => agent.close()));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, `${this.id} cleanup failed`);
  }
}
