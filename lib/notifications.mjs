import {access,stat,mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {acquireProcessLock} from '../scripts/process-lock.mjs';
import {stateDir} from './paths.mjs';
const exec=promisify(execFile);
export function validManagerReference(value){
 try{if(typeof value!=='string'||value.length>2048)return false;const parts=value.split(':').map(decodeURIComponent);return parts.length===3&&['codex','claude-code','dsh'].includes(parts[0])&&parts.every(p=>p.trim()&&!/[\r\n\0]/.test(p));}catch{return false;}
}

export function registeredManagerReference(value,instance=process.env.PM_SERVER_INSTANCE||'default'){
 if(typeof value!=='string')return null;
 if(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))return ['codex',instance,value].map(encodeURIComponent).join(':');
 if(/^(?:session-[A-Za-z0-9._-]+|teammate:[A-Za-z0-9._-]+|subagent:[A-Za-z0-9._-]+)$/.test(value))return ['dsh',instance,value].map(encodeURIComponent).join(':');
 if(!validManagerReference(value))return null;
 const [host,target,id]=value.split(':').map(decodeURIComponent);
 if(target!==instance||host==='codex'&&!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))return null;
 return value;
}

export async function notificationEnvironment(env=process.env,directory=stateDir()){
 if(env.PROJECT_MANAGER_NOTIFY_BIN||env.PROJECT_MANAGER_CODEX_BIN||env.PROJECT_MANAGER_NOTIFY_DISABLED==='1')return env;
 try{const saved=JSON.parse(await readFile(path.join(directory,'notification-config.json'),'utf8'));if(saved.version===1&&saved.backend==='codex')return {...env,PROJECT_MANAGER_CODEX_BIN:'codex'};}catch{}
 return env;
}
export async function configureCodexNotifications({directory=stateDir(),env=process.env}={}){
 const config=await notificationConfiguration({...env,PROJECT_MANAGER_NOTIFY_BIN:'',PROJECT_MANAGER_CODEX_BIN:'codex',PROJECT_MANAGER_NOTIFY_DISABLED:'0'});
 if(config.state!=='CONFIGURED_NOT_DELIVERY_VERIFIED')throw new Error('codex executable is unavailable; install Codex first.');
 if(env.PROJECT_MANAGER_NOTIFY_BIN||env.PROJECT_MANAGER_CODEX_BIN||env.PROJECT_MANAGER_NOTIFY_DISABLED==='1')throw new Error('An explicit notification environment setting takes precedence. Change or unset it before selecting a saved backend.');
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'notification-config.json'),tmp=file+'.'+randomUUID();
 await writeFile(tmp,JSON.stringify({version:1,backend:'codex'})+'\n',{mode:0o600});await rename(tmp,file);
 return {state:'SAVED',backend:'codex',delivery:'NOT_VERIFIED'};
}

// Called by explicit service startup, never by npm install or read-only checks.
export async function prepareDefaultNotifications({directory=stateDir(),env=process.env}={}){
 const current=await notificationConfiguration(env,directory);
 if(current.state!=='NOT_CONFIGURED')return current;
 try{await stat(path.join(directory,'notification-config.json'));return current;}catch(error){if(error.code!=='ENOENT')throw error;}
 try{
  const binding=JSON.parse(await readFile(path.join(env.CODEX_HOME||path.join(os.homedir(),'.codex'),'pm-server-observer.json'),'utf8'));
  if(binding.version!==1||binding.stateDir!==directory)return current;
 }catch{return current;}
 const available=await notificationConfiguration({...env,PROJECT_MANAGER_CODEX_BIN:'codex'},directory);
 if(available.state!=='CONFIGURED_NOT_DELIVERY_VERIFIED')return available;
 await configureCodexNotifications({directory,env});
 return notificationConfiguration(env,directory);
}

