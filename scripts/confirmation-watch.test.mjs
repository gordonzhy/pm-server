import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {watchConfirmations,confirmationMessage} from './confirmation-watch.mjs';
const exec=promisify(execFile),scripts=path.dirname(fileURLToPath(import.meta.url));
const manager='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const headers=['id','status','priority','boundary','title','dependencies','executor','created_at','modified_at','detail_path','dispatch_id','execution_thread_id','execution_turn_id','manager_thread_id','recovery_turn_id','recovery_state','recovery_state_at'];
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-confirmation-')),directory=path.join(root,'state'),queue=path.join(root,'queue.jsonl');await mkdir(directory);
 t.after(()=>rm(root,{recursive:true,force:true}));
 const fake=path.join(root,'receiver.mjs');await writeFile(fake,"import{appendFileSync}from'node:fs';appendFileSync(process.env.DEMO_QUEUE,JSON.stringify(process.argv.slice(2))+'\\n');if(process.env.DEMO_FAIL==='1')process.exit(1);\n");
 const env={...process.env,HOME:root,CODEX_HOME:path.join(root,'codex'),PROJECT_MANAGER_HOST_HOME:path.join(root,'codex'),CODEX_SESSION_RUNTIME_CSV:path.join(root,'absent.csv'),PROJECT_MANAGER_NOTIFY_DISABLED:'0',PROJECT_MANAGER_CODEX_BIN:'',PROJECT_MANAGER_NOTIFY_BIN:process.execPath,PROJECT_MANAGER_NOTIFY_ARGS:JSON.stringify([fake,'{manager}','{kind}','{message}']),DEMO_QUEUE:queue};
 const registry={version:1,revision:1,projects:[],pending:[],removed:[]};
 const saveRegistry=()=>writeFile(path.join(directory,'registry.json'),JSON.stringify(registry));
 async function project(index=0,route=manager,modified=new Date(Date.now()-7200000).toISOString()){
  const repo=path.join(root,'project-'+index);await mkdir(repo);await mkdir(path.join(repo,'tasks'));
  const p={id:'demo-'+index,name:'Example '+index,root:repo,csvPath:path.join(repo,'TASKS.csv')};
  const rows=[['DEMO-'+index,'待确认','P2','demo','PRIVATE_CANARY_TITLE','[]','',modified,modified,'tasks/card.md','','','','stale-route','','','']];
  await writeFile(path.join(repo,'tasks/card.md'),'PRIVATE_CANARY_DETAIL\nwaiting for a decision\n');
  async function config(id=route){await writeFile(path.join(repo,'project-manager.config.json'),JSON.stringify({configVersion:1,project:{name:'Example',prefix:'DEMO'},taskSystem:{csv:'TASKS.csv',detailsDir:'tasks'},...(id?{manager:{threadId:id,registeredAt:new Date().toISOString()}}:{})}));}
  async function save(){await writeFile(p.csvPath,[headers,...rows].map(r=>r.join(',')).join('\n')+'\n');}
  await config();await save();registry.projects.push(p);await saveRegistry();return {p,rows,save,config};
 }
 async function messages(){try{return (await readFile(queue,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 const run=(opts={})=>watchConfirmations({directory,env,...opts});
 return {root,directory,env,registry,saveRegistry,project,run,messages};
}
test('pending-only worker sends one cross-project aggregate without execution observation; source unchanged',async t=>{
 const f=await fixture(t),a=await f.project(0),b=await f.project(1);const originals=await Promise.all([a,b].map(x=>readFile(x.p.csvPath,'utf8')));
 await exec(process.execPath,[path.join(scripts,'run-task-monitor.mjs'),'--state-dir',f.directory,'--once'],{env:f.env});
 const health=JSON.parse(await readFile(path.join(f.directory,'task-monitor.json'),'utf8'));assert.equal(health.confirmationWatch.accepted,2);assert.equal(health.confirmationWatch.awaiting,2);
 const messages=(await f.messages()).filter(x=>x[1]==='confirmation');assert.equal(messages.length,1);assert.equal(messages[0][2],confirmationMessage);assert.ok(!JSON.stringify(messages).includes('PRIVATE_CANARY'));assert.equal(messages[0][0],'codex:default:'+manager);
 assert.deepEqual(await Promise.all([a,b].map(x=>readFile(x.p.csvPath,'utf8'))),originals);
 await exec(process.execPath,[path.join(scripts,'run-task-monitor.mjs'),'--state-dir',f.directory,'--once'],{env:f.env});assert.equal((await f.messages()).filter(x=>x[1]==='confirmation').length,1);
});
test('new and invalid timestamps age from first seen; accepted reminders repeat after cooldown',async t=>{
 const f=await fixture(t),a=await f.project(),now=Date.now();a.rows[0][8]='invalid';await a.save();
 assert.equal((await f.run({now})).accepted,0);assert.equal((await f.run({now:now+3600001})).accepted,1);
 assert.equal((await f.run({now:now+7200000})).accepted,0);assert.equal((await f.run({now:now+90000002})).accepted,1);
 for(const timestamp of ['',new Date(now+1000000000).toISOString(),new Date(now).toISOString()]){a.rows[0][8]=timestamp;await a.save();assert.equal((await f.run({now})).accepted,0);assert.equal((await f.run({now:now+3600001})).accepted,1);}
});
test('status departure, reentry, card changes and manager changes invalidate episodes',async t=>{
 const f=await fixture(t),a=await f.project(),now=Date.now();assert.equal((await f.run({now})).accepted,1);
 for(const status of ['已完成','已取消','受阻','待办','进行中']){a.rows[0][1]=status;await a.save();assert.equal((await f.run({now})).awaiting,0);}
 a.rows[0][1]='待确认';await a.save();assert.equal((await f.run({now})).accepted,0);assert.equal((await f.run({now:now+3600001})).accepted,1);
 await writeFile(path.join(a.p.root,'tasks/card.md'),'new evidence');assert.equal((await f.run({now:now+3600002})).accepted,0);
 await a.config(other);assert.equal((await f.run({now:now+7200003})).accepted,0);assert.equal((await f.run({now:now+10800004})).accepted,1);assert.equal((await f.messages()).at(-1)[0],'codex:default:'+other);
});
test('disabled and failed deliveries are visible and rate limited; no manager or corrupt project isolated',async t=>{
 const f=await fixture(t),a=await f.project(),now=Date.now();let result=await f.run({now,env:{...f.env,PROJECT_MANAGER_NOTIFY_DISABLED:'1'}});assert.equal(result.failed,1);assert.equal(result.state,'WARNING');
 assert.equal((await f.run({now:now+1})).accepted,0);assert.equal((await f.run({now:now+300001,env:{...f.env,DEMO_FAIL:'1'}})).failed,1);assert.equal((await f.run({now:now+600002})).accepted,1);
 await a.config(null);result=await f.run({now:now+600003});assert.ok(result.diagnostics.includes('MANAGER_UNAVAILABLE'));assert.equal(result.accepted,0);
 const b=await f.project(1);await writeFile(a.p.csvPath,'broken');result=await f.run();assert.equal(result.accepted,1);assert.ok(result.diagnostics.includes('PROJECT_SOURCE_UNAVAILABLE'));
 f.registry.projects=[];await f.saveRegistry();assert.equal((await f.run()).awaiting,0);
});
test('concurrent watchers persist a single accepted reminder',async t=>{
 const f=await fixture(t);await f.project();const results=await Promise.all([f.run(),f.run()]);assert.equal(results.reduce((n,r)=>n+r.accepted,0),1);assert.equal((await f.messages()).length,1);
});
test('send-time revalidation rejects removal, status changes, route changes and source updates',async t=>{
 for(const change of ['remove','status','route','detail']){
  const f=await fixture(t),a=await f.project();
  // onProgress is the worker heartbeat; a synchronous external writer races the final scan.
  const {writeFileSync}=await import('node:fs');
  const result=await f.run({onProgress:()=>{
   if(change==='remove'){f.registry.projects=[];writeFileSync(path.join(f.directory,'registry.json'),JSON.stringify(f.registry));}
   if(change==='status'){a.rows[0][1]='已完成';writeFileSync(a.p.csvPath,[headers,...a.rows].map(r=>r.join(',')).join('\n')+'\n');}
   if(change==='route')writeFileSync(path.join(a.p.root,'project-manager.config.json'),JSON.stringify({configVersion:1,project:{name:'Example',prefix:'DEMO'},manager:{threadId:other,registeredAt:new Date().toISOString()}}));
   if(change==='detail')writeFileSync(path.join(a.p.root,'tasks/card.md'),'changed');
  }});assert.equal(result.accepted,0);assert.equal((await f.messages()).length,0);
 }
});
test('failed delivery has a fast retry budget and health retains failures during cooldown',async t=>{
 const f=await fixture(t);await f.project();const now=Date.now(),env={...f.env,DEMO_FAIL:'1'};
 for(const offset of [0,300001,600002])assert.equal((await f.run({now:now+offset,env})).failed,1);
 const cooling=await f.run({now:now+900003,env});assert.equal(cooling.failed,0);assert.equal(cooling.delivery.failed,1);assert.equal(cooling.state,'WARNING');assert.equal((await f.messages()).length,3);
 assert.equal((await f.run({now:now+87000003,env})).failed,1);
});
test('temporary source errors preserve cooldown, whereas explicit removal forgets the episode',async t=>{
 const f=await fixture(t),a=await f.project(),now=Date.now();assert.equal((await f.run({now})).accepted,1);const csv=await readFile(a.p.csvPath,'utf8');await writeFile(a.p.csvPath,'bad');assert.ok((await f.run({now:now+1})).diagnostics.includes('PROJECT_SOURCE_UNAVAILABLE'));
 await writeFile(a.p.csvPath,csv);const restored=await f.run({now:now+2});assert.equal(restored.accepted,0);assert.equal(restored.cooling,1);
 f.registry.projects=[];await f.saveRegistry();await f.run({now:now+3});assert.deepEqual(JSON.parse(await readFile(path.join(f.directory,'confirmation-watch.json'),'utf8')).tasks,{});
});
