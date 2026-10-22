import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const hookEvents=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','Interrupt','SessionEnd'];
export const hookScript=fileURLToPath(new URL('../scripts/session-runtime-hook.mjs',import.meta.url));
export const hookCommand=`node "${hookScript.replaceAll('"','\\"')}"`;

export async function hookSignature(codexHome){
 const [raw,binding,script]=await Promise.all([readFile(path.join(codexHome,'hooks.json'),'utf8'),readFile(path.join(codexHome,'pm-server-observer.json'),'utf8'),readFile(hookScript)]);
 const value=JSON.parse(raw),managed=hookEvents.map(event=>[event,(value.hooks?.[event]||[]).flatMap(g=>g.hooks||[]).filter(h=>h.command===hookCommand)]);
 if(managed.some(([,handlers])=>!handlers.length))return null;
 return createHash('sha256').update(JSON.stringify(managed)).update(binding).update(script).digest('hex');
}

// Public, read-only Codex API. Never read or modify the private trust database.
export function probeCodex({cwd=process.cwd(),bin=process.env.PM_SERVER_CODEX_BIN||'codex',timeout=6000,includeAuthentication=true}={}){
 return new Promise(resolve=>{
  const child=spawn(bin,['app-server','--stdio'],{cwd,stdio:['pipe','pipe','ignore']});
  let done=false,buffer='',hookResult;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);child.kill('SIGTERM');resolve(result);};
  const timer=setTimeout(()=>finish({state:'UNKNOWN',reason:'HOST_PROBE_TIMEOUT'}),timeout);
  child.on('error',()=>finish({state:'UNKNOWN',reason:'CODEX_UNAVAILABLE'}));
  child.on('exit',()=>finish({state:'UNKNOWN',reason:'HOST_PROBE_ENDED'}));
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{
   buffer+=chunk.toString();if(buffer.length>2*1024*1024){finish({state:'UNKNOWN',reason:'HOST_RESPONSE_TOO_LARGE'});return;}
   let end;
   while((end=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);let value;try{value=JSON.parse(line);}catch{continue;}
    if(value.id===1){if(value.error){finish({state:'UNKNOWN',reason:'HOST_API_UNSUPPORTED'});return;}child.stdin.write(JSON.stringify({method:'initialized'})+'\n');child.stdin.write(JSON.stringify({id:2,method:'hooks/list',params:{cwds:[cwd]}})+'\n');}
    if(value.id===2){
     if(value.error||!Array.isArray(value.result?.data)){finish({state:'UNKNOWN',reason:'HOOK_API_UNSUPPORTED'});return;}
     const entries=value.result.data;
     if(entries.some(e=>e.errors?.length)){finish({state:'UNKNOWN',reason:'HOST_CONFIGURATION_ERROR'});return;}
     const hooks=entries.flatMap(e=>e.hooks||[]).filter(h=>h.command===hookCommand&&h.source==='user');
     const expected=new Set(hookEvents.map(s=>s[0].toLowerCase()+s.slice(1)));
     const present=new Set(hooks.map(h=>h.eventName));
     const state=hooks.some(h=>!h.enabled)?'DISABLED':hooks.some(h=>!['trusted','managed'].includes(h.trustStatus))?'REVIEW_REQUIRED':[...expected].every(e=>present.has(e))?'TRUSTED':'NOT_LOADED';
     hookResult={state,checkedAt:new Date().toISOString(),hookCount:hooks.length};
     if(!includeAuthentication){finish(hookResult);return;}
     child.stdin.write(JSON.stringify({id:3,method:'account/read',params:{refreshToken:false}})+'\n');
    }
    if(value.id===3){finish({...hookResult,authentication:value.error?'UNKNOWN':value.result?.account?'AUTHENTICATED':'NOT_LOGGED_IN'});return;}
   }
  });
  child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'pm-server-onboarding',version:'1.0.0'},capabilities:{experimentalApi:true}}})+'\n');
 });
}
