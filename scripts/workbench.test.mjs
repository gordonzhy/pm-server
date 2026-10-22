import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { Registry } from './workbench-registry.mjs';
import { parseCsv, taskRows, projectSnapshot } from './workbench-data.mjs';
import { readPassword, passwordPath, authorizationFor } from './workbench-auth.mjs';
import { startWorkbench, fetch } from './workbench-test-client.mjs';
const exec=promisify(execFile), scripts=path.dirname(fileURLToPath(import.meta.url));
const headers='id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,task_type';
const csv=status=>`${headers}\nSAME-001,${status},P0,产品,测试任务,[],开发,2026-10-13T00:00:00+08:00,2026-10-13T00:00:00+08:00,details/task.md,开发\n`;
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'pm-workbench-'));
  const cleanupStack=[];let cleaned=false;
  const addCleanup=action=>cleanupStack.push(action);
  const cleanup=async()=>{
    if(cleaned)return;
    const errors=[];
    while(cleanupStack.length){try{await cleanupStack.pop()();}catch(error){errors.push(error);}}
    // Preserve service identity and logs if stopping fails; never erase the
    // state needed to diagnose/retry cleanup and then claim a clean fixture.
    if(errors.length)throw new AggregateError(errors,`fixture cleanup failed; preserved ${root}`);
    await rm(root,{recursive:true,force:true});cleaned=true;
  };
  t.after(cleanup);
  const inputs=[];
  for(const [name,status] of [['项目甲','待确认'],['项目乙','受阻'],['项目丙','已完成']]) {
    const repo=path.join(root,name);await mkdir(path.join(repo,'details'),{recursive:true});
    const csvPath=path.join(repo,name==='项目乙'?'BACKLOG.csv':'TASKS.csv');
    await writeFile(csvPath,csv(status));await writeFile(path.join(repo,'details/task.md'),`# SAME-001 ${name}\n\n- 状态：${status}\n`);
    inputs.push({csvPath,root:repo,name,group:name==='项目丙'?'研究':'产品'});
  }
  return {root,inputs,registry:new Registry(path.join(root,'state')),addCleanup,cleanup};
}
async function assertExited(pid){
  const deadline=Date.now()+3000;
  while(true){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')return;throw error;}
    if(Date.now()>=deadline)assert.fail(`managed fixture process ${pid} remains alive after stop`);
    await new Promise(r=>setTimeout(r,25));
  }
}
function managedCleanup(fx,args){
  const pids=new Set();
  fx.addCleanup(async()=>{const value=JSON.parse((await exec(process.execPath,[...args,'--stop'])).stdout);assert.equal(value.state,'STOPPED');for(const pid of pids)await assertExited(pid);});
  return pids;
}

