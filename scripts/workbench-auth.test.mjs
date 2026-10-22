import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {request} from 'node:http';
import {mkdtemp,rm,readFile,writeFile,stat,chmod,symlink,mkdir} from 'node:fs/promises';
import {startWorkbench} from './workbench-server.mjs';
import {ensurePassword,readPassword,authorizationFor,createWorkbenchAuth} from './workbench-auth.mjs';
const rawGet=(url,headers)=>new Promise((resolve,reject)=>{const req=request(url,{headers},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});req.on('error',reject);req.end();});
async function fixture(t,options={}){
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'workbench-auth-'));let instance;
 t.after(async()=>{if(instance)await instance.close();await rm(stateDir,{recursive:true,force:true});});
 instance=await startWorkbench({stateDir,port:0,host:'0.0.0.0',...options});
 const password=await readPassword(instance.passwordFile),origin=new URL(instance.url).origin;
 const post=(endpoint,input,cookie='',extra={})=>fetch(new URL(endpoint,instance.url),{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...extra},body:JSON.stringify(input)});
 const login=await post('/auth/login',{password}),setCookie=login.headers.get('set-cookie'),cookie=setCookie.split(';')[0];
 const html=await(await fetch(instance.url,{headers:{Cookie:cookie}})).text(),token=html.match(/name="workbench-token" content="([^"]*)/)[1];
 const manage=(endpoint,input)=>post(endpoint,input,cookie,{'X-Workbench-Token':token});
 const get=(endpoint,cookieValue=cookie)=>fetch(new URL(endpoint,instance.url),{headers:{Cookie:cookieValue},redirect:'manual'});
 return {...instance,stateDir,password,cookie,post,manage,get,setCookie,token};
}
async function project(fx,name){
 const root=path.join(fx.stateDir,name);await mkdir(path.join(root,'tasks'),{recursive:true});
 await writeFile(path.join(root,'TASKS.csv'),'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path\nONE-001,待办,P1,产品,'+name+',[],测试,2026-10-16T00:00:00+08:00,2026-10-16T00:00:00+08:00,tasks/one.md\n');
 await writeFile(path.join(root,'tasks/one.md'),'# '+name);return fx.registry.add({root,csvPath:path.join(root,'TASKS.csv'),name});
}
const cookieOf=response=>response.headers.get('set-cookie').split(';')[0];
test('只输入密码登录，Cookie安全属性、退出撤销、Basic只用于本机健康检查',async t=>{
 const fx=await fixture(t);assert.match(fx.setCookie,/HttpOnly/);assert.match(fx.setCookie,/SameSite=Lax/);assert.match(fx.setCookie,/Path=\//);
 assert.doesNotMatch(fx.setCookie,new RegExp(fx.password));
 assert.equal((await fx.get('','')).status,303);
 for(const endpoint of ['api/state','assets/workbench.js','events','health','password.txt'])assert.equal((await fx.get(endpoint,'')).status,401);
 assert.equal((await fx.get('/api/state')).status,200);
 assert.equal((await fetch(fx.url,{headers:{Authorization:authorizationFor(fx.password)},redirect:'manual'})).status,303);
 assert.equal((await fetch(new URL('health',fx.url),{headers:{Authorization:authorizationFor(fx.password)}})).status,200);
 assert.equal((await fetch(new URL('health',fx.url),{headers:{Authorization:authorizationFor(fx.password),'X-Forwarded-For':'1.2.3.4'}})).status,401);
 assert.equal((await fx.post('/auth/logout',{},fx.cookie)).status,200);assert.equal((await fx.get('/api/state')).status,401);
});
test('密码文件固定、600权限，错误密码限流和登录CSRF校验',async t=>{
 const fx=await fixture(t);assert.equal((await stat(fx.passwordFile)).mode&0o777,0o600);assert.equal((await ensurePassword(fx.stateDir)).password,fx.password);
 assert.equal((await fx.post('/auth/login',{password:fx.password},'',{Origin:'https://evil.example'})).status,403);
 assert.equal((await fx.post('/auth/login',{password:fx.password},'',{Origin:''})).status,403);
 for(let i=0;i<30;i++)assert.equal((await fx.post('/auth/login',{password:'wrong'})).status,401);
 assert.equal((await fx.post('/auth/login',{password:'wrong'})).status,429);
 assert.equal((await fx.post('/auth/login',{password:fx.password})).status,200);
 const bad=path.join(fx.stateDir,'bad');await writeFile(bad,'short',{mode:0o600});await assert.rejects(readPassword(bad));await writeFile(bad,'password-long-enough');await chmod(bad,0o644);await assert.rejects(readPassword(bad),/chmod 600/);
 await symlink(fx.passwordFile,path.join(fx.stateDir,'link'));await assert.rejects(readPassword(path.join(fx.stateDir,'link')));
});
test('分享限定项目，撤销只阻止新登录，主动退出切断访客及SSE',async t=>{
 const fx=await fixture(t),a=await project(fx,'alpha'),b=await project(fx,'beta');
 const created=await fx.manage('/api/shares/create',{label:'评审',hours:24,projectIds:[a.id]});assert.equal(created.status,200);const share=await created.json();
 assert.match(share.url,/\/share#token=/);assert.ok(!share.url.includes(fx.password));
 const disk=await readFile(path.join(fx.stateDir,'auth-state.json'),'utf8');assert.ok(!disk.includes(share.token));assert.equal((await stat(path.join(fx.stateDir,'auth-state.json'))).mode&0o777,0o600);
 const redeemed=await fx.post('/auth/share',{token:share.token});assert.equal(redeemed.status,200);const guest=cookieOf(redeemed);
 const visible=await(await fx.get('/api/state',guest)).json();assert.equal(visible.projects.length,1);assert.notEqual(visible.projects[0].id,a.id);assert.deepEqual(visible.pending,[]);assert.deepEqual(visible.removed,[]);assert.deepEqual(visible.watchWarnings,[]);assert.equal(visible.projects[0].root,undefined);
 const alias=visible.projects[0].id;assert.equal((await fx.get(`/projects/${alias}/TASKS.csv`,guest)).status,200);assert.equal((await fx.get(`/projects/${alias}/${visible.projects[0].tasks[0].detail_path}`,guest)).status,200);assert.equal((await fx.get(`/projects/${alias}/tasks/one.md`,guest)).status,403);
 for(const endpoint of [`/api/projects/${b.id}`,`/projects/${b.id}/TASKS.csv`,`/projects/${b.id}/events`])assert.equal((await fx.get(endpoint,guest)).status,404);
 for(const endpoint of ['/api/add','/api/browse','/api/inspect','/api/remove','/api/shares/create','/api/shares/revoke','/api/onboarding/retry-notification','/api/onboarding/configure-notifications','/api/onboarding/test-notification','/api/onboarding/confirm-notification'])assert.equal((await fx.post(endpoint,{},guest,{'X-Workbench-Token':fx.token})).status,403);
 assert.equal((await fx.get('/api/onboarding',guest)).status,403);assert.equal((await fx.get('/api/onboarding?checkHost=1',guest)).status,403);assert.equal((await fx.get('/api/shares',guest)).status,403);assert.equal((await fx.get('/health',guest)).status,403);
 const list=await(await fx.get('/api/shares')).text();assert.ok(!list.includes(share.token));assert.ok(!list.includes('digest'));
 const stream=await fx.get('/events',guest),reader=stream.body.getReader();await reader.read();
 assert.equal((await fx.manage('/api/shares/revoke',{id:share.id})).status,200);
 assert.equal((await fx.get('/api/state',guest)).status,200);
 assert.equal((await fx.post('/auth/share',{token:share.token})).status,401);
 assert.equal((await fx.post('/auth/logout',{},guest)).status,200);
 const ended=async()=>{while(!(await reader.read()).done){}};await Promise.race([ended(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('SSE未关闭')),1500);timer.unref();})]);
 assert.equal((await fx.get('/api/state',guest)).status,401);assert.equal((await fx.post('/auth/share',{token:share.token})).status,401);
 assert.equal((await fx.get('/api/state')).status,200);
});
test('分享创建校验、无效令牌、同源和Secure Cookie',async t=>{
 const fx=await fixture(t,{publicOrigin:'https://board.example.com'}),a=await project(fx,'alpha');assert.match(fx.setCookie,/; Secure/);
 const headers={Cookie:fx.cookie,Host:'board.example.com'};assert.equal((await rawGet(fx.url,headers)).status,200);assert.equal((await rawGet(fx.url,{...headers,Host:'another.example'})).status,200);
 for(const input of [{label:'x',hours:0,projectIds:[a.id]},{label:'x',hours:169,projectIds:[a.id]},{label:'x',hours:24,projectIds:[]},{label:'x',hours:24,projectIds:['unknown']}])assert.equal((await fx.manage('/api/shares/create',input)).status,400);
 assert.equal((await fx.post('/auth/share',{token:'bad'})).status,401);
 assert.equal((await fx.manage('/api/shares/create',{label:'x',hours:1,projectIds:[a.id]})).status,200);
 assert.equal((await fx.post('/api/inspect',{},fx.cookie,{'X-Workbench-Token':fx.token,Origin:'https://board.example.com'})).status,400);
 assert.equal((await fx.post('/api/inspect',{},fx.cookie,{'X-Workbench-Token':fx.token,Origin:'https://evil.example'})).status,403);
});
test('长期会话跨时间和重启保留，分享到期只限制兑换，Cookie访问续期',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'workbench-permanent-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 let time=0;const options={stateDir,password:'long-password-for-testing',now:()=>time},auth=await createWorkbenchAuth(options);
 const req=()=>({headers:{},socket:{}}),response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;}});
 const ownerReq=req(),ownerRes=response();await auth.issue(ownerReq,ownerRes,{role:'owner'},false);ownerReq.headers.cookie=ownerRes.headers['Set-Cookie'].split(';')[0];
 const share=await auth.create({label:'one',hours:1,projectIds:['a']}),guestReq=req(),guestRes=response();await auth.issue(guestReq,guestRes,auth.redeem(share.token),true);guestReq.headers.cookie=guestRes.headers['Set-Cookie'].split(';')[0];
 assert.match(ownerRes.headers['Set-Cookie'],/Max-Age=34560000/);assert.match(guestRes.headers['Set-Cookie'],/; Secure/);
 const disk=await readFile(path.join(stateDir,'auth-state.json'),'utf8');assert.ok(!disk.includes(ownerReq.headers.cookie.split('=')[1]));assert.ok(!disk.includes(guestReq.headers.cookie.split('=')[1]));assert.equal((await stat(path.join(stateDir,'auth-state.json'))).mode&0o777,0o600);
 time=5*365*24*3600000;assert.equal(auth.principal(ownerReq).role,'owner');assert.equal(auth.principal(guestReq).role,'viewer');assert.equal(auth.redeem(share.token),null);
 const next=await createWorkbenchAuth(options),renew=response();assert.equal(next.principal(ownerReq,renew).role,'owner');assert.match(renew.headers['Set-Cookie'],/Max-Age=34560000/);assert.equal(next.principal(guestReq).role,'viewer');
 await next.revoke(share.id);assert.equal(next.principal(guestReq).role,'viewer');assert.equal(next.redeem(share.token),null);
 await next.logout(guestReq,response(),true);const restarted=await createWorkbenchAuth(options);assert.equal(restarted.principal(guestReq),null);assert.equal(restarted.principal(ownerReq).role,'owner');
 await restarted.syncPassword('changed-server-password');assert.equal(restarted.principal(ownerReq),null);assert.equal(restarted.checkPassword(options.password).ok,false);assert.equal(restarted.checkPassword('changed-server-password').ok,true);
 await restarted.syncPassword(options.password);assert.equal((await createWorkbenchAuth(options)).principal(ownerReq),null);
});
test('服务器修改密码无需重启即失效所有会话，旧密码不能登录',async t=>{
 const fx=await fixture(t),a=await project(fx,'password-rotation');const share=await(await fx.manage('/api/shares/create',{label:'one',hours:1,projectIds:[a.id]})).json();const guest=cookieOf(await fx.post('/auth/share',{token:share.token}));
 await writeFile(fx.passwordFile,'changed-password-for-live-test\n');
 assert.equal((await fx.get('/api/state')).status,401);assert.equal((await fx.get('/api/state',guest)).status,401);
 assert.equal((await fx.post('/auth/login',{password:fx.password})).status,401);assert.equal((await fx.post('/auth/login',{password:'changed-password-for-live-test'})).status,200);assert.equal((await fx.post('/auth/share',{token:share.token})).status,401);
 await writeFile(fx.passwordFile,fx.password+'\n');assert.equal((await fx.get('/api/state')).status,401);
});
test('旧分享记录迁移和并发会话持久化不丢失，坏状态拒绝启动',async t=>{
 const stateDir=await mkdtemp(path.join(os.tmpdir(),'workbench-state-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));const options={stateDir,password:'password-for-migration'};
 const first=await createWorkbenchAuth(options),share=await first.create({label:'legacy',hours:1,projectIds:['a']});const statePath=path.join(stateDir,'auth-state.json'),legacy=JSON.parse(await readFile(statePath,'utf8'));delete legacy.sessions;await writeFile(path.join(stateDir,'shares.json'),JSON.stringify(legacy),{mode:0o600});await rm(statePath);
 const migrated=await createWorkbenchAuth(options);assert.ok(migrated.redeem(share.token));
 const requests=await Promise.all(Array.from({length:8},async()=>{let cookie;const req={headers:{},socket:{}};await migrated.issue(req,{setHeader:(_name,value)=>cookie=value},{role:'owner'},false);req.headers.cookie=cookie.split(';')[0];return req;}));
 const restarted=await createWorkbenchAuth(options);assert.ok(requests.every(req=>restarted.principal(req)?.role==='owner'));
 await writeFile(statePath,'broken');await assert.rejects(createWorkbenchAuth(options));
});

test('0.0.0.0监听支持IPv4访问、同源登录与分享，回环模式仍限制公网Host',async t=>{
 const fx=await fixture(t),p=await project(fx,'public-alpha');assert.equal(fx.server.address().address,'0.0.0.0');
 const remoteHost='203.0.113.10:19999',remoteOrigin='http://'+remoteHost;
 const send=(endpoint,{method='GET',origin,cookie,body,host=remoteHost,authorization}={})=>new Promise((resolve,reject)=>{
  const headers={Host:host};if(origin)headers.Origin=origin;if(cookie)headers.Cookie=cookie;if(body)headers['Content-Type']='application/json';if(authorization)headers.Authorization=authorization;
  const req=request(new URL(endpoint,fx.url),{method,headers},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 assert.equal((await send('/')).status,303);assert.equal((await send('/api/state')).status,401);
 const login=await send('/auth/login',{method:'POST',origin:remoteOrigin,body:{password:fx.password}});assert.equal(login.status,200);const cookie=login.headers['set-cookie'][0].split(';')[0];
 assert.equal((await send('/api/state',{cookie})).status,200);
 assert.equal((await send('/auth/login',{method:'POST',origin:'http://203.0.113.11:19999',body:{password:fx.password}})).status,403);
 assert.equal((await send('/health',{authorization:authorizationFor(fx.password)})).status,401);
 const html=(await send('/',{cookie})).text,csrf=html.match(/name="workbench-token" content="([^"]*)/)[1];
 const share=await new Promise((resolve,reject)=>{const req=request(new URL('/api/shares/create',fx.url),{method:'POST',headers:{Host:remoteHost,Origin:remoteOrigin,Cookie:cookie,'Content-Type':'application/json','X-Workbench-Token':csrf}},res=>{let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve(JSON.parse(data)));});req.on('error',reject);req.end(JSON.stringify({label:'IP分享',hours:1,projectIds:[p.id]}));});assert.ok(share.url.startsWith(remoteOrigin+'/share#token='));
 const loopback=await fixture(t,{host:'127.0.0.1'});assert.equal(loopback.server.address().address,'127.0.0.1');assert.equal((await rawGet(loopback.url,{Host:remoteHost})).status,403);
});

test('域名免配置：HTTP/HTTPS同Host可登录，跨Host仍拒绝，分享沿用浏览器来源',async t=>{
 const fx=await fixture(t),p=await project(fx,'domain-project');
 const host='custom-board.example:9443';
 const send=(endpoint,{method='GET',origin,cookie,body,authority=host,csrf}={})=>new Promise((resolve,reject)=>{
  const headers={Host:authority};if(origin)headers.Origin=origin;if(cookie)headers.Cookie=cookie;if(body)headers['Content-Type']='application/json';if(csrf)headers['X-Workbench-Token']=csrf;
  const req=request(new URL(endpoint,fx.url),{method,headers},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 assert.equal((await send('/')).status,303);assert.equal((await send('/login')).status,200);assert.equal((await send('/api/state')).status,401);
 for(const scheme of ['http','https']){
  const origin=scheme+'://'+host,login=await send('/auth/login',{method:'POST',origin,body:{password:fx.password}});assert.equal(login.status,200);
  const setCookie=login.headers['set-cookie'][0],cookie=setCookie.split(';')[0];assert.equal(setCookie.includes('; Secure'),scheme==='https');
  const html=await send('/',{cookie}),csrf=html.text.match(/name="workbench-token" content="([^"]*)/)[1];
  const shared=await send('/api/shares/create',{method:'POST',origin,cookie,csrf,body:{label:scheme,hours:1,projectIds:[p.id]}});assert.equal(shared.status,200);assert.ok(JSON.parse(shared.text).url.startsWith(origin+'/share#token='));
  assert.equal((await send('/api/shares/create',{method:'POST',origin:'https://different-domain.example',cookie,csrf,body:{label:'x',hours:1,projectIds:[p.id]}})).status,403);
  assert.equal((await send('/auth/logout',{method:'POST',origin,cookie,body:{}})).status,200);
 }
 assert.equal((await send('/auth/login',{method:'POST',origin:'https://unrelated.example',body:{password:fx.password}})).status,403);
 for(const authority of ['user@host.example','host.example/path','host.example?query','host.example#fragment'])assert.equal((await send('/login',{authority})).status,403);
});

test('owner onboarding test requires explicit target and receipt confirmation; configuration changes invalidate proof',async t=>{
 const previous=Object.fromEntries(['PROJECT_MANAGER_NOTIFY_BIN','PROJECT_MANAGER_NOTIFY_ARGS','PROJECT_MANAGER_NOTIFY_DISABLED','PROJECT_MANAGER_CODEX_BIN','CODEX_HOME'].map(k=>[k,process.env[k]]));
 t.after(()=>{for(const [k,v] of Object.entries(previous))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const fx=await fixture(t),notifier=path.join(fx.stateDir,'fictional-notifier'),log=path.join(fx.stateDir,'notification-argv.json');
 await writeFile(notifier,'#!/usr/bin/env node\nrequire("node:fs").writeFileSync('+JSON.stringify(log)+',JSON.stringify(process.argv.slice(2)));');await chmod(notifier,0o755);
 process.env.PROJECT_MANAGER_NOTIFY_BIN=notifier;process.env.PROJECT_MANAGER_NOTIFY_ARGS='["--to","{manager}","--message","{message}"]';delete process.env.PROJECT_MANAGER_NOTIFY_DISABLED;
 process.env.CODEX_HOME=path.join(fx.stateDir,'isolated-codex');
 assert.equal((await fx.manage('/api/onboarding/select-hosts',{hosts:['codex']})).status,200);
 assert.equal((await fx.get('/api/onboarding','')).status,401);
 assert.equal((await fx.post('/api/onboarding/retry-notification',{},fx.cookie)).status,403);
 assert.equal((await fx.manage('/api/onboarding/retry-notification',{})).status,200);
 assert.equal((await fx.post('/api/onboarding/configure-notifications',{},fx.cookie)).status,403);
 assert.equal((await fx.manage('/api/onboarding/configure-notifications',{})).status,200);
 assert.equal((await fx.post('/api/onboarding/test-notification',{manager:'codex:default:fixture'},fx.cookie)).status,403);
 assert.equal((await fx.manage('/api/onboarding/test-notification',{manager:'::'})).status,400);
 assert.equal((await fx.manage('/api/onboarding/test-notification',{manager:'codex:default:fixture-manager'})).status,200);
 const args=JSON.parse(await readFile(log,'utf8'));assert.equal(args[1],'codex:default:fixture-manager');
 let value=await(await fx.get('/api/onboarding')).json();assert.equal(value.notificationDelivery.state,'ACCEPTED');assert.equal(value.notificationDiagnostics.checks.find(c=>c.id==='notification-delivery').status,'not_applicable');
 assert.equal(value.hosts.find(h=>h.id==='codex').checks.find(c=>c.id==='notification-config').command,undefined);assert.equal(value.notificationDiagnostics.checks.find(c=>c.id==='notification-delivery').command,undefined);
 assert.equal((await fx.manage('/api/onboarding/confirm-notification',{})).status,200);
 value=await(await fx.get('/api/onboarding')).json();assert.equal(value.notificationDelivery.state,'OWNER_CONFIRMED');assert.equal(value.notificationDiagnostics.checks.find(c=>c.id==='notification-delivery').status,'not_applicable');
 process.env.PROJECT_MANAGER_NOTIFY_ARGS='["{message}"]';value=await(await fx.get('/api/onboarding')).json();assert.equal(value.notificationDelivery.state,'NOT_VERIFIED');assert.equal(value.notificationDiagnostics.checks.find(c=>c.id==='notification-delivery').status,'not_applicable');
});

test('share projection rejects private canaries across JSON, CSV, details, runtime, errors and resource bypasses',async t=>{
 const fx=await fixture(t),a=await project(fx,'PRIVATE_PROJECT_CANARY'),b=await project(fx,'OTHER_PRIVATE_CANARY');
 const csv=path.join(a.root,'TASKS.csv'),source=await readFile(csv,'utf8');
 const rows=source.trimEnd().split('\n');
 rows[0]+=',manager_thread_id,execution_thread_id,dispatch_id,execution_turn_id,private_future_field';
 rows[1]+=',PRIVATE_MANAGER_CANARY,PRIVATE_EXECUTION_CANARY,PRIVATE_DISPATCH_CANARY,PRIVATE_TURN_CANARY,PRIVATE_FUTURE_CANARY';
 rows[1]=rows[1].replace('测试','private-person@example.invalid');
 rows.push(rows[1].replace('ONE-001','TWO-002').replace(',[],',',[ONE-001],'));
 const original=rows.join('\n')+'\n';await writeFile(csv,original);
 await writeFile(path.join(a.root,'tasks/one.md'),'# PRIVATE_BODY_CANARY\n\n/private/person/SECRET_CANARY');
 const owner=await(await fx.get('/api/state')).json();assert.equal(owner.projects[0].tasks[0].manager_thread_id,'PRIVATE_MANAGER_CANARY');
 const create=async ids=>{const share=await(await fx.manage('/api/shares/create',{label:'Private label canary',hours:1,projectIds:ids})).json();return cookieOf(await fx.post('/auth/share',{token:share.token}));};
 const guest=await create([a.id]),other=await create([b.id]),second=await create([a.id]);
 const visible=await(await fx.get('/api/state',guest)).json(),view=visible.projects[0];
 assert.equal(view.tasks.length,2);assert.equal(view.tasks[1].dependencyIds[0],view.tasks[0].id);
 assert.notEqual((await(await fx.get('/api/state',second)).json()).projects[0].id,view.id);
 const privateMarkers=['PRIVATE_','OTHER_PRIVATE_','ONE-001','TWO-002','private-person@example.invalid',a.root,b.root,a.id,b.id];
 const clean=text=>{for(const marker of privateMarkers)assert.ok(!text.includes(marker),`private output marker ${marker}`);};
 clean(JSON.stringify(visible));
 for(const endpoint of ['/api/state',`/api/projects/${view.id}`,`/projects/${view.id}/TASKS.csv`,`/projects/${view.id}/TASKS.html`,`/projects/${view.id}/${view.tasks[0].detail_path}`]){
  const response=await fx.get(endpoint,guest);assert.equal(response.status,200,endpoint);clean(await response.text());
  const head=await fetch(new URL(endpoint,fx.url),{method:'HEAD',headers:{Cookie:guest}});assert.equal(head.status,200);assert.equal(await head.text(),'');
  assert.equal((await fx.get(endpoint,'')).status,endpoint.endsWith('TASKS.html')?303:401);
 }
 for(const file of ['session-runtime.csv','tasks/one.md','task-log-file?card=ONE-001&ref=/private/person/SECRET_CANARY','evidence/secret.json','%ZZ']){
  const endpoint=`/projects/${view.id}/${file}`,response=await fx.get(endpoint,guest);assert.ok(response.status>=400);clean(await response.text());
 }
 for(const identity of [a.id,b.id])assert.equal((await fx.get(`/api/projects/${identity}`,guest)).status,404);
 assert.equal((await fx.get(`/api/projects/${view.id}`,other)).status,404);
 const stream=await fx.get(`/projects/${view.id}/events`,guest),reader=stream.body.getReader();clean(new TextDecoder().decode((await reader.read()).value));
 await writeFile(csv,original);clean(new TextDecoder().decode((await reader.read()).value));await reader.cancel();
 await rm(csv);const missing=await(await fx.get(`/api/projects/${view.id}`,guest)).json();assert.equal(missing.available,false);clean(JSON.stringify(missing));
 await writeFile(csv,original);assert.equal(await readFile(csv,'utf8'),original);
});
