#!/usr/bin/env node
import {upsertRuntimeSession} from '../lib/runtime-cache.mjs';
import {readFile,writeFile,rename,mkdir,rmdir,unlink,stat} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {stateDir} from '../lib/paths.mjs';
import {hookSignature} from '../lib/codex-integration.mjs';
import path from 'node:path';
import os from 'node:os';
import {readHookEvent} from '../lib/hook-event.mjs';
// Diagnostics contain fixed codes only; the observer never logs event bodies.
async function saveDiagnostic(file,code){
 const lock=file+'.lock';let owned=false;
 try{await mkdir(path.dirname(file),{recursive:true,mode:0o700});try{if(Date.now()-(await stat(lock)).mtimeMs>5000)await rmdir(lock);}catch{}
  await mkdir(lock,{mode:0o700});owned=true;
  let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch{}
  if(Date.now()-Date.parse(previous?.at)<60000)return true;
  const temporary=file+'.'+randomUUID();try{await writeFile(temporary,JSON.stringify({version:1,code,at:new Date().toISOString()})+'\n',{mode:0o600,flag:'wx'});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}return true;
 }catch(error){if(error.code==='EEXIST')try{return Date.now()-Date.parse(JSON.parse(await readFile(file,'utf8')).at)<60000;}catch{}return false;}finally{if(owned)await rmdir(lock).catch(()=>{});}
}
async function diagnostic(code){
 if(await saveDiagnostic(path.join(stateDir(),'hook-diagnostic.json'),code))return;
 // A broken state directory must not hide the failure. Only a digest of its
 // location names the fallback; no event identity or payload is retained.
 const digest=createHash('sha256').update(stateDir()).digest('hex').slice(0,16);
 if(!await saveDiagnostic(path.join(os.tmpdir(),`pm-server-hook-diagnostic-${digest}.json`),code))process.stderr.write('Observer diagnostics unavailable.\n');
}
const budget=setTimeout(()=>{void diagnostic('OBSERVER_BUDGET_EXHAUSTED').finally(()=>process.exit(0));setTimeout(()=>process.exit(0),50);},2400);
try{
// Codex may be started by a different shell than setup. Preserve the explicitly
// selected application state directory without relying on inherited variables.
if(!process.env.PM_SERVER_STATE_DIR){
 try{const binding=JSON.parse(await readFile(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'pm-server-observer.json'),'utf8'));if(binding.version!==1||typeof binding.stateDir!=='string'||!path.isAbsolute(binding.stateDir))throw new Error('invalid PM Server observer binding');process.env.PM_SERVER_STATE_DIR=binding.stateDir;}
 catch(error){if(error.code!=='ENOENT'){await diagnostic('OBSERVER_BINDING_UNAVAILABLE');process.exitCode=0;clearTimeout(budget);process.stdin.destroy();process.exit(0);}}
}
let event;try{event=await readHookEvent(process.stdin);}catch{process.stderr.write('Invalid or excessive observer event metadata.\n');process.exitCode=1;clearTimeout(budget);process.stdin.destroy();process.exit(1);}
const statuses={SessionStart:'idle',UserPromptSubmit:'running',PreToolUse:'running',PostToolUse:'running',PermissionRequest:'waiting',Stop:'idle',Interrupt:'interrupted',SessionEnd:'ended'};
const status=Object.hasOwn(statuses,event.hook_event_name)?statuses[event.hook_event_name]:undefined;
if(status&&event.session_id)try{await upsertRuntimeSession({sessionId:event.session_id,status,turnId:event.turn_id,host:process.env.CODEX_SESSION_RUNTIME_CSV?undefined:'codex',instance:process.env.PM_SERVER_INSTANCE||'default',retentionSeconds:Number(process.env.CODEX_SESSION_RUNTIME_RETENTION_SECONDS||86400),maxRows:Number(process.env.CODEX_SESSION_RUNTIME_MAX_ROWS||1000),occurredAt:event.occurred_at,sequence:event.sequence,eventId:event.event_id,lockTimeoutMs:350});}catch{await diagnostic('OBSERVER_CACHE_UNAVAILABLE');returnFromHook();}
function returnFromHook(){clearTimeout(budget);process.exit(0);}
if(status&&event.session_id){
 // No prompts, tool inputs, credentials or transcript paths are retained.
 try{
  const signature=await hookSignature(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
  if(signature){const file=path.join(stateDir(),'codex-observation.json');let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch{}
   const now=new Date().toISOString(),events=previous?.signature===signature?previous.events||{}:{};events[event.hook_event_name]=now;
   const temporary=file+'.'+randomUUID();await writeFile(temporary,JSON.stringify({version:1,signature,lastSeenAt:now,events})+'\n',{mode:0o600});await rename(temporary,file);
  }
 }catch{await diagnostic('OBSERVER_RECEIPT_UNAVAILABLE');} // Optional observation receipt.
}

}finally{clearTimeout(budget);}