test('CSV 支持 BOM、CRLF、引用字段和多行；拒绝未闭合引号',()=>{
  assert.deepEqual(parseCsv('\uFEFFa,b\r\n"甲,乙","一\n二"\r\n'),[['a','b'],['甲,乙','一\n二']]);
  assert.throws(()=>parseCsv('a,b\n"unfinished'),/未闭合/);
});
test('注册前拒绝重复 ID、非法状态、错误字段及跨项目依赖',()=>{
  assert.throws(()=>taskRows(csv('不存在')),/状态无效/);
  assert.throws(()=>taskRows(csv('待办')+csv('待办').split('\n')[1]+'\n'),/重复/);
  assert.throws(()=>taskRows('id,status\na,待办\n'),/必需字段/);
  assert.throws(()=>taskRows(csv('待办').replace(',[],',',[OTHER-001],')),/不存在/);
});
// Seed the persisted shape written by older releases, without the new request path.
async function legacyPending(fx,input=fx.inputs[0]) {
  const project=await fx.registry.add(input);
  await fx.registry.mutate(state=>{state.projects=state.projects.filter(p=>p.id!==project.id);state.pending.push({...project,requestedAt:new Date().toISOString()});});
  return {project};
}
test('无效来源不登记；请求旧申请立即升级并保留身份',async t=>{
  const fx=await fixture(t),old=await legacyPending(fx);
  const upgraded=await fx.registry.request(fx.inputs[0]);assert.equal(upgraded.state,'registered');assert.equal(upgraded.project.id,old.project.id);assert.equal((await fx.registry.read()).pending.length,0);
  await writeFile(fx.inputs[1].csvPath,'bad');await assert.rejects(fx.registry.request(fx.inputs[1]));assert.equal((await fx.registry.read()).projects.length,1);
});
test('启动迁移逐项验证旧申请，隔离坏来源且黑名单优先',async t=>{
  const fx=await fixture(t),good=await legacyPending(fx),bad=await legacyPending(fx,fx.inputs[1]),blocked=await legacyPending(fx,fx.inputs[2]);
  await writeFile(fx.inputs[1].csvPath,'broken');
  await fx.registry.mutate(state=>state.removed.push({...blocked.project,removedAt:new Date().toISOString()}));
  const instance=await startWorkbench({stateDir:fx.registry.directory,port:0,runtimePath:path.join(fx.root,'runtime.csv')});fx.addCleanup(()=>instance.close());
  const saved=await fx.registry.read();assert.deepEqual(saved.projects.map(p=>p.id),[good.project.id]);assert.equal(saved.pending.length,1);assert.equal(saved.pending[0].id,bad.project.id);assert.ok(saved.pending[0].registrationError);assert.equal(saved.removed[0].id,blocked.project.id);
  await fx.registry.activatePending();assert.equal((await fx.registry.read()).revision,saved.revision);
  await writeFile(fx.inputs[1].csvPath,csv('受阻'));await fx.registry.confirm(bad.project.id);assert.equal((await fx.registry.read()).projects.length,2);
});
test('并发自动登记与移除后只保留黑名单，重启不再加入',async t=>{
 const fx=await fixture(t),p=(await fx.registry.request(fx.inputs[0])).project;
 await Promise.all([fx.registry.remove(p.id),...Array.from({length:4},()=>fx.registry.request(fx.inputs[0]))]);
 const saved=await new Registry(fx.registry.directory).read();assert.equal(saved.projects.length,0);assert.equal(saved.pending.length,0);assert.equal(saved.removed.length,1);
 assert.equal((await new Registry(fx.registry.directory).request(fx.inputs[0])).state,'removed');
});
test('有效项目自动注册且重复请求不改变身份或登记修订',async t=>{
  const fx=await fixture(t),a=await fx.registry.request(fx.inputs[0]),b=await fx.registry.request(fx.inputs[0]);
  assert.equal(a.state,'registered');assert.equal(a.project.id,b.project.id);const saved=await fx.registry.read();assert.equal(saved.projects.length,1);assert.equal(saved.pending.length,0);assert.equal(saved.revision,1);
});
test('并发独立进程注册不会丢失或重复登记',async t=>{
  const fx=await fixture(t),state=fx.registry.directory;
  await Promise.all([...fx.inputs,...fx.inputs].map(input=>exec(process.execPath,[path.join(scripts,'workbench.mjs'),'request','--csv',input.csvPath,'--state-dir',state])));
  assert.equal((await fx.registry.read()).projects.length,3);assert.equal((await fx.registry.read()).pending.length,0);
});
test('旧版连接重试时重新核对来源，错误 CSV 不会加入',async t=>{
  const fx=await fixture(t),pending=await legacyPending(fx);await writeFile(fx.inputs[0].csvPath,'bad');
  await assert.rejects(fx.registry.confirm(pending.project.id));assert.equal((await fx.registry.read()).pending.length,1);assert.equal((await fx.registry.read()).projects.length,0);
});
test('移除持久加入黑名单，普通及旧版自动请求均不复活，CSV不变',async t=>{
  const fx=await fixture(t),before=await readFile(fx.inputs[0].csvPath),project=await fx.registry.add(fx.inputs[0]);
  await fx.registry.remove(project.id);assert.deepEqual(await readFile(fx.inputs[0].csvPath),before);
  assert.equal((await fx.registry.request(fx.inputs[0],{automatic:true})).state,'removed');assert.equal((await fx.registry.read()).pending.length,0);
  const request=await new Registry(fx.registry.directory).request(fx.inputs[0]);assert.equal(request.state,'removed');assert.equal(request.project.id,project.id);const alias=path.join(fx.inputs[0].root,'alias.csv');await symlink(fx.inputs[0].csvPath,alias);assert.equal((await fx.registry.request({...fx.inputs[0],csvPath:alias})).state,'removed');assert.equal((await fx.registry.read()).projects.length,0);
});
test('页面主动添加、重复添加、撤销与最近移除恢复保留身份',async t=>{
  const fx=await fixture(t),a=await fx.registry.add(fx.inputs[0]);assert.equal((await fx.registry.add(fx.inputs[0])).id,a.id);
  await fx.registry.remove(a.id);assert.equal((await fx.registry.restore(a.id)).id,a.id);
  await fx.registry.remove(a.id);assert.equal((await fx.registry.add(fx.inputs[0])).id,a.id);assert.equal((await fx.registry.read()).removed.length,0);
});
test('并发确认/移除/恢复不产生重复正式记录',async t=>{
  const fx=await fixture(t),p=await legacyPending(fx);
  const results=await Promise.allSettled([fx.registry.confirm(p.project.id),fx.registry.confirm(p.project.id)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await fx.registry.read()).projects.length,1);
  await fx.registry.remove(p.project.id);await fx.registry.request(fx.inputs[0]);await fx.registry.restore(p.project.id);
  assert.equal((await fx.registry.read()).pending.length,0);assert.equal((await fx.registry.read()).projects.length,1);
});
test('最近移除来源缺失时恢复失败，原登记继续可见',async t=>{
  const fx=await fixture(t),p=await fx.registry.add(fx.inputs[0]);await fx.registry.remove(p.id);await rm(fx.inputs[0].csvPath);
  await assert.rejects(fx.registry.restore(p.id));assert.equal((await fx.registry.read()).removed.length,1);
});
test('真实路径去重，拒绝仓库外 CSV 与详情符号链接',async t=>{
  const fx=await fixture(t),p=await fx.registry.add(fx.inputs[0]),alias=path.join(fx.inputs[0].root,'alias.csv');await symlink(fx.inputs[0].csvPath,alias);
  assert.equal((await fx.registry.add({...fx.inputs[0],csvPath:alias})).id,p.id);
  await assert.rejects(fx.registry.add({...fx.inputs[1],root:fx.inputs[0].root}));
  await rm(path.join(fx.inputs[1].root,'details/task.md'));await symlink(path.join(fx.inputs[0].root,'details/task.md'),path.join(fx.inputs[1].root,'details/task.md'));
  await assert.rejects(fx.registry.add(fx.inputs[1]),/outside/);
});
test('同名任务具有不同 key；单项目读取故障不污染其他项目',async t=>{
  const fx=await fixture(t),a=await fx.registry.add(fx.inputs[0]),b=await fx.registry.add(fx.inputs[1]);
  const snapshots=await Promise.all([a,b].map(projectSnapshot));assert.notEqual(snapshots[0].tasks[0].key,snapshots[1].tasks[0].key);
  await writeFile(b.csvPath,'broken');const failed=await projectSnapshot(b);assert.equal(failed.available,false);assert.equal(failed.counts,null);assert.equal((await projectSnapshot(a)).counts['待确认'],1);
});
test('拒绝申请后自动启动不再次申请，用户可重新添加',async t=>{
  const fx=await fixture(t),p=await legacyPending(fx);await fx.registry.reject(p.project.id);
  assert.equal((await fx.registry.request(fx.inputs[0],{automatic:true})).state,'removed');await fx.registry.add(fx.inputs[0]);assert.equal((await fx.registry.read()).projects.length,1);
});
async function webFixture(t) {
  const fx=await fixture(t),runtime=path.join(fx.root,'runtime.csv');await writeFile(runtime,'session_id,status,current_turn_id,status_at,last_seen_at\n');
  const instance=await startWorkbench({stateDir:fx.registry.directory,port:0,host:'127.0.0.1',runtimePath:runtime});fx.addCleanup(()=>instance.close());
  const html=await (await fetch(instance.url)).text(),token=html.match(/name="workbench-token" content="([^"]+)/)[1],origin=instance.url.slice(0,-1);
  const get=endpoint=>fetch(new URL(endpoint,instance.url));
  const post=(endpoint,input,extra={})=>fetch(new URL(endpoint,instance.url),{method:'POST',headers:{'Content-Type':'application/json','Origin':origin,'X-Workbench-Token':token,...extra},body:JSON.stringify(input)});
  return {...fx,...instance,get,post};
}
test('HTTP 自动注册立即可读，移除屏蔽读取与自动加入并保留文件',async t=>{
  const fx=await webFixture(t),request=await fx.registry.request(fx.inputs[0]);
  for(const [resource,type] of [['project-manager-logo.svg','image/svg+xml'],['project-manager-favicon.png','image/png']]){const response=await fx.get('/assets/'+resource);assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));assert.ok((await response.arrayBuffer()).byteLength>0);}
  assert.equal((await (await fx.get('/api/state')).json()).projects.length,1);assert.equal((await fx.get(`/projects/${request.project.id}/TASKS.csv`)).status,200);
  const add=await (await fx.post('/api/add',fx.inputs[1])).json();assert.equal((await fx.get(`/projects/${add.id}/TASKS.csv`)).status,200);
  assert.match(await (await fx.get(`/projects/${add.id}/details/task.md`)).text(),/项目乙/);
  const dashboard=await (await fx.get(`/projects/${add.id}/TASKS.html?task=SAME-001`)).text();assert.match(dashboard,/requestedTaskOpened/);assert.doesNotMatch(dashboard,/\{\{[A-Z_]+\}\}/);assert.match(dashboard,/let tasks=\[\]/);
  await fx.post('/api/remove',{id:add.id});assert.equal((await fx.registry.request(fx.inputs[1])).state,'removed');assert.equal((await fx.get(`/projects/${add.id}/TASKS.csv`)).status,404);
  assert.equal((await fx.get('/health')).status,200);assert.match(await readFile(add.csvPath,'utf8'),/受阻/);
  assert.equal((await fx.post('/api/restore',{id:add.id})).status,200);
});
test('HTTP 防止跨站修改、错误凭据、非本机 Host、任意文件读取',async t=>{
  const fx=await webFixture(t),p=await fx.registry.add(fx.inputs[0]);
  assert.equal((await fx.post('/api/remove',{id:p.id},{Origin:'https://foreign.example'})).status,403);
  assert.equal((await fx.post('/api/remove',{id:p.id},{'X-Workbench-Token':'wrong'})).status,403);
  assert.equal((await fx.get(`/projects/${p.id}/SKILL.md`)).status,404);
  assert.equal((await fx.get(`/projects/${p.id}/%2e%2e%2fTASKS.csv`)).status,404);
  const status=await new Promise((resolve,reject)=>{const request=httpRequest(fx.url,{headers:{Host:'foreign.example'}},response=>{response.resume();resolve(response.statusCode);});request.on('error',reject);request.end();});
  assert.equal(status,403);
  assert.equal((await fx.registry.read()).projects.length,1);
});
test('SSE 发送变化项目身份，CSV 原子替换及删除后恢复都重新读取',async t=>{
  const fx=await webFixture(t),p=await (await fx.post('/api/add',fx.inputs[0])).json();
  const controller=new AbortController();fx.addCleanup(()=>controller.abort());
  const response=await fetch(new URL('/events',fx.url),{signal:controller.signal}),reader=response.body.getReader();await reader.read();
  await new Promise(r=>setTimeout(r,120)); // 等添加通知排出，不把它当作文件变化证明。
  await writeFile(p.csvPath,csv('受阻'));
  let received='';const deadline=Date.now()+2000;
  while(!received.includes(p.id)&&Date.now()<deadline){const chunk=await reader.read();received+=new TextDecoder().decode(chunk.value);}
  assert.match(received,new RegExp(p.id));assert.equal((await (await fx.get(`/api/projects/${p.id}`)).json()).counts['受阻'],1);
  await rm(p.csvPath);assert.equal((await (await fx.get('/api/state')).json()).projects[0].available,false);
  await writeFile(p.csvPath,csv('待确认'));assert.equal((await (await fx.get('/api/state')).json()).projects[0].counts['待确认'],1);
  controller.abort();
});
test('运行观察只开放已登记会话；观察读取不会改变 CSV',async t=>{
  const fx=await webFixture(t);
  await writeFile(fx.inputs[0].csvPath,csv('待确认').replace(',task_type',',task_type,execution_thread_id').replace(',开发\n',',开发,session-A\n'));
  await writeFile(path.join(fx.root,'runtime.csv'),'session_id,status,current_turn_id,status_at,last_seen_at\nsession-A,running,turn-A,2026-10-13T00:00:00Z,2026-10-13T00:00:00Z\nsession-B,idle,turn-B,2026-10-13T00:00:00Z,2026-10-13T00:00:00Z\n');
  const p=await fx.registry.add(fx.inputs[0]),before=await readFile(p.csvPath,'utf8'),runtime=await (await fx.get(`/projects/${p.id}/session-runtime.csv`)).text();
  assert.match(runtime,/session-A/);assert.doesNotMatch(runtime,/session-B/);assert.equal(await readFile(p.csvPath,'utf8'),before);
});
test('各项目同时 ensure 只启动一个进程，项目移除不停止服务，显式 stop 可停止',async t=>{
  const fx=await fixture(t),args=[path.join(scripts,'manage-workbench-service.mjs'),'--state-dir',fx.registry.directory,'--port','0'];
  const pids=managedCleanup(fx,args);
  const started=await Promise.all([exec(process.execPath,args),exec(process.execPath,args)]),values=started.map(x=>JSON.parse(x.stdout));
  values.forEach(value=>pids.add(value.pid));
  assert.equal(values[0].pid,values[1].pid);assert.deepEqual(new Set(values.map(v=>v.state)),new Set(['STARTED','REUSED']));
  const status=JSON.parse((await exec(process.execPath,[...args,'--status'])).stdout);
  assert.equal(status.state,'RUNNING');assert.equal(status.pid,values[0].pid);assert.equal(status.url,values[0].url);
  const p=await fx.registry.add(fx.inputs[0]);await fx.registry.remove(p.id);assert.equal((await fetch(new URL('/health',values[0].url),{headers:{Authorization:authorizationFor(await readPassword(passwordPath(fx.registry.directory)))}})).status,200);
  assert.equal(JSON.parse((await exec(process.execPath,[...args,'--stop'])).stdout).state,'STOPPED');
});

