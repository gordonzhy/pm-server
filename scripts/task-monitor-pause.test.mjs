import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {monitorScope,monitorScopeMatches} from './task-monitor-policy.mjs';
const cli=fileURLToPath(new URL('../bin/pm-server.mjs',import.meta.url));
const manager='22222222-2222-4222-8222-222222222222',execution='11111111-1111-4111-8111-111111111111';
const headers='id,status,modified_at,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,recovery_turn_id,recovery_state,recovery_state_at';
async function fixture(t,{registered=true}={}){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pm-pause-'))),repo=path.join(root,'demo'),state=path.join(root,'state'),home=path.join(root,'home'),cache=path.join(state,'runtime.csv'),queue=path.join(root,'queue.log'),fake=path.join(root,'notify');
 await Promise.all([mkdir(repo),mkdir(state),mkdir(home)]);t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(fake,'#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROJECT_MANAGER_QUEUE_LOG"\n');await chmod(fake,0o755);
 const config={configVersion:1,project:{name:'Fictional example',prefix:'DEMO'},taskSystem:{csv:'TASKS.csv',detailsDir:'work-items'}};
 if(registered)config.manager={threadId:manager,registeredAt:new Date().toISOString()};
 const saveConfig=()=>writeFile(path.join(repo,'project-manager.config.json'),JSON.stringify(config));await saveConfig();
 const row=['DEMO-001','进行中','2000-01-01T00:00:00Z','dispatch-demo',execution,'',manager,'','',''];
 const saveTask=()=>writeFile(path.join(repo,'TASKS.csv'),headers+'\n'+row.join(',')+'\n');await saveTask();
 const saveRuntime=turn=>writeFile(cache,`session_id,status,current_turn_id,status_at,last_seen_at\n${execution},running,${turn},2000-01-01T00:00:00Z,2000-01-01T00:00:00Z\n`);await saveRuntime('');
 const env={HOME:home,PATH:process.env.PATH,CODEX_HOME:path.join(home,'.codex'),PM_SERVER_STATE_DIR:state,CODEX_SESSION_RUNTIME_CSV:cache,PROJECT_MANAGER_NOTIFY_BIN:fake,PROJECT_MANAGER_NOTIFY_ARGS:'["{kind}"]',PROJECT_MANAGER_QUEUE_LOG:queue,PM_SERVER_INSTANCE:'default'};
 const args=action=>[cli,'monitor',action,'--repo',repo,'--state-dir',state,...(action==='pause'?['--task','DEMO-001','--until','2099-01-01T00:00:00Z','--reason','synthetic wait','--actor','fixture']:[])];
 const run=action=>{const r=spawnSync(process.execPath,args(action),{env,encoding:'utf8'});if(r.error)throw r.error;assert.ok([0,3].includes(r.status),r.stderr);return r;};
 const asyncRun=action=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,args(action),{env});let stderr='';p.stderr.on('data',d=>stderr+=d);p.stdout.resume();p.on('error',reject);p.on('close',code=>[0,3].includes(code)?resolve():reject(new Error(stderr)));});
 const file=path.join(state,'monitor',createHash('sha256').update(repo).digest('hex')+'.json');
 const snapshot=async()=>JSON.parse(await readFile(file,'utf8'));
 const notifications=async()=>{try{return await readFile(queue,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}};
 return {config,row,repo,file,saveConfig,saveTask,saveRuntime,run,asyncRun,snapshot,notifications};
}
test('monitor scope canonicalizes equivalent manager references and binds registered manager',()=>{
 const task={dispatch_id:'d',execution_thread_id:execution,manager_thread_id:manager};
 assert.equal(monitorScope(task,manager),monitorScope({...task,manager_thread_id:'codex:default:'+manager},'codex:default:'+manager));
 assert.notEqual(monitorScope(task),monitorScope(task,manager));
 assert.notEqual(monitorScope(task,manager),monitorScope(task,execution));
});
for(const registered of [false,true])test(`CLI pause suppresses stale warnings through repeated cycles (registered=${registered})`,async t=>{
 const fx=await fixture(t,{registered}),before=await readFile(path.join(fx.repo,'TASKS.csv'),'utf8');
 assert.equal(JSON.parse(fx.run('pause').stdout).taskFilesChanged,false);
 let paused=await fx.snapshot();paused.tasks['DEMO-OTHER']={scope:'unrelated',monitor_pause_reason:'other fixture'};await writeFile(fx.file,JSON.stringify(paused));
 fx.run('pause');assert.deepEqual((await fx.snapshot()).tasks['DEMO-OTHER'],paused.tasks['DEMO-OTHER']);paused=await fx.snapshot();
 fx.run('once');fx.run('once');
 assert.deepEqual(await fx.snapshot(),paused);assert.equal(await fx.notifications(),'');assert.equal(await readFile(path.join(fx.repo,'TASKS.csv'),'utf8'),before);
});
test('equivalent task and registered manager encodings retain pause',async t=>{
 const fx=await fixture(t);fx.run('pause');fx.row[6]='codex:default:'+manager;await fx.saveTask();fx.config.manager.threadId='codex:default:'+manager;await fx.saveConfig();fx.run('once');
 assert.ok((await fx.snapshot()).tasks['DEMO-001'].monitor_pause_until);assert.equal(await fx.notifications(),'');
});
for(const change of ['registered manager','task manager','dispatch','execution','csv turn','runtime turn','status','deadline','legacy scope'])test(`pause invalidates on ${change}`,async t=>{
 const fx=await fixture(t);fx.run('pause');
 if(change==='registered manager'){fx.config.manager.threadId=execution;await fx.saveConfig();}
 if(change==='task manager')fx.row[6]=execution;
 if(change==='dispatch')fx.row[3]='new-dispatch';
 if(change==='execution')fx.row[4]=manager;
 if(change==='csv turn')fx.row[5]='new-turn';
 if(change==='status')fx.row[1]='待办';
 await fx.saveTask();
 if(change==='runtime turn')await fx.saveRuntime('new-turn');
 if(['deadline','legacy scope'].includes(change)){const s=await fx.snapshot(),task=s.tasks['DEMO-001'];if(change==='deadline')task.monitor_pause_until='2000-01-01T00:00:00Z';else task.scope=JSON.stringify(JSON.parse(task.scope).slice(0,4));await writeFile(fx.file,JSON.stringify(s));}
 fx.run('once');
 const s=await fx.snapshot();
 assert.equal(s.tasks['DEMO-001'].monitor_pause_until,'');
 if(change==='execution'){fx.row[4]=execution;await fx.saveTask();fx.run('once');assert.equal((await fx.snapshot()).tasks['DEMO-001'].monitor_pause_until,'');assert.equal((await fx.notifications()).trim(),'');}
 if(!['status','execution'].includes(change))assert.equal((await fx.notifications()).trim(),'');
});
test('concurrent CLI pause and monitor cycles preserve the final pause',async t=>{
 const fx=await fixture(t);fx.run('pause');await Promise.all([fx.asyncRun('pause'),fx.asyncRun('once')]);fx.run('once');
 assert.ok((await fx.snapshot()).tasks['DEMO-001'].monitor_pause_until);assert.equal(await fx.notifications(),'');
});

