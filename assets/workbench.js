import {t as tr,ui,locale,message,enumLabel} from './i18n.mjs';
'use strict';
import {createGraphMinimap} from './workbench-minimap.mjs';
import {createWorkbenchOnboarding} from './workbench-onboarding.mjs';
import {createWorkbenchNotifications} from './workbench-notifications.mjs';
import {taskPosture,buildDependencyGraph,renderDependencyGraph} from './workbench-graph.mjs';
import {defaultColumns,tableColumns,columnValue,matchesColumnFilters,sortTableTasks} from './workbench-table.mjs';
const $=id=>document.getElementById(id),esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const owner=document.body.dataset.access==='owner';
const token=document.querySelector('meta[name=workbench-token]').content;
const preferenceKey='project-manager-workbench:view:v2',controlIds=['keyword','status','priority','task-type'];
const PAGE_SIZE=50,collator=new Intl.Collator(locale(),{numeric:true,sensitivity:'base'});
let state={projects:[],pending:[],removed:[]},selected=new Set(),undoId=null,noticeTimer,knownIds=new Set(),preferences={},refreshChain=Promise.resolve(),busy=false,firstRender=true,pageNumber=1;
try{preferences=JSON.parse(localStorage.getItem(preferenceKey)||'{}')||{};}catch{}
if(Array.isArray(preferences.selected))selected=new Set(preferences.selected);
for(const id of controlIds)if(typeof preferences[id]==='string')$(id).value=preferences[id];
if(!$('status').value)$('status').value='active';
let activeTab=preferences.tab==='list'?'list':'graph',sortKey=typeof preferences.sortKey==='string'?preferences.sortKey:'priority',sortDirection=preferences.sortDirection==='desc'?'desc':'asc';
let columnFilters=Object.fromEntries(Object.entries(preferences.columnFilters||{}).filter(([,value])=>typeof value==='string'));
let visibleColumns=new Set(Array.isArray(preferences.visibleColumns)&&preferences.visibleColumns.length?preferences.visibleColumns:defaultColumns);
const projectPalette=['#A99AF7','#67D8EF','#EFA8CA','#93B4F6','#8BD4BF','#D7B6F2','#A3C6DD','#D7C5A0'];
preferences.projectColors=preferences.projectColors&&typeof preferences.projectColors==='object'?preferences.projectColors:{};
function projectAccent(id){
  if(projectPalette.includes(preferences.projectColors[id]))return preferences.projectColors[id];
  const used=new Set(Object.values(preferences.projectColors));
  const color=projectPalette.find(color=>!used.has(color))||projectPalette[Object.keys(preferences.projectColors).length%projectPalette.length];
  preferences.projectColors[id]=color;return color;
}
function persist(){const value={...preferences,selected:[...selected],tab:activeTab,sortKey,sortDirection,columnFilters,visibleColumns:[...visibleColumns]};for(const id of controlIds)value[id]=$(id).value;try{localStorage.setItem(preferenceKey,JSON.stringify(value));}catch{}}
async function api(endpoint,input,{signal}={}){
  const response=await fetch(endpoint,input===undefined?{cache:'no-store',signal}:{signal,method:'POST',headers:{'Content-Type':'application/json','X-Workbench-Token':token},body:JSON.stringify(input)});
  if(response.status===401){location.replace(globalThis.PMI18n.href('/login'));throw new Error(tr('登录已过期'));}
  const data=await response.json();if(!response.ok)throw new Error(message(data.error)||`HTTP ${response.status}`);return data;
}
function showError(error){const target=$('settings-dialog').open?$('settings-error'):$('error');target.hidden=false;target.textContent=message(error.message||String(error));}
function notify(text,id=null){clearTimeout(noticeTimer);undoId=id;$('notice-text').textContent=text;$('notice').hidden=false;$('undo').hidden=!id;if(id)noticeTimer=setTimeout(()=>{$('notice').hidden=true;undoId=null;},12000);}
function activeProjects(){return state.projects.filter(p=>selected.has(p.id));}

function allViewTasks(){return activeProjects().flatMap(project=>{const byId=new Map(project.tasks.map(t=>[t.id,t]));return project.tasks.map(t=>({...t,project:{...project,accent:projectAccent(project.id)},posture:taskPosture(t,byId)}));});}
function visibleTasks(){
  const keyword=$('keyword').value.trim().toLocaleLowerCase(locale()),status=$('status').value,priority=$('priority').value,type=$('task-type').value;
  return allViewTasks().filter(t=>{
    if(status==='active'&&['已完成','已取消'].includes(t.status))return false;
    if(['ready','waiting'].includes(status)){if(t.posture!==status)return false;}else if(status!=='active'&&status!=='all'&&t.status!==status)return false;
    if(priority&&t.priority!==priority)return false;
    if(type&&(t.task_type||'未分类')!==type)return false;
    return !keyword||[t.project.name,t.project.group,t.id,t.title,t.boundary,t.executor,t.task_type].join(' ').toLocaleLowerCase(locale()).includes(keyword);
  }).filter(t=>matchesColumnFilters(t,columnFilters));
}
function badge(status,posture=''){return `<span class="badge" data-status="${esc(status)}" data-posture="${esc(posture)}">${esc(tr(status))}</span>`;}
const notifications=createWorkbenchNotifications({openSettings,openTask:openDetail});
const onboarding=createWorkbenchOnboarding({api,openSettings,owner});
function renderScope(){
  $('scope-count').textContent=`${selected.size}/${state.projects.length}`;
  $('select-all').textContent=state.projects.length>0&&state.projects.every(p=>selected.has(p.id))?tr('全不选'):tr('全选');
  $('select-all').setAttribute('aria-pressed',String(state.projects.length>0&&state.projects.every(p=>selected.has(p.id))));$('select-all').disabled=state.projects.length===0;
  $('project-nav').innerHTML=state.projects.map(p=>`<button class="project-filter" style="--project-accent:${projectAccent(p.id)}" data-select="${p.id}" aria-pressed="${selected.has(p.id)}" title="${esc(p.group+' · '+p.name+' · '+p.csvPath)}"><i class="project-dot" aria-hidden="true"></i><span>${esc(p.name)}</span>${p.available?'':tr('<span class="unavailable">读取失败</span>')}</button>`).join('')||tr('<p class="muted small">尚未连接项目，请在设置中添加。</p>');
}