test('过期 PID 记录遇到明确连接拒绝可恢复，且不会结束无关进程',async t=>{
  const fx=await fixture(t);await mkdir(fx.registry.directory,{recursive:true});
  const probe=createNetServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const unusedPort=probe.address().port;await new Promise(r=>probe.close(r));
  await writeFile(path.join(fx.registry.directory,'service.json'),JSON.stringify({pid:process.pid,url:`http://127.0.0.1:${unusedPort}/`}));
  const args=[path.join(scripts,'manage-workbench-service.mjs'),'--state-dir',fx.registry.directory,'--port','0'];
  const pids=managedCleanup(fx,args);
  const value=JSON.parse((await exec(process.execPath,args)).stdout);pids.add(value.pid);assert.equal(value.state,'STARTED');assert.notEqual(value.pid,process.pid);
});

test('fixture cleanup hook stops managed PID before removing its state',async t=>{
  const hooks=[],fx=await fixture({after:hook=>hooks.push(hook)}),args=[path.join(scripts,'manage-workbench-service.mjs'),'--state-dir',fx.registry.directory,'--port','0'];
  t.after(fx.cleanup);
  const pids=managedCleanup(fx,args),value=JSON.parse((await exec(process.execPath,args)).stdout);pids.add(value.pid);
  assert.equal(hooks.length,1);await hooks[0]();
  await assertExited(value.pid);await assert.rejects(readFile(path.join(fx.registry.directory,'service.json')),error=>error.code==='ENOENT');
});

