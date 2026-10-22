#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {Registry} from './workbench-registry.mjs';
import {startWorkbench,browserStorageState} from './workbench-test-client.mjs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
if(!args.includes('--output')||!args.includes('--playwright'))throw new Error('--output and --playwright are required');
const output=path.resolve(get('--output'));await mkdir(output,{recursive:true});
const {chromium}=await import(pathToFileURL(path.resolve(get('--playwright'))).href);
const repo=path.join(output,'project'),stateDir=path.join(output,'state');await mkdir(path.join(repo,'tasks'),{recursive:true});
const header='id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,task_type';
const originals=[['T-1','待确认','P0','设置','设置','[]','项目工作台'],['T-2','进行中','P1','设置','项目原文保持中文','[]','项目工作台'],['T-3','待办','P1','设置','等待依赖的任务','[T-1]','项目工作台']];
const csv=header+'\n'+originals.map(r=>[...r,'2026-10-18T00:00:00Z','2026-10-18T01:00:00Z',`tasks/${r[0]}.md`,'开发'].join(',')).join('\n')+'\n';
await writeFile(path.join(repo,'TASKS.csv'),csv);
for(const r of originals){const events=[{id:'created',at:'2026-10-18T00:00:00Z',actor:'项目工作台',type:'created',title:'设置',detail:'原文说明保持中文，不翻译客户内容。',state_to:r[1],evidence:[{label:'原始依据',ref:'客户确认的原文'}]}];await writeFile(path.join(repo,`tasks/${r[0]}.md`),'# '+r[0]+' 设置\n\n## 目标\n项目原文保持中文。\n\n## 任务日志\n```yaml\n'+JSON.stringify({version:1,events})+'\n```\n');}
const registry=new Registry(stateDir),project=await registry.add({root:repo,csvPath:path.join(repo,'TASKS.csv'),name:'设置',group:'项目工作台'});
const runtimePath=path.join(output,'runtime.csv');await writeFile(runtimePath,'session_id,status,current_turn_id,status_at,last_seen_at\n');
const instance=await startWorkbench({stateDir,port:0,runtimePath});const browser=await chromium.launch({headless:true});
const checks=[],errors=[];function check(name,value=true){assert.ok(value,name);checks.push(name);console.log('PASS '+name);}
const storageState=browserStorageState(instance);
try{
 const context=await browser.newContext({locale:'en-US',viewport:{width:1440,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(instance.url);await page.waitForURL('**/login');check('English system locale selects English on login',(await page.locator('html').getAttribute('lang'))==='en');check('English login heading',(await page.locator('h1').innerText())==='Project Workbench');
 await page.locator('#password').fill('incorrect-password');await page.locator('#submit').click();await page.getByText('Incorrect password',{exact:true}).waitFor();check('Login errors are localized');
 await page.locator('#password').fill(await readFile(instance.passwordFile,'utf8').then(s=>s.trim()));await page.locator('#submit').click();await page.waitForURL(instance.url);await page.locator('.graph-node').first().waitFor({state:'attached'});
 check('Workbench follows English locale',await page.locator('h1').innerText()==='Project Workbench');check('Project name is not translated',await page.locator('.project-filter span').first().innerText()==='设置');
 check('Canonical status remains in option value',await page.locator('#status option[value="待确认"]').innerText()==='Needs review');
 check('Summary preserves canonical review filter',await page.locator('.metric.confirm').getAttribute('data-status-filter')==='待确认');check('Summary counts remain correct',await page.locator('.metric.confirm strong').innerText()==='1');
 check('Task title is not translated',await page.locator('[data-graph-key="'+project.id+':T-1"] .graph-task-title').textContent()==='设置');
 check('Task status display translated',await page.locator('[data-graph-key="'+project.id+':T-1"] .graph-status').textContent()==='Needs review');
 await page.locator('#list-tab').click();await page.locator('td[data-column=title] button[data-task]').first().waitFor({state:'attached'});check('English table headings',await page.getByRole('button',{name:'Task title',exact:false}).count()>0);
 check('Table preserves assignee text',await page.locator('td[data-column=executor]').first().innerText()==='项目工作台');
 await page.locator('#status').selectOption('待确认');check('Translated filter matches canonical status',await page.locator('tbody tr').count()===1);
 await page.locator('td[data-column=title] button[data-task]').first().click();const frame=page.frameLocator('#task-frame');await frame.locator('#task-modal').waitFor({state:'visible'});
 check('Embedded detail inherits locale',await frame.locator('html').getAttribute('lang')==='en');check('Detail navigation translated',await frame.locator('#task-log-tab').innerText()==='Task log');check('Description is not translated',(await frame.locator('#task-markdown').innerText()).includes('项目原文保持中文'));
 await frame.locator('#task-log-tab').click();check('Log event label translated',await frame.locator('.timeline-kind').first().innerText()==='Created');check('Log author is not translated',await frame.locator('.timeline-actor').first().innerText()==='项目工作台');check('Log title is not translated',await frame.locator('.timeline-event h3').first().innerText()==='设置');
 await frame.locator('#task-modal-close').click();await page.locator('#open-settings').click();for(const [tab,section] of [['settings-add','add-section'],['settings-sharing','sharing-section'],['settings-notifications','notifications-section'],['settings-column','column-section'],['settings-removed','removed-section']]){await page.locator('#'+tab).click();await page.locator('#'+section).waitFor({state:'visible'});const han=await page.locator('#'+section).evaluate(n=>[...n.querySelectorAll('h3,p,label,button')].filter(e=>e.offsetWidth&&!e.closest('#notification-items,#share-projects')&&/\p{Script=Han}/u.test(e.innerText)).map(e=>e.innerText));check('English settings '+tab,han.length===0);}
 await page.locator('#settings-add').click();await page.locator('#inspect-source').click();await page.locator('#add-error').waitFor({state:'visible'});check('Project input errors are localized',(await page.locator('#add-error').innerText()).includes('absolute CSV path'));
 await page.locator('#choose-csv').click();await page.locator('#browse-folder').fill(repo);await page.locator('#browse-form button[type=submit]').click();await page.locator(`[data-file-path="${path.join(repo,'TASKS.csv')}"]`).waitFor();check('File picker labels are localized',await page.locator('[data-file-kind=directory] .file-kind').first().innerText()==='Folder');await page.locator('#close-file-picker').click();
 await page.locator('#settings-sharing').click();await page.locator('#share-label').fill('原文分享标题');await page.locator('[name=share-project]').first().check();await page.locator('#share-form [type=submit]').click();await page.locator('#share-result').waitFor({state:'visible'});const share=await page.locator('#share-url').inputValue();check('Share name is not translated',await page.locator('#share-list strong').first().innerText()==='原文分享标题');
 const guest=await browser.newContext({locale:'en-US'}),viewer=await guest.newPage();viewer.on('pageerror',e=>errors.push(e.message));await viewer.goto(share);await viewer.waitForURL(instance.url);await viewer.locator('.project-filter').waitFor();check('Read-only share uses English',await viewer.locator('#viewer-label').innerText()==='Read-only access');await guest.close();
 await page.locator('#close-settings').click();await page.screenshot({path:path.join(output,'workbench-en.png'),fullPage:true});
 await page.locator('#language-select').selectOption('zh-CN');await page.waitForFunction(()=>document.documentElement.lang==='zh-CN');await page.locator('.graph-node').first().waitFor({state:'attached'});check('Manual Chinese overrides English system',await page.locator('h1').innerText()==='项目工作台');check('Language change preserves filter',await page.locator('#status').inputValue()==='待确认');
 await page.reload();check('Manual preference survives reload',await page.locator('html').getAttribute('lang')==='zh-CN');await page.screenshot({path:path.join(output,'workbench-zh.png'),fullPage:true});
 await page.locator('#language-select').selectOption('auto');await page.waitForFunction(()=>document.documentElement.lang==='en');check('System default restores English');await page.setViewportSize({width:390,height:844});await page.locator('.graph-node').first().waitFor({state:'attached'});check('English mobile page has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(output,'workbench-en-mobile.png'),fullPage:true});await page.locator('#open-settings').click();await page.locator('#settings-sharing').click();check('English mobile settings fit the viewport',await page.locator('#settings-dialog').evaluate(n=>n.scrollWidth<=n.clientWidth+1));await context.close();
 for(const [language,expected] of [['zh-CN','zh-CN'],['zh-TW','zh-CN'],['fr-FR','en']]){const c=await browser.newContext({locale:language,storageState});const p=await c.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(instance.url);await p.locator('.graph-node').first().waitFor({state:'attached'});check(language+' automatic selection',await p.locator('html').getAttribute('lang')===expected);if(language==='zh-CN'){await p.locator('#language-select').selectOption('en');await p.waitForFunction(()=>document.documentElement.lang==='en');check('Manual English overrides Chinese system',await p.locator('h1').innerText()==='Project Workbench');}await c.close();}
 check('Project CSV is byte-for-byte unchanged',await readFile(path.join(repo,'TASKS.csv'),'utf8')===csv);check('No browser JavaScript errors',errors.length===0);
 await writeFile(path.join(output,'results.json'),JSON.stringify({passed:checks.length,checks,errors},null,2)+'\n');console.log(JSON.stringify({passed:checks.length,errors}));
}finally{await browser.close();await instance.close();}
