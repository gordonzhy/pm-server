import {t as tr,ui,locale,message,enumLabel} from './i18n.mjs';
import './task-log.js';
// 图与表格共享筛选集合；所有依赖在项目身份内解析。
export function taskPosture(task,projectTasks) {
  const byId=projectTasks instanceof Map?projectTasks:new Map(projectTasks.map(t=>[t.id,t]));
  const dependencies=task.dependencyIds || [];
  return task.status==='待办'?(dependencies.every(id=>byId.get(id)?.status==='已完成')?'ready':'waiting'):
    ({'待确认':'confirm','进行中':'active','受阻':'blocked','已完成':'completed','已取消':'cancelled'}[task.status] || 'unknown');
}
export function buildDependencyGraph(tasks) {
  const byKey=new Map(tasks.map(t=>[t.key,t]));
  if(byKey.size!==tasks.length)throw new Error(tr('依赖图任务身份重复'));
  const edges=[],incoming=new Map(),layers=new Map(),visiting=new Set();
  for(const task of tasks){
    const sources=(task.dependencyIds || []).map(id=>`${task.project_id}:${id}`);
    incoming.set(task.key,sources.filter(key=>byKey.has(key)));
    for(const source of incoming.get(task.key))edges.push({source,target:task.key,projectId:task.project_id});
  }
  function depth(key){if(layers.has(key))return layers.get(key);if(visiting.has(key))throw new Error(tr('依赖图存在环'));visiting.add(key);const value=Math.max(0,...incoming.get(key).map(source=>depth(source)+1));visiting.delete(key);layers.set(key,value);return value;}
  for(const task of tasks)depth(task.key);
  const projectGroups=new Map();
  for(const task of tasks){if(!projectGroups.has(task.project_id))projectGroups.set(task.project_id,[]);projectGroups.get(task.project_id).push(task);}
  const nodes=[],lanes=[];let top=12;
  const nodeWidth=246,nodeHeight=104,columnGap=44,rowGap=14;
  const projects=[...projectGroups].sort(([,a],[,b])=>a[0].project.name.localeCompare(b[0].project.name,locale(),{numeric:true}));
  for(const [projectId,rows] of projects){
    const columns=new Map();for(const task of rows){const layer=layers.get(task.key);if(!columns.has(layer))columns.set(layer,[]);columns.get(layer).push(task);}
    const height=Math.max(...[...columns.values()].map(column=>column.length))*(nodeHeight+rowGap)+50;
    lanes.push({projectId,name:rows[0].project.name,top,height,count:rows.length,accent:rows[0].project.accent||'#A99AF7'});
    for(const [layer,column] of columns){column.sort((a,b)=>a.id.localeCompare(b.id,locale(),{numeric:true}));column.forEach((task,row)=>nodes.push({task,key:task.key,x:26+layer*(nodeWidth+columnGap),y:top+44+row*(nodeHeight+rowGap),width:nodeWidth,height:nodeHeight,layer,hiddenDependencies:(task.dependencyIds||[]).filter(id=>!byKey.has(`${projectId}:${id}`))}));}
    top+=height+20;
  }
  const width=Math.max(960,...nodes.map(node=>node.x+node.width+26));
  return {nodes,edges,lanes,width,height:Math.max(150,top),byKey};
}
const NS='http://www.w3.org/2000/svg';
const make=(tag,attributes={},text)=>{const node=document.createElementNS(NS,tag);for(const [key,value] of Object.entries(attributes))node.setAttribute(key,value);if(text!==undefined)node.textContent=text;return node;};
const short=(text,length)=>[...String(text)].length>length?[...String(text)].slice(0,length-1).join('')+'…':String(text);
export function renderDependencyGraph(svg,model){
  svg.replaceChildren();svg.setAttribute('viewBox',`0 0 ${model.width} ${model.height}`);
  const defs=make('defs'),marker=make('marker',{id:'workbench-dependency-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:6,markerHeight:6,orient:'auto'});marker.append(make('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'context-stroke'}));defs.append(marker);svg.append(defs);
  if(!model.nodes.length){svg.append(make('text',{x:30,y:65,class:'graph-empty'},tr('当前筛选没有可显示的任务')));return;}
  for(const lane of model.lanes){const group=make('g',{class:'graph-lane','data-project-id':lane.projectId,style:`--project-accent:${lane.accent}`});group.append(make('circle',{class:'graph-project-dot',cx:30,cy:lane.top+23,r:4}),make('line',{x1:26,y1:lane.top+lane.height,x2:model.width-26,y2:lane.top+lane.height}),make('text',{x:42,y:lane.top+28,class:'graph-project-title'},ui`${lane.name} · ${lane.count} 项`));svg.append(group);}
  const positions=new Map(model.nodes.map(node=>[node.key,node]));
  for(const edge of model.edges){const start=positions.get(edge.source),end=positions.get(edge.target),sx=start.x+start.width,sy=start.y+start.height/2,ex=end.x,ey=end.y+end.height/2;svg.append(make('path',{class:'graph-edge','data-source':edge.source,'data-target':edge.target,'data-project-id':edge.projectId,d:`M ${sx} ${sy} C ${sx+28} ${sy}, ${ex-28} ${ey}, ${ex} ${ey}`,'marker-end':'url(#workbench-dependency-arrow)'}));}
  for(const item of model.nodes){
    const t=item.task,posture=t.posture || t.status,pillWidth=locale()==='en'?90:46;
    const node=make('g',{class:'graph-node','data-graph-key':t.key,'data-status':t.status,'data-posture':posture,'data-attention':t.status==='受阻'?'blocked':t.status==='待确认'?'confirm':t.priority==='P0'?'priority':'normal',tabindex:0,role:'button','aria-label':`${t.project.name} · ${t.id} · ${t.title} · ${tr(t.status)}`});
    node.append(make('title',{},`${t.project.name} · ${t.id}\n${t.title}\n${tr(t.status)}${item.hiddenDependencies.length?tr(' · 筛选外依赖：')+item.hiddenDependencies.join('、'):''}`),make('rect',{class:'graph-node-surface',x:item.x,y:item.y,width:item.width,height:item.height,rx:8}),make('rect',{class:'graph-status-pill',x:item.x+item.width-10-pillWidth,y:item.y+8,width:pillWidth,height:18,rx:4}),make('line',{class:'graph-state-strip',x1:item.x+1,y1:item.y+10,x2:item.x+1,y2:item.y+item.height-10}),make('text',{x:item.x+12,y:item.y+21,class:'graph-id'},short(t.id,21)),make('text',{x:item.x+item.width-10-pillWidth/2,y:item.y+17,class:'graph-status','text-anchor':'middle','dominant-baseline':'central'},tr(t.status)),make('text',{x:item.x+12,y:item.y+47,class:'graph-task-title'},short(t.title,18)),make('text',{x:item.x+12,y:item.y+68,class:'graph-task-type','data-type':t.task_type||'未分类'},tr(t.task_type||'未分类')),make('text',{x:item.x+item.width-12,y:item.y+68,class:'graph-posture','text-anchor':'end'},item.hiddenDependencies.length?ui`${item.hiddenDependencies.length} 项筛选外依赖`:posture==='ready'?tr('可开始'):posture==='waiting'?tr('等待依赖'):t.priority));
    const time=t.timing;
    const value=time?.available?`${time.complete?'':tr('已记录 ')}${globalThis.TaskLog.formatDuration(time.executionMs+(time.live&&time.active?Math.max(0,Date.now()-time.asOf):0))}`:tr('暂无可靠记录');
    const label=make('text',{x:item.x+12,y:item.y+91,class:'graph-task-time','data-time-key':t.key},tr('执行 ')+value);
    label.append(make('title',{},time?.available?tr('累计进行中状态时长；点击查看时间分布'):(time?.issues||['缺少时间记录']).map(tr).join('; ')));node.append(label);
    svg.append(node);
  }
}