export async function notificationConfiguration(env=process.env,directory=stateDir()){
 env=await notificationEnvironment(env,directory);
 const bin=env.PROJECT_MANAGER_NOTIFY_BIN||env.PROJECT_MANAGER_CODEX_BIN;
 if(env.PROJECT_MANAGER_NOTIFY_DISABLED==='1')return {state:'DISABLED'};
 if(!bin)return {state:'NOT_CONFIGURED'};
 let template;
 try{template=env.PROJECT_MANAGER_NOTIFY_ARGS?JSON.parse(env.PROJECT_MANAGER_NOTIFY_ARGS):['{message}'];if(!Array.isArray(template)||template.some(v=>typeof v!=='string'))throw new Error();}
 catch{return {state:'INVALID_ARGUMENTS'};}
 const candidates=path.isAbsolute(bin)?[bin]:(env.PATH||'').split(path.delimiter).map(p=>path.join(p,bin));
 let executable=false;for(const file of candidates){try{await access(file,constants.X_OK);if(!(await stat(file)).isFile())continue;executable=true;break;}catch{}}
 if(!executable)return {state:'EXECUTABLE_UNAVAILABLE'};
 const signature=createHash('sha256').update(JSON.stringify([bin,env.PROJECT_MANAGER_NOTIFY_BIN?'custom':'codex',template])).digest('hex');
 return {state:'CONFIGURED_NOT_DELIVERY_VERIFIED',signature,backend:env.PROJECT_MANAGER_NOTIFY_BIN?'custom':'codex'};
}

export async function sendNotification({manager,message,kind='test',directory=stateDir(),env=process.env}){
 env=await notificationEnvironment(env,directory);
 const config=await notificationConfiguration(env,directory);
 if(config.state!=='CONFIGURED_NOT_DELIVERY_VERIFIED')throw new Error('Notification backend is missing, disabled or invalid; run pm-server doctor.');
 if(typeof manager!=='string'||!manager.trim())throw new Error('A manager session reference is required.');
 let argv;
 if(env.PROJECT_MANAGER_NOTIFY_BIN){const template=env.PROJECT_MANAGER_NOTIFY_ARGS?JSON.parse(env.PROJECT_MANAGER_NOTIFY_ARGS):['{message}'];argv=template.map(v=>v.replace(/\{(manager|message|kind)\}/g,(_,key)=>({manager,message,kind})[key]));}
 else{
  let native=manager;
  if(manager.includes(':')){const parts=manager.split(':').map(decodeURIComponent);if(parts.length!==3||parts[0]!=='codex'||parts[1]!== (env.PM_SERVER_INSTANCE||'default'))throw new Error('The configured Codex backend cannot route this host or instance.');native=parts[2];}
  argv=['queue','--thread',native,'--message',message];
 }
 try{await exec(env.PROJECT_MANAGER_NOTIFY_BIN||env.PROJECT_MANAGER_CODEX_BIN,argv,{env,timeout:15000,killSignal:'SIGKILL',maxBuffer:1024*1024});}
 catch{throw new Error('Notification backend failed or timed out; check its configuration and target session.');}
 const receipt={version:1,signature:config.signature,acceptedAt:new Date().toISOString(),kind,state:'ACCEPTED'};
 // Ordinary monitor deliveries must not create or replace setup-test evidence.
 if(kind!=='test')return {...receipt,evidenceSaved:false};
 // A failed evidence write must not turn an accepted message into a retry.
 try{await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'notification-check.json'),tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(receipt)+'\n',{mode:0o600});await rename(tmp,file);}catch{return {...receipt,evidenceSaved:false};}
 return {...receipt,evidenceSaved:true};
}

export async function notificationDelivery(directory,signature){
 try{const receipt=JSON.parse(await readFile(path.join(directory,'notification-check.json'),'utf8'));if(receipt.version===1&&receipt.kind==='test'&&receipt.signature===signature&&receipt.state==='ACCEPTED')return {state:receipt.confirmedAt?'OWNER_CONFIRMED':'ACCEPTED',acceptedAt:receipt.acceptedAt,...(receipt.confirmedAt?{confirmedAt:receipt.confirmedAt,confirmationSource:'owner'}:{})};}
 catch{}
 return {state:'NOT_VERIFIED'};
}

export async function confirmNotification({directory=stateDir(),env=process.env}={}){
 const config=await notificationConfiguration(env,directory),file=path.join(directory,'notification-check.json');
 if(config.state!=='CONFIGURED_NOT_DELIVERY_VERIFIED')throw new Error('Configure the notification backend first.');
 const receipt=JSON.parse(await readFile(file,'utf8'));
 if(receipt.version!==1||receipt.kind!=='test'||receipt.signature!==config.signature||receipt.state!=='ACCEPTED')throw new Error('Send a test notification with the current configuration first.');
 receipt.confirmedAt=new Date().toISOString();const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(receipt)+'\n',{mode:0o600});await rename(tmp,file);
 return {state:'OWNER_CONFIRMED',confirmedAt:receipt.confirmedAt,confirmationSource:'owner'};
}

