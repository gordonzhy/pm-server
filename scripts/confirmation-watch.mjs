// Independent manager follow-up for awaiting-confirmation tasks. Source files are read-only.
import {deliverReminder} from '../lib/reminder-delivery.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename} from 'node:fs/promises';
import path from 'node:path';
import {Registry} from './workbench-registry.mjs';
import {parseCsv} from './workbench-data.mjs';
import {readRepositoryFile} from './testing-dashboard.mjs';
import {loadProjectConfig} from './project-config-v2.mjs';
import {acquireProcessLock} from './process-lock.mjs';
import {registeredManagerReference, sendNotification} from '../lib/notifications.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
export const confirmationMessage='PROJECT_MANAGER_CONFIRMATION · 有待确认任务需要经理复核。请通过已授权的本机工作台或 CLI 核对最新卡片、回调与成果，明确等待谁、具体问题或证据、确认后的动作及跟进时点。正常等待用户决定时保持有界复核，不自动催用户、改状态、重派或恢复暂停。通知被接受不代表经理已处理。';
function seconds(env,key,fallback,min){const n=Number(env[key]??fallback);if(!Number.isInteger(n)||n<min)throw new Error('INVALID_CONFIRMATION_POLICY');return n*1000;}
async function scan(directory){
 const registry=await new Registry(directory).read(), tasks=[], inactive=[], unavailable=[], diagnostics=[];
 for(const project of registry.projects){
  const projectKey=hash(JSON.stringify([project.id,project.root]));
  try{
   if(path.resolve(project.csvPath)!==path.join(path.resolve(project.root),'TASKS.csv')){diagnostics.push('UNSUPPORTED_SOURCE');unavailable.push(projectKey);continue;}
   const rows=parseCsv(await readRepositoryFile(project.root,'TASKS.csv','utf8')),headers=rows.shift()||[];
   if(new Set(headers).size!==headers.length||!['id','status','modified_at'].every(h=>headers.includes(h)))throw new Error();
   const ids=new Set();
   for(const row of rows){if(row.length!==headers.length)throw new Error();const id=row[headers.indexOf('id')];if(!id||ids.has(id))throw new Error();ids.add(id);}
   const config=await loadProjectConfig(project.root);if(!config.ok)throw new Error();
   const manager=registeredManagerReference(config.config.manager?.threadId);
   const selected=[],departed=[];
   for(const row of rows){
    const task=Object.fromEntries(headers.map((h,i)=>[h,row[i]]));
    const key=hash(JSON.stringify([project.id,project.root,task.id]));
    if(task.status!=='待确认'){departed.push({key,projectKey});continue;}
    let detail='';if(task.detail_path)detail=await readRepositoryFile(project.root,task.detail_path,'utf8');
    // Source content, including task logs, invalidates an old notification episode.
    selected.push({key,projectKey,manager,
     fingerprint:hash(JSON.stringify([row,detail,manager])),modified:Date.parse(task.modified_at)});
   }
   if(selected.length&&!manager)diagnostics.push('MANAGER_UNAVAILABLE');
   tasks.push(...selected);inactive.push(...departed);
  }catch{diagnostics.push('PROJECT_SOURCE_UNAVAILABLE');unavailable.push(projectKey);}
 }
 return {tasks,inactive,unavailable,diagnostics};
}
export async function watchConfirmations({directory,env=process.env,now=Date.now(),onProgress=()=>{}}={}){
 const after=seconds(env,'PROJECT_MANAGER_CONFIRMATION_AFTER',3600,60);
 const repeat=seconds(env,'PROJECT_MANAGER_CONFIRMATION_REPEAT',86400,3600);
 const retry=seconds(env,'PROJECT_MANAGER_CONFIRMATION_RETRY',300,60);
 await mkdir(directory,{recursive:true,mode:0o700});
 // The lock covers persisted claims and delivery across worker instances.
 const lock=await acquireProcessLock(path.join(directory,'confirmation-watch.lock'),{timeoutMs:2000});
 try{
  const file=path.join(directory,'confirmation-watch.json');let saved={version:1,tasks:{}};
  try{saved=JSON.parse(await readFile(file,'utf8'));if(saved.version!==1||!saved.tasks||typeof saved.tasks!=='object'||Array.isArray(saved.tasks))throw new Error();}
  catch(e){if(e.code!=='ENOENT')throw new Error('CONFIRMATION_STATE_UNAVAILABLE');}
  const snapshot=await scan(directory),next={version:1,tasks:{}},groups=new Map();
  const summary={state:'CHECKED',awaiting:snapshot.tasks.length,due:0,accepted:0,failed:0,cooling:0,diagnostics:snapshot.diagnostics,evidence:'backend_acceptance_only'};
  for(const task of snapshot.tasks){
   const previous=saved.tasks[task.key];
   const valid=previous&&previous.fingerprint===task.fingerprint&&Number.isFinite(previous.since)&&previous.since<=now;
   const since=valid?previous.since:previous?now:Number.isFinite(task.modified)&&task.modified<=now?task.modified:now;
   const item=valid?{...previous}:{fingerprint:task.fingerprint,since,projectKey:task.projectKey};next.tasks[task.key]=item;
   if(now-since<after)continue;
   summary.due++;
   if(!task.manager)continue;
   if(Number.isFinite(item.nextAt)&&item.nextAt>now){summary.cooling++;continue;}
   const group=groups.get(task.manager)||[];group.push(task);groups.set(task.manager,group);
  }
  for(const {key,projectKey} of snapshot.inactive)if(saved.tasks[key])next.tasks[key]={fingerprint:null,since:now,projectKey};
  for(const [key,item] of Object.entries(saved.tasks))if(snapshot.unavailable.includes(item.projectKey))next.tasks[key]=item;
  async function save(){const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(next)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,file);}
  await save();
  for(const [manager,tasks] of groups){
   // Re-read registration, authoritative manager and source immediately before delivery.
   onProgress();
   const latest=await scan(directory);summary.diagnostics.push(...latest.diagnostics);
   const eligible=tasks.filter(t=>latest.tasks.some(x=>x.key===t.key&&x.manager===manager&&x.fingerprint===t.fingerprint));
   if(!eligible.length)continue;
   for(const task of eligible){const item=next.tasks[task.key];item.nextAt=now+repeat;item.delivery='UNKNOWN';}
   await save(); // An interrupted backend call cannot create a rapid duplicate.
   let accepted=false,receipt;
   try{receipt=await deliverReminder({manager,directory,env,now,cover:false,queuedAt:now-600000});accepted=receipt.state==='ACCEPTED';}catch{}
   if(receipt&&['BATCHING','CLOCK_REBASED'].includes(receipt.state)){for(const task of eligible){const item=next.tasks[task.key];item.queuedAt=receipt.state==='CLOCK_REBASED'?now:item.queuedAt??now;item.nextAt=receipt.nextAt;item.delivery='BATCHING';}summary.cooling+=eligible.length;await save();continue;}
   for(const task of eligible){const item=next.tasks[task.key];delete item.queuedAt;item.delivery=accepted?'ACCEPTED':'FAILED';item.failures=accepted?0:Math.min((item.failures||0)+1,3);item.nextAt=now+(accepted||item.failures>=3?repeat:Math.max(retry,600000));}
   if(accepted)summary.accepted+=eligible.length;else summary.failed+=eligible.length;
   await save();
  }
  summary.diagnostics=[...new Set(summary.diagnostics)];
  summary.delivery={accepted:0,failed:0,unknown:0};
  for(const item of Object.values(next.tasks)){if(item.delivery==='ACCEPTED')summary.delivery.accepted++;if(item.delivery==='FAILED')summary.delivery.failed++;if(item.delivery==='UNKNOWN')summary.delivery.unknown++;}
  if(summary.failed||summary.delivery.failed||summary.delivery.unknown||summary.diagnostics.length)summary.state='WARNING';
  return summary;
 }finally{await lock.release();}
}
