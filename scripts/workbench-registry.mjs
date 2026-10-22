import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { acquireProcessLock } from './process-lock.mjs';
import { inspectProject } from './workbench-data.mjs';

export {stateDir as defaultStateDir} from '../lib/paths.mjs';
import {stateDir as defaultStateDir} from '../lib/paths.mjs';
const empty=()=>({version:1,revision:0,projects:[],pending:[],removed:[]});
export class Registry {
  constructor(directory=defaultStateDir()) { this.directory=path.resolve(directory); this.file=path.join(this.directory,'registry.json'); }
  async read() {
    try {
      const value=JSON.parse(await readFile(this.file,'utf8'));
      if(value.version!==1 || !Number.isInteger(value.revision) || !['projects','pending','removed'].every(k=>Array.isArray(value[k]))) throw new Error('工作台登记文件格式错误');
      return value;
    } catch(error) { if(error.code==='ENOENT') return empty(); throw error; }
  }
  async mutate(action,{skipUnchanged=false}={}) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const handle=await acquireProcessLock(path.join(this.directory,'registry.lock'));
    let temporary;
    try {
      const state=await this.read(), before=skipUnchanged?JSON.stringify(state):null, result=await action(state);
      if(skipUnchanged && JSON.stringify(state)===before) return result;
      state.revision++; temporary=`${this.file}.${randomUUID()}.tmp`;
      const output=await open(temporary,'wx',0o600);
      try { await output.writeFile(JSON.stringify(state,null,2)+'\n'); await output.sync(); } finally { await output.close(); }
      await rename(temporary,this.file); temporary=null;
      return result;
    } finally { if(temporary) await unlink(temporary).catch(()=>{}); await handle.release(); }
  }
  async request(input) {
    const inspected=await inspectProject(input);
    const project={id:randomUUID(),name:inspected.name,group:inspected.group,root:inspected.root,csvPath:inspected.csvPath,csvRelative:inspected.csvRelative};
    return this.mutate(state=>{
      const active=state.projects.find(x=>x.csvPath===project.csvPath);
      if(active) return {state:'registered',project:active};
      const pending=state.pending.find(x=>x.csvPath===project.csvPath);
      const removed=state.removed.find(x=>x.csvPath===project.csvPath);
      // Both normal and legacy --auto requests respect the persistent blacklist.
      // Only an explicit add/restore/unblock action may clear it.
      if(removed) return {state:'removed',project:removed};
      if(pending) project.id=pending.id;
      project.registeredAt=new Date().toISOString();
      state.projects.push(project);
      state.pending=state.pending.filter(x=>x.csvPath!==project.csvPath);
      return {state:'registered',project};
    },{skipUnchanged:true});
  }
  async activatePending() {
    // Upgrade existing requests under the same lock as removal. Invalid sources
    // stay visible for retry; a blacklist entry always wins over an old request.
    return this.mutate(async state=>{
      const remaining=[];
      for(const pending of state.pending) {
        if(state.removed.some(x=>x.csvPath===pending.csvPath) || state.projects.some(x=>x.csvPath===pending.csvPath))continue;
        try {
          const inspected=await inspectProject(pending);
          const {registrationError,...project}=pending;
          state.projects.push({...project,name:inspected.name,group:inspected.group,root:inspected.root,csvPath:inspected.csvPath,csvRelative:inspected.csvRelative,registeredAt:new Date().toISOString()});
        } catch(error) {remaining.push({...pending,registrationError:error.message});}
      }
      state.pending=remaining;
    },{skipUnchanged:true});
  }
  async add(input) {
    const inspected=await inspectProject(input);
    return this.mutate(state=>{
      const active=state.projects.find(x=>x.csvPath===inspected.csvPath);
      if(active) return active;
      const old=state.pending.find(x=>x.csvPath===inspected.csvPath) || state.removed.find(x=>x.csvPath===inspected.csvPath);
      const project={id:old?.id || randomUUID(),name:inspected.name,group:inspected.group,root:inspected.root,csvPath:inspected.csvPath,csvRelative:inspected.csvRelative,registeredAt:new Date().toISOString()};
      state.projects.push(project);
      state.pending=state.pending.filter(x=>x.csvPath!==project.csvPath);
      state.removed=state.removed.filter(x=>x.csvPath!==project.csvPath);
      return project;
    });
  }
  async confirm(id) {
    // 在同一事务中重新校验，确认不能复活已经撤回的申请。
    return this.mutate(async state=>{
      const pending=state.pending.find(x=>x.id===id);
      if(!pending) throw new Error('注册申请不存在或已处理');
      if(state.removed.some(x=>x.csvPath===pending.csvPath))throw new Error('项目在黑名单中，请先恢复连接');
      await inspectProject(pending);
      const {registrationError,...source}=pending;
      const project={...source,registeredAt:new Date().toISOString()};
      state.projects.push(project); state.pending=state.pending.filter(x=>x.id!==id); state.removed=state.removed.filter(x=>x.csvPath!==project.csvPath);
      return project;
    });
  }
  async remove(id) {
    return this.mutate(state=>{
      const project=state.projects.find(x=>x.id===id);
      if(!project) throw new Error('项目不存在或已移除');
      state.projects=state.projects.filter(x=>x.id!==id);
      state.removed=state.removed.filter(x=>x.id!==id);
      const removed={...project,removedAt:new Date().toISOString()}; state.removed.unshift(removed);
      return removed;
    });
  }
  async reject(id) {
    return this.mutate(state=>{
      const project=state.pending.find(x=>x.id===id);
      if(!project) throw new Error('注册申请不存在或已处理');
      state.pending=state.pending.filter(x=>x.id!==id);
      state.removed=state.removed.filter(x=>x.id!==id);
      state.removed.unshift({...project,removedAt:new Date().toISOString()});
      return project;
    });
  }
  async deleteRemoved(id) {
    return this.mutate(state=>{
      if(!state.removed.some(project=>project.id===id))throw new Error('最近移除的记录不存在或已删除');
      state.removed=state.removed.filter(project=>project.id!==id);
      return {id};
    });
  }
  async restore(id) {
    return this.mutate(async state=>{
      const removed=state.removed.find(x=>x.id===id);
      if(!removed) throw new Error('最近移除的项目不存在');
      await inspectProject(removed);
      const {removedAt,...project}=removed;
      project.registeredAt=new Date().toISOString();
      state.projects.push(project); state.removed=state.removed.filter(x=>x.id!==id); state.pending=state.pending.filter(x=>x.id!==id);
      return project;
    });
  }
}