export function notificationManagers(snapshots,backend,instance='default'){
 const managers=new Map(),hasActive=snapshots.some(project=>(project.tasks||[]).some(task=>task.status==='进行中'));
 const candidates=[
  ...snapshots.filter(project=>project.manager).map(project=>({project,task:{id:'manager',manager_thread_id:registeredManagerReference(project.manager.threadId,instance)}})),
  ...snapshots.filter(project=>!project.manager).flatMap(project=>(project.tasks||[]).filter(task=>task.status==='进行中').map(task=>({project,task}))),
  ...(!hasActive?snapshots.filter(project=>!project.manager).flatMap(project=>(project.tasks||[]).filter(task=>task.status!=='进行中').map(task=>({project,task}))):[]),
 ];
 for(const {project,task} of candidates){
  let reference=task.manager_thread_id;
  // Legacy Codex task ledgers stored native UUIDs. Do not guess other hosts.
  if(backend==='codex'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference||''))reference=['codex',instance,reference].map(encodeURIComponent).join(':');
  if(!validManagerReference(reference))continue;
  if(backend==='codex'){
   const [host,targetInstance]=reference.split(':').map(decodeURIComponent);
   if(host!=='codex'||targetInstance!==instance)continue;
  }
  const label=project.name+' · '+task.id;
  const entry=managers.get(reference)||{reference,labels:[]};
  if(!entry.labels.includes(label))entry.labels.push(label);
  managers.set(reference,entry);
 }
 return [...managers.values()].map(({reference,labels})=>({reference,label:labels.join(' / ')}));
}


async function saveAutomaticCheck(directory,value){
 const file=path.join(directory,'notification-auto-check.json'),temporary=file+'.'+randomUUID();
 await writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,file);
}
export async function automaticNotificationStatus(directory,signature,managers){
 if(!signature)return {state:'UNAVAILABLE'};
 if(!managers.length)return {state:'WAITING_FOR_MANAGER'};
 try{
  const record=JSON.parse(await readFile(path.join(directory,'notification-auto-check.json'),'utf8'));
  if(record.version===1&&record.signature===signature&&managers.some(m=>m.reference===record.manager)){
   if(record.state==='SENDING'&&(!Number.isFinite(Date.parse(record.checkedAt))||Date.now()-Date.parse(record.checkedAt)>30000))return {...record,state:'UNKNOWN'};
   if(['ACCEPTED','FAILED','SENDING','UNKNOWN'].includes(record.state))return record;
  }
 }catch(error){if(error.code!=='ENOENT')return {state:'UNKNOWN'};}
 return {state:'PENDING'};
}
export async function checkAutomaticNotification({directory=stateDir(),managers=[],env=process.env,force=false}={}){
 const config=await notificationConfiguration(env,directory);
 if(config.state!=='CONFIGURED_NOT_DELIVERY_VERIFIED'||!managers.length)return automaticNotificationStatus(directory,config.signature,managers);
 await mkdir(directory,{recursive:true,mode:0o700});
 const lock=await acquireProcessLock(path.join(directory,'notification-auto-check.lock'),{timeoutMs:20000});
 try{
  const previous=await automaticNotificationStatus(directory,config.signature,managers);
  if(previous.state==='ACCEPTED'&&!force||previous.state==='SENDING')return previous;
  if(!force&&(previous.state==='UNKNOWN'||previous.state==='FAILED'&&(previous.attempts>=3||Date.now()<Date.parse(previous.nextRetryAt))))return previous;
  const manager=previous.manager||managers[0].reference;
  if(!validManagerReference(manager))throw new Error('A registered manager reference is required.');
  const record={version:1,signature:config.signature,manager,state:'SENDING',attempts:(previous.attempts||0)+1,checkedAt:new Date().toISOString(),evidence:'backend_acceptance_only'};
  // Persist before sending: an interrupted/uncertain send is never retried silently.
  await saveAutomaticCheck(directory,record);
  try{
   const receipt=await sendNotification({directory,env,manager,kind:'automatic-check',message:'PM Server automatic notification-channel check after manager registration. No action or reply is required; this message does not authorize new work.'});
   record.state='ACCEPTED';record.acceptedAt=receipt.acceptedAt;
  }catch{
   record.state='FAILED';record.nextRetryAt=new Date(Date.now()+300000).toISOString();
  }
  await saveAutomaticCheck(directory,record);return record;
 }finally{await lock.release();}
}
