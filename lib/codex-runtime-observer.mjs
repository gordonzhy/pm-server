import {open,readdir,realpath,lstat,readFile,writeFile,rename,mkdir,unlink} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {upsertRuntimeSession,sessionRef} from './runtime-cache.mjs';
import {acquireProcessLock} from '../scripts/process-lock.mjs';
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
export function codexReference(reference,instance=process.env.PM_SERVER_INSTANCE||'default'){
 if(uuid.test(reference||''))return {id:reference,reference:sessionRef('codex',instance,reference)};
 const fields=(reference||'').split(':');
 if(fields.length!==3||fields[0]!=='codex')return null;
 try{if(decodeURIComponent(fields[1])!==instance||!uuid.test(decodeURIComponent(fields[2])))return null;return {id:decodeURIComponent(fields[2]),reference};}catch{return null;}
}
export function cachedRuntimeSession(sessions,reference){
 const route=codexReference(reference),keys=route?[reference,route.reference,route.id]:[reference];
 return [...new Set(keys)].map(k=>sessions[k]).filter(Boolean).sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt))[0];
}
export function runtimeEvidence(session,now=Date.now(),{activeSeconds=1800,inactiveSeconds=86400}={}){
 if(!session)return 'MISSING';
 if(!['running','waiting','idle','interrupted','ended'].includes(session.status))return 'UNKNOWN';
 const at=Date.parse(session.lastSeenAt);
 if(!Number.isFinite(at)||at>now+60000)return 'INVALID_TIME';
 return now-at>=(['running','waiting'].includes(session.status)?activeSeconds:inactiveSeconds)*1000?'STALE':'CURRENT';
}
const reasonFor=e=>['EACCES','EPERM'].includes(e.code)?'PERMISSION_DENIED':e.code==='ENOENT'?'LOG_NOT_FOUND':'READ_FAILED';
async function atomic(file,value){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.'+randomUUID();try{await writeFile(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}}
async function locate(root,id,index,force){
 const saved=index.entries[id];
 if(saved?.relative)return path.join(root,saved.relative);
 if(!force&&saved&&Date.now()-saved.at<300000)throw Object.assign(new Error(),{reason:saved.reason});
 const queue=[{folder:root,depth:0}],matches=[];let entries=0,denied=false;
 while(queue.length){
  const {folder,depth}=queue.shift();let children;
  try{children=await readdir(folder,{withFileTypes:true});}catch(e){if(folder===root)throw e;if(['EACCES','EPERM'].includes(e.code))denied=true;continue;}
  for(const entry of children){
   if(++entries>25000)throw Object.assign(new Error(),{reason:'INDEX_LIMIT'});
   const file=path.join(folder,entry.name);
   if(entry.isDirectory()&&depth<3)queue.push({folder:file,depth:depth+1});
   if(entry.isFile()&&entry.name.endsWith('-'+id+'.jsonl'))matches.push(file);
  }
 }
 if(matches.length!==1)throw Object.assign(new Error(),{reason:matches.length?'AMBIGUOUS_LOG':denied?'PERMISSION_DENIED':'LOG_NOT_FOUND'});
 index.entries[id]={relative:path.relative(root,matches[0]),at:Date.now()};return matches[0];
}
async function observe(file,root,id,projectRoot){
 // Check both the real path and descriptor: symlinked transcripts are not followed.
 const resolved=await realpath(file);if(!inside(root,resolved)||resolved!==file)throw Object.assign(new Error(),{reason:'UNSAFE_PATH'});
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await handle.stat();if(!stat.isFile())throw Object.assign(new Error(),{reason:'UNSAFE_PATH'});
  const head=Buffer.alloc(Math.min(stat.size,65536));await handle.read(head,0,head.length,0);
  let meta;try{meta=JSON.parse(head.toString('utf8').split('\n')[0]);}catch{throw Object.assign(new Error(),{reason:'UNSUPPORTED_FORMAT'});}
  if(meta.type!=='session_meta'||meta.payload?.id!==id)throw Object.assign(new Error(),{reason:'IDENTITY_MISMATCH'});
  if(typeof meta.payload.cwd!=='string')throw Object.assign(new Error(),{reason:'PROJECT_MISMATCH'});
  let cwd,project;try{[cwd,project]=await Promise.all([realpath(meta.payload.cwd),realpath(projectRoot)]);}catch{throw Object.assign(new Error(),{reason:'PROJECT_MISMATCH'});}
  if(!inside(project,cwd))throw Object.assign(new Error(),{reason:'PROJECT_MISMATCH'});
  const start=Math.max(0,stat.size-4*1024*1024),tail=Buffer.alloc(stat.size-start);await handle.read(tail,0,tail.length,start);
  const text=tail.toString('utf8'),lines=text.split('\n');if(start)lines.shift();if(lines.at(-1)!=='')lines.pop();
  let observed;const closed=new Set();
  for(const line of lines){
   if(!line)continue;let record;try{record=JSON.parse(line);}catch{throw Object.assign(new Error(),{reason:'UNSUPPORTED_FORMAT'});}
   if(record.type==='session_meta'&&record.payload?.id!==id)throw Object.assign(new Error(),{reason:'IDENTITY_MISMATCH'});
   if(record.type!=='event_msg')continue;
   const p=record.payload,at=Date.parse(record.timestamp);
   if(!p||!Number.isFinite(at)||at>Date.now())continue;
   if(p.thread_id&&p.thread_id!==id)continue;
   const turn=p.turn_id;if(typeof turn!=='string'||!turn||turn.length>256)continue;
   let status;
   if(p.type==='task_started'&&!closed.has(turn))status='running';
   else if(p.type==='task_complete'){status='idle';closed.add(turn);}
   else if(p.type==='turn_aborted'){status='interrupted';closed.add(turn);}
   else if(p.type==='item_completed'&&p.thread_id===id&&!closed.has(turn))status='running';
   if(!status||observed&&at<Date.parse(observed.at))continue;
   observed={status,turn,at:record.timestamp,event:p.type};
  }
  const finalStat=await lstat(file);if(finalStat.ino!==stat.ino||finalStat.dev!==stat.dev||finalStat.size<stat.size)throw Object.assign(new Error(),{reason:'READ_FAILED'});
  if(!observed)throw Object.assign(new Error(),{reason:'NO_RECOGNIZED_EVENT'});
  return observed;
 }finally{await handle.close();}
}
// Only registered references are accepted; no transcript contents or paths leave this adapter.
export async function recoverCodexRuntime({targets,runtimeCsv,codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),force=false}={}){
 const results=[],indexFile=runtimeCsv+'.observer.json';
 if(!targets?.length)return {checked:0,recovered:0,results:[]};
 await mkdir(path.dirname(runtimeCsv),{recursive:true,mode:0o700});
 const lock=await acquireProcessLock(indexFile+'.lock');
 try{
  let root;try{root=await realpath(path.join(codexHome,'sessions'));}catch(e){return {checked:targets.length,recovered:0,results:targets.map(t=>({reference:t.reference,state:'UNAVAILABLE',reason:codexReference(t.reference)?reasonFor(e):'UNSUPPORTED_REFERENCE'}))};}
  let index={version:1,root,entries:{}};try{const saved=JSON.parse(await readFile(indexFile,'utf8'));if(saved.version===1&&saved.root===root&&saved.entries)index=saved;}catch{}
  let sessions={};try{sessions=JSON.parse(await readFile(runtimeCsv+'.json','utf8')).sessions||{};}catch{}
  const unique=new Map(targets.map(t=>[JSON.stringify([t.reference,t.projectRoot]),t]));
  for(const target of unique.values()){
   const route=codexReference(target.reference);
   if(!route){results.push({reference:target.reference,state:'UNAVAILABLE',reason:'UNSUPPORTED_REFERENCE'});continue;}
   const previous=cachedRuntimeSession(sessions,target.reference);
   if(runtimeEvidence(previous)==='CURRENT'&&previous.source?.kind!=='codex-session-log'){results.push({reference:target.reference,state:'CURRENT',source:previous.source?.kind||'runtime-event'});continue;}
   try{
    const file=await locate(root,route.id,index,force),event=await observe(file,root,route.id,target.projectRoot);
    const evidence=runtimeEvidence({status:event.status,lastSeenAt:event.at});
    if(evidence!=='CURRENT'){results.push({reference:target.reference,state:'UNAVAILABLE',reason:'STALE_EVENT',eventAt:event.at});continue;}
    const source={kind:'codex-session-log',checkedAt:new Date().toISOString(),eventAt:event.at,event:event.event};
    const update=await upsertRuntimeSession({runtimeCsv,sessionId:route.id,host:'codex',instance:process.env.PM_SERVER_INSTANCE||'default',status:event.status,turnId:event.turn,occurredAt:event.at,lastSeenAt:event.at,source});
    results.push({reference:target.reference,state:update.ignored?'CURRENT':'RECOVERED',source:'codex-session-log',eventAt:event.at,status:event.status});
   }catch(e){const reason=e.reason||reasonFor(e);if(['LOG_NOT_FOUND','INDEX_LIMIT'].includes(reason))index.entries[route.id]={at:Date.now(),reason};else if(['ENOENT'].includes(e.code))delete index.entries[route.id];results.push({reference:target.reference,state:'UNAVAILABLE',reason});}
  }
  // Never retain an index of sessions outside this request's registered target set.
  const ids=new Set(targets.map(t=>codexReference(t.reference)?.id).filter(Boolean));
  index.entries=Object.fromEntries(Object.entries(index.entries).filter(([id])=>ids.has(id)));
  await atomic(indexFile,index);
  return {checked:results.length,recovered:results.filter(r=>r.state==='RECOVERED').length,results};
 }finally{await lock.release();}
}
