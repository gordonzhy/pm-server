import {t as tr,ui,locale,message,enumLabel} from './i18n.mjs';
// Workbench notifications cover all connected sources, independent of display filters.
export function createWorkbenchNotifications({openSettings,openTask}) {
  const $=id=>document.getElementById(id),pendingKey='project-manager-workbench:pending-notified:v1';
  let snapshot={projects:[],pending:[]},feedback='',ready=false,enabled=true;
  try{enabled=localStorage.getItem('project-manager-workbench:notifications')!=='off';}catch{}
  const permission=()=>!('Notification' in window)?'unsupported':!isSecureContext?'insecure':Notification.permission;
  const load=key=>{try{const value=JSON.parse(localStorage.getItem(key)||'[]');return new Set(Array.isArray(value)?value:[]);}catch{return new Set();}};
  const save=(key,values)=>{try{localStorage.setItem(key,JSON.stringify([...values]));}catch{}};
  function entries(){return snapshot.projects.filter(p=>p.available).flatMap(p=>p.tasks.filter(t=>t.status==='待确认').map(t=>({project:p,task:t})));}
  function render(){
    const tasks=entries(),count=tasks.length+snapshot.pending.length;
    $('notification-count').textContent=count;$('notification-count').hidden=!count;
    $('open-notifications').setAttribute('aria-label',ui`通知（${tasks.length} 项待确认，${snapshot.pending.length} 个连接待重试）`);
    const state=permission();
    const messages={unsupported:'当前浏览器不支持桌面通知；下方提醒列表仍可查看。',insecure:'当前地址无法申请通知，请使用 HTTPS 或本机 127.0.0.1 / localhost。',denied:'浏览器已阻止通知。请从地址栏的站点设置允许通知，并检查系统的浏览器通知设置。',default:'尚未开启浏览器通知。点击下方按钮允许此站点发送通知。',granted:enabled?'浏览器通知已允许。若桌面仍未显示，请检查系统通知、勿扰模式和浏览器设置。':'已暂停此工作台的桌面提醒。'};
    $('notification-status').textContent=tr(messages[state]);$('notification-feedback').textContent=message(feedback);$('notification-feedback').hidden=!feedback;
    $('enable-workbench-notifications').textContent=state==='granted'?(enabled?tr('暂停桌面提醒'):tr('开启桌面提醒')):tr('开启浏览器通知');
    $('enable-workbench-notifications').disabled=!['default','granted'].includes(state);
    $('test-workbench-notification').disabled=state!=='granted'||!enabled;
    const list=$('notification-items');list.replaceChildren();
    if(snapshot.pending.length){const b=document.createElement('button');b.textContent=ui`${snapshot.pending.length} 个项目连接失败，等待重试`;b.onclick=()=>openSettings('pending');list.append(b);}
    for(const {project,task} of tasks){const b=document.createElement('button');b.textContent=`${project.name} · ${task.id} ${task.title}`;b.onclick=()=>{$('settings-dialog').close();openTask(project.id,task);};list.append(b);}
    if(!count){const p=document.createElement('p');p.className='muted';p.textContent=tr('目前没有待确认任务或连接失败。');list.append(p);}
  }
  function send(title,body,key,ids,onClick,test=false){
    try{
      const notice=new Notification(title,{body,tag:test?'workbench-notification-test':'workbench:'+key});
      const stored=load(key);ids.forEach(id=>stored.add(id));save(key,stored);
      feedback=test?'测试通知已提交给浏览器；是否在桌面展示由浏览器和系统决定。':'';
      notice.onclick=()=>{window.focus();onClick?.();notice.close?.();};
      notice.onerror=event=>{const stored=load(key);ids.forEach(id=>stored.delete(id));save(key,stored);feedback=ui`通知发送失败：${event.error?.message||tr('浏览器未能显示通知')}。保留待提醒，稍后刷新可重试。`;render();};
    }catch(error){feedback=ui`通知发送失败：${error.message}。保留待提醒，稍后刷新可重试。`;}
  }
  function update(value=snapshot){
    snapshot=value;ready=true;
    // Preserve unavailable sources' deduplication state; missing data is not a state transition.
    for(const p of snapshot.projects.filter(p=>p.available)){
      const key=`task-dashboard:confirm-notified:v1:/projects/${p.id}/TASKS.html`,current=p.tasks.filter(t=>t.status==='待确认'),ids=new Set(current.map(t=>t.id));
      const saved=new Set([...load(key)].filter(id=>ids.has(id)));save(key,saved);
      const fresh=current.filter(t=>!saved.has(t.id));
      if(enabled&&permission()==='granted'&&fresh.length)send(ui`${p.name} · ${fresh.length} 项任务待确认`,fresh.slice(0,5).map(t=>`${t.id} ${t.title}`).join('、'),key,fresh.map(t=>t.id),()=>openSettings('notifications'));
    }
    const pendingIds=new Set(snapshot.pending.map(p=>p.id)),seen=new Set([...load(pendingKey)].filter(id=>pendingIds.has(id)));save(pendingKey,seen);
    const fresh=snapshot.pending.filter(p=>!seen.has(p.id));
    if(enabled&&permission()==='granted'&&fresh.length)send(ui`${fresh.length} 个项目连接失败，需检查来源`,fresh.map(p=>p.name).join('、'),pendingKey,fresh.map(p=>p.id),()=>openSettings('pending'));
    render();
  }
  $('open-notifications').onclick=()=>{render();openSettings('notifications');};
  $('enable-workbench-notifications').onclick=async()=>{
    const button=$('enable-workbench-notifications');button.disabled=true;
    try{if(permission()==='default'){const result=await Notification.requestPermission();enabled=result==='granted';feedback=result==='default'?'浏览器尚未授予权限，请检查地址栏的通知提示。':'';}else enabled=!enabled;
      localStorage.setItem('project-manager-workbench:notifications',enabled?'on':'off');
    }catch(error){feedback=ui`通知权限请求失败：${error.message}`;}finally{update();}
  };
  $('test-workbench-notification').onclick=()=>{send(tr('项目工作台 · 测试通知'),tr('看到此消息即表示桌面通知链路可用。'),'workbench-test',[],null,true);render();};
  window.addEventListener('focus',()=>{if(ready)update();});
  return {update,render};
}
