#!/usr/bin/env node
import path from 'node:path';
import { readPassword, passwordPath, authorizationFor } from './workbench-auth.mjs';
import { mkdir, open, readFile, unlink, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
import { defaultStateDir } from './workbench-registry.mjs';
const args=process.argv.slice(2),get=(k,f)=>args.includes(k)?args[args.indexOf(k)+1]:f;
const directory=path.resolve(get('--state-dir',defaultStateDir()));
const command=args.includes('--stop')?'stop':args.includes('--status')?'status':'ensure';
const port=Number(get('--port','9999'));
const host=get('--host',process.env.WORKBENCH_HOST || '127.0.0.1');
const skillRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const recordFile=path.join(directory,'service.json'),lockFile=path.join(directory,'service-start.lock');
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try {process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
async function probe(url) {
  let authorization;
  try {authorization=authorizationFor(await readPassword(passwordPath(directory)));}
  catch(error) {if(error.code!=='ENOENT')throw error;}
  const response=await fetch(new URL('/health',url),{signal:AbortSignal.timeout(700),headers:authorization?{Authorization:authorization}:{}});
  if(!response.ok) throw new Error('工作台健康检查失败');
  const health=await response.json();
  if(health.kind!=='project-manager-workbench' || health.stateDir!==directory || health.skillRoot!==skillRoot || !alive(health.pid)) throw new Error('该服务不属于当前工作台或技能包');
  if(health.authentication!=='cookie')throw new Error('当前实例尚未启用密码认证，需要明确停止旧实例后启动新版');
  if(health.publicOrigin!==(process.env.WORKBENCH_PUBLIC_ORIGIN || ''))throw new Error('当前实例的外网来源配置不同，需要明确重新启动');
  return health;
}
async function current() {
  let record;
  try {record=JSON.parse(await readFile(recordFile,'utf8'));} catch(error) {if(error.code!=='ENOENT') throw error;}
  if(record && alive(record.pid)) {
    try {
      const health=await probe(record.url);
      if(health.pid!==record.pid) throw new Error('工作台服务身份不匹配');
      return health;
    } catch(error) {
      // PID 可能被系统复用；只在明确无监听者时丢弃记录，绝不杀该 PID。
      if(error.cause?.code!=='ECONNREFUSED') throw error;
    }
  }
  if(port) {
    try {return await probe(`http://127.0.0.1:${port}/`);}
    catch(error) {if(!error.cause || !['ECONNREFUSED'].includes(error.cause.code)) throw error;}
  }
  return null;
}
async function save(value) {
  const tmp=recordFile+'.'+process.pid+'.tmp',handle=await open(tmp,'w',0o600);
  try {await handle.writeFile(JSON.stringify(value)+'\n');}finally{await handle.close();}
  await rename(tmp,recordFile);
}
async function withLock(action) {
  await mkdir(directory,{recursive:true,mode:0o700});
  const handle=await acquireProcessLock(lockFile,{timeoutMs:6000});
  try {return await action();}finally{await handle.release();}
}
try {
  if(command==='status'){const service=await current();console.log(JSON.stringify(service?{state:'RUNNING',...service}:{state:'STOPPED',stateDir:directory}));process.exit(0);}
  const result=await withLock(async()=>{
    const service=await current();
    if(command==='status') return service?{state:'RUNNING',...service}:{state:'STOPPED',stateDir:directory};
    if(command==='stop') {
      if(!service)return {state:'STOPPED',stateDir:directory};
      process.kill(service.pid,'SIGTERM');
      const deadline=Date.now()+3000;
      while(alive(service.pid)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
      // 部分平台已结束的子进程仍暂时有 PID，HTTP 停止才是服务停止依据。
      try {await probe(service.url);return {state:'STOPPING',...service};}catch{}
      await unlink(recordFile).catch(()=>{});return {state:'STOPPED',stateDir:directory};
    }
    if(service){if(service.listenHost!==host)throw new Error('当前实例监听地址不同，需要明确停止旧实例后重新启动');await save(service);return {state:'REUSED',...service};}
    if(!['127.0.0.1','0.0.0.0'].includes(host))throw new Error('工作台监听地址只支持 127.0.0.1 或 0.0.0.0');
    if(!Number.isInteger(port)||port<0||port>65535)throw new Error('工作台端口无效');
    const log=await open(path.join(directory,'service.log'),'a',0o600);
    const child=spawn(process.execPath,[path.join(skillRoot,'scripts/workbench-server.mjs'),'--state-dir',directory,'--port',String(port),'--host',host],{detached:true,stdio:['ignore',log.fd,log.fd],cwd:skillRoot});
    child.unref();await log.close();
    if(!child.pid)throw new Error('工作台进程创建失败');
    // 启动输出包含实际端口；0 端口仅用于隔离测试。
    const deadline=Date.now()+4000;
    while(Date.now()<deadline) {
      if(!alive(child.pid))throw new Error('工作台启动失败，见 '+path.join(directory,'service.log'));
      try {
        let target=`http://127.0.0.1:${port}/`;
        if(!port){const lines=(await readFile(path.join(directory,'service.log'),'utf8')).trim().split('\n');const line=lines.reverse().find(x=>{try{return JSON.parse(x).pid===child.pid;}catch{return false;}});if(!line)throw new Error('等待地址');target=JSON.parse(line).url;}
        const health=await probe(target);
        if(health.pid!==child.pid)throw new Error('工作台启动进程不匹配');
        await save(health);return {state:'STARTED',...health};
      }catch{}
      await new Promise(r=>setTimeout(r,50));
    }
    process.kill(child.pid,'SIGTERM');throw new Error('工作台未在启动预算内通过健康检查，已停止本次创建的进程');
  });
  console.log(JSON.stringify(result));
} catch(error) {console.error(error.message);process.exitCode=1;}