test('文件浏览只列目录与CSV，支持隐藏项且不公开文件内容',async t=>{
 const fx=await webFixture(t);await writeFile(path.join(fx.root,'notes.txt'),'private fixture');await writeFile(path.join(fx.root,'hidden.csv'),'invalid fixture');await writeFile(path.join(fx.root,'.hidden.csv'),'invalid fixture');
 const data=await (await fx.post('/api/browse',{folder:fx.root})).json();assert.equal(data.folder,await realpathForTest(fx.root));assert.ok(data.entries.some(x=>x.kind==='directory'));assert.ok(data.entries.some(x=>x.name==='hidden.csv'));assert.ok(!data.entries.some(x=>x.name==='notes.txt'||x.name==='.hidden.csv'));assert.ok(data.entries.every(x=>!('content' in x)));
 const hidden=await (await fx.post('/api/browse',{folder:fx.root,showHidden:true})).json();assert.ok(hidden.entries.some(x=>x.name==='.hidden.csv'));
 assert.equal((await fx.post('/api/browse',{folder:'relative'})).status,400);assert.equal((await fx.post('/api/browse',{folder:fx.inputs[0].csvPath})).status,400);
 assert.equal((await fx.post('/api/browse',{folder:fx.root},{Origin:'https://foreign.example'})).status,403);assert.equal((await fx.post('/api/browse',{folder:fx.root},{'X-Workbench-Token':'wrong'})).status,403);
});
async function realpathForTest(p){return (await import('node:fs/promises')).realpath(p);}
test('选择后的文件检查不登记项目，重新验证CSV与详情且拒绝跨站操作',async t=>{
 const fx=await webFixture(t),before=await fx.registry.read();const response=await fx.post('/api/inspect',fx.inputs[0]);assert.equal(response.status,200);const info=await response.json();assert.equal(info.taskCount,1);assert.equal(info.csvPath,await realpathForTest(fx.inputs[0].csvPath));assert.ok(!('source' in info)&&!('tasks' in info));assert.deepEqual(await fx.registry.read(),before);
 assert.equal((await fx.post('/api/inspect',{csvPath:path.join(fx.root,'missing.csv')})).status,404);assert.equal((await fx.post('/api/inspect',fx.inputs[0],{Origin:'https://foreign.example'})).status,403);
 await writeFile(fx.inputs[0].csvPath,'invalid csv');assert.equal((await fx.post('/api/inspect',fx.inputs[0])).status,400);assert.deepEqual(await fx.registry.read(),before);
});

test('显式取消屏蔽清除黑名单，保留CSV并允许下次自动注册',async t=>{
 const fx=await webFixture(t),project=await fx.registry.add(fx.inputs[0]),source=await readFile(project.csvPath,'utf8');
 assert.equal((await fx.post('/api/delete-removed',{id:project.id})).status,400);assert.equal((await fx.registry.read()).projects.length,1);
 await fx.registry.remove(project.id);assert.equal((await fx.post('/api/delete-removed',{id:project.id},{Origin:'https://foreign.example'})).status,403);assert.equal((await fx.registry.read()).removed.length,1);
 assert.equal((await fx.post('/api/delete-removed',{id:project.id})).status,200);const saved=await new Registry(fx.registry.directory).read();assert.equal(saved.removed.length,0);assert.ok(!(await readFile(fx.registry.file,'utf8')).includes(project.csvPath));assert.equal(await readFile(project.csvPath,'utf8'),source);assert.equal((await fx.post('/api/restore',{id:project.id})).status,400);
 const request=await fx.registry.request(fx.inputs[0],{automatic:true});assert.equal(request.state,'registered');assert.equal((await fx.registry.read()).projects.length,1);
});
