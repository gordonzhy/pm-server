#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startWorkbench} from './workbench-server.mjs';
import {readPassword} from './workbench-auth.mjs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(!args.includes('--output')||!args.includes('--playwright'))throw new Error('请指定 --output 和 --playwright');
const output=path.resolve(get('--output'));await mkdir(output,{recursive:true});
const {chromium}=await import(pathToFileURL(path.resolve(get('--playwright'))).href);
let instance=await startWorkbench({stateDir:path.join(output,'state'),port:0});
let browser;const checks=[],errors=[];
const check=(name,value=true)=>{assert.ok(value,name);checks.push(name);console.log('PASS '+name);};
try{
 for(const name of ['项目甲','项目乙']){
  const root=path.join(output,name);await mkdir(path.join(root,'tasks'),{recursive:true});
  await writeFile(path.join(root,'TASKS.csv'),'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path\nDEMO-001,待办,P1,产品,'+name+'任务,[],测试,2026-10-16T00:00:00+08:00,2026-10-16T00:00:00+08:00,tasks/demo.md\n');
  await writeFile(path.join(root,'tasks/demo.md'),'# '+name+'任务\n\n## 任务日志\n\n测试记录');await instance.registry.add({root,csvPath:path.join(root,'TASKS.csv'),name});
 }
 const projects=(await instance.registry.read()).projects;
 browser=await chromium.launch({headless:true});
 const owner=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}}),page=await owner.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(instance.url);await page.locator('#password').waitFor();check('未登录自动进入只需密码的登录页',await page.locator('input:not([type=password])').count()===0);
 await page.locator('#password').fill('wrong');await page.locator('#submit').click();await page.locator('#error').waitFor({state:'visible'});check('错误密码显示反馈');
 await page.locator('#password').fill(await readPassword(instance.passwordFile));await page.locator('#submit').click();await page.waitForURL(instance.url);await page.locator('.project-filter').first().waitFor();check('密码登录后Cookie保持会话',await page.locator('.project-filter').count()===2);
 const cookies=await owner.cookies();check('登录凭据只存HttpOnly Cookie',cookies.some(c=>c.httpOnly&&c.sameSite==='Lax')&&!await page.evaluate(()=>document.cookie.includes('workbench_session')));
 await page.locator('#open-settings').click();await page.locator('#settings-sharing').click();await page.locator('[name=share-project]').first().waitFor();await page.locator('#share-label').fill('客户只读评审');await page.locator('[name=share-project]').first().check();await page.locator('#share-hours').selectOption('1');await page.locator('#share-form [type=submit]').click();await page.locator('#share-result').waitFor({state:'visible'});
 const link=await page.locator('#share-url').inputValue();check('界面生成可复制的单项目一小时分享链接',link.includes('/share#token='));await page.screenshot({path:path.join(output,'owner-share-desktop.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'owner-share-mobile.png')});check('窄屏分享界面不横向溢出',await page.locator('#sharing-section').evaluate(n=>n.scrollWidth<=n.clientWidth+1));
 const guest=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}}),viewer=await guest.newPage();viewer.on('pageerror',e=>errors.push(e.message));
 await viewer.goto(link);await viewer.waitForURL(instance.url);await viewer.locator('.project-filter').waitFor();check('分享链接无需输入密码自动登录并清除令牌',viewer.url()===instance.url&&await viewer.locator('.project-filter').count()===1);
 check('访客明确显示只读分享',await viewer.locator('#viewer-label').isVisible());
 await viewer.locator('.graph-node').first().click();
 const frame=viewer.frameLocator('#task-frame');await frame.locator('#task-modal').waitFor({state:'visible'});
 const sharedText=await frame.locator('#task-markdown').innerText();
 check('分享任务详情显示安全进度且无原始内容',sharedText.includes('Only de-identified progress')&&!sharedText.includes('项目甲')&&!sharedText.includes('测试记录'));
 await frame.locator('#task-modal-close').click();await viewer.locator('#task-dialog').waitFor({state:'hidden'});

 const guestState=await(await guest.request.get(instance.url+'api/state')).json();check('服务端只返回指定项目',guestState.projects.length===1&&guestState.projects[0].id!==projects[0].id&&guestState.projects[0].name==='Shared project 1'&&!JSON.stringify(guestState).includes('DEMO-001')&&!guestState.pending.length&&!guestState.removed.length);
 check('无法读取其他项目文件',(await guest.request.get(instance.url+`projects/${projects[1].id}/TASKS.csv`)).status()===404);
 check('访客无法浏览本机目录',(await guest.request.post(instance.url+'api/browse',{headers:{Origin:new URL(instance.url).origin},data:{folder:output}})).status()===403);
 await viewer.locator('#open-settings').click();check('分享设置只显示阅读选项',!await viewer.locator('#settings-projects').isVisible()&&!await viewer.locator('#settings-sharing').isVisible()&&await viewer.locator('#column-section').isVisible());await viewer.locator('#close-settings').click();
 await viewer.screenshot({path:path.join(output,'guest-readonly-desktop.png')});await viewer.setViewportSize({width:390,height:844});await viewer.screenshot({path:path.join(output,'guest-readonly-mobile.png')});
 const savedOwnerState=await owner.storageState(),boundPort=instance.server.address().port;
 check('持久Cookie设置长期保存期限',savedOwnerState.cookies.some(c=>c.name==='workbench_session'&&c.expires>Date.now()/1000+300*86400));
 await instance.close();instance=await startWorkbench({stateDir:path.join(output,'state'),port:boundPort});
 await page.reload();await page.locator('.project-filter').first().waitFor();await viewer.reload();await viewer.locator('.project-filter').waitFor();
 check('服务重启后管理和分享会话均保持登录',await page.locator('.project-filter').count()===2&&await viewer.locator('.project-filter').count()===1);
 const returning=await browser.newContext({locale:'zh-CN',storageState:savedOwnerState}),returningPage=await returning.newPage();await returningPage.goto(instance.url);await returningPage.locator('.project-filter').first().waitFor();check('恢复浏览器Cookie后无需再次输入密码',await returningPage.locator('.project-filter').count()===2);await returning.close();
 await page.locator('#open-settings').click();await page.locator('#settings-sharing').click();await page.locator('[data-revoke-share]').waitFor();

 await page.locator('[data-revoke-share]').click();await page.waitForFunction(()=>document.getElementById('share-list').textContent.includes('已撤销'));check('撤销链接后既有访客仍保持登录',(await guest.request.get(instance.url+'api/state')).status()===200);
 const expired=await browser.newContext({locale:'zh-CN'}),expiredPage=await expired.newPage();await expiredPage.goto(link);await expiredPage.locator('#error').waitFor({state:'visible'});check('撤销的链接再次打开显示失效',/撤销|过期|无效/.test(await expiredPage.locator('#error').innerText()));await expired.close();
 await page.locator('#close-settings').click();await page.locator('#logout').click();await page.waitForURL(instance.url+'login');check('退出后旧会话无法继续访问',(await owner.request.get(instance.url+'api/state')).status()===401);
 await page.screenshot({path:path.join(output,'password-login-mobile.png')});check('浏览器无未处理脚本异常',errors.length===0);
 await owner.close();await guest.close();
 await writeFile(path.join(output,'result.json'),JSON.stringify({checks,errors},null,2)+'\n');
 console.log(JSON.stringify({passed:checks.length,failures:errors.length,output}));
}finally{if(browser)await browser.close();await instance.close();}
