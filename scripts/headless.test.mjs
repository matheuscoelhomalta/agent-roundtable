import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { HeadlessAgent, parseHeadlessOutput, substituteArgs } from './headless.mjs';
import { Participant } from './recovery.mjs';

const fake = `
let input=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', d=>input+=d);
process.stdin.on('end', ()=>{
 const [protocol, mode, session] = process.argv.slice(1);
 if(mode==='hang'){ process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); return; }
 const id=session || 'explicit-native-id';
 const text=JSON.stringify({input,session:session || null});
 const stop=mode==='cancel'?'cancelled':'end_turn';
 const emit=e=>console.log(JSON.stringify(e));
 if(protocol==='codex') {emit({type:'thread.started',thread_id:id});emit({type:'item.completed',item:{type:'agent_message',text}});emit({type:'turn.completed'});}
 if(protocol==='claude') emit({type:'result',subtype:'success',session_id:id,result:text,stop_reason:stop});
 });`;
function cfg(protocol, mode='normal') {
 const args=[process.execPath,'-e',fake,protocol,mode];
 return {headless:{start:args,resume:[...args,'{session}'],input:'stdin',output:protocol==='codex'?'codex-jsonl':'json'}};
}
for(const protocol of ['codex','claude']) test(`${protocol}: three turns plus veto resume an explicit id and bootstrap once`, async()=>{
 const agent=new HeadlessAgent(protocol,cfg(protocol),process.cwd(),()=>{}, {history:[{prompt:'old prompt',reply:'old reply'}],graceMs:30});
 try {
  for(let turn=0;turn<4;turn++) {
   const response=await agent.ask(turn===3?'veto':`turn ${turn}`,2000);
   const decoded=JSON.parse(response.text);
   assert.equal(decoded.session,turn===0?null:'explicit-native-id');
   assert.equal(decoded.input.includes('old prompt'),turn===0);
   assert.equal(response.stopReason,'end_turn');
  }
 } finally {await agent.close();}
});
test('stdin preserves replacement tokens and a prompt larger than argv limits', async()=>{
 const agent=new HeadlessAgent('claude',cfg('claude'),process.cwd());
 const prompt='$$ $& {out} {cwd} {session}\n'+'x'.repeat(2_000_000);
 try {assert.equal(JSON.parse((await agent.ask(prompt,3000)).text).input,prompt);} finally {await agent.close();}
 assert.deepEqual(substituteArgs(['{cwd}/{session}'],{cwd:'$$ {session}',session:'$&'}),['$$ {session}/$&']);
});
test('non-end stop invalidates native id and does not commit completed history',async()=>{
 const agent=new HeadlessAgent('claude',cfg('claude','cancel'),process.cwd(),()=>{}, {nativeSessionId:'explicit-native-id'});
 const result=await agent.ask('cancel',2000);
 assert.equal(result.stopReason,'cancelled'); assert.equal(agent.nativeSessionId,null);assert.equal(agent.history.length,0);
 await agent.close();
});
test('timeout kills an uncooperative subprocess and clears session',async()=>{
 const agent=new HeadlessAgent('claude',cfg('claude','hang'),process.cwd(),()=>{}, {nativeSessionId:'explicit-native-id',graceMs:30});
 await assert.rejects(agent.ask('hang',200),/timed out/);
 assert.equal(agent.proc,null);assert.equal(agent.nativeSessionId,null);
 await agent.close();
});
test('spawn failure clears native id',async()=>{
 const bad=cfg('claude');bad.headless.resume=['/nonexistent/roundtable-cli','{session}'];
 const agent=new HeadlessAgent('claude',bad,process.cwd(),()=>{}, {nativeSessionId:'explicit-native-id'});
 await assert.rejects(agent.ask('hello',1000),/ENOENT/);assert.equal(agent.nativeSessionId,null);assert.equal(agent.proc,null);
});
test('reject unsupported adapters, missing terminal result, changed native id and malformed events',async()=>{
 await assert.rejects(new HeadlessAgent('other',{},process.cwd()).start(),/no validated/);
 assert.throws(()=>parseHeadlessOutput('json','{}'),/without a terminal/);
 assert.throws(()=>parseHeadlessOutput('json','noise'),/non-JSON/);
 const bad=cfg('claude');bad.headless.resume=[process.execPath,'-e',`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',sessionId:'wrong',finalText:'oops',stopReason:'end_turn'})))`,'{session}'];
 const agent=new HeadlessAgent('claude',bad,process.cwd(),()=>{}, {nativeSessionId:'explicit-native-id'});
 await assert.rejects(agent.ask('hello',1000),/changed the native/);assert.equal(agent.nativeSessionId,null);
});
test('Claude max-turn terminal result survives exit 8 and invalidates session',async()=>{
 const args=[process.execPath,'-e',`process.stdin.resume();process.stdin.on('end',()=>{console.log(JSON.stringify({type:'result',subtype:'max_turns',sessionId:'explicit-native-id',finalText:'partial',stopReason:'max_turns'}));process.exitCode=8;})`];
 const agent=new HeadlessAgent('claude',{headless:{start:args,resume:[...args,'{session}'],output:'json'}},process.cwd());
 const result=await agent.ask('hello',1000);assert.equal(result.stopReason,'max_turns');assert.equal(agent.nativeSessionId,null);assert.equal(agent.history.length,0);
});