function renderSummary(){
  const projects=activeProjects(),good=projects.filter(p=>p.available),tasks=allViewTasks();
  $('summary').innerHTML=[['待确认','confirm','待确认','需要你作出决定'],['进行中','active','进行中','执行或核验中'],['可开始','ready','ready','待办且任务依赖已完成'],['等待依赖','waiting','waiting','待办且前置任务未完成'],['受阻','blocked','受阻','存在明确阻碍'],['未终结','all','active','所选项目全部未终结任务']].map(([label,kind,value,hint])=>`<button class="metric ${kind}" title="${esc(tr(hint))}" data-status-filter="${value}" aria-pressed="${$('status').value===value}"><span>${tr(label)}</span><strong>${tasks.filter(t=>value==='active'?!['已完成','已取消'].includes(t.status):['ready','waiting'].includes(value)?t.posture===value:t.status===value).length}</strong><span class="metric-hint">${tr(hint)}</span></button>`).join('');
  $('coverage').textContent=ui`已选择 ${projects.length} 个项目 · 成功读取 ${good.length}/${projects.length}${good.length<projects.length?tr(' · 当前汇总不完整'):''}`;
  const warnings=[...projects.filter(p=>!p.available).map(p=>ui`${p.name}：读取失败，未计入汇总（${message(p.error)}）`),...(state.watchWarnings||[])];
  $('read-warnings').hidden=!warnings.length;$('read-warnings').textContent=warnings.join('；');
}

function settingsItem(p,action){return `<article class="setting-item" style="--project-accent:${projectAccent(p.id)}"><div><strong><i class="project-dot" aria-hidden="true"></i> ${esc(p.name)}</strong><span class="group-label">${esc(p.group)}</span><p class="source-path muted">${esc(p.csvPath)}</p></div><button ${action==='remove'?'class="remove-project"':''} data-${action}="${p.id}" ${action==='remove'?ui`aria-label="移除 ${esc(p.name)}" title="移除并加入黑名单，保留文件"`:''}>${action==='remove'?'×':tr('恢复连接')}</button>${action==='restore'?ui`<button class="delete-record" data-delete-removed="${p.id}" aria-label="取消屏蔽 ${esc(p.name)}">取消屏蔽</button>`:''}</article>`;}
function renderSettings(){
  $('registered-count').textContent=state.projects.length;$('registered-list').innerHTML=state.projects.map(p=>settingsItem(p,'remove')).join('')||tr('<p class="muted small">尚未连接项目</p>');
  $('settings-pending').hidden=!owner||!state.pending.length;$('pending-count').textContent=state.pending.length;$('settings-count').hidden=!state.pending.length;$('settings-count').textContent=state.pending.length;$('open-settings').setAttribute('aria-label',state.pending.length?ui`设置（${state.pending.length} 个连接待重试）`:tr('设置'));
  $('pending-list').innerHTML=state.pending.map(p=>ui`<article class="request"><strong>${esc(p.name)}</strong><span class="group-label">${esc(p.group)}</span><p class="source-path muted">${esc(p.csvPath)}</p><p class="muted small">${esc(message(p.registrationError||tr('来源需要重新检查')))}</p><div class="actions"><button data-reject="${p.id}">加入黑名单</button><button class="primary" data-confirm="${p.id}">重试连接</button></div></article>`).join('')||tr('<p class="muted small">没有待重试连接</p>');
  $('removed-count').textContent=state.removed.length;$('removed-list').innerHTML=state.removed.map(p=>settingsItem(p,'restore')).join('')||tr('<p class="muted small">黑名单为空</p>');
}

