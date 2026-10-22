import {t as tr,ui,locale,message,enumLabel} from './i18n.mjs';
// 字段排序和筛选只组织阅读视图，不修改 CSV。
export const defaultColumns=['id','title','source_project','status','priority','task_type','boundary','dependencies','executor','created_at','modified_at'];
const labels={id:'任务编号',title:'任务标题',source_project:'来源项目',source_group:'项目分组',status:'状态',priority:'优先级',task_type:'类型',task_posture:'任务态势',boundary:'所属边界',dependencies:'前置任务',executor:'执行者',created_at:'创建时间',modified_at:'更新时间',detail_path:'详情路径',dispatch_id:'派发标识',execution_thread_id:'执行会话',execution_turn_id:'执行轮次',manager_thread_id:'经理会话',manager_turn_id:'经理轮次',recovery_turn_id:'恢复轮次',recovery_state:'恢复状态',recovery_state_at:'恢复状态时间'};
const categories=new Set(['source_project','source_group','status','priority','task_type','task_posture','boundary','executor','recovery_state']);
const dates=new Set(['created_at','modified_at','recovery_state_at']);
const ignored=new Set(['key','project','project_id','dependencyIds','posture']);
const collator=new Intl.Collator(locale(),{numeric:true,sensitivity:'base'});
const postureLabels={ready:'可开始',waiting:'等待依赖',confirm:'待确认',active:'进行中',blocked:'受阻',completed:'已完成',cancelled:'已取消',unknown:'未知'};
export function tableColumns(tasks){const keys=new Set(defaultColumns);keys.add('task_posture');keys.add('source_group');for(const t of tasks)for(const key of Object.keys(t))if(!ignored.has(key))keys.add(key);return [...keys].map(key=>({key,label:tr(labels[key]||key),kind:categories.has(key)?'category':dates.has(key)?'date':'text'}));}
export function columnValue(task,key){if(key==='source_project')return task.project.name;if(key==='source_group')return task.project.group;if(key==='task_posture')return postureLabels[task.posture]||'未知';if(key==='task_type')return task.task_type||'未分类';return String(task[key]??'');}
export function matchesColumnFilters(task,filters){
  for(const [key,filter] of Object.entries(filters)){if(!filter)continue;const value=key==='source_project'?task.project_id:columnValue(task,key);if(categories.has(key)){if(value!==filter)return false;}else{const candidates=[value];if(dates.has(key)){const date=new Date(value);if(!Number.isNaN(date.getTime()))candidates.push(date.toLocaleString(locale(),{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}),value.replace('T',' '));}if(!candidates.some(candidate=>candidate.toLocaleLowerCase(locale()).includes(filter.trim().toLocaleLowerCase(locale()))))return false;}}
  return true;
}
export function sortTableTasks(tasks,key='priority',direction='asc'){
  const factor=direction==='desc'?-1:1;
  return [...tasks].sort((a,b)=>{
    const left=columnValue(a,key),right=columnValue(b,key);let primary;
    if(dates.has(key)){const l=Date.parse(left),r=Date.parse(right);if(Number.isFinite(l)&&Number.isFinite(r))primary=l-r;else if(Number.isFinite(l))return -1;else if(Number.isFinite(r))return 1;else primary=collator.compare(left,right);}
    else primary=collator.compare(left,right);
    return primary*factor || collator.compare(a.project.name,b.project.name) || collator.compare(a.id,b.id) || collator.compare(a.key,b.key);
  });
}