test('close during deferred startup never spawns a late child; concurrent ask is rejected', async () => {
  const agent = new HeadlessAgent('deferred', {}, process.cwd());
  let release;
  agent.start = () => new Promise(resolve => { release = resolve; });
  const pending = agent.ask('task', 1000);
  await assert.rejects(agent.ask('competing task', 1000), /concurrent/);
  await agent.close();
  release();
  await assert.rejects(pending, /closed during startup/);
  assert.equal(agent.proc, null);
});

test('configured model flag is preserved on initial and resumed headless turns', async () => {
  const source = `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',sessionId:'explicit',stopReason:'end_turn',finalText:JSON.stringify(process.argv.slice(1))})));`;
  const config = { model: 'provider/deep', headless: { start: [process.execPath, '-e', source, '--'], resume: [process.execPath, '-e', source, '--', '{session}'], output: 'json' } };
  const agent = new HeadlessAgent('claude', config, process.cwd());
  try {
    assert.equal(agent.requestedModel, 'provider/deep');
    assert.equal(agent.effectiveModel, null);
    assert.deepEqual(JSON.parse((await agent.ask('one', 1000)).text), ['--model', 'provider/deep']);
    assert.deepEqual(JSON.parse((await agent.ask('two', 1000)).text), ['explicit', '--model', 'provider/deep']);
    assert.equal(agent.effectiveModel, null, 'a configured model is not a reported identity');
  } finally { await agent.close(); }
});


test('Antigravity stream input, three resumed turns and veto preserve prompt and session', async () => {
  const source = `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
    const request=JSON.parse(input); if(request.event!=='user') process.exit(2);
    const session=process.argv[1]||'agy-native';
    console.log(JSON.stringify({event:'init',conversation_id:session}));
    console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:session,response:request.message.content}}));
  });`;
  const args=[process.execPath,'-e',source,'--'];
  const agent=new HeadlessAgent('gemini',{headless:{start:args,resume:[...args,'{session}'],input:'antigravity-stream',output:'antigravity-jsonl'}},process.cwd());
  try {
    for(const prompt of ['round 1\n$& {session}', 'round 2', 'round 3', 'veto']) {
      const result=await agent.ask(prompt,2000);
      assert.equal(result.text,prompt);
      assert.equal(result.nativeSessionId,'agy-native');
    }
  } finally { await agent.close(); }
});

test('Antigravity errors and partial terminal results cannot count as completed turns', () => {
  for(const result of [{status:'ERROR'}, {status:'SUCCESS',finished_reason:'print_timeout'}]) {
    const line=JSON.stringify({event:'result',result:{conversation_id:'agy-native',response:'partial',...result}});
    assert.throws(()=>parseHeadlessOutput('antigravity-jsonl',line));
  }
  assert.throws(()=>parseHeadlessOutput('antigravity-jsonl','{"event":"init"}'));
});

test('Antigravity reports invalid JSON without ignoring a malformed line before a valid result', () => {
  const valid = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'agy-native', response: 'answer' } });
  for (const stdout of ['not-json\n' + valid, valid + '\nnot-json']) {
    assert.throws(() => parseHeadlessOutput('antigravity-jsonl', stdout), /Antigravity stdout contained invalid JSON/);
  }
});

