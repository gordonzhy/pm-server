import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {deliverReminder,reminderMessage} from '../lib/reminder-delivery.mjs';
const manager='22222222-2222-4222-8222-222222222222',execution='11111111-1111-4111-8111-111111111111',other='33333333-3333-4333-8333-333333333333';
const cli=fileURLToPath(new URL('../bin/pm-server.mjs',import.meta.url));
async function fixture(t){const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pm-reminder-'))),directory=path.join(root,'state');await mkdir(directory);t.after(()=>rm(root,{recursive:true,force:true}));return {root,directory};}
test('manager batches scopes and isolates managers; failed/uncertain sends and clock rollback cannot hot-loop',async t=>{
 const f=await fixture(t);let sends=0;const send=async()=>{sends++;return {state:'ACCEPTED'};};
 const run=(now,queuedAt=0,target=manager)=>deliverReminder({directory:f.directory,manager:target,now,queuedAt,send});
 assert.equal((await run(0)).state,'BATCHING');assert.equal((await run(599999)).state,'BATCHING');assert.equal(sends,0);
 assert.equal((await run(600000)).state,'ACCEPTED');assert.equal((await run(600001,1)).coveredByBatch,true);assert.equal(sends,1);
 assert.equal((await run(600001,600001)).state,'BATCHING');assert.equal((await run(600001,0,other)).state,'ACCEPTED');assert.equal(sends,2);
 assert.equal((await run(1200001,600001)).state,'ACCEPTED');
 assert.equal((await deliverReminder({directory:f.directory,manager,queuedAt:1200002,now:1800002,send:async()=>{sends++;throw new Error('fixture');}})).state,'FAILED');
 assert.equal((await run(1800003,1200002)).state,'BATCHING');assert.equal(sends,4);assert.equal((await run(2400002,1200002)).state,'ACCEPTED');
 assert.equal((await run(10,0)).state,'CLOCK_REBASED');assert.equal(sends,5);
 const file=path.join(f.directory,'reminder-delivery',createHash('sha256').update('codex:default:'+manager).digest('hex')+'.json');await writeFile(file,'{broken');
 await assert.rejects(run(3000000,0),/STATE_UNAVAILABLE/);assert.equal(await readFile(file,'utf8'),'{broken');assert.equal(sends,5);
});
async function scenario(t){
 const f=await fixture(t),clock=path.join(f.root,'clock.mjs'),clockFile=path.join(f.root,'clock.txt'),cache=path.join(f.root,'runtime.csv'),queue=path.join(f.root,'queue.jsonl'),backend=path.join(f.root,'backend.mjs');let now=Date.parse('2026-01-02T12:00:00Z');
 await writeFile(clock,"import{readFileSync}from'node:fs';const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[Number(readFileSync(process.env.DEMO_CLOCK,'utf8'))]));}static now(){return Number(readFileSync(process.env.DEMO_CLOCK,'utf8'));}};");
 await writeFile(backend,"import{appendFileSync}from'node:fs';appendFileSync(process.env.DEMO_QUEUE,JSON.stringify(process.argv.slice(2))+'\\n');");
 const env={PATH:process.env.PATH,HOME:f.root,CODEX_HOME:path.join(f.root,'codex'),NODE_OPTIONS:'--import='+clock,DEMO_CLOCK:clockFile,DEMO_QUEUE:queue,PM_SERVER_STATE_DIR:f.directory,CODEX_SESSION_RUNTIME_CSV:cache,PROJECT_MANAGER_NOTIFY_BIN:process.execPath,PROJECT_MANAGER_NOTIFY_ARGS:JSON.stringify([backend,'{manager}','{message}'])};
 async function tick(ms){now+=ms;await writeFile(clockFile,String(now));}await tick(0);
 async function runtime(turn='turn-1',status='idle'){await writeFile(cache,`session_id,status,current_turn_id,status_at,last_seen_at\n${execution},${status},${turn},${new Date(now-300000).toISOString()},${new Date(now).toISOString()}\n`);}await runtime();
 async function project(name){const repo=path.join(f.root,name);await mkdir(repo);const row=['DEMO-001','进行中','2026-01-01T00:00:00Z','dispatch-demo',execution,'turn-1',manager];const save=()=>writeFile(path.join(repo,'TASKS.csv'),'id,status,modified_at,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id\n'+row.join(',')+'\n');await save();return {repo,row,save};}
 const raw=(p,action='once',extra=[])=>spawnSync(process.execPath,[cli,'monitor',action,'--repo',p.repo,'--state-dir',f.directory,...extra],{env,encoding:'utf8'});
 const run=(...a)=>{const r=raw(...a);assert.ok([0,3].includes(r.status),r.stderr);return r;};
 const messages=async()=>{try{return (await readFile(queue,'utf8')).trim().split('\n').map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
 const state=p=>path.join(f.directory,'monitor',createHash('sha256').update(p.repo).digest('hex')+'.json');return {...f,env,tick,runtime,project,run,raw,messages,state,now:()=>now};
}
test('CLI deduplicates turns, aggregates projects, backs off, and resets new dispatch/manager independently',async t=>{
 const s=await scenario(t),a=await s.project('one'),b=await s.project('two');s.run(a);s.run(b);assert.equal((await s.messages()).length,0);
 await s.tick(600001);s.run(a);s.run(b);assert.equal((await s.messages()).length,1);assert.equal((await s.messages())[0][1],reminderMessage);
 for(let i=0;i<5;i++){await s.runtime('new-turn-'+i);a.row[5]='csv-turn-'+i;await a.save();s.run(a);}assert.equal((await s.messages()).length,1);
 await s.runtime('active','running');s.run(a);await s.runtime();s.run(a);assert.equal((await s.messages()).length,1);
 let status=JSON.parse(s.run(a,'status').stdout);assert.equal(status.tasks['DEMO-001'].checkpoint,null);assert.equal(status.tasks['DEMO-001'].reminders.recovery.attempts,1);
 await s.tick(3600001);await s.runtime();s.run(a);assert.equal((await s.messages()).length,1);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,2);
 a.row[3]='new-dispatch';await a.save();s.run(a);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,3);
 a.row[6]=other;await a.save();s.run(a);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,4);
 for(const value of ['DEMO-001','dispatch-demo',execution,a.repo])assert.ok(!reminderMessage.includes(value));
});
test('explicit bounded checkpoint survives turns, expires, and rejects stale or unlimited handling',async t=>{
 const s=await scenario(t),a=await s.project('demo');s.run(a);const before=await readFile(path.join(a.repo,'TASKS.csv'),'utf8');
 const args=['--task','DEMO-001','--dispatch','dispatch-demo','--execution',execution,'--manager',manager,'--actor','fixture','--reason','checking a fictional result','--until',new Date(s.now()+1800000).toISOString()];
 assert.equal(JSON.parse(s.run(a,'checkpoint',args).stdout).state,'PROCESSING');await s.runtime('next-turn');a.row[5]='next-csv-turn';await a.save();await s.tick(600001);assert.match(s.run(a).stdout,/PROCESSING/);assert.equal((await s.messages()).length,0);
 await s.tick(1200000);await s.runtime();s.run(a);assert.equal(JSON.parse(s.run(a,'status').stdout).tasks['DEMO-001'].checkpoint,null);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,1);
 assert.equal(s.raw(a,'checkpoint',args.slice(0,-2)).status,2);assert.equal(s.raw(a,'checkpoint',[...args.slice(0,-1),new Date(s.now()+86400001).toISOString()]).status,2);
 const stale=[...args];stale[stale.indexOf('--dispatch')+1]='stale';stale[stale.length-1]=new Date(s.now()+600000).toISOString();assert.equal(s.raw(a,'checkpoint',stale).status,2);
 assert.equal((await readFile(path.join(a.repo,'TASKS.csv'),'utf8')).replace('next-csv-turn','turn-1'),before);
});
test('old private receipt avoids an upgrade flood; corruption fails closed and preserves evidence',async t=>{
 const s=await scenario(t),a=await s.project('legacy'),file=s.state(a);await mkdir(path.dirname(file));
 await writeFile(file,JSON.stringify({version:1,tasks:{'DEMO-001':{scope:JSON.stringify(['dispatch-demo',execution,'legacy-turn','codex:default:'+manager]),recovery_state:'sent',recovery_state_at:new Date(s.now()).toISOString(),recovery_turn_id:'old-runtime-generation'}}}));
 s.run(a);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,0);for(const corrupt of ['bad',JSON.stringify({version:1,tasks:[]}),JSON.stringify({version:1,tasks:'invalid'})]){await writeFile(file,corrupt);assert.equal(s.raw(a).status,1);assert.equal(await readFile(file,'utf8'),corrupt);}assert.equal((await s.messages()).length,0);
});

