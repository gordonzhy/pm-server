import {createHmac} from 'node:crypto';
import {statuses} from '../scripts/workbench-data.mjs';

// Share IDs are private salts: aliases remain stable for one share, not across shares.
export function sharedProjectId(principal,id){
 const hex=createHmac('sha256',principal.shareId).update('project:'+id).digest('hex').slice(0,32);
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function shareView(data,principal,index=0){
 const id=sharedProjectId(principal,data.id);
 const taskId=value=>'TASK-'+createHmac('sha256',principal.shareId).update(data.id+':task:'+value).digest('hex').slice(0,16);
 const tasks=(data.available?data.tasks:[]).map(task=>{
  const alias=taskId(task.id),dependencyIds=(task.dependencyIds||[]).map(taskId);
  return {id:alias,project_id:id,key:`${id}:${alias}`,title:'Shared task',status:statuses.includes(task.status)?task.status:'待办',priority:/^P[0-3]$/.test(task.priority)?task.priority:'P2',boundary:'Shared progress',executor:'',created_at:'',modified_at:'',dependencies:'['+dependencyIds.join(',')+']',dependencyIds,detail_path:`shared-tasks/${alias}.md`};
 });
 return {id,name:`Shared project ${index+1}`,group:'Shared projects',available:!!data.available,tasks,counts:Object.fromEntries(statuses.map(s=>[s,tasks.filter(t=>t.status===s).length])),...(!data.available?{error:'项目暂时不可读取'}:{})};
}
export function shareCsv(view){
 const fields=['id','status','priority','boundary','title','dependencies','executor','created_at','modified_at','detail_path'];
 return [fields,...view.tasks.map(task=>fields.map(key=>task[key]))].map(row=>row.map(value=>'"'+String(value).replaceAll('"','""')+'"').join(',')).join('\n')+'\n';
}
export function shareDetail(task){return `# Shared task\n\nStatus: ${task.status}\n\nPriority: ${task.priority}\n\nOnly de-identified progress is shared. Original task content, logs and files are private.\n`;}