for (const mode of ['success', 'failure', 'timeout']) {
  test(`headless removes its own scratch after ${mode}`, async () => {
    const source = `const fs=require('fs'),path=require('path');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
      const [out,mode]=process.argv.slice(1);fs.writeFileSync(out,'fixture response');
      const data={dir:path.dirname(out),prompt:input};
      if(mode==='timeout'){console.log(JSON.stringify(data));setInterval(()=>{},1000);return;}
      console.log(JSON.stringify({type:'result',subtype:'success',session_id:'cleanup-native',result:JSON.stringify(data)}));
      if(mode==='failure')process.exitCode=2;
    });`;
    const args = [process.execPath, '-e', source, '--', '{out}', mode];
    const agent = new HeadlessAgent('cleanup', { headless: { start: args, resume: [...args, '{session}'], output: 'json' } }, process.cwd(), () => {}, { graceMs: 30 });
    let data;
    try {
      if (mode === 'success') data = JSON.parse((await agent.ask('Private fixture prompt', 2000)).text);
      else await assert.rejects(agent.ask('Private fixture prompt', mode === 'timeout' ? 500 : 2000), error => {
        const partial = JSON.parse(error.partialText);
        data = mode === 'timeout' ? partial : JSON.parse(partial.result);
        assert.match(error.message, mode === 'timeout' ? /timed out/ : /exited 2/); return true;
      });
      assert.equal(data.prompt, 'Private fixture prompt');
      assert.equal(existsSync(data.dir), false); assert.equal(agent.proc, null);
    } finally { await agent.close(); }
  });
}

test('headless termination failure retains its process and prevents a replacement', { timeout: 6000 }, async () => {
  const originalKill = process.kill.bind(process);
  const args = [process.execPath, '-e', "process.stdin.resume();process.stdin.on('end',()=>setInterval(()=>{},1000));", '--', '{out}'];
  let agent, child, generations = 0;
  const participant = new Participant({ id: 'cleanup-fixture', factory() {
    generations++;
    if (generations > 1) throw new Error('replacement must not start');
    agent = new HeadlessAgent('cleanup-fixture', { headless: { start: args, resume: [...args, '{session}'], output: 'json' } }, process.cwd(), () => {}, { graceMs: 10 });
    return agent;
  } });
  const pending = participant.ask('fixture', 150);
  const rejected = assert.rejects(pending, /remains after bounded cleanup/);
  try {
    while (!agent?.proc?.pid) await new Promise(resolve => setTimeout(resolve, 5));
    child = agent.proc;
    process.kill = (pid, signal) => {
      if (Math.abs(pid) === child.pid) throw Object.assign(new Error('fixture signal denied'), { code: 'EPERM' });
      return originalKill(pid, signal);
    };
    await rejected;
    assert.equal(generations, 1);
    assert.equal(participant.state.dropped, true);
    assert.equal(agent.proc, child);
    assert.doesNotThrow(() => originalKill(child.pid, 0));
    await assert.rejects(participant.close(), /cleanup failed/);
  } finally {
    process.kill = originalKill;
    if (child) {
      const closed = child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve() : new Promise(resolve => child.once('close', resolve));
      try { originalKill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await closed;
      const scratch = dirname(child.spawnargs.at(-1));
      assert.ok(basename(scratch).startsWith('roundtable-'));
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('packaged Gemini permissions resolve on start and resume outside the skill directory', async () => {
  const registry = JSON.parse(readFileSync(new URL('../agents.json', import.meta.url), 'utf8'));
  const fixture = `const fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
    const argv=process.argv.slice(1);const path=argv[argv.indexOf('--settings')+1];
    const policy=JSON.parse(fs.readFileSync(path,'utf8'));
    console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:'policy-fixture',response:JSON.stringify({path,policy})}}));
  });`;
  const headless = registry.gemini.headless;
  const config = { headless: { ...headless,
    start: [process.execPath, '-e', fixture, '--', ...headless.start.slice(1)],
    resume: [process.execPath, '-e', fixture, '--', ...headless.resume.slice(1)],
  } };
  const agent = new HeadlessAgent('gemini', config, '/private/tmp');
  try {
    for (const prompt of ['initial', 'resumed']) {
      const response = JSON.parse((await agent.ask(prompt, 2000)).text);
      assert.equal(response.path.includes('{skill}'), false);
      assert.equal(response.policy.toolPermission, 'strict');
      assert.ok(response.policy.permissions.deny.includes('command(*)'));
      assert.ok(response.policy.permissions.deny.includes('write_file(*)'));
    }
  } finally { await agent.close(); }
});
