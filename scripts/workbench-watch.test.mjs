import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {watch} from 'node:fs';
import {mkdtemp,mkdir,writeFile,rename,rm,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Registry} from './workbench-registry.mjs';
import {startWorkbench, fetch} from './workbench-test-client.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){for(let i=0;i<100;i++){if(await check())return;await sleep(25);}throw new Error('condition not reached');}
const csv=status=>'id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path\nT-001,'+status+',P1,test,title,[],AI,2026-10-15T00:00:00Z,2026-10-15T00:00:00Z,tasks/T.md\n';
async function fixture(t,options={}){
  const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'pm-watch-test-'))),repo=path.join(root,'repo'),stateDir=path.join(root,'state'),runtimePath=path.join(root,'runtime','cache.csv');
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(repo,'tasks'),{recursive:true});await writeFile(path.join(repo,'tasks/T.md'),'# T');await writeFile(path.join(repo,'TASKS.csv'),csv('待办'));
  await new Registry(stateDir).add({root:repo,csvPath:path.join(repo,'TASKS.csv'),name:'探针项目'});
  const instance=await startWorkbench({stateDir,runtimePath,port:0,reconcileIntervalMs:150,...options});
  t.after(()=>instance.close());
  return {root,repo,runtimePath,instance,state:async()=>await(await fetch(instance.url+'api/state')).json()};
}
test('missing runtime and detail directories are visible, then recovered without project edits',async t=>{
  const calls=new Map();
  const fx=await fixture(t,{watchDirectory:(directory,callback)=>{calls.set(directory,(calls.get(directory)||0)+1);return watch(directory,callback);}});
  assert.ok((await fx.state()).watchWarnings.some(x=>x.includes('会话运行缓存')));
  const details=path.join(fx.repo,'tasks');await rename(details,details+'-old');
  await until(async()=>(await fx.state()).watchWarnings.some(x=>x.includes('任务详情')));
  await mkdir(path.dirname(fx.runtimePath));await writeFile(fx.runtimePath,'session_id,status\n');
  await mkdir(details);await writeFile(path.join(details,'T.md'),'# restored');
  await until(async()=>(await fx.state()).watchWarnings.length===0);
  assert.ok(calls.get(path.dirname(fx.runtimePath))>=1);
  assert.ok(calls.get(details)>=2);
});
test('directory inode replacement rebuilds watchers and watcher errors recover',async t=>{
  const created=[];let failingDirectory=null;
  const fx=await fixture(t,{watchDirectory:(directory,callback)=>{if(directory===failingDirectory)throw new Error('injected watcher failure');const watcher=watch(directory,callback);created.push({directory,watcher});return watcher;}});
  const details=path.join(fx.repo,'tasks');
  await rename(details,details+'-old');await mkdir(details);await writeFile(path.join(details,'T.md'),'# replaced');
  await until(()=>created.filter(x=>x.directory===details).length>=2);
  const latest=created.filter(x=>x.directory===details).at(-1);
  failingDirectory=details;latest.watcher.emit('error',new Error('injected watcher failure'));
  await until(async()=>(await fx.state()).watchWarnings.some(x=>x.includes('injected watcher failure')));
  failingDirectory=null;
  await until(()=>created.filter(x=>x.directory===details).length>=3);
  await until(async()=>(await fx.state()).watchWarnings.every(x=>!x.includes('injected watcher failure')));
  created.filter(x=>x.directory===details).at(-1).watcher.close();
  await until(()=>created.filter(x=>x.directory===details).length>=4);
});
test('periodic reconciliation compensates for dropped events and close releases timers/watchers',async t=>{
  const watchers=[];
  const fx=await fixture(t,{watchDirectory:()=>{const watcher=new EventEmitter();watcher.closed=false;watcher.close=()=>{watcher.closed=true;};watchers.push(watcher);return watcher;}});
  const abort=new AbortController(),response=await fetch(fx.instance.url+'events',{signal:abort.signal}),reader=response.body.getReader();
  await reader.read();
  await writeFile(path.join(fx.repo,'TASKS.csv'),csv('待确认'));
  const timeout=setTimeout(()=>abort.abort(),2500);
  try{const event=await reader.read();assert.match(new TextDecoder().decode(event.value),/event: change/);assert.equal((await fx.state()).projects[0].tasks[0].status,'待确认');}
  finally{clearTimeout(timeout);abort.abort();await reader.cancel().catch(()=>{});}
  // fixture normally closes in t.after; close here to verify no later reopens.
  const close=fx.instance.close;await close();fx.instance.close=async()=>{};
  const count=watchers.length;await sleep(350);
  assert.equal(watchers.length,count);assert.ok(watchers.every(x=>x.closed));
});
