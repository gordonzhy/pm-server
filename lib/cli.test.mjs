import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,access,rm,readFile,mkdir,writeFile,chmod} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),cli=fileURLToPath(new URL('../bin/pm-server.mjs',import.meta.url));
test('doctor is read only, ensure does not enable, stopped service remains disabled',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-cli-')),state=path.join(root,'state');
 const invoke=async(...args)=>JSON.parse((await run(process.execPath,[cli,...args,'--state-dir',state,'--port','0'])).stdout);
 t.after(async()=>{try{await invoke('service','stop');}finally{await rm(root,{recursive:true,force:true});}});
 assert.equal((await invoke('doctor')).application,'pm-server');await assert.rejects(access(state));
 assert.equal((await invoke('service','ensure')).state,'NOT_ENABLED');await assert.rejects(access(state));
 const started=await invoke('service','start');assert.equal(started.workbench.state,'STARTED');assert.ok(new URL(started.workbench.url).port);
 const status=await invoke('status');assert.equal(status.workbench.state,'RUNNING');assert.equal(status.workbench.pid,started.workbench.pid);
 const stopped=await invoke('service','stop');assert.equal(stopped.workbench.state,'STOPPED');assert.equal((await invoke('service','ensure')).state,'DISABLED');
});
test('project request through public CLI registers immediately without modifying task files',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-cli-project-')),repo=path.join(root,'project'),state=path.join(root,'state');t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(repo);
 const content='id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path\nT-1,待办,P1,Test,Test,[],AI,2026-10-18T00:00:00Z,2026-10-18T00:00:00Z,T-1.md\n';await writeFile(path.join(repo,'TASKS.csv'),content);await writeFile(path.join(repo,'T-1.md'),'# T-1');
 const invoke=async(...args)=>JSON.parse((await run(process.execPath,[cli,...args,'--state-dir',state])).stdout);
 const first=await invoke('project','request','--repo',repo);assert.equal(first.state,'registered');const second=await invoke('project','request','--repo',repo);assert.equal(second.project.id,first.project.id);
 const registry=await invoke('project','list');assert.equal(registry.projects.length,1);assert.equal(registry.pending.length,0);assert.equal(registry.revision,1);assert.equal(await readFile(path.join(repo,'TASKS.csv'),'utf8'),content);
});

test('Codex setup dry run is read only; explicit setup installs hooks and exposes unfinished verification',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-setup-')),state=path.join(root,'state'),codex=path.join(root,'codex');
 const bin=path.join(root,'bin');await mkdir(bin);await writeFile(path.join(bin,'codex'),'#!/bin/sh\nexit 0\n');await chmod(path.join(bin,'codex'),0o755);
 const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CODEX_HOME:codex,PROJECT_MANAGER_NOTIFY_DISABLED:'',PROJECT_MANAGER_NOTIFY_BIN:'',PROJECT_MANAGER_CODEX_BIN:'',CODEX_SESSION_RUNTIME_CSV:''};
 const invoke=async(...args)=>JSON.parse((await run(process.execPath,[cli,...args,'--state-dir',state,'--port','0'],{env})).stdout);
 t.after(async()=>{try{await invoke('service','stop');}finally{await rm(root,{recursive:true,force:true});}});
 assert.equal((await invoke('setup','codex','--dry-run')).state,'PREVIEW');
 await assert.rejects(access(codex));await assert.rejects(access(state));
 await mkdir(codex);await writeFile(path.join(codex,'hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'echo fictional-custom-hook'}]}]}}));
 const first=await invoke('setup','codex','--json');
 assert.equal(first.state,'ACTION_REQUIRED');assert.equal(first.services.workbench.state,'STARTED');
 assert.equal(first.onboarding.codex.configuration,'INSTALLED');assert.equal(first.onboarding.codex.observation,'MISSING');
 assert.equal(first.onboarding.codex.trust,'VERIFY_IN_CODEX_CLI');assert.equal(first.onboarding.notifications,'CONFIGURED_NOT_DELIVERY_VERIFIED');
 assert.match(JSON.stringify(first.onboarding.sessionDiagnostics),/\/hooks/);
 // A later Codex process need not inherit setup's --state-dir.
 const hook=JSON.parse(await readFile(path.join(codex,'hooks.json'),'utf8')).hooks.UserPromptSubmit[0].hooks[0].command;
 execFileSync(process.env.SHELL||'/bin/sh',['-c',hook],{env:{...env,PM_SERVER_STATE_DIR:''},input:JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'fictional-setup-session',turn_id:'fictional-turn'})});
 assert.match(await readFile(path.join(state,'session-runtime.csv'),'utf8'),/codex:default:fictional-setup-session,running/);
 const hooks=JSON.parse(await readFile(path.join(codex,'hooks.json'),'utf8'));
 assert.equal(hooks.hooks.Stop.flatMap(g=>g.hooks).filter(h=>h.command==='echo fictional-custom-hook').length,1);
 const second=await invoke('setup','codex','--json');assert.equal(second.services.workbench.pid,first.services.workbench.pid);
 const after=await invoke('doctor');assert.equal(after.onboarding.codex.configuration,'INSTALLED');assert.equal(after.onboarding.state,'CHECKS_PASSED');
});

test('doctor exposes invalid hooks and cache observations without treating them as trust or delivery',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-onboarding-')),state=path.join(root,'state'),codex=path.join(root,'codex');t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(codex);await writeFile(path.join(codex,'hooks.json'),'invalid json');await mkdir(state);
 const now=new Date().toISOString();await writeFile(path.join(state,'session-runtime.csv.json'),JSON.stringify({version:1,sessions:{demo:{id:'codex:demo:fictional',lastSeenAt:now}}}));
 const env={...process.env,CODEX_HOME:codex,CODEX_SESSION_RUNTIME_CSV:'',PROJECT_MANAGER_NOTIFY_BIN:'fictional-notifier',PROJECT_MANAGER_CODEX_BIN:''};
 const result=JSON.parse((await run(process.execPath,[cli,'doctor','--state-dir',state,'--port','0'],{env})).stdout);
 assert.equal(result.onboarding.codex.configuration,'INVALID');assert.equal(result.onboarding.codex.observation,'RECENT_CACHE_PRESENT');
 assert.equal(result.onboarding.codex.trust,'VERIFY_IN_CODEX_CLI');assert.equal(result.onboarding.notifications,'EXECUTABLE_UNAVAILABLE');
 assert.equal(await readFile(path.join(codex,'hooks.json'),'utf8'),'invalid json');
});

test('bare setup in automation is read only and requires explicit --json to apply changes',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'pm-setup-nontty-')),state=path.join(root,'state'),home=path.join(root,'codex');t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(run(process.execPath,[cli,'setup','--state-dir',state],{env:{...process.env,CODEX_HOME:home}}),error=>error.code===2&&/requires a terminal/.test(error.stderr));
 await assert.rejects(access(state));await assert.rejects(access(home));
});