function typeTag(type){const value=type||'未分类';return `<span class="type-tag" data-type="${esc(value)}">${esc(tr(value))}</span>`;}
function dependencyChips(t){return (t.dependencyIds||[]).map(id=>{const dependency=t.project.tasks.find(item=>item.id===id);return ui`<button class="dependency-chip" data-status="${esc(tr(dependency?.status||'未知'))}" data-posture="${dependency?taskPosture(dependency,t.project.tasks):''}" data-task="${esc(t.project_id+':'+id)}" title="前置任务：${esc(dependency?.title||id)} · ${esc(tr(dependency?.status||'未知'))}">${esc(id)}</button>`;}).join(' ')||'<span class="muted small">无</span>';}
function filterOptions(column){
  const all=allViewTasks();
  if(column.key==='source_project')return state.projects.map(p=>({value:p.id,label:p.name,title:p.csvPath}));
  return [...new Set(all.map(t=>columnValue(t,column.key)))].filter(Boolean).sort(collator.compare).map(value=>({value,label:value}));
}
function columnControl(column){
  const value=columnFilters[column.key]||'';
  if(column.kind==='category')return ui`<select data-column-filter="${esc(column.key)}" aria-label="${esc(tr('筛选'))} ${esc(column.label)}"><option value="">全部</option>${filterOptions(column).map(option=>`<option value="${esc(option.value)}" title="${esc(option.title||option.label)}" ${option.value===value?'selected':''}>${esc(['status','task_type','task_posture'].includes(column.key)?tr(option.label):option.label)}</option>`).join('')}</select>`;
  return ui`<input type="search" data-column-filter="${esc(column.key)}" aria-label="${esc(tr('筛选'))} ${esc(column.label)}" placeholder="${column.kind==='date'?tr('日期或时间'):tr('包含…')}" value="${esc(value)}">`;
}
function tableCell(task,column){
  const value=columnValue(task,column.key);
  if(column.key==='id'||column.key==='title')return `<button data-task="${esc(task.key)}">${esc(value)}</button>${column.key==='title'?`<div class="mobile-task-context"><span>${esc(task.id)}</span><button class="source-label" style="--project-accent:${projectAccent(task.project_id)}" data-open-project="${task.project_id}" title="${esc(task.project.csvPath)}"><i class="project-dot" aria-hidden="true"></i>${esc(task.project.name)}</button></div>`:''}`;
  if(column.key==='source_project')return `<button class="source-label" style="--project-accent:${projectAccent(task.project_id)}" data-open-project="${task.project_id}" title="${esc(task.project.csvPath)}"><i class="project-dot" aria-hidden="true"></i>${esc(value)}</button>`;
  if(column.key==='status')return badge(task.status,task.posture);
  if(column.key==='task_type')return typeTag(task.task_type);
  if(column.key==='dependencies')return dependencyChips(task);
  if(column.key==='priority')return `<span class="priority-label" data-priority="${esc(value)}">${esc(value)}</span>`;
  if(column.key==='task_posture')return `<span class="posture-label" data-posture="${task.posture}">${esc(tr(value))}</span>`;
  if(column.kind==='date'){const date=new Date(value);return `<span title="${esc(value)}">${Number.isNaN(date.getTime())?'—':esc(date.toLocaleString(locale(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}))}</span>`;}
  return `<span class="cell-value" title="${esc(value)}">${esc(value||'—')}</span>`;
}
function applyView(){
  document.querySelector('.graph-controls').hidden=activeTab!=='graph';$('graph-view').hidden=activeTab!=='graph';$('list-view').hidden=activeTab!=='list';minimap.schedule();
  for(const button of $('view-tabs').querySelectorAll('[data-view]')){const active=button.dataset.view===activeTab;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;}
}
function renderColumnSummary(){
  const advancedCount=Number(Boolean($('task-type').value))+Number(Boolean($('priority').value));$('advanced-filter-count').textContent=advancedCount||'';$('more-filters').classList.toggle('is-active',advancedCount>0);
  const catalog=new Map(tableColumns(allViewTasks()).map(column=>[column.key,column])),filters=Object.entries(columnFilters).filter(([,value])=>value);
  $('column-filter-summary').hidden=!filters.length;$('column-filter-summary').innerHTML=filters.map(([key,value])=>{const label=key==='source_project'?(state.projects.find(p=>p.id===value)?.name||value):value;return `<button data-clear-column="${esc(key)}">${esc(catalog.get(key)?.label||key)}：${esc(['status','task_type','task_posture'].includes(key)?tr(label):label)} <span aria-hidden="true">×</span></button>`;}).join('')+(filters.length?tr('<button id="clear-column-filters">清空列筛选</button>'):'');
}
function renderColumnSettings(){const catalog=tableColumns(allViewTasks());$('column-options').innerHTML=catalog.map(column=>`<label><input type="checkbox" data-column-toggle="${esc(column.key)}" ${visibleColumns.has(column.key)?'checked':''}>${esc(column.label)}</label>`).join('');}
function renderContent(){
  const openColumn=$('content').querySelector('.column-popover:popover-open')?.dataset.filterPanel;
  const focused=document.activeElement,focusFilter=focused?.dataset.columnFilter,focusSort=focused?.dataset.sortColumn,selection=focusFilter&&focused.tagName==='INPUT'?[focused.selectionStart,focused.selectionEnd]:null,scrollLeft=$('content').querySelector('.table-wrap')?.scrollLeft||0;
  const tasks=visibleTasks(),catalog=tableColumns(allViewTasks());if(!catalog.some(column=>column.key===sortKey))sortKey='priority';
  const sorted=sortTableTasks(tasks,sortKey,sortDirection),pages=Math.max(1,Math.ceil(sorted.length/PAGE_SIZE));pageNumber=Math.max(1,Math.min(pageNumber,pages));
  let columns=catalog.filter(column=>visibleColumns.has(column.key));if(!columns.length){visibleColumns=new Set(defaultColumns);columns=catalog.filter(column=>visibleColumns.has(column.key));}
  if(window.matchMedia('(max-width:650px)').matches){const order=key=>key==='title'?0:key==='status'?1:['id','source_project'].includes(key)?3:2;columns.sort((a,b)=>order(a.key)-order(b.key));}
  const rows=sorted.slice((pageNumber-1)*PAGE_SIZE,pageNumber*PAGE_SIZE);
  renderGraph(tasks);$('task-count').textContent=ui`${tasks.length} 项`;
  $('content').innerHTML=`<div class="table-wrap unified-table"><table><thead><tr>${columns.map(column=>ui`<th data-column="${esc(column.key)}" aria-sort="${sortKey===column.key?(sortDirection==='asc'?'ascending':'descending'):'none'}"><div class="column-heading"><button data-sort-column="${esc(column.key)}">${esc(column.label)} <span class="sort-indicator">${sortKey===column.key?(sortDirection==='asc'?'↑':'↓'):'↕'}</span></button><button class="column-filter-button ${columnFilters[column.key]?'is-active':''}" data-open-filter="${esc(column.key)}" aria-label="${esc(tr('筛选'))} ${esc(column.label)}" title="${esc(tr('筛选'))} ${esc(column.label)}" popovertarget="filter-${esc(column.key)}"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12L9 9v4l-2 1V9z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></div><div id="filter-${esc(column.key)}" class="column-popover" data-filter-panel="${esc(column.key)}" popover><strong>${esc(column.label)} · ${tr('筛选')}</strong>${columnControl(column)}</div></th>`).join('')}</tr></thead><tbody>${rows.map(task=>`<tr data-task-key="${esc(task.key)}" data-status="${esc(task.status)}" data-posture="${task.posture}">${columns.map(column=>`<td data-column="${esc(column.key)}" ${column.key==='title'?'class="task-title"':column.key==='source_project'?'class="project-source"':column.key==='dependencies'?'class="dependency-cell"':''}>${tableCell(task,column)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${rows.length?'':tr('<div class="empty">没有匹配任务，可调整项目范围或筛选条件。</div>')}`;
  $('pagination').hidden=pages===1;$('page-description').textContent=ui`第 ${pageNumber}/${pages} 页 · 共 ${tasks.length} 项`;$('previous-page').disabled=pageNumber<=1;$('next-page').disabled=pageNumber>=pages;
  renderColumnSummary();applyView();
  const wrapper=$('content').querySelector('.table-wrap');wrapper.scrollLeft=scrollLeft;
  if(openColumn){const panel=$('content').querySelector(`[data-filter-panel="${CSS.escape(openColumn)}"]`);if(panel){positionColumnPanel(panel);panel.showPopover();}}
  if(focusFilter||focusSort){const replacement=[...$('content').querySelectorAll('[data-column-filter],[data-sort-column]')].find(node=>focusFilter?node.dataset.columnFilter===focusFilter:node.dataset.sortColumn===focusSort);replacement?.focus({preventScroll:true});if(selection&&replacement?.tagName==='INPUT')replacement.setSelectionRange(...selection);}
}

function render(){
  const currentPriority=firstRender?(preferences.priority||''):$('priority').value;firstRender=false;
  $('priority').innerHTML=tr('<option value="">全部</option>')+[...new Set(state.projects.flatMap(p=>p.tasks.map(t=>t.priority)))].sort(collator.compare).map(p=>`<option>${esc(p)}</option>`).join('');$('priority').value=currentPriority;
  renderScope();renderSummary();renderSettings();renderColumnSettings();renderContent();
  if($('task-dialog').open&&!state.projects.some(p=>p.id===$('task-dialog').dataset.project)){$('task-dialog').close();$('task-frame').src='about:blank';showError(tr('正在查看的项目已从工作台移除。'));}
}
function refresh(ids=null){
  refreshChain=refreshChain.catch(()=>{}).then(async()=>{
    try{
      let full=!ids?.length;
      if(!full){const updates=await Promise.all(ids.filter(id=>state.projects.some(p=>p.id===id)).map(id=>api(`/api/projects/${id}`).catch(()=>null)));for(const p of updates)if(p){const index=state.projects.findIndex(x=>x.id===p.id);if(index>=0)state.projects[index]=p;}full=updates.some(x=>x===null);}
      if(full){state=await api('/api/state');const registered=new Set(state.projects.map(p=>p.id));for(const id of registered)if(!knownIds.has(id)&&(!Array.isArray(preferences.selected)||knownIds.size>0))selected.add(id);selected=new Set([...selected].filter(id=>registered.has(id)));knownIds=registered;}
      graphDetailCache.clear();$('error').hidden=true;render();notifications.update(state);
    }catch(error){showError(error);$('connection').textContent=tr('数据读取失败');}
  });return refreshChain;
}
async function mutate(endpoint,input){if(busy)return null;busy=true;try{const result=await api(endpoint,input);await refresh();return result;}finally{busy=false;}}
function openDetail(id,task=null){hideGraphCard(true);const project=state.projects.find(p=>p.id===id);if(!project)return;if(!task){window.open(`/projects/${id}/TASKS.html`,'_blank','noopener');return;}$('task-title').textContent=task?`${project.name} · ${task.id}`:ui`${project.name} · 项目详情`;$('task-dialog').dataset.project=id;$('task-frame').src=`/projects/${id}/TASKS.html${task?'?embed=detail&task='+encodeURIComponent(task.id):''}`;$('task-dialog').showModal();}
let settingsView='projects';
function selectSettingsView(view,focus=false){
  const requested=$('settings-nav').querySelector(`[data-settings-view="${view}"]`);const button=requested&&!requested.hidden?requested:$('settings-nav').querySelector('[data-settings-view]:not([hidden])');if(!button)return;settingsView=button.dataset.settingsView;
  for(const tab of $('settings-nav').querySelectorAll('[data-settings-view]')){const active=tab===button;tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;$(tab.getAttribute('aria-controls')).hidden=!active;}
  document.querySelector('.settings-content').scrollTop=0;if(focus)button.focus();
}
$('settings-nav').addEventListener('click',event=>{const button=event.target.closest('[data-settings-view]');if(button){selectSettingsView(button.dataset.settingsView);if(button.dataset.settingsView==='sharing')void renderSharing();if(button.dataset.settingsView==='onboarding')void onboarding.refresh();}});
$('settings-nav').addEventListener('keydown',event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const tabs=[...$('settings-nav').querySelectorAll('[data-settings-view]')].filter(tab=>!tab.hidden),index=tabs.findIndex(tab=>tab.dataset.settingsView===settingsView),next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowDown'?1:-1)+tabs.length)%tabs.length;selectSettingsView(tabs[next].dataset.settingsView,true);});
function openSettings(view=settingsView){if(!owner)view='column';if(view==='sharing')void renderSharing();if(view==='onboarding')void onboarding.refresh();$('settings-error').hidden=true;renderSettings();renderColumnSettings();notifications.render();selectSettingsView(view);if(!$('settings-dialog').open)$('settings-dialog').showModal();}
$('open-settings').onclick=()=>openSettings();
$('close-settings').onclick=()=>$('settings-dialog').close();
function closeTaskDetail(){$('task-dialog').close();$('task-frame').src='about:blank';}
$('close-task').onclick=closeTaskDetail;
$('task-dialog').addEventListener('close',()=>{if(!$('task-dialog').open)$('task-frame').src='about:blank';});
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===$('task-frame').contentWindow&&event.data?.type==='PROJECT_MANAGER_DETAIL_CLOSE')closeTaskDetail();});
$('select-all').onclick=()=>{selected=state.projects.every(p=>selected.has(p.id))?new Set():new Set(state.projects.map(p=>p.id));pageNumber=1;render();persist();};
$('project-nav').addEventListener('click',e=>{const button=e.target.closest('[data-select]');if(!button)return;const id=button.dataset.select;if(selected.has(id))selected.delete(id);else selected.add(id);pageNumber=1;render();persist();[...$('project-nav').querySelectorAll('[data-select]')].find(node=>node.dataset.select===id)?.focus({preventScroll:true});});
for(const id of controlIds)$(id).addEventListener(id==='keyword'?'input':'change',()=>{pageNumber=1;renderSummary();renderContent();persist();});
$('summary').addEventListener('click',e=>{const b=e.target.closest('[data-status-filter]');if(!b)return;$('status').value=$('status').value===b.dataset.statusFilter?'active':b.dataset.statusFilter;pageNumber=1;renderSummary();renderContent();persist();});
$('previous-page').onclick=()=>{pageNumber--;renderContent();$('content').scrollIntoView({block:'start'});};$('next-page').onclick=()=>{pageNumber++;renderContent();$('content').scrollIntoView({block:'start'});};
$('add-form').onsubmit=async e=>{
  e.preventDefault();if(busy)return;const button=e.submitter;button.disabled=true;
  const input=Object.fromEntries(new FormData(e.target));for(const key of Object.keys(input)){input[key]=input[key].trim();if(!input[key])delete input[key];}
  try{const p=await mutate('/api/add',input);if(p){selected.add(p.id);pageNumber=1;persist();render();e.target.reset();$('source-preview').hidden=true;$('add-error').hidden=true;notify(ui`已加入：${p.name}`);}}catch(error){$('add-error').textContent=message(error.message);$('add-error').hidden=false;}finally{button.disabled=false;}
};
$('undo').onclick=async()=>{if(!undoId)return;try{const p=await mutate('/api/restore',{id:undoId});if(p){selected.add(p.id);persist();render();notify(ui`已恢复：${p.name}`);}}catch(error){showError(error);}};
$('dismiss-notice').onclick=()=>{$('notice').hidden=true;undoId=null;clearTimeout(noticeTimer);};
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b||busy)return;let mutationButton=false;
  try{
    if(b.dataset.openProject){openDetail(b.dataset.openProject);return;}
    if(b.dataset.task){const task=state.projects.flatMap(p=>p.tasks).find(t=>t.key===b.dataset.task);if(task)openDetail(task.project_id,task);return;}
    // 所有登记修改只出现在设置弹窗中；主页面仅查看。
    if(!b.closest('#settings-dialog'))return;
    if(b.dataset.remove){mutationButton=true;b.disabled=true;const p=await mutate('/api/remove',{id:b.dataset.remove});if(p){persist();notify(ui`已移除：${p.name}。文件和执行会话保留。`,p.id);}return;}
    if(b.dataset.confirm){mutationButton=true;b.disabled=true;const p=await mutate('/api/confirm',{id:b.dataset.confirm});if(p){selected.add(p.id);pageNumber=1;persist();render();notify(ui`已加入：${p.name}`);}return;}
    if(b.dataset.reject){mutationButton=true;b.disabled=true;const p=await mutate('/api/reject',{id:b.dataset.reject});if(p)notify(ui`已加入黑名单：${p.name}`);return;}
    if(b.dataset.deleteRemoved){mutationButton=true;b.disabled=true;const result=await mutate('/api/delete-removed',{id:b.dataset.deleteRemoved});if(result){delete preferences.projectColors[result.id];if(columnFilters.source_project===result.id)delete columnFilters.source_project;persist();renderContent();notify(tr('已取消屏蔽，下次连接时可自动加入。'));}return;}
    if(b.dataset.restore){mutationButton=true;b.disabled=true;const p=await mutate('/api/restore',{id:b.dataset.restore});if(p){selected.add(p.id);pageNumber=1;persist();render();notify(ui`已重新添加：${p.name}`);}return;}
  }catch(error){showError(error);}finally{if(mutationButton)b.disabled=false;}
});
const events=new EventSource('/events');events.onopen=()=>{$('connection').textContent=tr('实时连接已建立');};events.onerror=()=>{$('connection').textContent=tr('连接中断 · 自动重连；可重载读取');};
events.addEventListener('change',e=>{try{const change=JSON.parse(e.data);void refresh(change.registry?null:change.projectIds);}catch{void refresh();}});
void refresh();

