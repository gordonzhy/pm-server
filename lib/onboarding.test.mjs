import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {hookCommand,hookEvents,probeCodex} from './codex-integration.mjs';
import {sendNotification,notificationConfiguration,notificationDelivery,confirmNotification,prepareDefaultNotifications} from './notifications.mjs';
import {notificationManagers} from './onboarding.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const cli=path.join(root,'bin/pm-server.mjs'),installer=path.join(root,'scripts/install-session-runtime-hook.mjs'),hook=path.join(root,'scripts/session-runtime-hook.mjs');
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'pm-guide-')),home=path.join(dir,'codex'),state=path.join(dir,'state'),fake=path.join(dir,'codex-bin'),mode=path.join(dir,'mode.json');
 await mkdir(home);await mkdir(state);t.after(()=>rm(dir,{recursive:true,force:true}));
 await writeFile(mode,JSON.stringify({trust:'trusted',enabled:true}));
 const source=[
 '#!/usr/bin/env node',
 "const fs=require('node:fs'),rl=require('node:readline').createInterface({input:process.stdin});",
 'rl.on("line",line=>{const r=JSON.parse(line),m=JSON.parse(fs.readFileSync('+JSON.stringify(mode)+'));let result={};',
 'if(r.method==="hooks/list")result={data:[{errors:[],hooks:'+JSON.stringify(hookEvents.map(s=>s[0].toLowerCase()+s.slice(1)))+'.map(eventName=>({eventName,command:'+JSON.stringify(hookCommand)+',source:"user",enabled:m.enabled,trustStatus:m.trust}))}]};',
 'if(r.method==="account/read")result={account:m.loggedOut?null:{type:"chatgpt"}};',
 'if(r.id)console.log(JSON.stringify({id:r.id,result}));});'
 ].join('\n');
 await writeFile(fake,source);await chmod(fake,0o755);
 const env={...process.env,CODEX_HOME:home,PM_SERVER_STATE_DIR:state,PM_SERVER_CODEX_BIN:fake,CODEX_SESSION_RUNTIME_CSV:'',PROJECT_MANAGER_NOTIFY_BIN:'',PROJECT_MANAGER_CODEX_BIN:'',PROJECT_MANAGER_NOTIFY_DISABLED:''};
 const invoke=(...args)=>JSON.parse(execFileSync(process.execPath,[cli,...args],{env,encoding:'utf8'}));
 return {dir,home,state,fake,mode,env,invoke};
}
test('public host probe distinguishes trusted, modified, disabled and unavailable hooks',async t=>{
 const f=await fixture(t);
 assert.equal((await probeCodex({bin:f.fake,cwd:f.dir})).state,'TRUSTED');
 await writeFile(f.mode,JSON.stringify({trust:'modified',enabled:true}));
 assert.equal((await probeCodex({bin:f.fake,cwd:f.dir})).state,'REVIEW_REQUIRED');
 await writeFile(f.mode,JSON.stringify({trust:'trusted',enabled:false}));
 assert.equal((await probeCodex({bin:f.fake,cwd:f.dir})).state,'DISABLED');
 assert.equal((await probeCodex({bin:path.join(f.dir,'missing'),cwd:f.dir})).state,'UNKNOWN');
});
test('checklist requires current hook receipt; generic ingest and obsolete receipts cannot complete it',async t=>{
 const f=await fixture(t);execFileSync(process.execPath,[installer,'--install'],{env:f.env});
 const now=new Date().toISOString();await writeFile(path.join(f.state,'session-runtime.csv.json'),JSON.stringify({version:1,sessions:{fixture:{id:'codex:default:demo',status:'idle',turn:'',statusAt:now,lastSeenAt:now,occurredAt:now}}}));
 let value=f.invoke('doctor','--check-host').onboarding;
 assert.equal(value.codex.trust,'TRUSTED');assert.equal(value.codex.authentication,'UNKNOWN');
 assert.equal(value.sessionDiagnostics.checks.find(c=>c.id==='runtime-observation').status,'verify');
 execFileSync(process.execPath,[hook],{env:f.env,input:JSON.stringify({hook_event_name:'PostToolUse',session_id:'fixture-native',turn_id:'fixture-turn'})});
 value=f.invoke('doctor','--check-host').onboarding;assert.equal(value.codex.lifecycle,'TOOL_EVENT_OBSERVED');
 const config=JSON.parse(await readFile(path.join(f.home,'hooks.json'),'utf8'));config.hooks.Stop[0].hooks[0].timeout=2;await writeFile(path.join(f.home,'hooks.json'),JSON.stringify(config));
 await writeFile(f.mode,JSON.stringify({trust:'modified',enabled:true}));
 value=f.invoke('doctor','--check-host').onboarding;assert.equal(value.codex.trust,'REVIEW_REQUIRED');assert.equal(value.codex.lifecycle,'NOT_VERIFIED');
 await writeFile(f.mode,JSON.stringify({trust:'trusted',enabled:true,loggedOut:true}));
 assert.ok(!f.invoke('doctor','--check-host').onboarding.sessionDiagnostics.checks.some(c=>c.id==='codex-login'));
});
test('notification checks validate executable/arguments, require explicit receipt confirmation and invalidate changed backends',async t=>{
 const f=await fixture(t),bin=path.join(f.dir,'notifier'),log=path.join(f.dir,'argv.json');
 await writeFile(bin,'#!/usr/bin/env node\nrequire("node:fs").writeFileSync('+JSON.stringify(log)+',JSON.stringify(process.argv.slice(2)));');await chmod(bin,0o755);
 const env={...f.env,PROJECT_MANAGER_NOTIFY_BIN:bin,PROJECT_MANAGER_NOTIFY_ARGS:'["--to","{manager}","--message","{message}"]'};
 const config=await notificationConfiguration(env);assert.equal(config.state,'CONFIGURED_NOT_DELIVERY_VERIFIED');
 const target='codex:default:demo$(touch_NOT_EXECUTED)';
 await sendNotification({manager:target,message:'literal $() ; text',directory:f.state,env});
 assert.deepEqual(JSON.parse(await readFile(log)),['--to',target,'--message','literal $() ; text']);
 assert.equal((await notificationDelivery(f.state,config.signature)).state,'ACCEPTED');
 await confirmNotification({directory:f.state,env});assert.equal((await notificationDelivery(f.state,config.signature)).state,'OWNER_CONFIRMED');
 const changed=await notificationConfiguration({...env,PROJECT_MANAGER_NOTIFY_ARGS:'["{message}"]'});
 assert.equal((await notificationDelivery(f.state,changed.signature)).state,'NOT_VERIFIED');
 await assert.rejects(confirmNotification({directory:f.state,env:{...env,PROJECT_MANAGER_NOTIFY_ARGS:'["{message}"]'}}));
 assert.equal((await notificationConfiguration({...env,PROJECT_MANAGER_NOTIFY_ARGS:'[{}]'})).state,'INVALID_ARGUMENTS');
 assert.equal((await notificationConfiguration({...env,PROJECT_MANAGER_NOTIFY_BIN:path.join(f.dir,'missing')})).state,'EXECUTABLE_UNAVAILABLE');
});