for(const registered of [false,true])test(`legacy complete scope retains equivalent manager encoding and dedup (registered=${registered})`,async t=>{
 const fx=await fixture(t,{registered});fx.run('pause');const before=await fx.snapshot(),task=before.tasks['DEMO-001'];
 const scope=JSON.parse(task.scope);scope[3]=manager;task.scope=JSON.stringify(scope);
 const pause=JSON.parse(task.monitor_pause_scope);pause.manager=manager;task.monitor_pause_scope=JSON.stringify(pause);
 Object.assign(task,{recovery_turn_id:'previous-warning',recovery_state:'warning-sent',recovery_state_at:'2026-01-01T00:00:00Z'});
 await writeFile(fx.file,JSON.stringify(before));fx.run('once');fx.run('once');
 assert.deepEqual(await fx.snapshot(),before);assert.equal(await fx.notifications(),'');
});
test('scope compatibility requires complete shape and rejects true manager changes',()=>{
 const task={dispatch_id:'d',execution_thread_id:execution,manager_thread_id:manager};
 const legacy=JSON.stringify(['d',execution,'',manager,'codex:default:'+manager]);
 assert.equal(monitorScopeMatches(legacy,task,manager),true);
 assert.equal(monitorScopeMatches(legacy,{...task,manager_thread_id:execution},manager),false);
 assert.equal(monitorScopeMatches(legacy,task,execution),false);
 assert.equal(monitorScopeMatches(JSON.stringify(['d',execution,'',manager]),task,manager),false);
 assert.equal(monitorScopeMatches(legacy,task),false);
 for(const invalid of ['{}','null','[1,2,3,4,5]','bad'])assert.equal(monitorScopeMatches(invalid,task,manager),false);
});
test('legacy five scope invalidates when registered manager really changes',async t=>{
 const fx=await fixture(t);fx.run('pause');const before=await fx.snapshot(),task=before.tasks['DEMO-001'],scope=JSON.parse(task.scope);scope[3]=manager;task.scope=JSON.stringify(scope);await writeFile(fx.file,JSON.stringify(before));
 fx.config.manager.threadId=execution;await fx.saveConfig();fx.run('once');
 assert.equal((await fx.snapshot()).tasks['DEMO-001'].monitor_pause_until,'');assert.equal((await fx.notifications()).trim(),'');
});
for(const registered of [false,true])test(`legacy complete scope retains warning dedup without a pause (registered=${registered})`,async t=>{
 const fx=await fixture(t,{registered});fx.run('once');assert.equal((await fx.notifications()).trim(),'');
 const before=await fx.snapshot(),task=before.tasks['DEMO-001'],scope=JSON.parse(task.scope);scope[3]=manager;task.scope=JSON.stringify(scope);await writeFile(fx.file,JSON.stringify(before));
 fx.run('once');assert.equal((await fx.snapshot()).tasks['DEMO-001'].scope,before.tasks['DEMO-001'].scope);assert.equal((await fx.notifications()).trim(),'');
});
