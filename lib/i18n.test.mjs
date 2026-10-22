import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../assets/i18n.js',import.meta.url),'utf8');
function load({languages=['en-US'],preference=null,denied=false,search=''}={}){
 const navigation=[];
 const context={navigator:{languages,language:languages[0]},localStorage:{getItem(){if(denied)throw new Error('storage denied');return preference;},setItem(key,value){if(denied)throw new Error('storage denied');preference=value;}},location:{search,href:'http://localhost/login'+search,replace(url){navigation.push(String(url));},reload(){navigation.push('reload');}},document:{documentElement:{},readyState:'loading',addEventListener(){}},URLSearchParams,URL,addEventListener(){}};
 context.window=context;context.parent=context;vm.runInNewContext(source,context);return {api:context.PMI18n,context,navigation};
}
test('primary browser preference and explicit override select the interface language',()=>{
 for(const [languages,expected] of [[['zh-TW'],'zh-CN'],[['zh-HK'],'zh-CN'],[['en-US'],'en'],[['fr-FR','zh-CN'],'en']])assert.equal(load({languages}).api.language,expected);
 assert.equal(load({languages:['en-US'],preference:'zh-CN'}).api.language,'zh-CN');
 assert.equal(load({languages:['zh-CN'],preference:'en'}).api.language,'en');
 assert.equal(load({languages:['zh-CN'],preference:'invalid'}).api.language,'zh-CN');
 assert.equal(load({languages:['zh-CN'],denied:true}).api.language,'zh-CN');
});
test('template localization preserves interpolated content and protocol attributes',()=>{
 const {api}=load();
 assert.equal(api.ui(['<span>','</span>'],'设置'),'<span>设置</span>');
 assert.equal(api.ui(['<option value="待确认" data-status="待确认">待确认</option>']),'<option value="待确认" data-status="待确认">Needs review</option>');
 assert.equal(api.ui([' · 项目详情']),' · Project details');
 assert.equal(api.message('任务状态无效：设置'),'Invalid task status: 设置');
 assert.equal(load({languages:['zh-CN']}).api.ui(['项目工作台']),'项目工作台');
});
test('denied storage uses a language query that survives login navigation',()=>{
 const {api,navigation}=load({denied:true});api.setLanguage('zh-CN');assert.equal(new URL(navigation[0]).searchParams.get('lang'),'zh-CN');
 const restored=load({denied:true,search:'?lang=zh-CN'});assert.equal(restored.api.language,'zh-CN');assert.equal(restored.api.href('/'),'http://localhost/?lang=zh-CN');
 assert.throws(()=>api.setLanguage('unsupported'));
});

test('self-contained task pages preserve executable localization source literally',async()=>{
 const {inlineTaskLog}=await import('../scripts/task-log.mjs');
 const html=inlineTaskLog('<head><script src="/assets/i18n.js"></script></head>');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
 assert.ok(script,'inline localization script is present');
 assert.doesNotThrow(()=>new vm.Script(script));
 assert.equal(script,source);
});

test('blacklist and automatic connection copy is localized without translating project names',()=>{
 const {api}=load();assert.equal(api.t('黑名单'),'Blacklist');assert.equal(api.t('恢复连接'),'Restore connection');assert.equal(api.t('取消屏蔽'),'Unblock');
 assert.equal(api.ui(['<button aria-label="取消屏蔽 ', '">取消屏蔽</button>'],'设置'),'<button aria-label="Unblock 设置">Unblock</button>');
 assert.equal(api.ui(['设置（',' 个连接待重试）'],2),'Settings (2 connections to retry)');
});

test('manager intake distinguishes registered routes and observation gaps in both languages',()=>{
 const english=load().api,chinese=load({languages:['zh-CN']}).api;
 const messages=["项目或活动任务缺少经理、执行或派发身份；由 PM Skill 核对登记，服务不会修改任务账本。", "路由字段已登记，但部分执行会话的运行观察缺失或过期；请核对原执行会话及 Hook，不要重复接管或猜测执行状态。", "经理与活动任务路由已登记，执行观察可关联。", "项目经理已登记；当前无活动任务，无需创建执行会话。", "发送后由 PM Skill 复用或创建管理结构并登记真实经理；不派发新业务任务。"];
 for(const message of messages){assert.equal(chinese.t(message),message);assert.doesNotMatch(english.t(message),/[\u4e00-\u9fff]/);}
});