test('startup prepares notifications only for a matching Codex binding and preserves explicit preferences',async t=>{
 const f=await fixture(t),binDir=path.join(f.dir,'bin'),bin=path.join(binDir,'codex');
 await mkdir(binDir);
 await writeFile(bin,'#!/bin/sh\nexit 0\n');await chmod(bin,0o755);
 const env={...f.env,PATH:binDir};
 assert.equal((await prepareDefaultNotifications({directory:f.state,env})).state,'NOT_CONFIGURED');
 await writeFile(path.join(f.home,'pm-server-observer.json'),JSON.stringify({version:1,stateDir:f.state}));
 assert.equal((await prepareDefaultNotifications({directory:f.state,env:{...env,PROJECT_MANAGER_NOTIFY_DISABLED:'1'}})).state,'DISABLED');
 await assert.rejects(readFile(path.join(f.state,'notification-config.json')));
 const custom={...env,PROJECT_MANAGER_NOTIFY_BIN:bin};
 assert.equal((await prepareDefaultNotifications({directory:f.state,env:custom})).backend,'custom');
 await assert.rejects(readFile(path.join(f.state,'notification-config.json')));
 assert.equal((await prepareDefaultNotifications({directory:f.state,env:{...env,PATH:''}})).state,'EXECUTABLE_UNAVAILABLE');
 await assert.rejects(readFile(path.join(f.state,'notification-config.json')));
 assert.equal((await prepareDefaultNotifications({directory:f.state,env})).state,'CONFIGURED_NOT_DELIVERY_VERIFIED');
 const file=path.join(f.state,'notification-config.json'),saved=await readFile(file,'utf8');
 assert.equal((await prepareDefaultNotifications({directory:f.state,env})).backend,'codex');assert.equal(await readFile(file,'utf8'),saved);
 await writeFile(file,JSON.stringify({version:1,backend:'disabled'}));
 assert.equal((await prepareDefaultNotifications({directory:f.state,env})).state,'NOT_CONFIGURED');assert.equal(JSON.parse(await readFile(file)).backend,'disabled');
});

