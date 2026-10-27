#!/usr/bin/env node
import {spawnSync,spawn} from 'node:child_process';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stateDir,runtimeCsv} from '../lib/paths.mjs';
import {upsertRuntimeSession} from '../lib/runtime-cache.mjs';
import {onboardingStatus} from '../lib/onboarding.mjs';
import {sendNotification,confirmNotification,validManagerReference,configureCodexNotifications,prepareDefaultNotifications,checkAutomaticNotification} from '../lib/notifications.mjs';
import {setupWizard} from '../lib/setup-wizard.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const args=process.argv.slice(2),command=args.shift();
function run(file,argv=[],{accept=false}={}) {
 const result=spawnSync(process.execPath,[path.join(root,'scripts',file),...argv],{encoding:'utf8',env:process.env,maxBuffer:8*1024*1024});
 if(result.error)throw result.error;
 if(!accept&&result.status!==0)throw new Error(result.stderr.trim()||result.stdout.trim()||`exit ${result.status}`);
 return {code:result.status,stdout:result.stdout,stderr:result.stderr};
}
function parsed(result){try{return JSON.parse(result.stdout);}catch{return {error:result.stderr||result.stdout};}}
function output(value){console.log(JSON.stringify(value,null,2));}
const get=(key,fallback)=>{const i=args.indexOf(key);if(i<0)return fallback;if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`missing ${key}`);return args[i+1];};
if(args.includes('--state-dir'))process.env.PM_SERVER_STATE_DIR=path.resolve(get('--state-dir'));
const shared=['--state-dir',stateDir()];
async function serviceStatus(){return {workbench:parsed(run('manage-workbench-service.mjs',[...shared,'--status','--port',get('--port','9999')],{accept:true})),monitor:parsed(run('manage-task-monitor.mjs',[...shared,'--status'],{accept:true}))};}
async function control(enabled){await mkdir(stateDir(),{recursive:true,mode:0o700});const f=path.join(stateDir(),'control.json'),tmp=f+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify({enabled,changedAt:new Date().toISOString()})+'\n',{mode:0o600});await rename(tmp,f);}
try {
 if(!command||['help','--help','-h'].includes(command)){
  console.log(`PM Server ${pkg.version}\n\n项目留在你的仓库，进展汇聚到同一个工作台。\n\nCommands:\n  setup [codex] [--json | --dry-run] [--port PORT] [--state-dir PATH]\n  doctor | status [--json] [--check-host] [--state-dir PATH]\n  service start|ensure|stop|status|run [--port 9999] [--state-dir PATH]\n  project request|list|collect [--repo PATH] [--csv PATH]\n  monitor once|status|checkpoint|release|pause|resume [--repo PATH] [--task ID]\n    checkpoint: --dispatch ID --execution ID --manager HOST:INSTANCE:ID --until ISO --reason TEXT --actor TEXT (max 24h)\n  adapter list|check|install codex|dsh|claude-code [--dry-run]\n  notification test --manager HOST:INSTANCE:SESSION_ID\n  event ingest --host HOST --instance ID\n  --version\n\nNo install hooks, automatic host changes or startup at npm install time.`);
 } else if(command==='--version'||command==='version')console.log(pkg.version);
 else if(command==='doctor')output({application:'pm-server',version:pkg.version,contractVersion:1,node:process.version,stateDir:stateDir(),runtimeCsv:runtimeCsv(),platform:process.platform,validatedPlatforms:['darwin'],services:await serviceStatus(),onboarding:await onboardingStatus({checkHost:args.includes('--check-host')}),hostIntegration:'See onboarding checks; cached observations are not hook trust or delivery verification.'});
 else if(command==='status')output({application:'pm-server',version:pkg.version,contractVersion:1,stateDir:stateDir(),runtimeCsv:runtimeCsv(),...await serviceStatus(),onboarding:await onboardingStatus({checkHost:args.includes('--check-host')})});
 else if(command==='notification'){
  const action=args.shift();if(action==='retry'){const state=await onboardingStatus();output(await checkAutomaticNotification({managers:state.notificationManagers,force:true}));process.exit(0);}if(action==='confirm'){output(await confirmNotification());process.exit(0);}
  if(action!=='test')throw new Error('notification test --manager HOST:INSTANCE:SESSION_ID | notification confirm');
  const manager=get('--manager');if(!validManagerReference(manager))throw new Error('--manager requires a qualified HOST:INSTANCE:SESSION_ID');
  output(await sendNotification({manager,message:'PM Server test notification. Confirm receipt in the target manager session; acceptance does not mean the manager handled it.',kind:'test'}));
 }
 else if(command==='setup'){
  const host=args[0]&&!args[0].startsWith('--')?args.shift():'codex';if(host!=='codex')throw new Error('setup [codex] [--json | --dry-run] [--port PORT] [--state-dir PATH]');
  if(!args.includes('--json')&&!args.includes('--dry-run')){
   if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Interactive setup requires a terminal. Use setup codex --json for explicit automated installation, or doctor --json --check-host for read-only checks.');
   const invoke=(...operation)=>{const r=spawnSync(process.execPath,[fileURLToPath(import.meta.url),...operation,...args],{encoding:'utf8',env:process.env,maxBuffer:8*1024*1024});if(r.error)throw r.error;if(r.status!==0)throw new Error(r.stderr.trim()||r.stdout.trim());return JSON.parse(r.stdout);};
   await setupWizard({retry:async()=>{const state=await onboardingStatus();return checkAutomaticNotification({managers:state.notificationManagers,force:true});},check:async()=>({...await onboardingStatus({checkHost:true}),services:await serviceStatus()}),execute:(operation,repo)=>operation==='setup'?invoke('setup','codex','--json'):invoke('project','request','--repo',path.resolve(repo)),
    configure:async()=>{const saved=await configureCodexNotifications(),previous=await serviceStatus(),web=previous.workbench;invoke('service','stop');const options=web.url?['--port',new URL(web.url).port,'--host',web.listenHost||'127.0.0.1']:[];return {...saved,service:invoke('service','start',...options)};},
    send:manager=>{if(!validManagerReference(manager))throw new Error('Target must be HOST:INSTANCE:SESSION_ID');return sendNotification({manager,message:'PM Server test notification. Please verify receipt in this manager session.',kind:'test'});},
    confirm:()=>confirmNotification(),launch:()=>new Promise((resolve,reject)=>{const child=spawn(process.env.PM_SERVER_CODEX_BIN||'codex',[],{stdio:'inherit',env:process.env});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error('Codex exited: '+code)));})});
  }
  else if(args.includes('--dry-run'))output({host,state:'PREVIEW',changes:['Merge user-level Codex lifecycle hooks with backup','Start the workbench and monitor'],trust:'Review in Codex CLI /hooks; never changed automatically',notifications:'Not enabled automatically'});
  else{
   const installation=run('install-session-runtime-hook.mjs',['--install']);
   const started=spawnSync(process.execPath,[fileURLToPath(import.meta.url),'service','start',...args],{encoding:'utf8',env:process.env});
   if(started.error)throw started.error;
   if(started.status!==0)throw new Error(started.stderr.trim()||'Service start failed; Codex hooks remain installed. Retry setup after resolving the service error.');
   output({state:'ACTION_REQUIRED',host,installation:installation.stdout.trim(),services:JSON.parse(started.stdout),onboarding:await onboardingStatus()});
  }
 }
 else if(command==='project'){
  const action=args.shift();if(!['request','list','collect'].includes(action))throw new Error('project request|list|collect; projects register automatically; removal/restoration/unblocking is available in workbench settings');
  console.log(run('workbench.mjs',[action,...args,...shared]).stdout.trim());
 }else if(command==='monitor'){
  const action=args.shift();
  if(action==='once'){const r=run(args.includes('--repo')?'watch-active-tasks.mjs':'run-task-monitor.mjs',[...args,...shared,...(args.includes('--repo')?[]:['--once'])],{accept:true});if(r.stdout.trim())console.log(r.stdout.trim());if(r.stderr.trim())console.error(r.stderr.trim());process.exitCode=r.code;}
  else if(['status','checkpoint','release'].includes(action))console.log(run('monitor-checkpoint.mjs',[action,...args]).stdout.trim());
  else if(['pause','resume'].includes(action))console.log(run('pause-task-monitor.mjs',[...args,...shared,...(action==='resume'?['--resume']:[])]).stdout.trim());
  else throw new Error('monitor once|status|checkpoint|release|pause|resume');
 }else if(command==='service'){
  const action=args.shift();
  if(action==='status')output(await serviceStatus());
  else if(action==='start'||action==='ensure'){
   if(action==='ensure'){let c;try{c=JSON.parse(await readFile(path.join(stateDir(),'control.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}if(c?.enabled!==true){output({state:c?.enabled===false?'DISABLED':'NOT_ENABLED'});process.exit(0);}}
   await prepareDefaultNotifications();
   const web=parsed(run('manage-workbench-service.mjs',[...shared,'--port',get('--port','9999'),'--host',get('--host','127.0.0.1')]));
   try{const monitor=parsed(run('manage-task-monitor.mjs',[...shared]));await control(true);output({state:'STARTED',workbench:web,monitor,onboarding:await onboardingStatus()});}
   catch(e){if(web.state==='STARTED')run('manage-workbench-service.mjs',[...shared,'--stop','--port',String(web.url?new URL(web.url).port:0)],{accept:true});throw e;}
  }else if(action==='stop'){
   await control(false);
   const monitor=run('manage-task-monitor.mjs',[...shared,'--stop'],{accept:true});
   const web=run('manage-workbench-service.mjs',[...shared,'--stop','--port',get('--port','9999')],{accept:true});
   output({enabled:false,workbench:parsed(web),monitor:parsed(monitor)});
   if(web.code||monitor.code)process.exitCode=1;
  }else if(action==='run'){
   const children=[spawn(process.execPath,[path.join(root,'scripts/workbench-server.mjs'),...shared,'--port',get('--port','9999')],{stdio:'inherit'}),spawn(process.execPath,[path.join(root,'scripts/run-task-monitor.mjs'),...shared],{stdio:'inherit'})];
   let ending=false;const stop=()=>{if(ending)return;ending=true;for(const c of children)c.kill('SIGTERM');};
   process.on('SIGTERM',stop);process.on('SIGINT',stop);
   await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.on('error',e=>{stop();reject(e);});c.on('exit',code=>{if(code)process.exitCode=code;stop();resolve();});})));
  }else throw new Error('service start|ensure|stop|status|run; OS autostart installation is not included in this release');
 }else if(command==='event'){
  if(args.shift()!=='ingest')throw new Error('event ingest required');let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>1048576)throw new Error('event exceeds 1 MiB');}
  const event=JSON.parse(input);if(!get('--host',event.session?.host))throw new Error('--host is required');output(await upsertRuntimeSession({sessionId:event.session_id||event.session?.session_id,host:get('--host',event.session?.host),instance:get('--instance',event.session?.instance_id||'default'),status:event.status,turnId:event.turn_id,occurredAt:event.occurred_at,sequence:event.sequence,eventId:event.event_id}));
 }else if(command==='adapter'){
  const action=args.shift(),host=args.shift();
  if(action==='list')output({codex:{observation:'legacy hook, target-host verification pending',installer:'available'},dsh:{observation:'minimal Cordis observer, new package integration pending',path:path.join(root,'adapters/dsh/observer.js')},'claude-code':{observation:'manual standard event ingest',nativeInstaller:'not yet verified'}});
  else if(!['codex','dsh','claude-code'].includes(host))throw new Error('adapter host must be codex|dsh|claude-code');
  else if(action==='check'&&host==='codex'){const r=run('install-session-runtime-hook.mjs',['--check'],{accept:true});console.log(r.stdout.trim());process.exitCode=r.code;}
  else if(action==='install'&&host==='codex'){
   if(args.includes('--dry-run'))output({host,changes:'merge legacy lifecycle command definitions with backup; host event/trust support must be verified',installer:path.join(root,'scripts/install-session-runtime-hook.mjs')});
   else console.log(run('install-session-runtime-hook.mjs',['--install']).stdout.trim());
  }else if(['install','check'].includes(action))output({host,state:'MANUAL_SETUP_REQUIRED',path:host==='dsh'?path.join(root,'adapters/dsh/observer.js'):null,help:'See README and adapter documentation; no host configuration was modified.'});
  else throw new Error('adapter list|check|install; automatic uninstall is not yet available, restore only the backed-up managed entries');
 }else if(command==='open'){
  const status=await serviceStatus(),url=status.workbench.url;if(!url)throw new Error('workbench is stopped; enable with pm-server service start');
  const opener=process.platform==='darwin'?'open':process.platform==='win32'?'explorer.exe':'xdg-open';const r=spawnSync(opener,[url],{stdio:'ignore'});if(r.error||r.status)throw new Error(`Open ${url}`);output({url});
 }else throw new Error(`Unknown command ${command}; see pm-server --help`);
}catch(error){console.error(error.message);process.exitCode=2;}