test('new observation cause and an expired handled checkpoint do not inherit a legacy recovery cooldown',async t=>{
 const s=await scenario(t),a=await s.project('causes');s.run(a);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,1);
 await s.runtime('warning','unknown');s.run(a);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,2);
 const args=['--task','DEMO-001','--dispatch','dispatch-demo','--execution',execution,'--manager',manager,'--actor','fixture','--reason','checking','--until',new Date(s.now()+600000).toISOString()];
 s.run(a,'checkpoint',args);await s.runtime();await s.tick(600000);s.run(a);await s.tick(600001);s.run(a);assert.equal((await s.messages()).length,3);
});

test('scope changes while execution is active persist invalidation even without a delivery receipt',async t=>{
 const s=await scenario(t),a=await s.project('scope-round-trip');await s.runtime('active','running');
 const args=['--task','DEMO-001','--dispatch','dispatch-demo','--execution',execution,'--manager',manager,'--actor','fixture','--reason','checking','--until',new Date(s.now()+600000).toISOString()];s.run(a,'checkpoint',args);
 a.row[3]='different-dispatch';await a.save();s.run(a);a.row[3]='dispatch-demo';await a.save();await s.runtime();assert.doesNotMatch(s.run(a).stdout,/PROCESSING/);assert.equal(JSON.parse(s.run(a,'status').stdout).tasks['DEMO-001'].checkpoint,null);
});
