import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,realpath,utimes} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {acquireProcessLock} from './process-lock.mjs';
const hook=new URL('./session-runtime-hook.mjs',import.meta.url);
async function fixture(){const home=await mkdtemp(path.join(os.tmpdir(),'observer-budget-')),state=path.join(home,'state');await mkdir(state);const canonical=await realpath(state);return {home,state,csv:path.join(canonical,'session-runtime.csv'),env:{...process.env,HOME:home,CODEX_HOME:home,PM_SERVER_STATE_DIR:state,CODEX_SESSION_RUNTIME_CSV:path.join(canonical,'session-runtime.csv')}};}
function run(fx,event){return new Promise((resolve,reject)=>{const start=performance.now(),child=spawn(process.execPath,[hook.pathname],{env:fx.env,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.stdin.on('error',()=>{});child.on('close',code=>resolve({code,stderr,ms:performance.now()-start}));child.stdin.end(typeof event==='string'?event:JSON.stringify(event));});}
const event=(name,sequence)=>({hook_event_name:name,session_id:'fixture-session',turn_id:'fixture-turn',sequence});
test('all eight events keep states, large payloads stay private, stale concurrent events cannot regress',async()=>{
 const fx=await fixture();let sequence=0;
 for(const [name,status] of Object.entries({SessionStart:'idle',UserPromptSubmit:'running',PreToolUse:'running',PostToolUse:'running',PermissionRequest:'waiting',Stop:'idle',Interrupt:'interrupted',SessionEnd:'ended'})){
  const result=await run(fx,{tool_response:'SYNTHETIC_PRIVATE_IMAGE'.repeat(60000),...event(name,++sequence)});assert.equal(result.code,0,result.stderr);assert.ok(result.ms<2800);
  assert.equal(JSON.parse(await readFile(fx.csv+'.json')).sessions['fixture-session'].status,status);
 }
 await Promise.all([run(fx,event('Stop',50)),run(fx,event('PreToolUse',49))]);
 assert.equal(JSON.parse(await readFile(fx.csv+'.json')).sessions['fixture-session'].sequence,50);
 for(const file of await readdir(fx.state)){const content=await readFile(path.join(fx.state,file),'utf8');assert.doesNotMatch(content,/SYNTHETIC_PRIVATE_IMAGE|tool_response/);}
 const before=await readFile(fx.csv,'utf8');assert.equal((await run(fx,event('__proto__',51))).code,0);assert.equal(await readFile(fx.csv,'utf8'),before);
});
test('cache contention degrades within budget with fixed diagnostics and recovers',async()=>{
 const fx=await fixture(),lockPath=path.join(os.tmpdir(),`pm-server-cache-${createHash('sha256').update(fx.csv).digest('hex').slice(0,16)}.lock`),lock=await acquireProcessLock(lockPath);
 try{
  for(let i=0;i<2;i++){const r=await run(fx,event('PreToolUse',i));assert.equal(r.code,0);assert.equal(r.stderr,'');assert.ok(r.ms<2000);}
  const diagnostic=await readFile(path.join(fx.state,'hook-diagnostic.json'),'utf8');assert.equal(JSON.parse(diagnostic).code,'OBSERVER_CACHE_UNAVAILABLE');
  await run(fx,event('PreToolUse',2));assert.equal(await readFile(path.join(fx.state,'hook-diagnostic.json'),'utf8'),diagnostic);
  await assert.rejects(readFile(fx.csv));
 }finally{await lock.release();}
 assert.equal((await run(fx,event('PostToolUse',3))).code,0);assert.match(await readFile(fx.csv,'utf8'),/fixture-session,running/);
});
test('cache write failure is optional, malformed metadata rejects without raw diagnostics',async()=>{
 const fx=await fixture();await writeFile(fx.csv+'.json','invalid snapshot');
 const r=await run(fx,event('Stop',1));assert.equal(r.code,0);assert.equal(r.stderr,'');assert.equal(JSON.parse(await readFile(path.join(fx.state,'hook-diagnostic.json'))).code,'OBSERVER_CACHE_UNAVAILABLE');
 const rejected=await run(fx,'{"session_id":"secret fixture","sequence":{},"hook_event_name":"Stop"}');assert.equal(rejected.code,1);assert.doesNotMatch(rejected.stderr,/secret fixture|file:\/\//);
});
test('stalled input is bounded by the observer watchdog',async()=>{
 const fx=await fixture(),start=performance.now();const child=spawn(process.execPath,[hook.pathname],{env:fx.env,stdio:['pipe','pipe','pipe']});child.stdin.on('error',()=>{});child.stdin.write('{"tool_input":"');
 const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,0);assert.ok(performance.now()-start<2900);assert.equal(JSON.parse(await readFile(path.join(fx.state,'hook-diagnostic.json'))).code,'OBSERVER_BUDGET_EXHAUSTED');
});

test('diagnostics recover stale rate locks and use private fallback for a broken state directory',async()=>{
 const fx=await fixture(),file=path.join(fx.state,'hook-diagnostic.json'),lock=file+'.lock';
 await mkdir(lock);await utimes(lock,new Date(0),new Date(0));await writeFile(fx.csv+'.json','broken');
 assert.equal((await run(fx,event('Stop',1))).code,0);assert.equal(JSON.parse(await readFile(file)).code,'OBSERVER_CACHE_UNAVAILABLE');
 const blocked=path.join(fx.home,'blocked');await writeFile(blocked,'x');fx.env.PM_SERVER_STATE_DIR=blocked;fx.env.CODEX_SESSION_RUNTIME_CSV=path.join(blocked,'session-runtime.csv');
 const fallback=path.join(os.tmpdir(),`pm-server-hook-diagnostic-${createHash('sha256').update(blocked).digest('hex').slice(0,16)}.json`);
 const r=await run(fx,event('Stop',2));assert.equal(r.code,0);assert.equal(r.stderr,'');assert.deepEqual(Object.keys(JSON.parse(await readFile(fallback))).sort(),['at','code','version']);
 const before=await readFile(fallback,'utf8');await run(fx,event('Stop',3));assert.equal(await readFile(fallback,'utf8'),before);
});
