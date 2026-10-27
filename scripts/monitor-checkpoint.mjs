#!/usr/bin/env node
// Explicit manager handling checkpoints; never mutate task facts or infer handling from delivery.
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,mkdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {stateDir} from '../lib/paths.mjs';
import {parseCsv} from '../lib/runtime-cache.mjs';
import {registeredManagerReference} from '../lib/notifications.mjs';
import {loadProjectConfig} from './project-config-v2.mjs';
import {monitorScope,monitorScopeMatches} from './task-monitor-policy.mjs';
import {acquireProcessLock} from './process-lock.mjs';
const args=process.argv.slice(2),action=args.shift();
const allowed=new Set(['--repo','--state-dir','--task','--dispatch','--execution','--manager','--until','--reason','--actor']);
const options=new Map();
for(let i=0;i<args.length;i+=2){if(!allowed.has(args[i])||!args[i+1]?.trim()||args[i+1].startsWith('--')||options.has(args[i]))throw new Error('Invalid checkpoint arguments');options.set(args[i],args[i+1]);}
const get=k=>options.get(k);
if(!['status','checkpoint','release'].includes(action)||!get('--repo'))throw new Error('monitor status|checkpoint|release --repo PATH; checkpoint/release require --task --dispatch --execution --manager --reason --actor; checkpoint also requires --until (at most 24 hours)');
const repo=await realpath(get('--repo')),directory=path.join(get('--state-dir')||stateDir(),'monitor');
const file=path.join(directory,createHash('sha256').update(repo).digest('hex')+'.json');
async function read(){try{const s=JSON.parse(await readFile(file,'utf8'));if(s.version!==1||!s.tasks||typeof s.tasks!=='object'||Array.isArray(s.tasks))throw new Error();return s;}catch(e){if(e.code==='ENOENT')return {version:1,tasks:{}};throw new Error('MONITOR_STATE_UNAVAILABLE');}}
if(action==='status'){
 const saved=await read();
 console.log(JSON.stringify({state:'READ_ONLY',policyVersion:1,minimumBatchSeconds:600,maxCheckpointSeconds:86400,tasks:Object.fromEntries(Object.entries(saved.tasks).filter(([id])=>!get('--task')||id===get('--task')).map(([id,t])=>[id,{scope:t.scope,checkpoint:t.checkpoint||null,checkpointState:t.checkpoint?(t.checkpoint.until>Date.now()?'PROCESSING':'EXPIRED'):null,reminders:t.reminders||{},pauseUntil:t.monitor_pause_until||null}])),taskFilesChanged:false}));
}else {
 for(const k of ['--task','--dispatch','--execution','--manager','--reason','--actor'])if(!get(k))throw new Error(`${k} is required`);
 const until=Date.parse(get('--until')),now=Date.now();
 if(action==='checkpoint'&&(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(get('--until')||'')||!Number.isFinite(until)||until<=now||until-now>86400000))throw new Error('--until must be a future ISO timestamp no more than 24 hours away');
 if(get('--reason').length>2000||get('--actor').length>200)throw new Error('Checkpoint reason or actor is too long');
 await mkdir(directory,{recursive:true,mode:0o700});const lock=await acquireProcessLock(file+'.lock');
 try {
  const saved=await read(),rows=parseCsv(await readFile(path.join(repo,'TASKS.csv'),'utf8')),headers=rows.shift()||[];
  if(new Set(headers).size!==headers.length||rows.some(r=>r.length!==headers.length))throw new Error('Invalid task source');
  const matches=rows.filter(r=>r[headers.indexOf('id')]===get('--task'));
  if(matches.length!==1)throw new Error('Task not found or duplicated');
  const task=Object.fromEntries(headers.map((h,i)=>[h,matches[0][i]]));
  const config=await loadProjectConfig(repo);if(!config.ok)throw new Error('Invalid project configuration');
  const projectManager=config.config.manager?registeredManagerReference(config.config.manager.threadId):null;
  const manager=projectManager||registeredManagerReference(task.manager_thread_id);
  if(!manager||task.status!=='进行中'||task.dispatch_id!==get('--dispatch')||task.execution_thread_id!==get('--execution')||registeredManagerReference(get('--manager'))!==manager)throw new Error('Checkpoint requires the current active task, dispatch, execution and registered manager');
  const item=monitorScopeMatches(saved.tasks[task.id]?.scope,task,projectManager)?saved.tasks[task.id]:{scope:monitorScope(task,projectManager)};
  if(action==='checkpoint')item.checkpoint={until,reason:get('--reason'),actor:get('--actor'),createdAt:now};
  else {delete item.checkpoint;item.reminders={};}
  saved.tasks[task.id]=item;
  const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(saved)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,file);
  console.log(JSON.stringify({state:action==='checkpoint'?'PROCESSING':'RELEASED',task:task.id,until:action==='checkpoint'?new Date(until).toISOString():null,taskFilesChanged:false}));
 }finally{await lock.release();}
}