let graphModel=buildDependencyGraph([]),graphZoom=Number(preferences.graphZoom)||1,graphPinned=false,graphCardKey=null,graphRequest=0,graphHideTimer;
const graphDetailCache=new Map(),zoomSteps=[0.1,0.25,0.5,0.75,1,1.25,1.5,2];
graphZoom=Math.max(0.1,Math.min(2,graphZoom));
const minimap=createGraphMinimap({graph:$('dependency-graph'),scroller:$('graph-scroll'),panel:$('graph-minimap'),map:$('minimap-map'),toggle:$('minimap-toggle'),isActive:()=>activeTab==='graph'&&!$('graph-body').hidden,onNavigate:()=>hideGraphCard(true),collapsed:preferences.minimapCollapsed===true,onCollapse:value=>{preferences.minimapCollapsed=value;persist();}});
function applyGraphZoom(){const svg=$('dependency-graph');svg.style.width=`${Math.round(graphModel.width*graphZoom)}px`;svg.style.height=`${Math.round(graphModel.height*graphZoom)}px`;$('graph-scroll').style.setProperty('--graph-height',`${Math.round(graphModel.height*graphZoom)}px`);sizeGraphBackdrop();$('graph-zoom-reset').textContent=`${Math.round(graphZoom*100)}%`;$('graph-zoom-out').disabled=graphZoom<=0.1;$('graph-zoom-in').disabled=graphZoom>=2;positionGraphCard();minimap.schedule();}
function setGraphZoom(value){graphZoom=Math.max(0.1,Math.min(2,value));applyGraphZoom();preferences.graphZoom=graphZoom;persist();}
function setGraphExpanded(expanded){$('graph-body').hidden=!expanded;$('graph-toggle').setAttribute('aria-expanded',String(expanded));$('graph-toggle').textContent=expanded?tr('收起'):tr('展开');preferences.graphExpanded=expanded;if(!expanded)hideGraphCard(true);minimap.schedule();persist();}
function renderGraph(tasks){
  try{
    graphModel=buildDependencyGraph(tasks);minimap.render(graphModel);renderDependencyGraph($('dependency-graph'),graphModel);$('graph-lanes').innerHTML=graphModel.lanes.map(lane=>`<div class="graph-lane-backdrop" style="--project-accent:${lane.accent};top:${lane.top/graphModel.height*100}%;height:${lane.height/graphModel.height*100}%"></div>`).join('');applyGraphZoom();
    $('status-legend').innerHTML=[['待确认','待确认',''],['进行中','进行中',''],['可开始','待办','ready'],['等待依赖','待办','waiting'],['受阻','受阻',''],['已完成','已完成',''],['已取消','已取消','']].map(([label,status,posture])=>`<button class="badge legend-item" data-status="${status}" data-posture="${posture}" data-legend-status="${posture||status}">${tr(label)}</button>`).join('');
    $('graph-count').textContent=ui`筛选结果 ${tasks.length} 项 · ${graphModel.lanes.length} 个项目 · ${graphModel.edges.length} 条可见依赖；图随页面完整向下展开，列表按页显示同一筛选结果。`;
    $('graph-body').hidden=preferences.graphExpanded===false;$('graph-toggle').setAttribute('aria-expanded',String(!$('graph-body').hidden));$('graph-toggle').textContent=$('graph-body').hidden?tr('展开'):tr('收起');
    if(graphCardKey){if(graphModel.byKey.has(graphCardKey)&&graphPinned)showGraphCard(graphCardKey,true);else hideGraphCard(true);}
  }catch(error){$('graph-count').textContent=ui`依赖图不可用：${error.message}`;$('dependency-graph').replaceChildren();$('graph-lanes').replaceChildren();minimap.render(buildDependencyGraph([]));hideGraphCard(true);}
}
function graphNode(key){return [...$('dependency-graph').querySelectorAll('[data-graph-key]')].find(node=>node.dataset.graphKey===key);}
function highlightTask(key){for(const node of $('dependency-graph').querySelectorAll('.graph-node'))node.classList.toggle('graph-focus',node.dataset.graphKey===key);for(const row of $('content').querySelectorAll('tr[data-task-key]'))row.classList.toggle('task-focus',row.dataset.taskKey===key);for(const edge of $('dependency-graph').querySelectorAll('.graph-edge'))edge.classList.toggle('graph-edge-focus',edge.dataset.source===key||edge.dataset.target===key);}
function positionGraphCard(){if($('graph-card').hidden||!graphCardKey)return;const node=graphNode(graphCardKey);if(!node)return;const rect=node.getBoundingClientRect(),card=$('graph-card'),width=card.offsetWidth,height=card.offsetHeight;const left=innerWidth-rect.right>=width+24?rect.right+12:rect.left-width-12;card.style.left=`${Math.max(12,Math.min(innerWidth-width-12,left))}px`;card.style.top=`${Math.max(12,Math.min(innerHeight-height-12,rect.top-20))}px`;}
function renderPreviewMarkdown(source){const container=$('graph-card-detail');container.replaceChildren();const lines=source.split(/\r?\n/),section=lines.findIndex(line=>/^##\s/.test(line));for(const line of (section>=0?lines.slice(section):lines)){const value=line.trim();if(!value)continue;const heading=value.match(/^(#{2,4})\s+(.+)$/),node=document.createElement(heading?'h4':'p');node.textContent=heading?heading[2]:/^[-*]\s/.test(value)?'• '+value.slice(2):value;container.append(node);}positionGraphCard();}
let graphPreviewTiming=null;
async function showGraphCard(key,pin=false){
  if(graphPinned&&!pin&&graphCardKey!==key)return;
  const task=graphModel.byKey.get(key);if(!task)return;clearTimeout(graphHideTimer);graphCardKey=key;graphPinned=pin;const request=++graphRequest;
  $('graph-card').style.setProperty('--project-accent',projectAccent(task.project_id));$('graph-card-title').textContent=`${task.project.name} · ${task.id}`;$('graph-card-open').dataset.task=key;
  $('graph-card-meta').innerHTML=ui`<h3>${esc(task.title)}</h3><div class="card-tags">${badge(task.status,task.posture)}${typeTag(task.task_type)}<span class="priority-label">${esc(task.priority)}</span></div><p>负责人：${esc(task.executor||tr('未登记'))}</p><p>前置任务：${esc((task.dependencyIds||[]).join('、')||tr('无'))}</p><p>更新时间：${esc(task.modified_at)}</p>${task.status==='待办'?`<p class="posture-label" data-posture="${task.posture}">${task.posture==='ready'?tr('任务依赖已完成；派发前仍须核对授权和真实阻碍。'):tr('等待前置任务完成。')}</p>`:''}`;
  graphPreviewTiming=null;$('graph-card-time').textContent=tr('正在读取活动时间轴…');
  $('graph-card-detail').textContent=tr('正在读取任务详情…');$('graph-card').hidden=false;highlightTask(key);positionGraphCard();
  const cacheKey=`${key}\n${task.detail_path}\n${task.modified_at}`;
  try{
    if(!graphDetailCache.has(cacheKey))graphDetailCache.set(cacheKey,fetch(`/projects/${task.project_id}/${task.detail_path.split('/').map(encodeURIComponent).join('/')}`,{cache:'no-store'}).then(async response=>{if(!response.ok)throw new Error(`HTTP ${response.status}`);return response.text();}));
    const markdown=await graphDetailCache.get(cacheKey);if(request===graphRequest&&graphCardKey===key){
      const parsed=globalThis.TaskLog.parse(markdown);graphPreviewTiming={task,parsed};
      globalThis.TaskLog.renderTiming($('graph-card-time'),task,parsed,Date.now(),{preview:true});
      renderPreviewMarkdown(parsed.description);
    }
  }catch(error){graphDetailCache.delete(cacheKey);if(request===graphRequest&&graphCardKey===key){$('graph-card-time').textContent=tr('活动时间轴不可用：详情读取失败');$('graph-card-detail').textContent=ui`详情读取失败：${error.message}`;positionGraphCard();}}
}
function hideGraphCard(force=false){if(graphPinned&&!force)return;clearTimeout(graphHideTimer);graphRequest++;graphCardKey=null;graphPinned=false;$('graph-card').hidden=true;highlightTask(null);}
function scheduleHideGraphCard(){clearTimeout(graphHideTimer);graphHideTimer=setTimeout(()=>hideGraphCard(),160);}
$('graph-zoom-out').onclick=()=>setGraphZoom([...zoomSteps].reverse().find(value=>value<graphZoom-0.001)||0.1);
$('graph-zoom-in').onclick=()=>setGraphZoom(zoomSteps.find(value=>value>graphZoom+0.001)||2);
$('graph-zoom-reset').onclick=()=>setGraphZoom(1);$('graph-fit').onclick=()=>setGraphZoom(($('graph-scroll').clientWidth-24)/graphModel.width);
$('graph-toggle').onclick=()=>setGraphExpanded($('graph-body').hidden);
$('status-legend').onclick=e=>{const button=e.target.closest('[data-legend-status]');if(!button)return;$('status').value=button.dataset.legendStatus;pageNumber=1;renderSummary();renderContent();persist();};
$('dependency-graph').addEventListener('pointerover',e=>{const node=e.target.closest('[data-graph-key]');if(node)void showGraphCard(node.dataset.graphKey);});
$('dependency-graph').addEventListener('pointerout',e=>{if(!e.relatedTarget?.closest?.('[data-graph-key]'))scheduleHideGraphCard();});
$('dependency-graph').addEventListener('focusin',e=>{const node=e.target.closest('[data-graph-key]');if(node)void showGraphCard(node.dataset.graphKey);});
$('dependency-graph').addEventListener('focusout',scheduleHideGraphCard);
function openGraphTask(key){const task=graphModel.byKey.get(key);if(task)openDetail(task.project_id,task);}
$('dependency-graph').addEventListener('click',e=>{const node=e.target.closest('[data-graph-key]');if(node)openGraphTask(node.dataset.graphKey);});
$('dependency-graph').addEventListener('keydown',e=>{const node=e.target.closest('[data-graph-key]');if(node&&['Enter',' '].includes(e.key)){e.preventDefault();openGraphTask(node.dataset.graphKey);}});
$('graph-card').addEventListener('pointerenter',()=>clearTimeout(graphHideTimer));$('graph-card').addEventListener('pointerleave',scheduleHideGraphCard);$('close-graph-card').onclick=()=>hideGraphCard(true);
$('content').addEventListener('pointerover',e=>{const row=e.target.closest('tr[data-task-key]');if(row&&!graphPinned)highlightTask(row.dataset.taskKey);});$('content').addEventListener('pointerleave',()=>{if(!graphPinned)highlightTask(null);});
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideGraphCard(true);});window.addEventListener('resize',positionGraphCard);window.addEventListener('scroll',positionGraphCard,true);