test('manager choices deduplicate references, support native Codex UUIDs and exclude other Codex instances',()=>{
 const native='00000000-0000-4000-8000-000000000001',reference='codex:default:'+native;
 const snapshots=[{name:'Demo',tasks:[{id:'DEMO-001',manager_thread_id:native},{id:'DEMO-002',manager_thread_id:reference},{id:'DEMO-003',manager_thread_id:'codex:remote:other'},{id:'DEMO-004',manager_thread_id:'claude-code:default:other'},{id:'DEMO-005',manager_thread_id:'not-a-qualified-manager'}]}];
 assert.deepEqual(notificationManagers(snapshots,'codex'),[{reference,label:'Demo · DEMO-001 / Demo · DEMO-002'}]);
 assert.equal(notificationManagers(snapshots,'custom').length,3);
});

test('automatic notification manager selection prefers current active routes over historical managers',()=>{
 const snapshots=[{name:'Demo',tasks:[{id:'DEMO-OLD',status:'已完成',manager_thread_id:'codex:default:old'},{id:'DEMO-ACTIVE',status:'进行中',manager_thread_id:'codex:default:current'}]}];
 assert.deepEqual(notificationManagers(snapshots,'codex'),[{reference:'codex:default:current',label:'Demo · DEMO-ACTIVE'}]);
});

test('empty project manager is read from truth and is available for automatic notifications',async t=>{
 const f=await fixture(t),repo=path.join(f.dir,'empty');await mkdir(repo);
 const headers='id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at';
 const manager='22222222-2222-4222-8222-222222222222';
 await writeFile(path.join(repo,'TASKS.csv'),headers+'\n');
 await writeFile(path.join(repo,'project-manager.config.json'),JSON.stringify({configVersion:1,project:{name:'Empty',prefix:'EMPTY'},taskSystem:{csv:'TASKS.csv',detailsDir:'cards'},manager:{threadId:manager,registeredAt:new Date().toISOString()}}));
 const {projectSnapshot}=await import('../scripts/workbench-data.mjs');
 const snapshot=await projectSnapshot({id:'empty',name:'Empty',root:repo,csvRelative:'TASKS.csv'});
 assert.equal(snapshot.available,true);assert.equal(snapshot.tasks.length,0);assert.equal(snapshot.manager.threadId,manager);
 assert.equal(notificationManagers([snapshot],'codex')[0].reference,'codex:default:'+manager);
});

