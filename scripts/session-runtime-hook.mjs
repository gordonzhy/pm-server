#!/usr/bin/env node
import {upsertRuntimeSession} from '../lib/runtime-cache.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {stateDir} from '../lib/paths.mjs';
import {hookSignature} from '../lib/codex-integration.mjs';
import path from 'node:path';
import os from 'node:os';
// Codex may be started by a different shell than setup. Preserve the explicitly
// selected application state directory without relying on inherited variables.
if(!process.env.PM_SERVER_STATE_DIR){
 try{const binding=JSON.parse(await readFile(path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'pm-server-observer.json'),'utf8'));if(binding.version!==1||typeof binding.stateDir!=='string'||!path.isAbsolute(binding.stateDir))throw new Error('invalid PM Server observer binding');process.env.PM_SERVER_STATE_DIR=binding.stateDir;}
 catch(error){if(error.code!=='ENOENT')throw error;}
}
let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1048576)throw new Error('event exceeds 1 MiB');}
const event=JSON.parse(input||'{}');
const statuses={SessionStart:'idle',UserPromptSubmit:'running',PreToolUse:'running',PostToolUse:'running',PermissionRequest:'waiting',Stop:'idle',Interrupt:'interrupted',SessionEnd:'ended'};
const status=statuses[event.hook_event_name];
if(status&&event.session_id)await upsertRuntimeSession({sessionId:event.session_id,status,turnId:event.turn_id,host:process.env.CODEX_SESSION_RUNTIME_CSV?undefined:'codex',instance:process.env.PM_SERVER_INSTANCE||'default',retentionSeconds:Number(process.env.CODEX_SESSION_RUNTIME_RETENTION_SECONDS||86400),maxRows:Number(process.env.CODEX_SESSION_RUNTIME_MAX_ROWS||1000),occurredAt:event.occurred_at,sequence:event.sequence,eventId:event.event_id});
if(status&&event.session_id){
 // No prompts, tool inputs, credentials or transcript paths are retained.
 try{
  const signature=await hookSignature(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
  if(signature){const file=path.join(stateDir(),'codex-observation.json');let previous;try{previous=JSON.parse(await readFile(file,'utf8'));}catch{}
   const now=new Date().toISOString(),events=previous?.signature===signature?previous.events||{}:{};events[event.hook_event_name]=now;
   const temporary=file+'.'+randomUUID();await writeFile(temporary,JSON.stringify({version:1,signature,lastSeenAt:now,events})+'\n',{mode:0o600});await rename(temporary,file);
  }
 }catch{} // Observation receipts must never break an otherwise successful hook.
}
