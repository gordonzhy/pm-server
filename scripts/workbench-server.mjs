#!/usr/bin/env node
import {sharedProjectId,shareView,shareCsv,shareDetail} from '../lib/share-view.mjs';
import {runtimeCsv} from '../lib/paths.mjs';
import {onboardingStatus,selectOnboardingHosts} from '../lib/onboarding.mjs';
import {sendNotification,confirmNotification,validManagerReference,prepareDefaultNotifications,checkAutomaticNotification} from '../lib/notifications.mjs';
import { taskLogResources, readAbsoluteLogEvidence } from './task-log-resources.mjs';
import { inlineTaskLog } from './task-log.mjs';
import path from 'node:path';
import { ensurePassword, readPassword, createWorkbenchAuth } from './workbench-auth.mjs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, realpath, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Registry, defaultStateDir } from './workbench-registry.mjs';
import { taskRows, parseCsv, projectSnapshot, inspectProject } from './workbench-data.mjs';
import { readRepositoryFile, testingResources } from './testing-dashboard.mjs';

const skillRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const applicationRelease=JSON.parse(await readFile(path.join(skillRoot,'package.json'),'utf8'));
const escapeHtml=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const csvEncode=rows=>rows.map(row=>row.map(x=>'"'+String(x||'').replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
const uuid=/^[0-9a-f-]{36}$/;
export async function startWorkbench({stateDir=defaultStateDir(),port=9999,host=process.env.WORKBENCH_HOST || '127.0.0.1',publicOrigin=process.env.WORKBENCH_PUBLIC_ORIGIN || '',runtimePath=runtimeCsv(),reconcileIntervalMs=30000,watchDirectory=watch}={}) {
  if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('工作台监听地址只支持 127.0.0.1 或 0.0.0.0');
  if(!Number.isInteger(port)||port<0||port>65535) throw new Error('工作台端口无效');
  if(!Number.isInteger(reconcileIntervalMs)||reconcileIntervalMs<100) throw new Error('工作台对账间隔必须是不小于100的毫秒整数');
  if(publicOrigin) {
    const origin=new URL(publicOrigin);
    if(origin.protocol!=='https:' || origin.origin!==publicOrigin || origin.username || origin.password) throw new Error('WORKBENCH_PUBLIC_ORIGIN 必须是无路径的 HTTPS 来源，例如 https://board.example.com');
  }
  const credentials=await ensurePassword(stateDir), auth=await createWorkbenchAuth({stateDir,password:credentials.password});
  const registry=new Registry(stateDir);
  // 首次创建空目录，不登记任何项目。
  await registry.mutate(()=>null);
  await registry.activatePending();
  const token=randomBytes(32).toString('hex'), clients=new Map(), watchers=new Map();
  let base, closing=false, syncChain=Promise.resolve(), syncPending=false, pendingChanges=new Set(), eventTimer, watchWarnings=[];
  function emit(projectId=null) {
    pendingChanges.add(projectId);
    clearTimeout(eventTimer);
    eventTimer=setTimeout(()=>{
      const ids=[...pendingChanges]; pendingChanges.clear();
      closeInvalidClients();
      for(const [client,entry] of clients) {
        const allowed=entry.principal.role==='owner'?ids:ids.filter(id=>id===null||entry.principal.projectIds.includes(id));
        if(!allowed.length)continue;
        if(allowed.includes(null)||!entry.filter)client.write(`event: change\ndata: ${JSON.stringify({projectIds:entry.principal.role==='owner'?allowed:allowed.map(id=>id===null?null:sharedProjectId(entry.principal,id)),registry:allowed.includes(null)})}\n\n`);
        else if(allowed.includes(entry.filter))client.write(`event: change\ndata: ${JSON.stringify({projectIds:[entry.principal.role==='owner'?entry.filter:sharedProjectId(entry.principal,entry.filter)]})}\n\n`);
      }
    },80);
  }
  function closeInvalidClients(){for(const [client,entry] of clients)if(!auth.valid(entry.principal)){clearTimeout(entry.timer);client.end();clients.delete(client);}}
  async function refreshPassword(){
    try{const changed=await auth.syncPassword(await readPassword(credentials.filename));if(changed)closeInvalidClients();}
    catch(error){for(const [client,entry] of clients){clearTimeout(entry.timer);client.end();}clients.clear();throw error;}
  }
  async function syncWatchers() {
    if(closing) return;
    const state=await registry.read(), desired=new Map(), warnings=[];
    const add=(directory,key,label)=>{ const entry=desired.get(directory)||{keys:new Set(),labels:new Set()}; entry.keys.add(key);entry.labels.add(label);desired.set(directory,entry); };
    add(registry.directory,null,'工作台登记');
    add(path.dirname(runtimePath),'runtime','会话运行缓存');
    for(const project of state.projects) {
      add(path.dirname(project.csvPath),project.id,`${project.name} 的 CSV`);
      try {
        const rows=parseCsv(await readRepositoryFile(project.root,project.csvRelative,'utf8'));
        const tasks=taskRows(await readRepositoryFile(project.root,project.csvRelative,'utf8'));
        for(const task of tasks) add(path.dirname(path.join(project.root,task.detail_path)),project.id,`${project.name} 的任务详情`);
        const resources=await testingResources(project.root,rows,parseCsv);
        for(const directory of resources.directories) add(directory,project.id,`${project.name} 的测试依据`);
        const logs=await taskLogResources(project.root,rows);
        for(const directory of logs.directories) add(directory,project.id,`${project.name} 的日志依据`);
      } catch(error) {warnings.push(`${project.name} 的监听资源读取失败（${error.message}）；后台将重试`);}
    }
    if(closing) return;
    for(const [directory,entry] of watchers) if(!desired.has(directory)) {entry.watcher.close(); watchers.delete(directory);}
    for(const [directory,{keys,labels}] of desired) {
      try {
        // fs.watch follows the old inode when a directory is replaced. Recheck
        // identity during reconciliation, even when the watcher reports no error.
        const info=await stat(directory);
        if(!info.isDirectory())throw new Error('不是文件夹');
        const previous=watchers.get(directory);
        if(previous&&previous.dev===info.dev&&previous.ino===info.ino){previous.keys=keys;previous.labels=labels;continue;}
        if(previous){previous.watcher.close();watchers.delete(directory);}
        const entry={keys,labels,watcher:null,dev:info.dev,ino:info.ino};
        entry.watcher=watchDirectory(directory,(_event,filename)=>{
          const name=filename===null ? null : String(filename);
          for(const key of entry.keys) {
            if(key===null) { if(name===null || name==='registry.json') {emit(null); scheduleWatchSync();} }
            else if(key==='runtime') {if(name===null || name===path.basename(runtimePath)) {void registry.read().then(s=>s.projects.forEach(p=>emit(p.id))).catch(()=>{});}}
            else {emit(key); scheduleWatchSync();}
          }
        });
        entry.watcher.on('error',error=>{entry.watcher.close();if(watchers.get(directory)===entry)watchers.delete(directory);watchWarnings=[...watchWarnings,`${[...entry.labels].join('、')} 监听不可用（${directory}；${error.message}）；后台将重试`];emit(null);});
        entry.watcher.on('close',()=>{if(!closing&&watchers.get(directory)===entry){watchers.delete(directory);watchWarnings=[...watchWarnings,`${[...entry.labels].join('、')} 监听已关闭（${directory}）；后台将重试`];emit(null);}});
        watchers.set(directory,entry);
      } catch(error) {
        watchers.get(directory)?.watcher.close();watchers.delete(directory);
        warnings.push(`${[...labels].join('、')} 监听不可用（${directory}；${error.message}）；后台将重试`);
      }
    }
    watchWarnings=warnings;
  }
  function scheduleWatchSync() {
    if(closing)return syncChain;
    if(!syncPending){syncPending=true;syncChain=syncChain.then(async()=>{syncPending=false;await syncWatchers();}).catch(error=>{watchWarnings=[`监听资源对账失败（${error.message}）；后台将重试`];emit(null);});}
    return syncChain;
  }
  const respond=(res,status,value,type='application/json; charset=utf-8',head=false)=>{
    const body=Buffer.isBuffer(value)?value:Buffer.from(type.startsWith('application/json')?JSON.stringify(value):String(value));
    res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store','Content-Length':body.length,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'"});
    res.end(head?undefined:body);
  };
  const server=createServer((req,res)=>{let privateErrors=false;void (async()=>{
    const method=req.method || 'GET',head=method==='HEAD';
    const localHosts=new Set([new URL(base).host,`localhost:${server.address().port}`]);
    const allowedHosts=new Set(localHosts);if(publicOrigin)allowedHosts.add(new URL(publicOrigin).host);
    let requestOrigin;
    try {
      const authority=req.headers.host;
      if(typeof authority!=='string'||/[\s\\/@?#%]/.test(authority))throw new Error('地址无效');
      const target=new URL('http://'+authority);
      if(!target.hostname||target.pathname!=='/'||target.search||target.hash||target.username||target.password)throw new Error('地址无效');
      // 全网卡监听允许任意合法 Host；回环模式仍只接受本机地址。
      if(host!=='0.0.0.0'&&!allowedHosts.has(target.host)){respond(res,403,{error:'工作台地址未获允许'});return;}
      requestOrigin=target.origin;
    }catch{respond(res,403,{error:'工作台地址无效'});return;}
    await refreshPassword();
    const url=new URL(req.url,base);
    const sameOrigin=()=>[requestOrigin,requestOrigin.replace(/^http:/,'https:')].includes(req.headers.origin) || (publicOrigin && req.headers.origin===publicOrigin);
    // 浏览器 Origin 经同源校验后可用于识别代理外侧 HTTPS，无需信任任意转发头。
    const secureSession=publicOrigin|| (req.headers.origin===requestOrigin.replace(/^http:/,'https:')?'https':'');
    async function inputJson() {
      const chunks=[];let length=0;for await(const chunk of req){length+=chunk.length;if(length>65536){const error=new Error('请求过大');error.code='BODY_TOO_LARGE';throw error;}chunks.push(chunk);}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('请求必须是 JSON 对象');return value;
    }
    if(method==='POST'&&(!sameOrigin()||!/^application\/json\b/.test(req.headers['content-type']||''))) {respond(res,403,{error:'请在工作台页面操作'});return;}
    if(['GET','HEAD'].includes(method)&&url.pathname==='/assets/i18n.js'){respond(res,200,await readFile(path.join(skillRoot,'assets/i18n.js')),'text/javascript; charset=utf-8',head);return;}
    if(['GET','HEAD'].includes(method)&&['/login','/share'].includes(url.pathname)) {
      respond(res,200,await readFile(path.join(skillRoot,'assets/workbench-login.html')),'text/html; charset=utf-8',head);return;
    }
    if(method==='POST'&&['/auth/login','/auth/share','/auth/logout'].includes(url.pathname)) {
      const input=await inputJson();
      if(url.pathname==='/auth/logout'){await auth.logout(req,res,secureSession);closeInvalidClients();respond(res,200,{ok:true});return;}
      let identity;
      if(url.pathname==='/auth/login') {
        const result=auth.checkPassword(input.password);
        if(!result.ok){if(result.limited)res.setHeader('Retry-After',String(result.retryAfter));respond(res,result.limited?429:401,{error:result.limited?'尝试过多，请稍后再试':'密码不正确'});return;}
        identity={role:'owner'};
      } else {
        identity=auth.redeem(input.token);
        if(!identity){const result=auth.checkPassword(null);if(result.limited)res.setHeader('Retry-After',String(result.retryAfter));respond(res,result.limited?429:401,{error:'分享链接无效、已过期或已撤销'});return;}
        // 分享必须仍包含已登记项目，不能复活已移除的资料。
        if(!(await registry.read()).projects.some(p=>identity.projectIds.includes(p.id))){respond(res,403,{error:'分享的项目已不再提供访问'});return;}
        if(auth.principal(req)?.role==='owner'){respond(res,200,{ok:true});return;}
      }
      await auth.issue(req,res,identity,secureSession);closeInvalidClients();respond(res,200,{ok:true});return;
    }
    const localHealth=url.pathname==='/health'&&['GET','HEAD'].includes(method)&&localHosts.has(req.headers.host)&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)&&!Object.keys(req.headers).some(h=>h==='forwarded'||h.startsWith('x-forwarded-'))&&auth.healthCredential(req);
    const principal=localHealth?{role:'owner'}:auth.principal(req,res);
    if(!principal) {
      if(['GET','HEAD'].includes(method)&&(url.pathname==='/'||/^\/projects\/[^/]+\/TASKS.html$/.test(url.pathname))){res.setHeader('Location','/login');respond(res,303,{error:'请先登录'},undefined,head);}
      else respond(res,401,{error:'登录已过期，请重新登录'},undefined,head);
      return;
    }
    const owner=principal.role==='owner';privateErrors=owner;
    if(url.pathname==='/auth/session'&&method==='GET'){respond(res,200,{role:principal.role,expiresAt:null,permanent:true});return;}
    if(!owner&&(method==='POST'||url.pathname==='/health'||url.pathname.startsWith('/api/shares')||url.pathname.startsWith('/api/onboarding'))){respond(res,403,{error:'分享访问仅允许阅读指定项目'});return;}
    if(method==='POST') {
      if(req.headers['x-workbench-token']!==token || !/^application\/json\b/.test(req.headers['content-type']||'')) {respond(res,403,{error:'工作台操作凭据无效，请重载页面'});return;}
      const input=await inputJson(); let result;
      if(url.pathname==='/api/onboarding/retry-notification'){
        const state=await onboardingStatus({directory:registry.directory,cachePath:runtimePath,projects:(await registry.read()).projects});
        respond(res,200,await checkAutomaticNotification({directory:registry.directory,managers:state.notificationManagers,force:true}));return;
      }
      if(url.pathname==='/api/onboarding/select-hosts'){respond(res,200,await selectOnboardingHosts({directory:registry.directory,hosts:input.hosts}));return;}
      if(url.pathname==='/api/onboarding/configure-notifications'){respond(res,200,await prepareDefaultNotifications({directory:registry.directory}));return;}
      if(url.pathname==='/api/onboarding/confirm-notification'){respond(res,200,await confirmNotification({directory:registry.directory}));return;}
      if(url.pathname==='/api/onboarding/test-notification'){
        if(!validManagerReference(input.manager)){respond(res,400,{error:'请填写完整的经理会话引用'});return;}
        const receipt=await sendNotification({manager:input.manager,message:'PM Server test notification. Confirm receipt in the target manager session; acceptance does not mean the manager handled it.',kind:'test',directory:registry.directory});respond(res,200,receipt);return;
      }
      if(url.pathname==='/api/shares/create'){const ids=(await registry.read()).projects.map(p=>p.id);if(!Array.isArray(input.projectIds)||input.projectIds.some(id=>!ids.includes(id)))throw new Error('请选择仍已登记的项目');const result=await auth.create(input);respond(res,200,{...result,url:(publicOrigin||req.headers.origin)+'/share#token='+result.token});return;}
      if(url.pathname==='/api/shares/revoke'){const result=await auth.revoke(input.id);closeInvalidClients();respond(res,200,result);return;}
      if(url.pathname==='/api/browse') {
        const folder=input.folder||os.homedir();if(typeof folder!=='string'||!path.isAbsolute(folder))throw new Error('请选择文件夹的绝对路径');
        const directory=await realpath(folder);if(!(await stat(directory)).isDirectory())throw new Error('该路径不是文件夹');
        const names=await readdir(directory,{withFileTypes:true}),entries=[];
        for(const entry of names){if(!input.showHidden&&entry.name.startsWith('.'))continue;let directoryEntry=entry.isDirectory(),fileEntry=entry.isFile();if(entry.isSymbolicLink()){try{const info=await stat(path.join(directory,entry.name));directoryEntry=info.isDirectory();fileEntry=info.isFile();}catch{continue;}}
          if(directoryEntry||(fileEntry&&/\.csv$/i.test(entry.name)))entries.push({name:entry.name,path:path.join(directory,entry.name),kind:directoryEntry?'directory':'csv'});
        }
        entries.sort((a,b)=>(a.kind===b.kind?0:a.kind==='directory'?-1:1)||a.name.localeCompare(b.name,'zh-CN',{numeric:true}));
        respond(res,200,{folder:directory,parent:path.dirname(directory),entries:entries.slice(0,1000),truncated:entries.length>1000,shortcuts:[{label:'个人文件夹',path:os.homedir()},{label:'工作目录',path:process.cwd()},{label:'磁盘',path:process.platform==='darwin'?'/Volumes':path.parse(directory).root}]});return;
      }
      else if(url.pathname==='/api/inspect') {const p=await inspectProject(input);respond(res,200,{name:p.name,group:p.group,root:p.root,csvPath:p.csvPath,taskCount:p.tasks.length});return;}
      else if(url.pathname==='/api/add') result=await registry.add(input);
      else if(url.pathname==='/api/confirm') result=await registry.confirm(input.id);
      else if(url.pathname==='/api/remove') result=await registry.remove(input.id);
      else if(url.pathname==='/api/delete-removed') result=await registry.deleteRemoved(input.id);
      else if(url.pathname==='/api/restore') result=await registry.restore(input.id);
      else if(url.pathname==='/api/reject') result=await registry.reject(input.id);
      else {respond(res,404,{error:'接口不存在'});return;}
      await scheduleWatchSync(); emit(null); respond(res,200,result);return;
    }
    if(!['GET','HEAD'].includes(method)) {respond(res,405,{error:'方法不支持'});return;}
    if(url.pathname==='/api/onboarding'){
      const registered=(await registry.read()).projects;
      respond(res,200,await onboardingStatus({directory:registry.directory,cachePath:runtimePath,projects:registered,checkHost:url.searchParams.get('checkHost')==='1',diagnoseRuntime:url.searchParams.get('diagnoseRuntime')==='1',cwd:registered[0]?.root||process.cwd(),service:{port:Number(new URL(base).port),host}}),undefined,head);return;
    }
    if(url.pathname==='/health') {respond(res,200,{kind:'project-manager-workbench',application:'pm-server',applicationVersion:applicationRelease.version,contractVersion:1,stateDir:registry.directory,pid:process.pid,url:base+'/',skillRoot,authentication:'cookie',publicOrigin,listenHost:host},undefined,head);return;}
    if(url.pathname==='/') {
      const template=await readFile(path.join(skillRoot,'assets/workbench.html'),'utf8');
      respond(res,200,template.replaceAll('__WORKBENCH_TOKEN__',owner?token:'').replaceAll('__WORKBENCH_ROLE__',owner?'owner':'viewer'),'text/html; charset=utf-8',head);return;
    }
    if(url.pathname==='/assets/i18n.mjs' || url.pathname==='/assets/task-log.css' || url.pathname==='/assets/vendor/js-yaml.min.js' || url.pathname==='/assets/task-log.js' || url.pathname==='/assets/workbench-minimap.mjs' || url.pathname==='/assets/workbench-notifications.mjs' || url.pathname==='/assets/workbench-onboarding.mjs' || url.pathname==='/assets/workbench.js' || url.pathname==='/assets/workbench.css' || url.pathname==='/assets/workbench-graph.mjs' || url.pathname==='/assets/workbench-table.mjs') {
      respond(res,200,await readFile(path.join(skillRoot,url.pathname)),(url.pathname.endsWith('.js')||url.pathname.endsWith('.mjs'))?'text/javascript; charset=utf-8':'text/css; charset=utf-8',head);return;
    }
    if(url.pathname==='/assets/project-manager-logo.svg' || url.pathname==='/assets/project-manager-favicon.png') {
      respond(res,200,await readFile(path.join(skillRoot,url.pathname)),url.pathname.endsWith('.svg')?'image/svg+xml':'image/png',head);return;
    }
    if(url.pathname==='/api/shares'){respond(res,200,{shares:auth.list(),publicOrigin});return;}
    const fullState=await registry.read();
    const state=owner?fullState:{version:1,revision:0,projects:fullState.projects.filter(p=>principal.projectIds.includes(p.id)),pending:[],removed:[]};
    const visibleId=p=>owner?p.id:sharedProjectId(principal,p.id);
    const snapshot=async p=>{const data=await projectSnapshot(p);return owner?data:shareView(data,principal,principal.projectIds.indexOf(p.id));};
    if(url.pathname==='/api/state') {
      const projects=await Promise.all(state.projects.map(snapshot));
      respond(res,200,{...state,projects,watchWarnings:owner?watchWarnings:[]},undefined,head);return;
    }
    const snapshotMatch=url.pathname.match(/^\/api\/projects\/([0-9a-f-]+)$/);
    if(snapshotMatch) {
      const project=state.projects.find(x=>visibleId(x)===snapshotMatch[1]);
      if(!project) {respond(res,404,{error:'项目已移除'});return;}
      respond(res,200,await snapshot(project),undefined,head);return;
    }
    const resourceMatch=url.pathname.match(/^\/projects\/([0-9a-f-]+)\/(.*)$/);
    const eventMatch=url.pathname.match(/^\/projects\/([0-9a-f-]+)\/events$/);
    if(url.pathname==='/events' || eventMatch) {
      const id=eventMatch?.[1] || null;
      if(id && !state.projects.some(x=>visibleId(x)===id)) {respond(res,404,{error:'项目已移除'});return;}
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','Connection':'keep-alive'});
      if(head) {res.end();return;}
      const entry={filter:id?state.projects.find(p=>visibleId(p)===id).id:null,principal,timer:null};clients.set(res,entry);res.write(`event: change\ndata: ${JSON.stringify({registry:true})}\n\n`); req.on('close',()=>{clearTimeout(entry.timer);clients.delete(res);});return;
    }
    if(resourceMatch && uuid.test(resourceMatch[1])) {
      const project=state.projects.find(x=>visibleId(x)===resourceMatch[1]);
      if(!project) {respond(res,404,{error:'项目已移除'});return;}
      const relative=decodeURIComponent(resourceMatch[2]);
      if(!owner&&relative!=='TASKS.html'){
        const view=await snapshot(project);
        if(relative==='TASKS.csv'){respond(res,200,shareCsv(view),'text/csv; charset=utf-8',head);return;}
        const task=view.tasks.find(task=>task.detail_path===relative);
        if(task){respond(res,200,shareDetail(task),'text/markdown; charset=utf-8',head);return;}
        respond(res,403,{error:'分享只提供去标识化进度，不提供原始资料'},undefined,head);return;
      }
      if(relative==='TASKS.html') {
        let template=inlineTaskLog(await readFile(path.join(skillRoot,'assets/task-dashboard.html'),'utf8'));
        const logo=(await readFile(path.join(skillRoot,'assets/project-manager-logo.svg'),'utf8')).trim();
        const replacements={DASHBOARD_TITLE:escapeHtml((owner?project.name:(await snapshot(project)).name)+' 任务看板'),DASHBOARD_LOGO:logo,DASHBOARD_FAVICON:'data:image/svg+xml,'+encodeURIComponent(logo),TASK_JSON:'[]',STATUS_OPTIONS:'',BOUNDARY_OPTIONS:'',PRIORITY_OPTIONS:''};
        template=template.replace(/\{\{([A-Z_]+)\}\}/g,(_match,key)=>{if(key in replacements)return replacements[key];if(key.endsWith('_COUNT'))return '0';if(key.endsWith('_IDS'))return '无';throw new Error('未知看板模板占位符：'+key);});
        respond(res,200,template,'text/html; charset=utf-8',head);return;
      }
      const source=await readRepositoryFile(project.root,project.csvRelative,'utf8');
      if(relative==='task-log-file') {
        const file=await readAbsoluteLogEvidence(project.root,parseCsv(source),url.searchParams.get('card'),url.searchParams.get('ref'));
        if(file.contentType==='application/octet-stream')res.setHeader('Content-Disposition','attachment');
        respond(res,200,file.body,file.contentType,head);return;
      }
      if(relative==='TASKS.csv') {respond(res,200,source,'text/csv; charset=utf-8',head);return;}
      const tasks=taskRows(source);
      if(relative==='session-runtime.csv') {
        const sessions=new Set(tasks.flatMap(t=>[t.execution_thread_id,t.manager_thread_id]).filter(Boolean));
        const rows=parseCsv(await readFile(runtimePath,'utf8')),headers=rows.shift()||[];
        const selected=['session_id','status','current_turn_id','status_at','last_seen_at'], indices=selected.map(x=>headers.indexOf(x));
        if(indices.some(x=>x<0)) throw new Error('会话观察缓存字段不完整');
        respond(res,200,csvEncode([selected,...rows.filter(row=>sessions.has(row[indices[0]])).map(row=>indices.map(i=>row[i]))]),'text/csv; charset=utf-8',head);return;
      }
      const resources=await testingResources(project.root,parseCsv(source),parseCsv);
      if(!tasks.some(t=>t.detail_path===relative) && !resources.allowed.has(relative) && !(await taskLogResources(project.root,parseCsv(source))).allowed.has(relative)) {respond(res,404,{error:'文件未登记'});return;}
      if(['.html','.htm','.svg'].includes(path.extname(relative).toLowerCase()))res.setHeader('Content-Disposition','attachment');
      const media={'.pdf':'application/pdf','.md':'text/markdown; charset=utf-8','.json':'application/json; charset=utf-8','.jsonl':'application/x-ndjson','.csv':'text/csv; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.mp4':'video/mp4','.webm':'video/webm'};
      respond(res,200,await readRepositoryFile(project.root,relative),media[path.extname(relative)] || 'text/plain; charset=utf-8',head);return;
    }
    respond(res,404,{error:'入口不存在'},undefined,head);
  })().catch(error=>{
    if(res.headersSent) {res.end();return;}
    respond(res,error.code==='BODY_TOO_LARGE'?413:['EACCES','ELOOP'].includes(error.code)?403:error.code==='ENOENT'?404:400,{error:privateErrors?error.message:'请求无法完成',...(!privateErrors?{code:'REQUEST_FAILED'}:{})},undefined,req.method==='HEAD');
  });});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  base=`http://127.0.0.1:${server.address().port}`;
  await scheduleWatchSync();
  // Notifications are hints, not the sole source of truth. Periodic full refresh
  // also repairs dropped events and retries missing/failed directory watches.
  let reconciling=false;
  const reconciliation=setInterval(()=>{
    if(reconciling||closing)return;
    reconciling=true;
    void scheduleWatchSync().then(()=>{if(!closing)emit(null);}).finally(()=>{reconciling=false;});
  },reconcileIntervalMs);reconciliation.unref();
  const credentialCheck=setInterval(()=>{void refreshPassword().catch(()=>{});},1000);credentialCheck.unref();
  const heartbeat=setInterval(()=>{closeInvalidClients();for(const client of clients.keys()) client.write(': heartbeat\n\n');},20000);heartbeat.unref();
  return {server,registry,passwordFile:credentials.filename,url:base+'/',async close(){closing=true;clearInterval(heartbeat);clearInterval(reconciliation);clearInterval(credentialCheck);await syncChain;await auth.flush();clearTimeout(eventTimer);for(const {watcher} of watchers.values()) watcher.close();for(const [client,entry] of clients){clearTimeout(entry.timer);client.end();}clients.clear();server.closeIdleConnections();await new Promise(r=>server.close(r));}};
}
if(process.argv[1] && await realpath(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),get=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
  const instance=await startWorkbench({stateDir:get('--state-dir',defaultStateDir()),port:Number(get('--port','9999')),host:get('--host',process.env.WORKBENCH_HOST || '127.0.0.1')});
  process.stdout.write(JSON.stringify({url:instance.url,pid:process.pid})+'\n');
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>void instance.close().then(()=>process.exit(0)));
}
