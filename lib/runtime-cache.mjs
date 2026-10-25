import {mkdir,readFile,writeFile,rename,realpath,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import os from 'node:os';
import {acquireProcessLock} from '../scripts/process-lock.mjs';
import {runtimeCsv as defaultCsv} from './paths.mjs';
export const RUNTIME_HEADERS=['session_id','status','current_turn_id','status_at','last_seen_at'];
export const RUNTIME_STATUSES=new Set(['idle','running','waiting','interrupted','ended','unknown']);
export const normalizeStatus=value=>RUNTIME_STATUSES.has(value)?value:'unknown';
export function sessionRef(host,instance,id) {
  if(!['codex','claude-code','dsh'].includes(host)||!instance||!id)throw new Error('host, instance and session ID are required');
  return [host,instance,id].map(encodeURIComponent).join(':');
}
export function parseCsv(text) {
  const rows=[];let row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){field+='"';i++;}else if(c==='"')quoted=false;else field+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(field);field='';}else if(c==='\n'){row.push(field.replace(/\r$/,''));rows.push(row);row=[];field='';}else field+=c;}
  if(quoted)throw new Error('unterminated CSV field');if(field||row.length){row.push(field);rows.push(row);}return rows;
}
export const encodeCsv=rows=>rows.map(row=>row.map(v=>/[",\r\n]/.test(String(v??''))?'"'+String(v??'').replaceAll('"','""')+'"':String(v??'')).join(',')).join('\n')+'\n';
export async function upsertRuntimeSession({runtimeCsv=defaultCsv(),sessionId,status,turnId,host,instance='default',occurredAt,sequence,eventId,lastSeenAt,source,retentionSeconds=86400,maxRows=1000,lockTimeoutMs=5000}) {
  if(!sessionId)throw new Error('sessionId is required');
  if(!Number.isInteger(retentionSeconds)||retentionSeconds<60||!Number.isInteger(maxRows)||maxRows<1)throw new Error('invalid retention policy');
  await mkdir(path.dirname(runtimeCsv),{recursive:true,mode:0o700});
  runtimeCsv=path.join(await realpath(path.dirname(runtimeCsv)),path.basename(runtimeCsv));
  // Explicit legacy CSV is a single-host bridge. New installations use qualified IDs.
  const id=host?sessionRef(host,instance,sessionId):sessionId;
  const lock=await acquireProcessLock(path.join(os.tmpdir(),`pm-server-cache-${createHash('sha256').update(runtimeCsv).digest('hex').slice(0,16)}.lock`),{timeoutMs:lockTimeoutMs});
  try {
    let data={version:1,sessions:{}};
    try{data=JSON.parse(await readFile(runtimeCsv+'.json','utf8'));if(data.version!==1||!data.sessions)throw new Error('invalid runtime snapshot');}
    catch(e){if(e.code!=='ENOENT')throw e;
      try{const rows=parseCsv(await readFile(runtimeCsv,'utf8'));const headers=rows.shift()||[];if(!RUNTIME_HEADERS.every(h=>headers.includes(h)))throw new Error('invalid runtime CSV schema');for(const row of rows){const r=Object.fromEntries(headers.map((h,i)=>[h,row[i]]));data.sessions[r.session_id]={id:r.session_id,status:r.status,turn:r.current_turn_id,statusAt:r.status_at,lastSeenAt:r.last_seen_at,occurredAt:r.last_seen_at};}}catch(e){if(e.code!=='ENOENT')throw e;}
    }
    const now=new Date().toISOString(),at=occurredAt||now;
    if(!Number.isFinite(Date.parse(at)))throw new Error('invalid event timestamp');
    const previous=data.sessions[id];
    if(previous&&((eventId&&previous.eventId===eventId)||(Date.parse(at)<Date.parse(previous.occurredAt))||(Number.isInteger(sequence)&&Number.isInteger(previous.sequence)&&sequence<=previous.sequence)))return {ignored:true};
    if(source?.kind==='codex-session-log'&&previous&&Date.parse(at)<=Date.parse(previous.occurredAt))return {ignored:true,reason:'newer or equal runtime evidence'};
    if(turnId&&previous?.retiredTurns?.includes(turnId))return {ignored:true,reason:"retired turn"};
    status=normalizeStatus(status);
    // Missing turn or timestamp is not enough to end an observed newer turn.
    if(previous?.turn&&turnId&&previous.turn!==turnId&&!occurredAt&&['idle','ended','interrupted'].includes(status))return {ignored:true,reason:'ambiguous turn ordering'};
    const retiredTurns=[...(previous?.retiredTurns||[])];if(previous?.turn&&turnId&&previous.turn!==turnId)retiredTurns.push(previous.turn);
    data.sessions[id]={id,retiredTurns:[...new Set(retiredTurns)].slice(-256),status,turn:turnId||previous?.turn||'',statusAt:previous?.status===status?previous.statusAt:at,lastSeenAt:lastSeenAt||now,occurredAt:at,sequence,eventId,...(source?{source}:{})};
    const retained=Object.values(data.sessions).filter(s=>Date.now()-Date.parse(s.lastSeenAt)<retentionSeconds*1000).sort((a,b)=>Date.parse(b.lastSeenAt)-Date.parse(a.lastSeenAt)).slice(0,maxRows);
    data.sessions=Object.fromEntries(retained.map(s=>[s.id,s]));
    for(const [file,text] of [[runtimeCsv+'.json',JSON.stringify(data)+'\n'],[runtimeCsv,encodeCsv([RUNTIME_HEADERS,...retained.map(s=>[s.id,s.status,s.turn,s.statusAt,s.lastSeenAt])])]]){
      const temp=file+'.'+randomUUID()+'.tmp';try{await writeFile(temp,text,{mode:0o600,flag:'wx'});await rename(temp,file);}finally{await unlink(temp).catch(()=>{});}
    }
    return {id,status};
  } finally {await lock.release();}
}
