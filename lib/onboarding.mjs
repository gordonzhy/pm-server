import {recoverCodexRuntime,runtimeEvidence,cachedRuntimeSession} from './codex-runtime-observer.mjs';
import {readFile,writeFile,mkdir,rename,access,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {runtimeCsv,stateDir} from './paths.mjs';
import {hookEvents,hookCommand,hookSignature,probeCodex} from './codex-integration.mjs';
import {notificationConfiguration,notificationDelivery,notificationManagers,automaticNotificationStatus,registeredManagerReference} from './notifications.mjs';
import {projectSnapshot} from '../scripts/workbench-data.mjs';
const probes=new Map();
const pendingProbes=new Map();
export const managerSetupPrompt='$project-manager 请接管当前项目的项目管理：将当前会话登记为项目经理，核对进行中任务的经理和执行会话路由，连接 PM Server 工作台，并检查运行观察和后台通知。保留现有任务和授权范围，不猜测会话身份，不启动新的业务交付。';

export const synchronizationPrompt="$project-manager 请检查当前项目与 PM Server 的连接和运行状态同步，说明需要处理的事项，并在现有授权内修复后复检。保留现有经理、任务、执行会话和授权范围，不启动新业务交付。";

export {notificationManagers} from './notifications.mjs';

const supportedHosts=['codex','dsh'];
export async function selectOnboardingHosts({directory=stateDir(),hosts}={}){
 if(!Array.isArray(hosts)||hosts.length>supportedHosts.length||new Set(hosts).size!==hosts.length||hosts.some(h=>!supportedHosts.includes(h)))throw new Error('Invalid host selection');
 await mkdir(directory,{recursive:true,mode:0o700});const file=path.join(directory,'adapter-selection.json'),tmp=file+'.'+randomUUID();
 await writeFile(tmp,JSON.stringify({version:1,hosts})+'\n',{mode:0o600});await rename(tmp,file);return {state:'SAVED',hosts};
}
async function commandAvailable(command){
 for(const p of path.isAbsolute(command)?[command]:(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir,command))){try{await access(p,constants.X_OK);if((await stat(p)).isFile())return true;}catch{}}
 return false;
}

