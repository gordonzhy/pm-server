import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,readFile,rm,stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setupWizard} from './setup-wizard.mjs';
import {configureCodexNotifications,notificationConfiguration,sendNotification,confirmNotification,notificationDelivery} from './notifications.mjs';

test('wizard cancels changes, recovers failed actions and rechecks before exiting',async()=>{
 const answers=['1','n','2','n','3','/fictional/project','7','0'],actions=[];let checks=0,transcript='';
 const result=await setupWizard({ask:async()=>answers.shift(),output:{write:s=>transcript+=s},check:async()=>{checks++;return {pendingCount:2,checks:[{title:'Test',status:'verify',detail:'Unverified'}]};},execute:async(op,repo)=>{actions.push([op,repo]);throw new Error('unavailable');}});
 assert.deepEqual(actions,[['project','/fictional/project']]);assert.equal(checks,5);assert.equal(result.pendingCount,2);assert.match(transcript,/unavailable/);assert.match(transcript,/再次运行/);
});
test('wizard retries automatic checks without asking for a manager session or receipt',async()=>{
 const answers=['5','6','0'],actions=[];let transcript='';
 await setupWizard({ask:async()=>answers.shift(),output:{write:text=>transcript+=text},check:async()=>({pendingCount:1,checks:[]}),retry:async()=>{actions.push('retry');return {state:'ACCEPTED'};}});
 assert.deepEqual(actions,['retry']);assert.match(transcript,/\$project-manager/);assert.ok(!transcript.includes('HOST:INSTANCE:SESSION_ID'));
});
test('saved Codex notification choice survives a new environment and preserves explicit overrides',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pm-setup-notify-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const bin=path.join(dir,'codex'),log=path.join(dir,'argv.json');
 await writeFile(bin,'#!'+process.execPath+'\nrequire("node:fs").writeFileSync('+JSON.stringify(log)+',JSON.stringify(process.argv.slice(2)));');await chmod(bin,0o755);
 const env={PATH:dir,PROJECT_MANAGER_NOTIFY_BIN:'',PROJECT_MANAGER_CODEX_BIN:'',PROJECT_MANAGER_NOTIFY_DISABLED:''};
 assert.equal((await notificationConfiguration(env,dir)).state,'NOT_CONFIGURED');
 await configureCodexNotifications({directory:dir,env});
 assert.equal((await stat(path.join(dir,'notification-config.json'))).mode&0o777,0o600);
 assert.deepEqual(JSON.parse(await readFile(path.join(dir,'notification-config.json'))),{version:1,backend:'codex'});
 const config=await notificationConfiguration({...env},dir);assert.equal(config.state,'CONFIGURED_NOT_DELIVERY_VERIFIED');
 await sendNotification({directory:dir,env:{...env},manager:'codex:default:fictional',message:'test'});
 assert.deepEqual(JSON.parse(await readFile(log)),['queue','--thread','fictional','--message','test']);
 assert.equal((await notificationDelivery(dir,config.signature)).state,'ACCEPTED');
 await confirmNotification({directory:dir,env});assert.equal((await notificationDelivery(dir,config.signature)).state,'OWNER_CONFIRMED');
 await sendNotification({directory:dir,env,manager:'codex:default:fictional',message:'monitor reminder',kind:'recovery'});
 assert.equal((await notificationDelivery(dir,config.signature)).state,'OWNER_CONFIRMED');
 await sendNotification({directory:dir,env,manager:'codex:default:another-fictional',message:'another test'});
 assert.equal((await notificationDelivery(dir,config.signature)).state,'ACCEPTED');
 assert.equal((await notificationConfiguration({...env,PROJECT_MANAGER_NOTIFY_DISABLED:'1'},dir)).state,'DISABLED');
 assert.equal((await notificationConfiguration({...env,PROJECT_MANAGER_NOTIFY_BIN:'/unavailable'},dir)).state,'EXECUTABLE_UNAVAILABLE');
 await assert.rejects(configureCodexNotifications({directory:dir,env:{...env,PROJECT_MANAGER_NOTIFY_DISABLED:'1'}}));
});

test('ordinary monitor acceptance cannot satisfy or confirm setup test delivery',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'pm-monitor-not-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const env={...process.env,PROJECT_MANAGER_NOTIFY_BIN:process.execPath,PROJECT_MANAGER_NOTIFY_ARGS:'["-e", "process.exit(0)"]',PROJECT_MANAGER_NOTIFY_DISABLED:''};
 const config=await notificationConfiguration(env,dir);
 await sendNotification({directory:dir,env,manager:'codex:default:fictional',message:'reminder',kind:'recovery'});
 assert.equal((await notificationDelivery(dir,config.signature)).state,'NOT_VERIFIED');
 await assert.rejects(confirmNotification({directory:dir,env}));
 await writeFile(path.join(dir,'notification-check.json'),JSON.stringify({version:1,signature:config.signature,state:'ACCEPTED',kind:'recovery',confirmedAt:new Date().toISOString()}));
 assert.equal((await notificationDelivery(dir,config.signature)).state,'NOT_VERIFIED');
 await assert.rejects(confirmNotification({directory:dir,env}));
});
