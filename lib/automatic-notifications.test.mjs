import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkAutomaticNotification,automaticNotificationStatus,notificationConfiguration} from './notifications.mjs';
async function fixture(t){
 const directory=await mkdtemp(path.join(os.tmpdir(),'pm-auto-notify-')),log=path.join(directory,'attempts'),failure=path.join(directory,'fail');t.after(()=>rm(directory,{recursive:true,force:true}));
 const source='const fs=require("node:fs");fs.appendFileSync('+JSON.stringify(log)+',"sent\\n");if(fs.existsSync('+JSON.stringify(failure)+'))process.exit(1);';
 const env={...process.env,PROJECT_MANAGER_NOTIFY_BIN:process.execPath,PROJECT_MANAGER_NOTIFY_ARGS:JSON.stringify(['-e',source]),PROJECT_MANAGER_NOTIFY_DISABLED:'',PROJECT_MANAGER_CODEX_BIN:''};
 return {directory,log,failure,env,managers:[{reference:'codex:default:demo-manager'}]};
}
test('first registered manager triggers exactly one automatic check across concurrency, later scans and restarts',async t=>{
 const f=await fixture(t),config=await notificationConfiguration(f.env,f.directory);
 assert.equal((await checkAutomaticNotification({...f,managers:[]})).state,'WAITING_FOR_MANAGER');
 await assert.rejects(readFile(f.log));
 await Promise.all([checkAutomaticNotification(f),checkAutomaticNotification(f)]);
 assert.equal((await readFile(f.log,'utf8')).trim(),'sent');
 assert.equal((await automaticNotificationStatus(f.directory,config.signature,f.managers)).state,'ACCEPTED');
 assert.equal((await checkAutomaticNotification(f)).state,'ACCEPTED');assert.equal((await readFile(f.log,'utf8')).trim(),'sent');
 // Changing the manager invalidates the previous target and checks the new route.
 await checkAutomaticNotification({...f,managers:[{reference:'codex:default:replacement'}]});
 assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2);
});
test('failed automatic delivery is persisted, bounded and retriable without manual target selection',async t=>{
 const f=await fixture(t);await writeFile(f.failure,'fail');
 assert.equal((await checkAutomaticNotification(f)).state,'FAILED');
 await checkAutomaticNotification(f);assert.equal((await readFile(f.log,'utf8')).trim(),'sent');
 const file=path.join(f.directory,'notification-auto-check.json'),record=JSON.parse(await readFile(file));record.nextRetryAt='2000-01-01T00:00:00Z';record.attempts=3;await writeFile(file,JSON.stringify(record));
 await checkAutomaticNotification(f);assert.equal((await readFile(f.log,'utf8')).trim(),'sent');
 await rm(f.failure);assert.equal((await checkAutomaticNotification({...f,force:true})).state,'ACCEPTED');
 assert.equal((await readFile(f.log,'utf8')).trim().split('\n').length,2);
});
test('uncertain interrupted send is not silently repeated and changed backend invalidates evidence',async t=>{
 const f=await fixture(t),config=await notificationConfiguration(f.env,f.directory);
 await writeFile(path.join(f.directory,'notification-auto-check.json'),JSON.stringify({version:1,signature:config.signature,manager:f.managers[0].reference,state:'SENDING',checkedAt:'2000-01-01T00:00:00Z'}));
 assert.equal((await checkAutomaticNotification(f)).state,'UNKNOWN');await assert.rejects(readFile(f.log));
 const changed={...f.env,PROJECT_MANAGER_NOTIFY_ARGS:JSON.stringify(['-e','process.exit(0)'])};
 assert.equal((await checkAutomaticNotification({...f,env:changed})).state,'ACCEPTED');
});

test('background monitor notices the first manager added after startup without a browser request',async t=>{
 let invoke; t.after(async()=>{if(invoke)await invoke('--stop');});
 const f=await fixture(t),repo=path.join(f.directory,'project');
 const {mkdir}=await import('node:fs/promises'),{promisify}=await import('node:util'),{execFile}=await import('node:child_process'),{fileURLToPath}=await import('node:url');
 const exec=promisify(execFile),manage=fileURLToPath(new URL('../scripts/manage-task-monitor.mjs',import.meta.url));
 await mkdir(repo);
 const csv=manager=>'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,manager_thread_id\nDEMO-001,待办,P1,Demo,Demo,[],AI,2026-10-20T00:00:00Z,2026-10-20T00:00:00Z,task.md,'+manager+'\n';
 await writeFile(path.join(repo,'TASKS.csv'),csv(''));await writeFile(path.join(repo,'task.md'),'# Demo');
 await writeFile(path.join(f.directory,'registry.json'),JSON.stringify({version:1,revision:0,projects:[{id:'demo',name:'Demo',root:repo,csvPath:path.join(repo,'TASKS.csv'),csvRelative:'TASKS.csv'}],pending:[],removed:[]}));
 invoke=(...args)=>exec(process.execPath,[manage,'--state-dir',f.directory,...args],{env:f.env});
 await invoke('--interval','1');await new Promise(r=>setTimeout(r,1200));await assert.rejects(readFile(f.log));
 await writeFile(path.join(repo,'TASKS.csv'),csv(f.managers[0].reference));
 const deadline=Date.now()+6000;
 while(Date.now()<deadline){try{if((await readFile(f.log,'utf8')).includes('sent'))break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal((await readFile(f.log,'utf8')).trim(),'sent');
 await new Promise(r=>setTimeout(r,1500));assert.equal((await readFile(f.log,'utf8')).trim(),'sent');
 await invoke('--stop');
});

test('corrupt automatic-check evidence never causes a silent duplicate send',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.directory,'notification-auto-check.json'),'invalid');
 assert.equal((await checkAutomaticNotification(f)).state,'UNKNOWN');await assert.rejects(readFile(f.log));
 assert.equal((await checkAutomaticNotification({...f,force:true})).state,'ACCEPTED');
});

test('automatic-check bodies and backend failures never echo private route or subprocess output',async t=>{
 const f=await fixture(t),log=path.join(f.directory,'captured-message.json');
 const source='require("node:fs").writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)));if(process.argv[4]==="fail"){console.error("PRIVATE_BACKEND_CANARY /private/example/secret");process.exit(1)}';
 const makeEnv=mode=>({...f.env,PROJECT_MANAGER_NOTIFY_ARGS:JSON.stringify(['-e',source,log,'{manager}','{message}',mode])});
 const managers=[{reference:'codex:default:PRIVATE_ROUTE_CANARY',label:'PRIVATE_PROJECT_CANARY'}];
 const result=await checkAutomaticNotification({...f,managers,env:makeEnv('ok')});assert.equal(result.state,'ACCEPTED');
 const [route,body]=JSON.parse(await readFile(log,'utf8'));assert.equal(route,managers[0].reference);assert.ok(!body.includes('PRIVATE_'));assert.ok(!body.includes(f.directory));
 const {sendNotification}=await import('./notifications.mjs');
 await assert.rejects(sendNotification({directory:f.directory,env:makeEnv('fail'),manager:route,message:'Generic reminder'}),error=>!error.message.includes('PRIVATE_')&&!error.message.includes('/private/example')&&error.message.includes('backend failed'));
 const failed=await checkAutomaticNotification({...f,managers,env:makeEnv('fail')});assert.equal(failed.state,'FAILED');
 assert.ok(!JSON.stringify(failed).includes('PRIVATE_BACKEND_CANARY'));
});
