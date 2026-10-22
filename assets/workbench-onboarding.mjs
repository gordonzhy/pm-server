import {t as tr,ui,locale} from './i18n.mjs';
export function createWorkbenchOnboarding({api,openSettings,owner}){
 const $=id=>document.getElementById(id);
 if(!owner){$('settings-onboarding').hidden=true;return {refresh:async()=>{}};}
 const configureButton=$('configure-onboarding-notifications'),retryButton=$('retry-onboarding-notification'),section=$('onboarding-section');
 let value,inflight=null,configuring=false,retrying=false,savingHosts=false,activeHost=null;
 const labels={complete:'已完成',action_required:'需要操作',verify:'待验证',not_applicable:'暂不需要',checking:'自动检查中'};
 function copyButton(text,label){
  const control=document.createElement('div'),button=document.createElement('button'),status=document.createElement('span'),manual=document.createElement('textarea');
  control.className='onboarding-copy';button.type='button';button.textContent=tr(label);
  status.className='onboarding-copy-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  manual.className='onboarding-copy-text';manual.readOnly=true;manual.hidden=true;manual.value=text;manual.setAttribute('aria-label',tr('手动复制内容'));manual.spellcheck=false;
  control.append(button,status,manual);
  let copying=false;
  button.onclick=async()=>{
   if(copying)return;copying=true;status.textContent='';manual.hidden=true;
   const focused=document.activeElement,selection=window.getSelection(),ranges=selection?Array.from({length:selection.rangeCount},(_,i)=>selection.getRangeAt(i).cloneRange()):[];
   const inputSelection=focused&&typeof focused.selectionStart==='number'?{start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection}:null;
   let copied=false;
   try{
    if(window.isSecureContext&&typeof navigator.clipboard?.writeText==='function'){
     try{await navigator.clipboard.writeText(text);copied=true;}catch{}
    }
    if(!copied){
     // Stay inside the active dialog: a textarea under body would be inert.
     manual.hidden=false;manual.focus({preventScroll:true});manual.select();manual.setSelectionRange(0,text.length);
     try{copied=typeof document.execCommand==='function'&&document.execCommand('copy');}catch{}
    }
    if(copied){
     manual.hidden=true;
     if(focused?.isConnected)focused.focus({preventScroll:true});
     if(inputSelection)focused.setSelectionRange(inputSelection.start,inputSelection.end,inputSelection.direction);
     else if(selection){selection.removeAllRanges();for(const range of ranges)selection.addRange(range);}
     status.textContent=tr('已复制');
    }else{
     manual.hidden=false;manual.focus({preventScroll:true});manual.select();manual.setSelectionRange(0,text.length);
     status.textContent=tr('自动复制未成功，内容已选中。请按 ⌘C（Mac）或 Ctrl+C 复制。');
    }
   }finally{copying=false;}
  };
  return control;
 }
 function showHost(id,{focus=false}={}){
  activeHost=id;
  for(const tab of $('host-configuration-tabs').querySelectorAll('[role=tab]')){const selected=tab.dataset.host===id;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;if(selected&&focus)tab.focus();}
  for(const panel of $('host-configuration-groups').children)panel.hidden=panel.dataset.host!==id;
  const panel=$('host-panel-'+id);if(panel)panel.querySelector('.host-scope').append($('save-host-selection'));
 }
 function render(){
  const actions=value.actionRequiredCount??value.checks.filter(c=>c.status==='action_required').length;
  const unverified=value.verificationCount??value.checks.filter(c=>c.status==='verify').length;
  $('onboarding-count').textContent=actions||'';
  $('onboarding-reminder').hidden=!(actions||unverified||value.hostConfigurationPendingCount);
  $('onboarding-summary').textContent=ui`${actions} 项需要处理，${unverified} 项暂未核验。暂未核验不代表未完成。`;
  for(const id of ['onboarding-checks','runtime-diagnostic-checks','session-diagnostic-checks','notification-diagnostic-checks'])$(id).replaceChildren();
  const sessionSection=$('session-diagnostics'),notificationSection=$('notification-diagnostics'),permissions=$('codex-hook-permissions'),recovery=$('codex-runtime-recovery'),saveButton=$('save-host-selection');
  const restoreTabFocus=!!document.activeElement?.closest('#host-configuration-tabs');
  const preserved=[sessionSection,notificationSection,permissions,recovery,saveButton];for(const node of preserved)section.append(node);
  const hostChecks=[],hostLists=new Map(),hostPanels=new Map(),hosts=value.hosts||[];
  $('host-configuration-tabs').replaceChildren();$('host-configuration-groups').replaceChildren();$('codex-runtime-result').replaceChildren();
  for(const node of [sessionSection,notificationSection,permissions,recovery])node.hidden=true;
  if(!hosts.some(h=>h.id===activeHost))activeHost=hosts.find(h=>h.selected)?.id||hosts[0]?.id||null;
  for(const host of hosts){
   const tab=document.createElement('button');tab.type='button';tab.id='host-tab-'+host.id;tab.dataset.host=host.id;tab.setAttribute('role','tab');tab.setAttribute('aria-controls','host-panel-'+host.id);tab.textContent=host.id==='codex'?'Codex':host.id.toUpperCase();
   tab.onclick=()=>showHost(host.id);
   tab.onkeydown=event=>{const index=hosts.findIndex(h=>h.id===host.id);let next;if(event.key==='ArrowRight')next=(index+1)%hosts.length;else if(event.key==='ArrowLeft')next=(index-1+hosts.length)%hosts.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=hosts.length-1;else return;event.preventDefault();showHost(hosts[next].id,{focus:true});};
   $('host-configuration-tabs').append(tab);
   const group=document.createElement('section'),scope=document.createElement('div'),choice=document.createElement('label'),input=document.createElement('input'),state=document.createElement('p'),heading=document.createElement('h4'),detail=document.createElement('p'),list=document.createElement('ol');
   group.id='host-panel-'+host.id;group.dataset.host=host.id;group.setAttribute('role','tabpanel');group.setAttribute('aria-labelledby',tab.id);group.tabIndex=0;scope.className='host-scope';input.type='checkbox';input.id='host-choice-'+host.id;input.checked=host.selected;choice.append(input,document.createTextNode(' '+tr('将此宿主纳入检查范围')));state.className='muted small';state.textContent=tr(host.selected?'已纳入检查范围；切换页签不会改变此设置。':'尚未纳入检查范围；查看此页不会启用接入。');scope.append(choice,state);
   heading.textContent=host.id==='codex'?tr('Codex 必要配置')+': '+host.pendingCount+' '+tr('项待配置'):host.id.toUpperCase()+' '+tr('适配器能力');detail.textContent=tr(host.detail);list.className='onboarding-host-checks';group.append(scope,detail);if(host.selected)group.append(heading,list);
   $('host-configuration-groups').append(group);hostPanels.set(host.id,group);
   if(host.id==='codex'){for(const node of [sessionSection,notificationSection,permissions,recovery]){node.hidden=!host.selected;group.append(node);}}
   for(const check of host.checks){hostChecks.push(check);hostLists.set(check,list);}
  }
  saveButton.hidden=!hosts.length;if(hosts.length)showHost(activeHost,{focus:restoreTabFocus});
  if(value.hostConfigurationPendingCount)$('onboarding-summary').textContent+=' '+tr('已选宿主待配置')+': '+value.hostConfigurationPendingCount+' '+tr('不影响工作台访问。');
  const quiet=['complete','not_applicable','checking'];
  const diagnostics=value.runtimeDiagnostics?.checks||[],sessions=value.sessionDiagnostics?.checks||[],notifications=value.notificationDiagnostics?.checks||[];
  const ordered=[...value.checks,...diagnostics,...sessions,...notifications,...hostChecks].sort((a,b)=>Number(quiet.includes(a.status))-Number(quiet.includes(b.status)));
  let deliveryItem,configurationItem;
  for(const check of ordered){
   const item=document.createElement('li');item.dataset.check=check.id;item.dataset.state=check.status;
   const heading=document.createElement('h4'),label=document.createElement('span');heading.textContent=tr(check.title)+' ';label.className='onboarding-state';label.textContent=tr((sessions.includes(check)||notifications.includes(check))?({action_required:'未就绪（不影响工作台）',verify:'待核验（不影响工作台）'}[check.status]||labels[check.status]):labels[check.status]);heading.append(label);item.append(heading);
   const detail=document.createElement('p');detail.textContent=tr(check.detail);item.append(detail);
   if(check.id==='execution-observation'&&value.runtimeRecovery?.checked){
    const result=document.createElement('p');result.textContent=ui`已检查 ${value.runtimeRecovery.checked} 个执行会话，恢复 ${value.runtimeRecovery.recovered} 项观察记录。`;$('codex-runtime-result').append(result);
    if(value.runtimeRecovery.results.some(r=>r.source==='codex-session-log')){const source=document.createElement('p');source.textContent=tr('观察来自本机会话日志，只说明记录时刻的会话活动，不代表任务完成或 Hook 已执行。');$('codex-runtime-result').append(source);}
    const reasons={LOG_NOT_FOUND:'本机没有找到对应会话日志，观察状态仍待核验。',PERMISSION_DENIED:'没有读取本机会话记录的权限，未更改观察状态。',UNSUPPORTED_REFERENCE:'该执行会话尚无可用的本机观察适配器。',PROJECT_MISMATCH:'会话记录与登记项目不匹配，已拒绝自动恢复。',IDENTITY_MISMATCH:'会话记录身份不匹配，已拒绝自动恢复。',UNSAFE_PATH:'会话记录路径不安全，已拒绝自动恢复。',STALE_EVENT:'最新可识别活动已过期，无法确认当前执行状态。',NO_RECOGNIZED_EVENT:'未找到可识别的生命周期或带身份的活动事件。',UNSUPPORTED_FORMAT:'会话记录格式暂不支持，未推测执行状态。',INDEX_LIMIT:'本次索引检查达到安全上限，观察状态仍待核验。',AMBIGUOUS_LOG:'找到多个候选会话记录，已拒绝猜测身份。',READ_FAILED:'暂时无法读取本机会话记录，请稍后重新检测。',RECOVERY_UNAVAILABLE:'观察恢复暂不可用，请稍后重新检测。'};
    for(const reason of new Set(value.runtimeRecovery.results.filter(r=>r.state==='UNAVAILABLE').map(r=>r.reason))){const line=document.createElement('p');line.textContent=tr(reasons[reason]||reasons.RECOVERY_UNAVAILABLE);$('codex-runtime-result').append(line);}
   }

   if(check.instructions){const steps=document.createElement('ol');for(const step of check.instructions){const line=document.createElement('li');line.textContent=tr(step);steps.append(line);}item.append(steps);}
   if(check.promptHelp){const help=document.createElement('p');help.textContent=tr(check.promptHelp);item.append(help);}
   if(check.prompt){const prompt=document.createElement('pre'),code=document.createElement('code');code.textContent=tr(check.prompt);prompt.append(code);item.append(prompt,copyButton(code.textContent,'复制提示词'));}
   if(check.command&&check.status!=='complete'){
    const command=document.createElement('code');command.textContent=check.command;item.append(command,copyButton(check.command,'复制命令'));
   }
   (hostLists.get(check)||$(diagnostics.includes(check)?'runtime-diagnostic-checks':sessions.includes(check)?'session-diagnostic-checks':notifications.includes(check)?'notification-diagnostic-checks':'onboarding-checks')).append(item);
   if(check.id==='notification-delivery')deliveryItem=item;
   if(check.id==='notification-config')configurationItem=item;
  }
  configureButton.hidden=!value.hosts?.some(h=>h.id==='codex'&&h.selected)||value.notifications==='CONFIGURED_NOT_DELIVERY_VERIFIED';configureButton.disabled=configuring;
  (configurationItem||hostPanels.get('codex')||section).append(configureButton);
  retryButton.hidden=!(value.hosts?.some(h=>h.id==='codex'&&h.selected)??true)||!['FAILED','UNKNOWN'].includes(value.automaticNotification?.state);retryButton.disabled=retrying;
  (deliveryItem||hostPanels.get('codex')||section).append(retryButton);
 }
 function refresh(checkHost=false,{diagnoseRuntime=false}={}){
  if(inflight)return inflight;
  const button=$('refresh-onboarding'),diagnosticButton=$('refresh-runtime-diagnostics'),sessionButton=$('refresh-session-diagnostics'),feedback=$('onboarding-feedback');
  button.disabled=true;diagnosticButton.disabled=true;sessionButton.disabled=true;$('save-host-selection').disabled=true;button.textContent=tr('检测中…');section.setAttribute('aria-busy','true');feedback.textContent=tr('正在检测接入状态，请稍候…');
  const controller=new AbortController();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('ONBOARDING_TIMEOUT'));},12000);});
  inflight=(async()=>{
   try{
    const previous=value?JSON.stringify([value.checks,value.hosts,value.sessionDiagnostics,value.notificationDiagnostics].map(v=>v||null)):null;
    value=await Promise.race([api('/api/onboarding'+(diagnoseRuntime?'?diagnoseRuntime=1':checkHost?'?checkHost=1':''),undefined,{signal:controller.signal}),timeout]);
    render();
    const unchanged=previous===JSON.stringify([value.checks,value.hosts,value.sessionDiagnostics,value.notificationDiagnostics].map(v=>v||null));
    feedback.textContent=value.runtimeRecovery?.recovered?ui`检测完成，已恢复 ${value.runtimeRecovery.recovered} 项观察记录。任务状态未被修改。`:tr(unchanged?'检测完成，检查结果未变化。':'检测完成，检查结果已更新。');
    const at=new Date(value.checkedAt||Date.now());
    $('onboarding-checked-at').textContent=ui`最近检测：${at.toLocaleString(locale())}`;
   }catch(error){
    feedback.textContent=tr(controller.signal.aborted?'检测超时，请重试。上次结果已保留。':'接入状态检测失败，请重新检测。上次结果已保留。');
    if(!value){$('onboarding-reminder').hidden=false;$('onboarding-summary').textContent=tr('接入状态尚未取得，请重新检测。');}
   }finally{clearTimeout(timer);inflight=null;button.disabled=false;diagnosticButton.disabled=false;sessionButton.disabled=false;$('save-host-selection').disabled=savingHosts;button.textContent=tr('重新检测');section.setAttribute('aria-busy','false');}
  })();
  return inflight;
 }
 $('save-host-selection').onclick=async()=>{
  if(savingHosts||inflight)return;savingHosts=true;$('save-host-selection').disabled=true;
  try{await api('/api/onboarding/select-hosts',{hosts:(value.hosts||[]).filter(host=>host.id===activeHost?$('host-choice-'+host.id).checked:host.selected).map(host=>host.id)});await refresh();}
  catch(error){$('onboarding-feedback').textContent=error.message;}
  finally{savingHosts=false;$('save-host-selection').disabled=false;}
 };
 $('open-onboarding').onclick=()=>{openSettings('onboarding');};
 $('refresh-onboarding').onclick=()=>{void refresh();};
 $('refresh-session-diagnostics').onclick=()=>{void refresh(true);};
 $('refresh-runtime-diagnostics').onclick=()=>{void refresh(false,{diagnoseRuntime:true});};
 configureButton.onclick=async()=>{
  configuring=true;configureButton.disabled=true;
  try{const result=await api('/api/onboarding/configure-notifications',{});$('onboarding-feedback').textContent=tr(result.state==='CONFIGURED_NOT_DELIVERY_VERIFIED'?'后台通知通道已就绪，登记经理后会自动检查。':'通知通道尚不可用，请检查接入清单中的原因。');await refresh(false);}
  catch(error){$('onboarding-feedback').textContent=error.message;}
  finally{configuring=false;configureButton.disabled=false;}
 };
 retryButton.onclick=async()=>{
  if(retrying)return;retrying=true;retryButton.disabled=true;
  try{const result=await api('/api/onboarding/retry-notification',{});$('onboarding-feedback').textContent=tr(result.state==='ACCEPTED'?'自动通知检查已通过。':'自动检查尚未通过，请查看检查清单。');await refresh(false);}
  catch(error){$('onboarding-feedback').textContent=error.message;}
  finally{retrying=false;retryButton.disabled=false;}
 };
 void refresh();setInterval(()=>{if(!document.hidden)void refresh();},60000);
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
 return {refresh};
}
