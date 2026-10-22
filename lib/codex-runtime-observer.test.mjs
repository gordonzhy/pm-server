import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,utimes,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {recoverCodexRuntime,runtimeEvidence} from './codex-runtime-observer.mjs';
import {upsertRuntimeSession} from './runtime-cache.mjs';
const id='11111111-1111-4111-8111-111111111111',turn='22222222-2222-4222-8222-222222222222';
async function fixture(t){
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-log-observer-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const codexHome=path.join(root,'host'),projectRoot=path.join(root,'project'),folder=path.join(codexHome,'sessions','2026','01','01'),runtimeCsv=path.join(root,'state','runtime.csv');
 await mkdir(folder,{recursive:true});await mkdir(projectRoot);
 const file=path.join(folder,'rollout-demo-'+id+'.jsonl'),targets=[{reference:id,projectRoot}];
 const meta={type:'session_meta',payload:{id,cwd:projectRoot}};
 const event=(type,at=new Date().toISOString(),extra={})=>({timestamp:at,type:'event_msg',payload:{type,thread_id:id,turn_id:turn,...extra}});
 const write=async records=>writeFile(file,[meta,...records].map(JSON.stringify).join('\n')+'\n');
 return {root,codexHome,projectRoot,runtimeCsv,file,targets,event,write,meta,recover:extra=>recoverCodexRuntime({targets,runtimeCsv,codexHome,...extra})};
}
test('identified local activity restores observation with event time and no Hook receipt or task writes',async t=>{
 const f=await fixture(t),at=new Date(Date.now()-10000).toISOString();await f.write([f.event('item_completed',at)]);
 const report=await f.recover();assert.equal(report.recovered,1);
 const raw=await readFile(f.runtimeCsv+'.json','utf8'),row=Object.values(JSON.parse(raw).sessions)[0];
 assert.equal(row.status,'running');assert.equal(row.lastSeenAt,at);assert.equal(row.source.kind,'codex-session-log');assert.equal(row.source.event,'item_completed');
 const again=await f.recover();assert.equal(again.recovered,0);assert.equal((await readFile(f.runtimeCsv+'.json','utf8')),raw);
 await assert.rejects(readFile(path.join(path.dirname(f.runtimeCsv),'codex-observation.json')),e=>e.code==='ENOENT');
 assert.ok(!JSON.stringify(report).includes(f.file));
});
test('terminal lifecycle stays inactive despite delayed same-turn activity and expired start is unknown',async t=>{
 const f=await fixture(t);await f.write([f.event('task_started'),f.event('task_complete'),f.event('item_completed')]);
 assert.equal((await f.recover()).recovered,1);assert.equal(Object.values(JSON.parse(await readFile(f.runtimeCsv+'.json')).sessions)[0].status,'idle');
 const g=await fixture(t);await g.write([g.event('task_started',new Date(Date.now()-1900000).toISOString())]);
 await utimes(g.file,new Date(),new Date());assert.equal((await g.recover()).results[0].reason,'STALE_EVENT');
 assert.equal(runtimeEvidence({status:'idle',lastSeenAt:new Date(Date.now()-3600000).toISOString()}),'CURRENT');
});
test('identity, project, reference, unsupported events and future timestamps fail closed',async t=>{
 for(const kind of ['identity','project','unknown','future','thread']){
  const f=await fixture(t);let meta=f.meta,event=f.event('item_completed');
  if(kind==='identity')meta={...meta,payload:{...meta.payload,id:turn}};
  if(kind==='project')meta={...meta,payload:{...meta.payload,cwd:f.root}};
  if(kind==='unknown')event=f.event('token_count');
  if(kind==='future')event=f.event('item_completed',new Date(Date.now()+3600000).toISOString());
  if(kind==='thread')event=f.event('item_completed',undefined,{thread_id:turn});
  await writeFile(f.file,[meta,event].map(JSON.stringify).join('\n')+'\n');
  const r=await f.recover();assert.equal(r.recovered,0,kind);assert.equal(r.results[0].state,'UNAVAILABLE');
 }
 const f=await fixture(t);assert.equal((await f.recover({targets:[{reference:'codex:other:'+id,projectRoot:f.projectRoot}]})).results[0].reason,'UNSUPPORTED_REFERENCE');
});
test('symlink and poisoned index cannot escape the host sessions directory',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'external.jsonl');await writeFile(outside,JSON.stringify(f.meta)+'\n'+JSON.stringify(f.event('task_started'))+'\n');
 await symlink(outside,f.file);assert.equal((await f.recover()).recovered,0);
 await mkdir(path.dirname(f.runtimeCsv),{recursive:true});await writeFile(f.runtimeCsv+'.observer.json',JSON.stringify({version:1,root:await realpath(path.join(f.codexHome,'sessions')),entries:{[id]:{relative:'../../external.jsonl'}}}));
 const r=await f.recover();assert.equal(r.recovered,0);assert.equal(r.results[0].reason,'UNSAFE_PATH');
});
test('newer Hook evidence wins and partial trailing lines do not fabricate events',async t=>{
 const f=await fixture(t);await f.write([f.event('task_started',new Date(Date.now()-10000).toISOString())]);
 await upsertRuntimeSession({runtimeCsv:f.runtimeCsv,sessionId:id,host:'codex',status:'idle',turnId:turn});
 const before=await readFile(f.runtimeCsv+'.json','utf8');assert.equal((await f.recover()).recovered,0);assert.equal(await readFile(f.runtimeCsv+'.json','utf8'),before);
 const g=await fixture(t);await g.write([g.event('task_complete')]);await writeFile(g.file,(await readFile(g.file,'utf8'))+'{"timestamp":');
 assert.equal((await g.recover()).recovered,1);assert.equal(Object.values(JSON.parse(await readFile(g.runtimeCsv+'.json')).sessions)[0].status,'idle');
});
test('registered HTTP inspection and background monitor share recovered evidence without changing tasks',async t=>{
 const f=await fixture(t),state=path.dirname(f.runtimeCsv),now=new Date().toISOString();await f.write([f.event('item_completed',now)]);
 await mkdir(state,{recursive:true});
 const headers=['id','status','priority','boundary','title','dependencies','executor','created_at','modified_at','detail_path','dispatch_id','execution_thread_id','execution_turn_id','manager_thread_id','recovery_turn_id','recovery_state','recovery_state_at'];
 const row=['DEMO-001','进行中','P1','Demo','Demo','[]','AI',now,now,'card.md','dispatch-demo',id,turn,turn,'','',''];
 const csv=headers.join(',')+'\n'+row.join(',')+'\n';await writeFile(path.join(f.projectRoot,'TASKS.csv'),csv);
 const project={id:'demo',name:'Demo',root:f.projectRoot,csvRelative:'TASKS.csv',csvPath:path.join(f.projectRoot,'TASKS.csv')};
 await writeFile(path.join(state,'registry.json'),JSON.stringify({version:1,revision:1,projects:[project],pending:[],removed:[]}));
 const env={...process.env,CODEX_HOME:f.codexHome,PM_SERVER_STATE_DIR:state,CODEX_SESSION_RUNTIME_CSV:f.runtimeCsv,PROJECT_MANAGER_NOTIFY_DISABLED:'1'};
 const {execFileSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const module=fileURLToPath(new URL('./onboarding.mjs',import.meta.url));
 const script=`import {onboardingStatus} from ${JSON.stringify(module)};console.log(JSON.stringify(await onboardingStatus({directory:${JSON.stringify(state)},cachePath:${JSON.stringify(f.runtimeCsv)},checkHost:true,diagnoseRuntime:true})));`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{env,encoding:'utf8'}));
 assert.equal(result.runtimeRecovery.recovered,1);assert.equal(result.projects.observationGaps,0);
 assert.equal(result.runtimeDiagnostics.checks.find(c=>c.id==='execution-observation').status,'complete');
 const worker=fileURLToPath(new URL('../scripts/task-monitor-worker.mjs',import.meta.url));
 execFileSync(process.execPath,[worker,'--state-dir',state,'--once'],{env,encoding:'utf8'});
 const health=JSON.parse(await readFile(path.join(state,'task-monitor.json'),'utf8'));
 assert.equal(health.projects[0].status,'HEALTHY');assert.equal(health.runtimeRecovery.recovered,0);
 assert.equal(await readFile(path.join(f.projectRoot,'TASKS.csv'),'utf8'),csv);
});
test('large transcripts use bounded tail activity without retaining transcript content',async t=>{
 const f=await fixture(t),sentinel='private-transcript-sentinel';
 const large={type:'response_item',payload:{type:'message',content:sentinel+'x'.repeat(5*1024*1024)}};
 await f.write([large,f.event('item_completed')]);
 const r=await f.recover();assert.equal(r.recovered,1);
 for(const name of [f.runtimeCsv+'.json',f.runtimeCsv+'.observer.json'])assert.ok(!(await readFile(name,'utf8')).includes(sentinel));
});
test('newer legacy Hook observations win over older qualified log observations',async t=>{
 const f=await fixture(t);await f.write([f.event('item_completed')]);
 await f.recover();
 await upsertRuntimeSession({runtimeCsv:f.runtimeCsv,sessionId:id,status:'idle',turnId:turn,occurredAt:new Date().toISOString()});
 const before=await readFile(f.runtimeCsv+'.json','utf8');
 const r=await f.recover();assert.equal(r.recovered,0);assert.equal(r.results[0].source,'runtime-event');assert.equal(await readFile(f.runtimeCsv+'.json','utf8'),before);
 const {cachedRuntimeSession}=await import('./codex-runtime-observer.mjs');
 const chosen=cachedRuntimeSession(JSON.parse(before).sessions,'codex:default:'+id);assert.equal(chosen.id,id);assert.equal(chosen.status,'idle');
});