function switchView(view){activeTab=view;hideGraphCard(true);applyView();persist();}
$('view-tabs').addEventListener('click',e=>{const button=e.target.closest('[data-view]');if(button)switchView(button.dataset.view);});
$('view-tabs').addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const view=e.key==='Home'?'graph':e.key==='End'?'list':activeTab==='graph'?'list':'graph';switchView(view);$(view+'-tab').focus();});
$('content').addEventListener('click',e=>{const button=e.target.closest('[data-sort-column]');if(!button)return;const key=button.dataset.sortColumn;sortDirection=sortKey===key&&sortDirection==='asc'?'desc':'asc';sortKey=key;pageNumber=1;renderContent();persist();});
function changeColumnFilter(e){const control=e.target.closest('[data-column-filter]');if(!control)return;if(e.type==='input'&&control.tagName!=='INPUT')return;if(e.type==='change'&&control.tagName==='INPUT')return;const key=control.dataset.columnFilter;if(control.value)columnFilters[key]=control.value;else delete columnFilters[key];pageNumber=1;renderContent();persist();}
$('content').addEventListener('input',changeColumnFilter);$('content').addEventListener('change',changeColumnFilter);
$('column-filter-summary').addEventListener('click',e=>{const button=e.target.closest('button');if(!button)return;if(button.id==='clear-column-filters')columnFilters={};else if(button.dataset.clearColumn)delete columnFilters[button.dataset.clearColumn];pageNumber=1;renderContent();persist();});
$('column-options').addEventListener('change',e=>{const control=e.target.closest('[data-column-toggle]');if(!control)return;const key=control.dataset.columnToggle;if(control.checked)visibleColumns.add(key);else{if(visibleColumns.size===1){control.checked=true;showError(tr('至少保留一个显示字段'));return;}visibleColumns.delete(key);delete columnFilters[key];}renderContent();persist();});

