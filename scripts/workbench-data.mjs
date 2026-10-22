import path from 'node:path';
import {loadProjectConfig} from './project-config-v2.mjs';
import {parse as parseLog,timing} from './task-log.mjs';
import { realpath, stat } from 'node:fs/promises';
import { readRepositoryFile } from './testing-dashboard.mjs';

export const statuses = ['待办', '进行中', '待确认', '受阻', '已完成', '已取消'];
const required = ['id','status','priority','boundary','title','dependencies','executor','created_at','modified_at','detail_path'];
export function parseCsv(source) {
  const rows=[]; let row=[], field='', quoted=false, closed=false;
  source=source.replace(/^\uFEFF/,'');
  for(let i=0;i<source.length;i++) {
    const c=source[i];
    if(quoted) {
      if(c==='"' && source[i+1]==='"') { field+='"'; i++; }
      else if(c==='"') { quoted=false; closed=true; }
      else field+=c;
    } else if(c===',' || c==='\n' || (c==='\r' && source[i+1]==='\n')) {
      row.push(field); field=''; closed=false;
      if(c!==',') { if(c==='\r') i++; if(row.some(Boolean)) rows.push(row); row=[]; }
    } else if(c==='"') {
      if(field || closed) throw new Error('CSV 引号格式错误');
      quoted=true;
    } else { if(closed) throw new Error('CSV 引号后有多余字符'); field+=c; }
  }
  if(quoted) throw new Error('CSV 引号未闭合');
  if(field || row.length || closed) { row.push(field); if(row.some(Boolean)) rows.push(row); }
  return rows;
}
export function taskRows(source) {
  const rows=parseCsv(source), headers=rows.shift() || [];
  if(new Set(headers).size!==headers.length || required.some(x=>!headers.includes(x))) throw new Error('CSV 缺少必需字段或字段重复');
  const ids=new Set();
  const tasks=rows.map(row=>{
    if(row.length!==headers.length) throw new Error('CSV 行列数不一致');
    const task=Object.fromEntries(headers.map((h,i)=>[h,row[i]]));
    if(!task.id || ids.has(task.id)) throw new Error(`任务 ID 缺失或重复：${task.id}`);
    ids.add(task.id);
    if(!statuses.includes(task.status)) throw new Error(`任务状态无效：${task.id}`);
    if(!/^\[.*\]$/.test(task.dependencies)) throw new Error(`任务依赖格式错误：${task.id}`);
    task.dependencyIds=task.dependencies.slice(1,-1).split(',').map(x=>x.trim()).filter(Boolean);
    if(new Set(task.dependencyIds).size!==task.dependencyIds.length) throw new Error(`任务依赖重复：${task.id}`);
    if(!task.detail_path || path.isAbsolute(task.detail_path) || task.detail_path.includes('\\') || task.detail_path.split('/').some(x=>!x || x==='.' || x==='..')) throw new Error(`详情路径不安全：${task.id}`);
    return task;
  });
  const byId=new Map(tasks.map(t=>[t.id,t])), visiting=new Set(), visited=new Set();
  function visit(id) {
    if(visiting.has(id)) throw new Error(`任务依赖有环：${id}`);
    if(visited.has(id)) return;
    visiting.add(id);
    for(const dependency of byId.get(id).dependencyIds) {
      if(!byId.has(dependency)) throw new Error(`任务依赖不存在：${dependency}`);
      visit(dependency);
    }
    visiting.delete(id); visited.add(id);
  }
  for(const id of ids) visit(id);
  return tasks;
}
export async function inspectProject(input, checkDetails=true) {
  if(!input || typeof input.csvPath!=='string' || !path.isAbsolute(input.csvPath)) throw new Error('请提供 CSV 的绝对路径');
  const root=await realpath(input.root || path.dirname(input.csvPath));
  if(!(await stat(root)).isDirectory()) throw new Error('仓库根目录不是目录');
  const csvPath=await realpath(input.csvPath);
  const relative=path.relative(root,csvPath).split(path.sep).join('/');
  const source=await readRepositoryFile(root,relative,'utf8');
  const tasks=taskRows(source);
  if(checkDetails) for(const task of tasks) await readRepositoryFile(root,task.detail_path,'utf8');
  const name=String(input.name || path.basename(root)).trim();
  const group=String(input.group || '未分组').trim();
  if(!name || name.length>100 || !group || group.length>100) throw new Error('项目名称和分组应为 1–100 个字符');
  const config=await loadProjectConfig(root);
  if(!config.ok)throw new Error(config.errors.join('; '));
  return {root,csvPath,csvRelative:relative,name,group,tasks,source,manager:config.config.manager||null};
}
export async function projectSnapshot(project) {
  const loadedAt=new Date().toISOString();
  try {
    const source=await readRepositoryFile(project.root,project.csvRelative,'utf8');
    const tasks=await Promise.all(taskRows(source).map(async task=>{
      let time;
      try {time=timing(task,parseLog(await readRepositoryFile(project.root,task.detail_path,'utf8')),Date.parse(loadedAt));}
      catch {time={available:false,executionMs:null,issues:['任务日志读取失败']};}
      const {segments,...summary}=time;summary.active=segments?.at(-1)?.state==='进行中';
      return {...task,timing:summary,project_id:project.id,key:`${project.id}:${task.id}`};
    }));
    const config=await loadProjectConfig(project.root);
    if(!config.ok)throw new Error(config.errors.join('; '));
    return {...project,manager:config.config.manager||null,available:true,loadedAt,tasks,counts:Object.fromEntries(statuses.map(s=>[s,tasks.filter(t=>t.status===s).length]))};
  } catch(error) { return {...project,available:false,loadedAt,error:error.message,tasks:[],counts:null}; }
}
