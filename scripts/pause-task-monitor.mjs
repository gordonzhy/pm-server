#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,realpath} from 'node:fs/promises';
import path from 'node:path';
import {stateDir,runtimeCsv} from '../lib/paths.mjs';
import {parseCsv} from '../lib/runtime-cache.mjs';
import {acquireProcessLock} from './process-lock.mjs';
import {pauseScope,monitorScope} from './task-monitor-policy.mjs';
import {loadProjectConfig} from './project-config-v2.mjs';
import {registeredManagerReference} from '../lib/notifications.mjs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
for(const key of ['--repo','--task','--reason','--actor'])if(!args.includes(key)||!get(key)?.trim())throw new Error(`${key} is required`);
const resume=args.includes('--resume'),until=get('--until');
if(!resume&&(!Number.isFinite(Date.parse(until))||Date.parse(until)<=Date.now()))throw new Error('--until must be a future ISO timestamp');
const repo=await realpath(get('--repo')),directory=path.join(args.includes('--state-dir')?get('--state-dir'):stateDir(),'monitor');
await mkdir(directory,{recursive:true,mode:0o700});
const file=path.join(directory,createHash('sha256').update(repo).digest('hex')+'.json'),lock=await acquireProcessLock(file+'.lock');
try {
 const rows=parseCsv(await readFile(path.join(repo,'TASKS.csv'),'utf8')),headers=rows.shift();
 const matches=rows.filter(r=>r[headers.indexOf('id')]===get('--task'));
 if(matches.length!==1)throw new Error('task not found or duplicated');
 const task=Object.fromEntries(headers.map((h,i)=>[h,matches[0][i]]));
 if(!resume&&(task.status!=='进行中'||!task.dispatch_id||!task.execution_thread_id||!task.manager_thread_id))throw new Error('only a routed active task can pause');
 let saved={version:1,tasks:{}};try{saved=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let turn='';try{const cache=parseCsv(await readFile(runtimeCsv(),'utf8')),h=cache.shift(),r=cache.find(r=>r[h.indexOf('session_id')]===task.execution_thread_id);turn=r?.[h.indexOf('current_turn_id')]||'';}catch(e){if(e.code!=='ENOENT')throw e;}
 const projectConfig=await loadProjectConfig(repo);
 if(!projectConfig.ok)throw new Error('Invalid project configuration');
 const projectManager=projectConfig.config.manager?registeredManagerReference(projectConfig.config.manager.threadId):null;
 if(projectConfig.config.manager&&!projectManager)throw new Error('Invalid or incompatible registered project manager');
 const scope=monitorScope(task,projectManager);
 saved.tasks[task.id]={scope,monitor_pause_until:resume?'':until,monitor_pause_reason:resume?'':get('--reason'),monitor_pause_scope:resume?'':JSON.stringify(pauseScope(task,turn)),actor:get('--actor'),changedAt:new Date().toISOString()};
 const temp=file+'.'+process.pid+'.tmp';await writeFile(temp,JSON.stringify(saved)+'\n',{mode:0o600});await rename(temp,file);
 console.log(JSON.stringify({state:resume?'RESUMED':'PAUSED',task:task.id,until:resume?null:until,storage:file,taskFilesChanged:false}));
}finally{await lock.release();}