export async function onboardingStatus({directory=stateDir(),cachePath=runtimeCsv(),checkHost=false,diagnoseRuntime=false,cwd=process.cwd(),projects,service}={}){
 const codexHome=process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),hooksPath=path.join(codexHome,'hooks.json');
 let configuration='MISSING',error;
 try{const value=JSON.parse(await readFile(hooksPath,'utf8'));configuration=hookEvents.every(event=>(Array.isArray(value.hooks?.[event])?value.hooks[event]:[]).some(group=>(Array.isArray(group?.hooks)?group.hooks:[]).some(h=>h?.type==='command'&&h.command===hookCommand)))?'INSTALLED':'OUTDATED_OR_INCOMPLETE';}
 catch(e){if(e.code!=='ENOENT'){configuration='INVALID';error='Cannot read valid Codex hook configuration';}}
 let stateBinding='MISSING';
 try{const b=JSON.parse(await readFile(path.join(codexHome,'pm-server-observer.json'),'utf8'));stateBinding=b.version===1&&b.stateDir===directory?'MATCHED':'DIFFERENT_STATE_DIRECTORY';}catch(e){if(e.code!=='ENOENT')stateBinding='INVALID';}
 if(!projects){try{projects=JSON.parse(await readFile(path.join(directory,'registry.json'),'utf8')).projects||[];}catch{projects=[];}}
 const projectStates=new Map(await Promise.all(projects.map(async p=>[p,await projectSnapshot(p)])));
 const targets=[...projectStates.values()].filter(p=>p.available).flatMap(p=>(p.tasks||[]).filter(t=>t.status==='进行中'&&t.execution_thread_id).map(t=>({reference:t.execution_thread_id,projectRoot:p.root})));
 let runtimeRecovery={checked:0,recovered:0,results:[]};
 if(diagnoseRuntime&&targets.length){try{runtimeRecovery=await recoverCodexRuntime({targets,runtimeCsv:cachePath,codexHome,force:true});}catch{runtimeRecovery={checked:targets.length,recovered:0,results:[{state:'UNAVAILABLE',reason:'RECOVERY_UNAVAILABLE'}]};}}
 let sessions=[],allSessions=[],observation='MISSING';
 try{allSessions=Object.values(JSON.parse(await readFile(cachePath+'.json','utf8')).sessions||{});sessions=allSessions.filter(s=>s.id?.startsWith('codex:'));observation=sessions.some(s=>Number.isFinite(Date.parse(s.lastSeenAt))&&Date.now()-Date.parse(s.lastSeenAt)<300000)?'RECENT_CACHE_PRESENT':sessions.length?'STALE_CACHE':'MISSING';}catch(e){if(e.code!=='ENOENT')observation='INVALID_CACHE';}
 let signature,receipt;
 try{signature=await hookSignature(codexHome);receipt=JSON.parse(await readFile(path.join(directory,'codex-observation.json'),'utf8'));}catch{}
 const receiptMatches=!!signature&&receipt?.signature===signature&&Number.isFinite(Date.parse(receipt.lastSeenAt))&&Date.parse(receipt.lastSeenAt)<=Date.now()+60000;
 const toolObserved=receiptMatches&&!!receipt.events?.PostToolUse;
 const notify=await notificationConfiguration(process.env,directory),delivery=await notificationDelivery(directory,notify.signature);
 let hostSelection,selectionError=false,selectionSource='inferred';
 try{const saved=JSON.parse(await readFile(path.join(directory,'adapter-selection.json'),'utf8'));if(saved.version!==1||!Array.isArray(saved.hosts)||saved.hosts.length>supportedHosts.length||new Set(saved.hosts).size!==saved.hosts.length||saved.hosts.some(h=>!supportedHosts.includes(h)))throw new Error();hostSelection=saved.hosts;selectionSource='saved';}catch(e){if(e.code!=='ENOENT')selectionError=true;}
 if(!hostSelection&&process.env.PM_SERVER_HOSTS!==undefined){hostSelection=process.env.PM_SERVER_HOSTS.split(',').filter(Boolean);selectionSource='environment';if(hostSelection.some(h=>!supportedHosts.includes(h)))selectionError=true;}
 let savedCodex=false;try{savedCodex=JSON.parse(await readFile(path.join(directory,'notification-config.json'),'utf8')).backend==='codex';}catch{}
 hostSelection||=[...(stateBinding!=='MISSING'||notify.backend==='codex'||savedCodex||process.env.PROJECT_MANAGER_CODEX_BIN?['codex']:[]),...(allSessions.some(s=>s.id?.startsWith('dsh:'))?['dsh']:[])];
 const key=JSON.stringify([codexHome,cwd,signature,process.env.PM_SERVER_CODEX_BIN||'codex',process.env.PATH]);
 let host=probes.get(key)?.value||{state:'UNKNOWN',authentication:'UNKNOWN'};
 if(checkHost&&hostSelection.includes('codex')&&configuration==='INSTALLED'&&stateBinding==='MATCHED'){
  if(!pendingProbes.has(key))pendingProbes.set(key,probeCodex({cwd,includeAuthentication:false}));
  try{host=await pendingProbes.get(key);probes.set(key,{at:Date.now(),value:host});if(probes.size>16)probes.delete(probes.keys().next().value);}
  finally{pendingProbes.delete(key);}
 }
 if(!checkHost&&probes.has(key)&&Date.now()-probes.get(key).at>30000)host={state:'UNKNOWN',authentication:'UNKNOWN'};
 if(!projects){try{projects=JSON.parse(await readFile(path.join(directory,'registry.json'),'utf8')).projects||[];}catch{projects=[];}}
 let active=0,missingRoutes=0,unreadableProjects=0;const snapshots=[],routeIssues=[];
 for(const project of projects){
  try{
   const data=projectStates.get(project);
   if(!data.available){unreadableProjects++;continue;}
   snapshots.push(data);
   for(const task of data.tasks||[])if(task.status==='进行中'){
    active++;
    const reasons=[];
    if(!task.manager_thread_id)reasons.push('manager_route_missing');
    if(!task.execution_thread_id)reasons.push('execution_route_missing');
    if(!task.dispatch_id)reasons.push('dispatch_identity_missing');
    if(reasons.length)missingRoutes++;
    if(task.execution_thread_id){
     let reference=task.execution_thread_id;
     // Only native Codex UUIDs have an established legacy-to-qualified mapping.
     if(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(reference))reference='codex:'+(process.env.PM_SERVER_INSTANCE||'default')+':'+reference;
     const observed=cachedRuntimeSession(Object.fromEntries(allSessions.map(s=>[s.id,s])),reference);
     if(!observed)reasons.push('execution_observation_missing');
     else if(runtimeEvidence(observed)!=='CURRENT')reasons.push('execution_observation_stale');
    }
    if(reasons.length)routeIssues.push({projectId:project.id,projectName:project.name,projectRoot:project.root,taskId:task.id,taskTitle:task.title,reasons});
   }
  }catch{unreadableProjects++;}
 }
 const observationGaps=routeIssues.filter(issue=>issue.reasons.some(reason=>reason.startsWith('execution_observation_'))).length;
 const missingProjectManagers=snapshots.filter(project=>project.manager?!registeredManagerReference(project.manager.threadId):new Set((project.tasks||[]).map(task=>registeredManagerReference(task.manager_thread_id)).filter(Boolean)).size!==1).length;
 const checks=[];
 const stateArgument=' --state-dir /path/to/pm-server-state';
 const add=(id,title,status,detail,command)=>checks.push({id,title,status,detail,...(command?{command}:{})});
 add('hook-config','安装运行观察',configuration==='INSTALLED'&&stateBinding==='MATCHED'?'complete':'action_required','安装 Hook 并连接到当前服务的状态目录。','pm-server adapter install codex'+stateArgument);
 add('hook-trust','信任并启用 Hook',host.state==='TRUSTED'?'complete':['REVIEW_REQUIRED','DISABLED','NOT_LOADED'].includes(host.state)?'action_required':'verify',host.state==='UNKNOWN'?'自动检测暂时无法确认，请重新检测或在 Codex 中检查。':host.state==='DISABLED'?'Hook 已被禁用，请在 Codex 中启用后重新检测。':'在 Codex CLI 检查并信任当前 PM Server Hook。','/hooks');
 add('runtime-observation','验证真实运行事件',toolObserved?'complete':'verify','运行一次包含工具调用的 Codex 会话，再重新检测。普通事件缓存不能代替当前 Hook 的执行记录。');
 add('projects','项目来源',unreadableProjects?'action_required':projects.length?'complete':'not_applicable',unreadableProjects?'部分项目无法读取，请修复来源。':'连接需要纳入工作台的项目。','pm-server project request --repo /absolute/path/to/project'+stateArgument);
 add('routes','连接项目经理',unreadableProjects?'verify':missingProjectManagers?'action_required':snapshots.length?'complete':'not_applicable',
  missingProjectManagers?'当前没有可用的经理路由，不影响查看任务；已有经理在下一次真实管理请求时按既有授权核对并修复。':snapshots.length?'项目经理已登记。既有任务的执行路由和运行观察由经理后续协调时逐步核对。':'当前无需连接经理会话；需要项目管理时可在项目对话中使用 PM Skill。');
 const runtimeDiagnostics={state:routeIssues.length?'OBSERVATION_PENDING':'NO_GAPS',observationGaps,routeIssues,recovery:runtimeRecovery,checks:[{
  id:'execution-observation',title:'运行观察与执行路由',status:routeIssues.length?'verify':active?'complete':'not_applicable',
  detail:routeIssues.length?'部分任务的执行路由或运行观察尚待核对。原经理下次协调任务时按当前真源和既有执行身份逐步对齐；不影响工作台使用。':'当前没有待核对的执行路由或运行观察缺口。'
 }]};

 const notifyDetail={INVALID_ARGUMENTS:'通知参数不是有效的字符串 JSON 数组，请修正 PROJECT_MANAGER_NOTIFY_ARGS。',EXECUTABLE_UNAVAILABLE:'找不到可执行的通知程序，请检查路径与执行权限。',DISABLED:'后台通知已停用，请启用并重启服务。'}[notify.state]||'Codex 接入后会自动准备通知通道；不可用时点击检测并连接。';
 add('notification-config','配置后台通知',notify.state==='CONFIGURED_NOT_DELIVERY_VERIFIED'?'complete':'action_required',notify.state==='CONFIGURED_NOT_DELIVERY_VERIFIED'?'后台通知通道已就绪，登记经理后会自动检查。':notifyDetail);
 const managers=notificationManagers(snapshots,notify.backend,process.env.PM_SERVER_INSTANCE||'default'),automatic=await automaticNotificationStatus(directory,notify.signature,managers);
 const automaticFailure=['FAILED','UNKNOWN'].includes(automatic.state);
 add('notification-delivery','通知通道自动检查',automatic.state==='ACCEPTED'?'complete':automaticFailure?'action_required':['UNAVAILABLE','WAITING_FOR_MANAGER'].includes(automatic.state)?'not_applicable':'checking',automatic.state==='ACCEPTED'?'自动测试已被通知服务接受，无需手动确认；这不代表经理已处理任务。':automaticFailure?'通知调用尚未通过，请按实际调用错误核对通道；不影响已完成的配置检查。':automatic.state==='WAITING_FOR_MANAGER'?'当前没有可投递的经理路由；不影响任务查看。后续真实管理请求会核对路由。':'通知能力尚未就绪；不影响任务查看。');
 const nodeAvailable=await commandAvailable('node');let hookEntryAvailable=false;try{await access(new URL('../scripts/session-runtime-hook.mjs',import.meta.url));hookEntryAvailable=true;}catch{}
 const hookConfigured=configuration==='INSTALLED'&&stateBinding==='MATCHED'&&nodeAvailable&&hookEntryAvailable;
 const sendConfigured=notify.state==='CONFIGURED_NOT_DELIVERY_VERIFIED';
 const codexChecks=[{id:'hook-config',title:'Codex Hook 回传入口',status:hookConfigured?'complete':'action_required',detail:hookConfigured?'已配置，待运行验证。':'需要匹配的 Hook 定义、状态绑定和可用命令入口。',...(!hookConfigured?{command:'pm-server adapter install codex'+stateArgument}:{})},
 {id:'notification-config',title:'Codex 发送通道',status:sendConfigured?'complete':'action_required',detail:sendConfigured?'已配置，待运行验证。':notifyDetail}];
 const hosts=supportedHosts.map(id=>{const selected=hostSelection.includes(id),hostChecks=id==='codex'?codexChecks:[];const pendingCount=selected?hostChecks.filter(c=>c.status==='action_required').length:0;return {id,selected,selectionSource,pendingCount,state:!selected?'NOT_SELECTED':id==='dsh'?'ADAPTER_AVAILABLE':pendingCount?'CONFIGURATION_REQUIRED':'CONFIGURED_PENDING_RUNTIME',checks:selected?hostChecks:[],capabilities:id==='codex'?{send:sendConfigured,returnEvents:hookConfigured,correlatedReceipt:false}:{observation:true,send:false,returnEvents:false,correlatedReceipt:false},detail:id==='dsh'?'产品提供 DSH 生命周期观察适配器；不代表本机已加载或观察成功，尚未提供双向通知配置。':'双向配置由发送后端与 Hook 事件回传组成，尚无同一消息的关联收发回执。配置就绪不代表 Hook 已触发、通知已收到或结果已回传。'};});
 runtimeDiagnostics.checks.push(...checks.filter(c=>c.id==='routes'));
 const sessionDiagnostics={checks:checks.filter(c=>hostSelection.includes('codex')&&['hook-trust','runtime-observation'].includes(c.id))};
 const notificationDiagnostics={checks:hostSelection.includes('codex')?checks.filter(c=>c.id==='notification-delivery'):[]};
 const basicChecks=checks.filter(c=>c.id==='projects');
 if(selectionError)basicChecks.push({id:'adapter-selection',title:'宿主选择配置',status:'action_required',detail:'宿主选择配置无效，请重新保存选择。'});
 const pending=basicChecks.filter(c=>!['complete','not_applicable','checking'].includes(c.status));
 const actionRequiredCount=basicChecks.filter(c=>c.status==='action_required').length,verificationCount=basicChecks.filter(c=>c.status==='verify').length;
 return {hosts,hostConfigurationPendingCount:hosts.reduce((n,h)=>n+h.pendingCount,0),sessionDiagnostics,notificationDiagnostics,runtimeDiagnostics,runtimeRecovery,actionRequiredCount,verificationCount,state:pending.length?'VERIFICATION_REQUIRED':'CHECKS_PASSED',checkedAt:new Date().toISOString(),pendingCount:pending.length,checks:basicChecks,
  codex:{configuration,hooksPath,stateBinding,...(error?{error}:{}),trust:host.state==='UNKNOWN'?'VERIFY_IN_CODEX_CLI':host.state,authentication:host.authentication||'UNKNOWN',probeReason:host.reason,hostCheckedAt:probes.get(key)?new Date(probes.get(key).at).toISOString():null,observation,observedSessions:sessions.length,lifecycle:toolObserved?'TOOL_EVENT_OBSERVED':receiptMatches?'SESSION_EVENT_ONLY':'NOT_VERIFIED',lastHookAt:receiptMatches?receipt.lastSeenAt:null},
  projects:{registered:projects.length,activeTasks:active,missingRoutes,observationGaps,missingProjectManagers,routeIssues,unreadable:unreadableProjects},notifications:notify.state,notificationManagers:managers,automaticNotification:automatic,notificationDelivery:delivery,nextSteps:pending.map(c=>c.title+': '+(c.prompt||c.command||c.detail))};
}
