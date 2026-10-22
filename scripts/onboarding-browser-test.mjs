#!/usr/bin/env node
// UI scenarios use synthetic statuses; background dispatch has separate integration tests.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {startWorkbench,browserStorageState} from './workbench-test-client.mjs';
import {managerSetupPrompt,onboardingStatus} from '../lib/onboarding.mjs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(!args.includes('--output')||!args.includes('--playwright'))throw new Error('--output and --playwright are required');
const output=path.resolve(get('--output'));await mkdir(output,{recursive:true});
const {chromium}=await import(pathToFileURL(path.resolve(get('--playwright'))));
const instance=await startWorkbench({stateDir:path.join(output,'state'),port:0});
const browser=await chromium.launch({headless:true}),checks=[];
const projectRoot=path.join(output,'demo-project');await mkdir(projectRoot,{recursive:true});
await writeFile(path.join(projectRoot,'TASKS.csv'),'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,manager_thread_id\nDEMO-001,进行中,P1,Demo,Demo task,[],AI,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,task.md,demo-dispatch,11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222\n');
process.env.CODEX_HOME=path.join(output,'isolated-host');
const observationScenario=await onboardingStatus({directory:path.join(output,'isolated-check'),cachePath:path.join(output,'isolated-runtime'),projects:[{id:'demo-project',name:'Demo project',root:projectRoot,csvRelative:'TASKS.csv'}]});
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
try{
 for(const language of ['en','zh-CN']){
  const context=await browser.newContext({storageState:browserStorageState(instance),locale:language,viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let attempts=0,requests=0,reads=0,lastSavedHosts;
  let snapshot={...observationScenario,hosts:[{id:'codex',selected:true,pendingCount:0,detail:'Demo',checks:[]},{id:'dsh',selected:false,pendingCount:0,detail:'DSH supports lifecycle observation only.',checks:[]}],notifications:'CONFIGURED_NOT_DELIVERY_VERIFIED',automaticNotification:{state:'WAITING_FOR_MANAGER'},notificationDiagnostics:{checks:[{id:'notification-config',title:'配置后台通知',status:'complete',detail:'Demo'},{id:'notification-delivery',title:'通知通道自动检查',status:'not_applicable',detail:'Demo'}]}};
  await page.route('**/api/onboarding**',async route=>{
   const url=new URL(route.request().url());
   if(route.request().method()==='POST')requests++;
   if(route.request().method()==='GET')reads++;
   if(url.pathname.endsWith('/select-hosts')){lastSavedHosts=route.request().postDataJSON().hosts;snapshot.hosts=snapshot.hosts.map(host=>({...host,selected:lastSavedHosts.includes(host.id)}));await route.fulfill({json:{state:'SAVED'}});return;}
   if(url.pathname.endsWith('/retry-notification')){
    assert.deepEqual(route.request().postDataJSON(),{});
    if(++attempts===1){await route.fulfill({status:500,json:{error:'Test backend unavailable'}});return;}
    snapshot.automaticNotification={state:'ACCEPTED'};snapshot.pendingCount=1;snapshot.notificationDiagnostics.checks.find(c=>c.id==='notification-delivery').status='complete';await route.fulfill({json:{state:'ACCEPTED'}});return;
   }
   await route.fulfill({json:snapshot});
  });
  await page.goto(instance.url);await page.locator('#open-settings').click();await page.locator('#settings-onboarding').click();await page.locator('#onboarding-section').waitFor();
  await page.waitForFunction(()=>!document.getElementById('refresh-onboarding').disabled);
  const readBefore=reads,postsBefore=requests;
  check(language+' two host tabs expose tab semantics',await page.locator('#host-configuration-tabs [role=tab]').count()===2&&await page.locator('#host-tab-codex').getAttribute('aria-controls')==='host-panel-codex');
  await page.locator('#host-tab-dsh').click();
  check(language+' browsing an unselected host does not enable it',await page.locator('#host-panel-dsh').isVisible()&&await page.locator('#host-panel-codex').isHidden()&&!await page.locator('#host-choice-dsh').isChecked());
  check(language+' Codex actions stay inside its hidden panel',await page.locator('#host-panel-codex #refresh-session-diagnostics,#host-panel-codex #refresh-runtime-diagnostics,#host-panel-codex #codex-hook-permissions').count()===3&&await page.locator('#refresh-session-diagnostics').isHidden());
  await page.locator('#host-tab-dsh').focus();await page.keyboard.press('ArrowRight');
  check(language+' arrow keys wrap and set focus plus aria selection',await page.locator('#host-tab-codex').getAttribute('aria-selected')==='true'&&await page.locator('#host-tab-codex').evaluate(n=>n===document.activeElement));
  await page.keyboard.press('End');check(language+' End selects the final host',await page.locator('#host-tab-dsh').getAttribute('aria-selected')==='true');
  await page.keyboard.press('Home');check(language+' Home selects the first host',await page.locator('#host-tab-codex').getAttribute('aria-selected')==='true');
  check(language+' switching tabs has no network side effects',requests===postsBefore&&reads===readBefore);
  await page.locator('#host-choice-codex').uncheck();await page.locator('#host-tab-dsh').click();await page.locator('#host-choice-dsh').check();
  await page.locator('#save-host-selection').click();await page.waitForFunction(()=>!document.getElementById('refresh-onboarding').disabled&&!document.getElementById('save-host-selection').disabled);
  check(language+' explicit save only changes the displayed host scope',JSON.stringify(lastSavedHosts)===JSON.stringify(['codex','dsh'])&&await page.locator('#host-choice-codex').isChecked());
  check(language+' refresh keeps the current host tab',await page.locator('#host-tab-dsh').getAttribute('aria-selected')==='true');
  await page.locator('#host-tab-codex').click();
  check(language+' no manager selector or manual receipt requirement',await page.locator('#onboarding-manager,#send-onboarding-test,#confirm-onboarding-notification').count()===0);
  check(language+' optional session diagnostics folded',!await page.locator('#session-diagnostics').evaluate(n=>n.open));
  check(language+' no takeover prompt',await page.locator('[data-check=routes] code, [data-check=routes] button').count()===0);
  await page.locator('#notification-diagnostics summary').click();
  check(language+' only explicit scope save posts; browsing never sends a message',requests===postsBefore+1&&attempts===0);
  check(language+' waiting for first manager has no retry demand',await page.locator('#retry-onboarding-notification').isHidden());
  check(language+' bilingual labels',await page.locator('#settings-onboarding [data-i18n]').innerText()===(language==='en'?'Setup guide':'接入引导'));
  await page.screenshot({path:path.join(output,'guide-'+language+'.png'),fullPage:true});
  snapshot.automaticNotification={state:'FAILED'};snapshot.pendingCount=2;snapshot.notificationDiagnostics.checks.find(c=>c.id==='notification-delivery').status='action_required';
  await page.locator('#refresh-onboarding').click();await page.locator('#retry-onboarding-notification').waitFor();
  check(language+' only automatic failure offers retry',await page.locator('#retry-onboarding-notification').isVisible());
  await page.locator('#retry-onboarding-notification').click();await page.waitForFunction(()=>document.getElementById('onboarding-feedback').textContent.includes('Test backend unavailable'));
  check(language+' failed retry remains usable',await page.locator('#retry-onboarding-notification').isEnabled());
  await page.locator('#retry-onboarding-notification').click();await page.waitForFunction(()=>document.getElementById('retry-onboarding-notification').hidden);
  check(language+' accepted auto check needs no manual receipt',await page.locator('[data-check=notification-delivery]').getAttribute('data-state')==='complete');
  snapshot.pendingCount=0;snapshot.checks=snapshot.checks.map(c=>({...c,status:'complete'}));await page.locator('#refresh-onboarding').click();await page.waitForFunction(()=>document.getElementById('onboarding-reminder').hidden);
  check(language+' no unfinished automatic-test step keeps banner',await page.locator('#onboarding-reminder').isHidden());
  check(language+' registration does not demand takeover',await page.locator('[data-check=routes] code').count()===0);
  snapshot={...snapshot,...observationScenario,hosts:[{id:'codex',selected:true,pendingCount:0,detail:'Demo',checks:[]},{id:'dsh',selected:false,pendingCount:0,detail:'DSH supports lifecycle observation only.',checks:[]}]};
  await page.locator('#refresh-onboarding').click();await page.waitForFunction(()=>!document.querySelector('#refresh-onboarding').disabled);
  check(language+' runtime gaps do not show setup reminder',await page.locator('#onboarding-reminder').isHidden());
  check(language+' runtime diagnostics collapsed by default',!await page.locator('#runtime-diagnostics').evaluate(n=>n.open));
  await page.locator('#runtime-diagnostics summary').click();
  const action=page.locator('[data-check=execution-observation]');
  check(language+' registration complete is separate from diagnostic observation gap',await action.getAttribute('data-state')==='verify');
  check(language+' diagnostics do not ask to copy or reinitialize',await action.locator('button,code').count()===0);
  if(language==='en')check('English action guidance is fully localized',!/[\u4e00-\u9fff]/.test(await action.innerText()));
  await page.screenshot({path:path.join(output,'observation-'+language+'.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'guide-mobile-'+language+'.png'),fullPage:true});
  check(language+' action card fits mobile',await action.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  check(language+' mobile does not overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));check(language+' no browser errors',!errors.length);await context.close();
 }
 // Clipboard API availability and permissions vary by browser and HTTP origin.
 for(const language of ['en','zh-CN'])for(const mode of ['missing-api','insecure-context','write-rejected','manual-false','manual-throws']){
  console.log('Clipboard scenario '+language+' '+mode);
  const context=await browser.newContext({storageState:browserStorageState(instance),locale:language,viewport:{width:390,height:844},permissions:['clipboard-read','clipboard-write']}),page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(mode=>{
   window.clipboardReader=navigator.clipboard;window.writeAttempts=0;
   const rejected={writeText:async()=>{window.writeAttempts++;throw new DOMException('Denied','NotAllowedError');}};
   Object.defineProperty(navigator,'clipboard',{value:mode==='missing-api'?undefined:rejected});
   if(mode==='insecure-context')Object.defineProperty(window,'isSecureContext',{value:false});
   if(mode==='manual-false')document.execCommand=()=>false;
   if(mode==='manual-throws')document.execCommand=()=>{throw new Error('Copy unavailable');};
  },mode);
  const command='pm-server doctor --json\n# Demo command';
  await page.route('**/api/onboarding**',route=>route.fulfill({json:{pendingCount:1,notifications:'CONFIGURED_NOT_DELIVERY_VERIFIED',checks:[{id:'routes',title:'登记执行与经理路由',status:'action_required',detail:'Demo',prompt:managerSetupPrompt},{id:'command',title:'检查命令',status:'action_required',detail:'Demo',command}]}}));
  await page.goto(instance.url);await page.locator('#open-settings').click();await page.locator('#settings-onboarding').click();await page.waitForFunction(()=>!document.getElementById('refresh-onboarding').disabled);
  for(const id of ['routes','command']){
   const card=page.locator('[data-check='+id+']'),button=card.locator('button'),manual=card.locator('textarea'),status=card.locator('.onboarding-copy-status'),text=await card.locator('code').innerText();
   await button.focus();
   await card.locator('code').evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);});
   // Programmatic activation preserves the pre-existing selection for this assertion.
   await button.evaluate(node=>node.click());await status.waitFor();await page.waitForFunction(id=>document.querySelector('[data-check='+id+'] .onboarding-copy-status').textContent.length>0,id);
   if(mode.startsWith('manual-')){
    check(language+' '+mode+' '+id+' gives selected manual text',await manual.isVisible()&&await manual.evaluate(node=>document.activeElement===node&&node.readOnly&&node.selectionStart===0&&node.selectionEnd===node.value.length)&&await manual.inputValue()===text);
    check(language+' '+mode+' '+id+' never claims success',(await status.innerText()).includes(language==='en'?'Automatic copying failed':'自动复制未成功'));
   }else{
    check(language+' '+mode+' '+id+' copies exact visible text',await page.evaluate(()=>window.clipboardReader.readText())===text);
    check(language+' '+mode+' '+id+' restores focus and selection',await button.evaluate(node=>document.activeElement===node)&&await page.evaluate(()=>getSelection().toString())===text&&await manual.isHidden());
    check(language+' '+mode+' '+id+' shows nearby success',await status.innerText()===(language==='en'?'Copied':'已复制'));
   }
   check(language+' '+mode+' '+id+' fits narrow card',await card.evaluate(node=>node.scrollWidth<=node.clientWidth+1));
  }
  if(mode==='insecure-context')check(language+' insecure origin skips Clipboard API',await page.evaluate(()=>window.writeAttempts)===0);
  check(language+' '+mode+' no browser errors',errors.length===0);
  await page.screenshot({path:path.join(output,'clipboard-'+language+'-'+mode+'.png'),fullPage:true});await context.close();
 }
 const viewer=await browser.newContext({storageState:browserStorageState(instance)}),page=await viewer.newPage();let probeRequests=0;
 await page.route(instance.url,async route=>{const response=await route.fetch();const html=(await response.text()).replace('data-access="owner"','data-access="viewer"');await route.fulfill({response,body:html});});
 page.on('request',request=>{if(request.url().includes('/api/onboarding'))probeRequests++;});
 await page.goto(instance.url);await page.locator('#connection').waitFor();await page.waitForTimeout(300);
 check('viewer cannot read setup or trigger checks',probeRequests===0&&await page.locator('#settings-onboarding').isHidden()&&await page.locator('#onboarding-reminder').isHidden());await viewer.close();
 await writeFile(path.join(output,'report.json'),JSON.stringify({state:'PASS',checks,boundaries:{nativeHooks:false,notificationBackend:'synthetic UI statuses'}},null,2)+'\n');console.log('PASS '+checks.length+' onboarding browser checks');
}finally{await browser.close();await instance.close();}