function positionColumnPanel(panel){
  const button=$('content').querySelector(`[data-open-filter="${CSS.escape(panel.dataset.filterPanel)}"]`),rect=button.getBoundingClientRect();
  panel.style.left=Math.max(8,Math.min(rect.left,innerWidth-252))+'px';panel.style.top=Math.min(rect.bottom+8,innerHeight-160)+'px';
}
$('content').addEventListener('click',event=>{const button=event.target.closest('[data-open-filter]');if(button)positionColumnPanel(document.getElementById(button.getAttribute('popovertarget')));});

window.matchMedia('(max-width:650px)').addEventListener('change',()=>{hideGraphCard(true);renderContent();});

function sizeGraphBackdrop(){const scroll=$('graph-scroll');$('graph-lanes').style.width=Math.max(scroll.clientWidth-16,Math.round(graphModel.width*graphZoom))+'px';}
new ResizeObserver(sizeGraphBackdrop).observe($('graph-scroll'));

let browserFolder='',browserEntries=[],browseGeneration=0;
function renderFileEntries(){const keyword=$('browse-search').value.trim().toLocaleLowerCase(locale());const entries=browserEntries.filter(entry=>entry.name.toLocaleLowerCase(locale()).includes(keyword));$('file-entries').innerHTML=entries.map(entry=>`<button type="button" class="file-entry" data-file-kind="${entry.kind}" data-file-path="${esc(entry.path)}"><span class="file-kind">${entry.kind==='directory'?tr('文件夹'):'CSV'}</span><span>${esc(entry.name)}</span><span class="file-entry-action">${entry.kind==='directory'?tr('进入 ›'):tr('选择')}</span></button>`).join('')||tr('<div class="empty">没有匹配的文件夹或 CSV。</div>');}
async function browseFiles(folder){const generation=++browseGeneration;$('browse-folder').disabled=true;$('browse-form').querySelector('[type=submit]').disabled=true;$('file-entries').replaceChildren();$('browse-error').hidden=true;$('file-entries').setAttribute('aria-busy','true');$('browse-hint').textContent=tr('正在读取文件夹…');try{const data=await api('/api/browse',{folder:folder||undefined,showHidden:$('show-hidden-files').checked});if(generation!==browseGeneration)return;browserFolder=data.folder;browserEntries=data.entries;$('browse-folder').value=data.folder;$('browse-parent').dataset.folder=data.parent;$('browse-parent').disabled=data.folder===data.parent;$('file-shortcuts').innerHTML=data.shortcuts.map(shortcut=>`<button type="button" data-browse-folder="${esc(shortcut.path)}">${esc(tr(shortcut.label))}</button>`).join('');$('browse-search').value='';renderFileEntries();$('browse-hint').textContent=data.truncated?tr('仅显示前 1000 项，可输入更具体的文件夹路径。'):tr('只显示文件夹与 CSV 文件；选择文件后还需确认添加。');}catch(error){if(generation!==browseGeneration)return;$('browse-error').hidden=false;$('browse-error').textContent=message(error.message);browserEntries=[];$('file-entries').replaceChildren();$('browse-hint').textContent=tr('请检查文件夹路径及读取权限。');}finally{if(generation===browseGeneration){$('file-entries').setAttribute('aria-busy','false');$('browse-folder').disabled=false;$('browse-form').querySelector('[type=submit]').disabled=false;}}}
$('choose-csv').onclick=()=>{$('file-picker').showModal();void browseFiles(browserFolder);};
$('close-file-picker').onclick=()=>$('file-picker').close();
$('browse-form').onsubmit=event=>{event.preventDefault();void browseFiles($('browse-folder').value.trim());};
$('browse-parent').onclick=()=>void browseFiles($('browse-parent').dataset.folder);
$('browse-search').oninput=renderFileEntries;
$('show-hidden-files').onchange=()=>void browseFiles(browserFolder);
$('file-shortcuts').onclick=event=>{const button=event.target.closest('[data-browse-folder]');if(button)void browseFiles(button.dataset.browseFolder);};
$('file-entries').onclick=event=>{const button=event.target.closest('[data-file-path]');if(!button)return;if(button.dataset.fileKind==='directory'){void browseFiles(button.dataset.filePath);return;}$('csv-path').value=button.dataset.filePath;$('file-picker').close();$('source-preview').hidden=true;void inspectSource();};
function addInput(){const input=Object.fromEntries(new FormData($('add-form')));for(const key of Object.keys(input)){input[key]=input[key].trim();if(!input[key])delete input[key];}return input;}
async function inspectSource(){const button=$('inspect-source');button.disabled=true;$('add-error').hidden=true;$('source-preview').hidden=true;const input=addInput();try{const data=await api('/api/inspect',input);if(JSON.stringify(addInput())!==JSON.stringify(input))return;$('source-preview').innerHTML=ui`<strong>文件可连接 · ${data.taskCount} 个任务</strong><p>${esc(data.csvPath)}</p><span>项目根目录：${esc(data.root)}</span>`;$('source-preview').hidden=false;}catch(error){$('add-error').textContent=message(error.message);$('add-error').hidden=false;}finally{button.disabled=false;}}
$('inspect-source').onclick=()=>void inspectSource();
$('add-form').addEventListener('input',()=>{$('source-preview').hidden=true;});
$('browse-folder').addEventListener('input',()=>{browseGeneration++;$('file-entries').replaceChildren();$('file-entries').setAttribute('aria-busy','false');$('browse-hint').textContent=tr('按“前往”打开这个文件夹。');});