test('native UUID route matches qualified observation and missing cache is not a missing route',async t=>{
 const f=await fixture(t),repo=path.join(f.dir,'routed');await mkdir(repo);
 const execution='11111111-1111-4111-8111-111111111111',manager='22222222-2222-4222-8222-222222222222';
 await writeFile(path.join(repo,'TASKS.csv'),'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,manager_thread_id\nTEST-001,进行中,P1,Test,Test,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,card.md,d1,'+execution+','+manager+'\n');
 const {onboardingStatus}=await import('./onboarding.mjs');
 const projects=[{id:'test',name:'Test',root:repo,csvRelative:'TASKS.csv'}],cachePath=path.join(f.state,'runtimes');
 let result=await onboardingStatus({directory:f.state,cachePath,projects});
 assert.equal(result.projects.missingRoutes,0);assert.equal(result.projects.observationGaps,1);
 assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='routes').status,'complete');
 assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='routes').prompt,undefined);
 const sync=result.runtimeDiagnostics.checks.find(c=>c.id==='execution-observation');
 assert.equal(sync.status,'verify');
 const {synchronizationPrompt}=await import('./onboarding.mjs');
 assert.equal(sync.prompt,undefined);
 assert.ok(!result.checks.some(c=>c.id==='execution-observation'));
 assert.ok(!result.nextSteps.some(v=>v.includes(synchronizationPrompt)));assert.equal(sync.actions,undefined);
 for(const marker of [repo,'TEST-001',execution,manager])assert.ok(!result.nextSteps.join(' ').includes(marker));
 const otherRepo=path.join(f.dir,'different-private-repo');await mkdir(otherRepo);
 await writeFile(path.join(otherRepo,'TASKS.csv'),(await readFile(path.join(repo,'TASKS.csv'),'utf8')).replaceAll('TEST-001','OTHER-999').replaceAll(execution,'33333333-3333-4333-8333-333333333333').replaceAll(manager,'44444444-4444-4444-8444-444444444444'));
 const other=await onboardingStatus({directory:f.state,cachePath,projects:[{...projects[0],root:otherRepo,name:'Other private project',id:'other'}]});
 assert.equal(other.runtimeDiagnostics.checks.find(c=>c.id==='execution-observation').prompt,sync.prompt);
 const now=new Date().toISOString();
 await writeFile(cachePath+'.json',JSON.stringify({sessions:{execution:{id:'codex:default:'+execution,status:'running',lastSeenAt:now}}}));
 result=await onboardingStatus({directory:f.state,cachePath,projects});
 assert.equal(result.projects.observationGaps,0);assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='routes').status,'complete');
 assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='execution-observation').status,'complete');
 assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='execution-observation').prompt,undefined);
 await writeFile(cachePath+'.json',JSON.stringify({sessions:{execution:{id:'codex:default:'+execution,lastSeenAt:'2020-01-01T00:00:00Z'}}}));
 result=await onboardingStatus({directory:f.state,cachePath,projects});
 assert.equal(result.projects.missingRoutes,0);assert.equal(result.projects.routeIssues[0].reasons[0],'execution_observation_stale');
});
test('HTTP host checks separate unverified steps and recheck changed host state immediately',async t=>{
 const f=await fixture(t);execFileSync(process.execPath,[installer,'--install'],{env:f.env});
 const saved={...process.env};Object.assign(process.env,f.env);
 t.after(()=>{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);});
 const {startWorkbench,fetch}=await import('../scripts/workbench-test-client.mjs');
 const instance=await startWorkbench({stateDir:f.state,runtimePath:path.join(f.state,'session-runtime.csv'),port:0});t.after(()=>instance.close());
 const get=async query=>{const response=await fetch(instance.url+'api/onboarding'+query);assert.equal(response.status,200);return response.json();};
 const unknown=await get('');
 assert.ok(!unknown.sessionDiagnostics.checks.some(c=>c.id==='codex-login'));
 assert.equal(unknown.verificationCount,0);
 assert.equal(unknown.pendingCount,unknown.actionRequiredCount+unknown.verificationCount);
 assert.equal(unknown.state,'CHECKS_PASSED');
 const checked=await get('?checkHost=1');
 assert.equal(checked.codex.authentication,'UNKNOWN');assert.equal(checked.codex.trust,'TRUSTED');
 assert.equal(unknown.actionRequiredCount,checked.actionRequiredCount);
 assert.equal(checked.verificationCount,unknown.verificationCount);
 assert.ok(checked.codex.hostCheckedAt);
 await writeFile(f.mode,JSON.stringify({trust:'trusted',enabled:false,loggedOut:true}));
 const changed=await get('?checkHost=1');
 assert.equal(changed.codex.authentication,'UNKNOWN');assert.equal(changed.codex.trust,'DISABLED');
 assert.equal(changed.actionRequiredCount,checked.actionRequiredCount);
 assert.ok(!changed.sessionDiagnostics.checks.some(c=>c.id==='codex-login'));
});
test('project manager setup excludes execution gaps and does not scan logs on basic recheck',async t=>{
 const f=await fixture(t),repo=path.join(f.dir,'manager-aligned');await mkdir(repo);
 const manager='22222222-2222-4222-8222-222222222222',execution='11111111-1111-4111-8111-111111111111';
 await writeFile(path.join(repo,'project-manager.config.json'),JSON.stringify({configVersion:1,project:{name:'Demo',prefix:'DEMO'},taskSystem:{csv:'TASKS.csv',detailsDir:'tasks'},manager:{threadId:manager,registeredAt:new Date().toISOString()}}));
 await writeFile(path.join(repo,'TASKS.csv'),'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,manager_thread_id\nDEMO-001,进行中,P1,Demo,Demo,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,card.md,,,'+'\n');
 const {onboardingStatus}=await import('./onboarding.mjs');
 const options={directory:f.state,cachePath:path.join(f.state,'runtime'),projects:[{id:'demo',root:repo,csvRelative:'TASKS.csv'}]};
 const result=await onboardingStatus({...options,checkHost:true});
 assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='routes').status,'complete');
 assert.equal(result.runtimeRecovery.checked,0);assert.equal(result.projects.missingRoutes,1);
 assert.equal(result.runtimeDiagnostics.checks[0].status,'verify');
 assert.ok(!result.checks.some(c=>c.id==='execution-observation'));
 assert.ok(!result.nextSteps.some(v=>v.includes('同步任务运行状态')));
 await assert.rejects(readFile(options.cachePath+'.observer.json'),e=>e.code==='ENOENT');
 const previousPending=result.pendingCount;
 await writeFile(path.join(repo,'TASKS.csv'),(await readFile(path.join(repo,'TASKS.csv'),'utf8')).replace('card.md,,,','card.md,dispatch,'+execution+','+manager));
 const now=new Date().toISOString();await writeFile(options.cachePath+'.json',JSON.stringify({sessions:{s:{id:'codex:default:'+execution,status:'running',lastSeenAt:now}}}));
 assert.equal((await onboardingStatus({...options,checkHost:true})).pendingCount,previousPending);
});
test('current project manager wins over stale task managers for channel checks',()=>{
 const current='22222222-2222-4222-8222-222222222222',old='11111111-1111-4111-8111-111111111111';
 const snapshots=[{name:'Demo',manager:{threadId:current},tasks:[{id:'DEMO-001',status:'进行中',manager_thread_id:old}]}];
 assert.deepEqual(notificationManagers(snapshots,'codex'),[{reference:'codex:default:'+current,label:'Demo · manager'}]);
 for(const bad of ['codex:other:'+current,'codex:default:not-native','invalid:default:'+current])assert.deepEqual(notificationManagers([{...snapshots[0],manager:{threadId:bad}}],'codex'),[]);
});
test('host configuration is scoped and complete before runtime evidence, without checking login',async t=>{
 const f=await fixture(t),saved={...process.env};Object.assign(process.env,f.env);
 t.after(()=>{for(const k of Object.keys(process.env))if(!(k in saved))delete process.env[k];Object.assign(process.env,saved);});
 const {onboardingStatus,selectOnboardingHosts}=await import('./onboarding.mjs');const opts={directory:f.state,cachePath:path.join(f.state,'runtime'),projects:[]};
 let value=await onboardingStatus(opts);assert.equal(value.hosts.find(h=>h.id==='codex').selected,false);assert.equal(value.pendingCount,0);assert.equal(value.hostConfigurationPendingCount,0);
 await selectOnboardingHosts({directory:f.state,hosts:['codex']});value=await onboardingStatus(opts);assert.equal(value.hostConfigurationPendingCount,2);assert.equal(value.pendingCount,0);
 execFileSync(process.execPath,[installer,'--install'],{env:f.env});process.env.PROJECT_MANAGER_CODEX_BIN=f.fake;
 value=await onboardingStatus(opts);const codex=value.hosts.find(h=>h.id==='codex');assert.equal(codex.pendingCount,0);assert.equal(codex.state,'CONFIGURED_PENDING_RUNTIME');assert.equal(codex.capabilities.correlatedReceipt,false);assert.equal(value.codex.lifecycle,'NOT_VERIFIED');assert.ok(!value.sessionDiagnostics.checks.some(c=>c.id==='codex-login'));
 const source=await readFile(f.fake,'utf8');await writeFile(f.fake,source.replace('let result={};','if(r.method==="account/read")process.exit(7);let result={};'));
 value=await onboardingStatus({...opts,checkHost:true});assert.equal(value.codex.trust,'TRUSTED');assert.equal(value.codex.authentication,'UNKNOWN');
 await selectOnboardingHosts({directory:f.state,hosts:['dsh']});await writeFile(f.mode,JSON.stringify({enabled:false,trust:'modified'}));
 value=await onboardingStatus({...opts,checkHost:true});assert.equal(value.hostConfigurationPendingCount,0);assert.equal(value.hosts.find(h=>h.id==='codex').selected,false);assert.equal(value.hosts.find(h=>h.id==='dsh').state,'ADAPTER_AVAILABLE');assert.ok(!JSON.stringify(value.sessionDiagnostics).includes('/hooks'));assert.equal(value.notificationDiagnostics.checks.length,0);
 await assert.rejects(selectOnboardingHosts({directory:f.state,hosts:['other']}));await writeFile(path.join(f.state,'adapter-selection.json'),'invalid');assert.equal((await onboardingStatus(opts)).checks.find(c=>c.id==='adapter-selection').status,'action_required');
});
