#!/usr/bin/env node
// 隔离通知回归：真实 Chromium 权限/创建与受控发送失败分开记录，不验证系统桌面弹窗。
import assert from 'node:assert/strict';
import { readPassword } from './workbench-auth.mjs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Registry} from './workbench-registry.mjs';
import {startWorkbench, fetch, browserStorageState} from './workbench-test-client.mjs';
const args=process.argv.slice(2),get=key=>args.includes(key)?args[args.indexOf(key)+1]:undefined;
if(!get('--output')||!get('--playwright'))throw new Error('请指定 --output 隔离输出目录和 --playwright 实际模块路径');
const output=path.resolve(get('--output'));await mkdir(path.join(output,'project','tasks'),{recursive:true});
const {chromium}=await import(pathToFileURL(path.resolve(get('--playwright'))).href);
const root=path.join(output,'project'),csvPath=path.join(root,'TASKS.csv');
const headers='id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,task_type';
const csv=status=>`${headers}\nTEST-001,${status},P0,测试,通知验证,[],测试,2026-10-14T00:00:00+08:00,2026-10-14T00:00:00+08:00,tasks/test.md,测试\n`;
await writeFile(csvPath,csv('待确认'));await writeFile(path.join(root,'tasks/test.md'),'# TEST-001 通知验证\n');
const stateDir=path.join(output,'state'),registry=new Registry(stateDir),project=await registry.add({root,csvPath,name:'隔离通知验证'});
const runtimePath=path.join(output,'runtime.csv');await writeFile(runtimePath,'session_id,status,current_turn_id,status_at,last_seen_at\n');
const instance=await startWorkbench({stateDir,port:0,runtimePath});
const storageState=browserStorageState(instance);
let browser;const checks=[],failures=[];
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);console.log('PASS '+name);};
const pathname=`/projects/${project.id}/TASKS.html`,url=new URL(pathname,instance.url).href;
try{
 // macOS headless shell 会将 Notification.permission 报为 denied，使用完整 Chromium。
 browser=await chromium.launch({headless:true,channel:'chromium'});
 for(const host of ['127.0.0.1','localhost']){
  const target=new URL(url);target.hostname=host;
  const context=await browser.newContext({locale:'zh-CN',storageState});await context.grantPermissions(['notifications'],{origin:target.origin});
  const page=await context.newPage();page.on('pageerror',error=>failures.push(error.message));await page.goto(target.href);await page.waitForFunction(()=>tasks.length===1);
  check(`${host} 的真实权限与通知创建`,await page.evaluate(()=>isSecureContext&&Notification.permission==='granted'&&localStorage.getItem(notifiedConfirmKey)==='["TEST-001"]'));
  check(`${host} 授权且成功后隐藏提示`,!await page.locator('#notification-permission').isVisible());await context.close();
 }
 const html=await (await fetch(url)).text();await writeFile(path.join(output,'file.html'),html);
 const fileContext=await browser.newContext({locale:'zh-CN',storageState}),filePage=await fileContext.newPage();await filePage.goto(pathToFileURL(path.join(output,'file.html')).href);
 check('file:// 不提供无效权限按钮且说明 HTTP 入口',!await filePage.locator('#enable-notifications').isVisible()&&(await filePage.locator('#notification-permission-text').innerText()).includes('本地文件'));await fileContext.close();
 for(const mode of ['throw','async','success']){
  const context=await browser.newContext({locale:'zh-CN',storageState});await context.addInitScript(mode=>{
   window.notificationAttempts=[];window.notificationMode=mode;
   window.Notification=class{
    static permission='granted';
    constructor(title){window.notificationAttempts.push(title);if(window.notificationMode==='throw')throw new Error('transport unavailable');if(window.notificationMode==='async')setTimeout(()=>this.onerror?.({error:new Error('delivery unavailable')}),0);}
   };
  },mode);
  const page=await context.newPage();page.on('pageerror',error=>failures.push(error.message));await page.goto(url);await page.waitForFunction(()=>tasks.length===1);
  if(mode!=='success'){
   // Observe feedback, deduplication and visibility atomically: SSE can retry
   // between separate browser reads and legitimately clear the old feedback.
   const failureVisible=await page.waitForFunction(()=>notificationDeliveryFeedback.includes('发送失败')&&localStorage.getItem(notifiedConfirmKey)==='[]'&&!notificationPermission.hidden&&notificationPermission.getClientRects().length>0);
   check(`${mode} 失败可见且撤销去重`,await failureVisible.jsonValue());
   await page.screenshot({path:path.join(output,`${mode}-failure.png`)});
   const before=await page.evaluate(()=>notificationAttempts.length);
   await page.evaluate(()=>{window.notificationMode='success';updateConfirmNotifications();});
   check(`${mode} 失败后可重试`,await page.evaluate(before=>notificationAttempts.length===before+1&&localStorage.getItem(notifiedConfirmKey)==='["TEST-001"]'&&notificationPermission.hidden,before));
  }else{
   await page.evaluate(()=>updateConfirmNotifications());check('刷新不重复提醒',await page.evaluate(()=>notificationAttempts.length===1));
   await writeFile(csvPath,csv('进行中'));await page.waitForFunction(()=>tasks[0].status==='进行中'&&localStorage.getItem(notifiedConfirmKey)==='[]');
   await writeFile(csvPath,csv('待确认'));await page.waitForFunction(()=>notificationAttempts.length===2);
   check('SSE 更新离开后重新进入待确认可再提醒',await page.evaluate(()=>tasks[0].status==='待确认'));
  }
  await context.close();
 }
 // Unified workbench entry, permission request and retries are exercised separately from OS delivery.
 await writeFile(csvPath,csv('待确认'));
 const homeContext=await browser.newContext({locale:'zh-CN',storageState});await homeContext.addInitScript(()=>{
   window.notificationAttempts=[];window.notificationMode='success';
   window.Notification=class{static permission=localStorage.getItem('mock-notification-permission')||'default';static async requestPermission(){this.permission='granted';localStorage.setItem('mock-notification-permission','granted');return 'granted';}constructor(title){window.notificationAttempts.push(title);if(window.notificationMode==='throw')throw Error('workbench transport unavailable');if(window.notificationMode==='async')setTimeout(()=>this.onerror?.({error:Error('workbench delivery unavailable')}),0);}close(){}};
 });
 const home=await homeContext.newPage();home.on('pageerror',e=>failures.push(e.message));await home.goto(instance.url);await home.locator('.project-filter').waitFor();await home.locator('#open-notifications').click();
 check('工作台固定入口显示通知权限及待确认任务',await home.locator('#notifications-section').isVisible()&&(await home.locator('#notification-status').innerText()).includes('尚未开启')&&await home.locator('#notification-items button').count()===1);
 await home.locator('#enable-workbench-notifications').click();await home.waitForFunction(()=>notificationAttempts.length===1);
 check('工作台用户授权后发送待确认提醒',await home.evaluate(()=>Notification.permission==='granted'&&notificationAttempts[0].includes('待确认')));
 await home.locator('#test-workbench-notification').click();check('工作台可发送测试通知并准确说明投递边界',(await home.locator('#notification-feedback').innerText()).includes('系统决定')&&await home.evaluate(()=>notificationAttempts.length===2));
 await home.locator('#enable-workbench-notifications').click();await home.locator('#close-settings').click();await home.reload();await home.locator('.project-filter').waitFor();await home.locator('#open-notifications').click();check('暂停提醒偏好持久化且入口仍可找回',(await home.locator('#notification-status').innerText()).includes('已暂停'));
 await home.locator('#enable-workbench-notifications').click();await home.locator('#close-settings').click();await home.locator('#select-all').click();
 await writeFile(csvPath,csv('进行中'));await home.waitForFunction(()=>!document.getElementById('notification-count').textContent||document.getElementById('notification-count').textContent==='0');
 await home.evaluate(()=>window.notificationMode='async');await writeFile(csvPath,csv('待确认'));await home.waitForFunction(()=>document.getElementById('notification-feedback').textContent.includes('发送失败'));
 check('全不选仍监测待确认且异步失败保留重试机会',await home.evaluate(key=>localStorage.getItem(key)==='[]',`task-dashboard:confirm-notified:v1:${pathname}`));
 await home.evaluate(()=>window.notificationMode='success');await home.locator('#open-notifications').click();await home.locator('#test-workbench-notification').click();await home.evaluate(()=>window.dispatchEvent(new Event('focus')));await home.waitForFunction(key=>localStorage.getItem(key)==='["TEST-001"]',`task-dashboard:confirm-notified:v1:${pathname}`);
 const sent=await home.evaluate(()=>notificationAttempts.length);await home.evaluate(()=>window.dispatchEvent(new Event('focus')));check('工作台成功后更新不重复提醒',await home.evaluate(sent=>notificationAttempts.length===sent,sent));
 const clone=path.join(output,'second-project');await mkdir(path.join(clone,'tasks'),{recursive:true});await writeFile(path.join(clone,'TASKS.csv'),csv('待确认'));await writeFile(path.join(clone,'tasks/test.md'),'# 同编号另一项目');const second=await registry.add({root:clone,csvPath:path.join(clone,'TASKS.csv'),name:'第二项目'});
 await home.waitForFunction(()=>document.querySelectorAll('.project-filter').length===2&&notificationAttempts.some(x=>x.includes('第二项目')));
 check('不同项目同任务编号分别提醒',await home.evaluate(id=>localStorage.getItem(`task-dashboard:confirm-notified:v1:/projects/${id}/TASKS.html`)==='["TEST-001"]',second.id));
 const autoRoot=path.join(output,'auto-project');await mkdir(path.join(autoRoot,'tasks'),{recursive:true});await writeFile(path.join(autoRoot,'TASKS.csv'),csv('待确认'));await writeFile(path.join(autoRoot,'tasks/test.md'),'# 自动连接');const automatic=await registry.request({root:autoRoot,csvPath:path.join(autoRoot,'TASKS.csv'),name:'自动加入项目'});
 await home.waitForFunction(()=>document.querySelectorAll('.project-filter').length===3&&notificationAttempts.some(x=>x.includes('自动加入项目')));
 check('新项目自动加入后直接提醒待确认任务，免注册审批',automatic.state==='registered'&&(await registry.read()).pending.length===0&&(await home.locator('#notification-items').innerText()).includes('自动加入项目'));
 await home.locator('#notification-items button').filter({hasText:'自动加入项目'}).click();check('新项目任务提醒可直达任务详情',await home.locator('#task-dialog').isVisible());await home.frameLocator('#task-frame').locator('button.task-modal-close:visible').click();await home.locator('#task-dialog').waitFor({state:'hidden'});await home.locator('#open-notifications').click();
 await home.screenshot({path:path.join(output,'workbench-notifications.png')});await homeContext.close();
 const deniedContext=await browser.newContext({locale:'zh-CN',storageState});await deniedContext.addInitScript(()=>{window.Notification=class{static permission='denied';};});const deniedPage=await deniedContext.newPage();await deniedPage.goto(instance.url);await deniedPage.locator('#open-notifications').click();check('拒绝通知时仍有固定入口和明确设置指引',(await deniedPage.locator('#notification-status').innerText()).includes('地址栏')&&await deniedPage.locator('#enable-workbench-notifications').isDisabled());await deniedContext.close();

 const realHomeContext=await browser.newContext({locale:'zh-CN',storageState});await realHomeContext.grantPermissions(['notifications'],{origin:new URL(instance.url).origin});const realHome=await realHomeContext.newPage();await realHome.goto(instance.url);await realHome.waitForFunction(key=>localStorage.getItem(key)==='["TEST-001"]',`task-dashboard:confirm-notified:v1:${pathname}`);check('工作台在真实Chromium权限下创建通知',await realHome.evaluate(()=>Notification.permission==='granted'));await realHomeContext.close();
 if(failures.length)console.log(JSON.stringify({pageErrors:failures}));
 check('HTTP 页面无未处理脚本异常',failures.length===0);
}finally{
 await writeFile(path.join(output,'result.json'),JSON.stringify({checks,failures,scope:'Chromium API 与受控失败回归；未验证操作系统桌面显示'},null,2));
 await browser?.close();await instance.close();
}
