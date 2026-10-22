import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';

// The CLI owns side effects. The wizard only selects explicit public operations.
export async function setupWizard({check,execute,configure,send,confirm,retry,launch,input=stdin,output=stdout,ask:providedAsk}){
 const say=text=>output.write(text+'\n');
 const ask=providedAsk|| (async prompt=>{const rl=createInterface({input,output});try{return (await rl.question(prompt)).trim();}finally{rl.close();}});
 say('PM Server 接入引导 / Setup');
 say('可以随时退出，稍后重新运行 pm-server setup 继续。安装 npm 包不会自动接入宿主。');
 for(;;){
  const status=await check();
  if(status.services)say('工作台：'+status.services.workbench.state+(status.services.workbench.url?' '+status.services.workbench.url:'')+'；后台监测：'+status.services.monitor.state);
  say(`\n工作台基础检查：${status.pendingCount} 项待处理（已选宿主必要配置单独检查）`);
  for(const item of status.checks)say(`  ${item.status==='complete'?'✓':item.status==='not_applicable'?'—':'!'} ${item.title} [${item.status}]${['complete','not_applicable'].includes(item.status)?'':'：'+item.detail}`);
  for(const host of status.hosts||[])if(host.selected){say(`${host.id} 必要配置：${host.pendingCount} 项待配置（不要求会话就绪）`);for(const item of host.checks)say(`  ${item.title} [${item.status}]：${item.detail}`);say(host.detail);}
  const optional=[...(status.sessionDiagnostics?.checks||[]),...(status.notificationDiagnostics?.checks||[])];
  if(optional.length){say('可选会话/通知诊断（不影响工作台使用）：');for(const item of optional)say(`  ${item.title} [${item.status}]：${item.detail}`);}
  say('\n1 安装/修复 Hook 并启动服务\n2 打开 Codex：/hooks 与运行验证（延迟检查）\n3 连接项目\n4 配置 Codex 后台通知\n5 重试经理通知自动检查\n6 显示可选 PM Skill 管理说明\n7 重新检测\n0 退出');
  const choice=await ask('请选择 [0-7]：');
  if(choice==='0'||choice===''){say(`已退出；基础检查还有 ${status.pendingCount} 项待处理。再次运行 pm-server setup 可继续。`);return status;}
  try{
   if(choice==='1'){
    say('将以当前用户权限合并 Codex 用户级 Hook，保留其他条目并备份旧配置；Hook 运行时具有本机用户权限。');
    say('同时启动工作台和后台监测；不安装系统自启、不自动信任 Hook。已有服务会复用。');
    if((await ask('执行以上操作？[y/N]：')).toLowerCase()==='y')say(JSON.stringify(await execute('setup'),null,2));
   }else if(choice==='2'){
    say('即将打开正常 Codex CLI。输入 /hooks，审查后信任并启用 PM Server Hook。');
    say('再让 Codex 执行一次无害工具操作；结束后 /quit 返回此引导重新检测。此处不会自动授予信任。');
    if((await ask('现在打开 Codex？[y/N]：')).toLowerCase()==='y')await launch();
   }else if(choice==='3'){
    const repo=await ask('项目目录（留空取消）：');if(repo)say(JSON.stringify(await execute('project',repo),null,2));
   }else if(choice==='4'){
    say('使用 Codex queue 向同一实例中的经理会话投递。只保存后端选择，不保存登录凭据。已有环境变量优先。');
    say('保存后重启此状态目录的服务，使后台进程加载配置；此步骤不会发送消息。');
    if((await ask('保存并启用 Codex 通知、重启服务？[y/N]：')).toLowerCase()==='y')say(JSON.stringify(await configure(),null,2));
   }else if(choice==='5'){
    say(JSON.stringify(await retry(),null,2));
   }else if(choice==='6'){
    say('无需经理在线即可使用工作台。已有经理在下一次真实管理请求中由 PM Skill 按当前身份及原授权核对可修复路由；纯状态查询保持只读。仅在希望明确更换或首次指定经理时，请在项目对话中使用 $project-manager 明确接管。');
   }else if(choice!=='7')say('请输入 0 到 7。');
  }catch(error){say('操作未完成：'+error.message+'。可修复后重试，或退出稍后继续。');}
 }
}
