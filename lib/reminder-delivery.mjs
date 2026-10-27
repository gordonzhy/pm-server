// Shared, private per-manager batching. External host callbacks are outside this gate.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {acquireProcessLock} from '../scripts/process-lock.mjs';
import {sendNotification,registeredManagerReference} from './notifications.mjs';
export const reminderWindow=600000;
export const reminderMessage='PROJECT_MANAGER_RECONCILIATION · 有未处理事项需要经理合并核对。请通过已授权的本机工作台或 CLI 核对最新任务、回调与成果；需要继续处理时记录有期限的检查点。运行观察和通知接受都不代表完成或已处理。仅在实质进展、需用户决定或风险变化时合并播报。';
export async function deliverReminder({directory,manager,queuedAt,now=Date.now(),env=process.env,send=sendNotification,cover=true}) {
 manager=registeredManagerReference(manager)||manager;
 if(!Number.isFinite(queuedAt)||!Number.isFinite(now)||queuedAt>now)throw new Error('INVALID_REMINDER_TIME');
 const folder=path.join(directory,'reminder-delivery');await mkdir(folder,{recursive:true,mode:0o700});
 const file=path.join(folder,createHash('sha256').update(manager).digest('hex')+'.json');
 const lock=await acquireProcessLock(file+'.lock',{timeoutMs:2000});
 try {
  let saved={version:1};
  try{saved=JSON.parse(await readFile(file,'utf8'));if(!saved||saved.version!==1||Array.isArray(saved)||['checkedAt','nextAt','acceptedAt'].some(k=>k in saved&&(!Number.isFinite(saved[k])||saved[k]<0)))throw new Error();}
  catch(error){if(error.code!=='ENOENT')throw new Error('REMINDER_DELIVERY_STATE_UNAVAILABLE');}
  const save=async()=>{const tmp=file+'.'+randomUUID();await writeFile(tmp,JSON.stringify(saved)+'\n',{mode:0o600,flag:'wx'});await rename(tmp,file);};
  // A backward clock never grants an early send. Rebase the finite wait once.
  if(saved.checkedAt>now){saved={version:1,nextAt:now+reminderWindow,checkedAt:now};await save();return {state:'CLOCK_REBASED',nextAt:saved.nextAt};}
  if(cover&&Number.isFinite(saved.acceptedAt)&&saved.acceptedAt>queuedAt)return {state:'ACCEPTED',acceptedAt:saved.acceptedAt,coveredByBatch:true};
  const nextAt=Math.max(queuedAt+reminderWindow,saved.nextAt||0);
  if(now<nextAt)return {state:'BATCHING',nextAt,deliveryState:saved.delivery};
  // Reserve before calling the backend: crash/timeout/failed persistence cannot hot-loop.
  saved.nextAt=now+reminderWindow;saved.checkedAt=now;saved.delivery='UNKNOWN';await save();
  try{
   const result=await send({directory,manager,env,kind:'reconciliation',message:reminderMessage});
   if(result.state!=='ACCEPTED')throw new Error();
   saved.acceptedAt=now;saved.delivery='ACCEPTED';await save();return {state:'ACCEPTED',acceptedAt:now,coveredByBatch:false};
  }catch{saved.delivery='FAILED';await save();return {state:'FAILED',nextAt:saved.nextAt};}
 }finally{await lock.release();}
}
