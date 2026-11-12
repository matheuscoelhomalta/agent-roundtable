import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { terminateProcess, withTimeout } from './runtime.mjs';

test('cleanup kills a SIGTERM-ignoring descendant after its direct parent has exited', { timeout: 5000 }, async () => {
  const grandchild = "process.on('SIGTERM',()=>{});console.log('READY '+process.pid);setInterval(()=>{},1000);";
  const source = `const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore',process.stdout,process.stderr]});child.unref();`;
  const proc = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(proc, 'exit');
  let text = '';
  const ready = new Promise(resolve => proc.stdout.on('data', data => {
    text += data;
    const match = text.match(/READY (\d+)/);
    if (match) resolve(Number(match[1]));
  }));
  try {
    const pid = await withTimeout(ready, 2000, 'descendant fixture startup');
    await exited;
    assert.equal(proc.exitCode, 0);
    assert.doesNotThrow(() => process.kill(pid, 0));
    await terminateProcess(proc, 30);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
});