function updateGraphTimes(){
  if(document.hidden)return;
  if(graphPreviewTiming&&!$('graph-card').hidden&&!$('graph-card-time').querySelector('.activity-mark:hover')&&!document.activeElement?.closest('#graph-card-time .activity-mark'))globalThis.TaskLog.renderTiming($('graph-card-time'),graphPreviewTiming.task,graphPreviewTiming.parsed,Date.now(),{preview:true});
  for(const label of document.querySelectorAll('[data-time-key]')){
    const task=graphModel.byKey.get(label.dataset.timeKey),time=task?.timing;
    if(!time?.available)continue;
    const elapsed=time.live&&time.active?Math.max(0,Date.now()-time.asOf):0;
    label.firstChild.nodeValue=ui`执行 ${time.complete?'':tr('已记录 ')}${globalThis.TaskLog.formatDuration(time.executionMs+elapsed)}`;
  }
}
setInterval(updateGraphTimes,1000);
document.addEventListener('visibilitychange',updateGraphTimes);

// 分享授权由服务端强制校验；隐藏控件只用于明确访客可用的操作。
if(!owner){
  $('viewer-label').hidden=false;
  for(const id of ['settings-projects','settings-add','settings-pending','settings-sharing','settings-removed'])$(id).hidden=true;
}
$('logout').onclick=async()=>{try{await api('/auth/logout',{});location.replace(globalThis.PMI18n.href('/login'));}catch(error){showError(error);}};
async function renderSharing(){
  try{
    const data=await api('/api/shares');
    $('share-projects').innerHTML=state.projects.map(p=>`<label class="share-project"><input type="checkbox" name="share-project" value="${esc(p.id)}"> ${esc(p.name)}</label>`).join('')||tr('<p>请先添加项目。</p>');
    $('share-origin-hint').textContent=data.publicOrigin?tr('分享地址：')+data.publicOrigin:tr('分享链接使用当前访问地址：')+location.origin+tr('。公网请使用 HTTPS。');
    $('share-list').innerHTML=data.shares.map(s=>`<article class="setting-item"><div><strong>${esc(s.label)}</strong><p class="muted small">${esc(s.projectIds.map(id=>state.projects.find(p=>p.id===id)?.name||'已移除项目').join('、'))}</p><p>${s.revoked?tr('已撤销'):s.expiresAt<=Date.now()?tr('已过期'):tr('链接有效至 ')+esc(new Date(s.expiresAt).toLocaleString(locale()))}</p></div>${!s.revoked&&s.expiresAt>Date.now()?ui`<button type="button" data-revoke-share="${esc(s.id)}">撤销链接</button>`:''}</article>`).join('')||tr('<p class="muted small">尚未创建分享。</p>');
  }catch(error){showError(error);}
}
$('share-form').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('[type=submit]');button.disabled=true;$('share-result').hidden=true;
  try{const result=await api('/api/shares/create',{label:$('share-label').value,hours:Number($('share-hours').value),projectIds:[...document.querySelectorAll('[name=share-project]:checked')].map(n=>n.value)});$('share-url').value=result.url;$('share-result').hidden=false;$('copy-share-status').textContent='';await renderSharing();}catch(error){showError(error);}finally{button.disabled=false;}
};
$('share-list').onclick=async event=>{const button=event.target.closest('[data-revoke-share]');if(!button)return;button.disabled=true;try{await api('/api/shares/revoke',{id:button.dataset.revokeShare});await renderSharing();}catch(error){showError(error);button.disabled=false;}};
$('copy-share').onclick=async()=>{try{await navigator.clipboard.writeText($('share-url').value);$('copy-share-status').textContent=tr('已复制');}catch{$('share-url').focus();$('share-url').select();$('copy-share-status').textContent=tr('请复制选中的链接');}};
