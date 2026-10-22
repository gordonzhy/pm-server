#!/usr/bin/env node
// 独立于工作台页面的用户级监测循环，仅检查已确认登记项目。
import {recoverCodexRuntime} from '../lib/codex-runtime-observer.mjs';
import {runtimeCsv} from '../lib/paths.mjs';
import { spawn } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry, defaultStateDir } from './workbench-registry.mjs';
import {inspectProject} from './workbench-data.mjs';
import {notificationConfiguration,notificationManagers,checkAutomaticNotification} from '../lib/notifications.mjs';

const args = process.argv.slice(2), get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--once') continue;
  if (!['--state-dir', '--interval'].includes(args[i]) || !args[++i]) throw new Error('usage: run-task-monitor.mjs [--state-dir directory] [--interval seconds] [--once]');
}
const directory = path.resolve(get('--state-dir', defaultStateDir()));
const interval = Number(get('--interval', '60'));
if (!Number.isInteger(interval) || interval < 1) throw new Error('--interval must be a positive integer');
const scripts = path.dirname(fileURLToPath(import.meta.url)), registry = new Registry(directory);
const healthPath = path.join(directory, 'task-monitor.json');
await mkdir(directory, {recursive: true, mode: 0o700});
let stopping = false, child, timer, wake;
const health = {kind: 'project-manager-task-monitor', pid: process.pid, stateDir: directory, skillRoot: path.dirname(scripts), interval,
  startedAt: new Date().toISOString(), lastCheckedAt: null, status: 'STARTING', projects: []};
async function save() {
  if (process.send) {
    if (process.connected) process.send({type: 'health', health});
    return; // supervisor 拥有服务快照；断开后不得用 worker 身份覆盖它。
  }
  const temporary = `${healthPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(health, null, 2) + '\n', {mode: 0o600}); await rename(temporary, healthPath);
}
function progress(phase, timeoutMs) { if (process.connected) process.send?.({type: 'progress', phase, timeoutMs}); }
function stop() {stopping = true; child?.kill('SIGTERM'); clearTimeout(timer); wake?.();}
process.on('disconnect', stop);
process.on('SIGTERM', stop); process.on('SIGINT', stop);
async function inspect(project) {
  progress(`project:${project.id}`, 50000);
  // 标准CSV后端；其他后端不能猜测写入位置。
  if (path.resolve(project.csvPath) !== path.join(path.resolve(project.root), 'TASKS.csv')) return {id: project.id, name: project.name, status: 'WARNING', message: 'nonstandard CSV backend requires an adapter'};
  return new Promise(resolve => {
    let output = '', finished = false;
    child = spawn(process.execPath, [path.join(scripts, 'watch-active-tasks.mjs'), '--repo', project.root, '--state-dir', directory], {env: {...process.env, CODEX_PM_REPORT_ACTION: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
    const current = child;
    const timeout = setTimeout(() => {current.kill('SIGKILL');}, 45_000);
    const capture = chunk => {output = (output + chunk).slice(-6000);};
    current.stdout.on('data', capture); current.stderr.on('data', capture);
    const finish = (code, message) => {
      if (finished) return; finished = true; clearTimeout(timeout); child = null;
      resolve({id: project.id, name: project.name, checkedAt: new Date().toISOString(), status: code === 0 ? 'HEALTHY' : code === 3 ? 'WARNING' : 'ERROR',
        message: message || output.trim(), observationCoverage:output.includes('CODEX_PM_DIAGNOSTIC observation_coverage ')?'PARTIAL':'AVAILABLE',observationDiagnosticCount:Number([...output.matchAll(/CODEX_PM_DIAGNOSTIC observation_coverage (\d+)/g)].at(-1)?.[1]||0),pendingNotifications: Number([...output.matchAll(/CODEX_PM_PENDING (\d+)/g)].at(-1)?.[1] || 0), queued: [...output.matchAll(/CODEX_PM_ACTION (\S+) (\d+)/g)].map(match => ({kind: match[1], count: Number(match[2])}))});
    };
    current.once('error', error => finish(-1, error.message)); current.once('exit', (code, signal) => finish(code, signal ? `check stopped: ${signal}` : ''));
  });
}
try {
  do {
    progress('registry', 10000);
    health.status = 'CHECKING'; await save();
    try {
      const state = await registry.read(), results = [];
      progress('notification-check',50000);
      const snapshots=[];
      for(const project of state.projects){try{snapshots.push(await inspectProject(project,false));}catch{}}
      const targets=snapshots.flatMap(p=>(p.tasks||[]).filter(t=>t.status==='进行中'&&t.execution_thread_id).map(t=>({reference:t.execution_thread_id,projectRoot:p.root})));
      try{health.runtimeRecovery=await recoverCodexRuntime({targets,runtimeCsv:runtimeCsv()});}catch{health.runtimeRecovery={checked:targets.length,recovered:0,results:[{state:'UNAVAILABLE',reason:'RECOVERY_UNAVAILABLE'}]};}
      const backend=await notificationConfiguration(process.env,directory);
      try{health.notificationCheck=await checkAutomaticNotification({directory,managers:notificationManagers(snapshots,backend.backend,process.env.PM_SERVER_INSTANCE||'default')});}
      catch{health.notificationCheck={state:'UNKNOWN'};}
      for (const project of state.projects) {
        if (stopping) break;
        try {results.push(await inspect(project));}
        catch (error) {
          results.push({id: project?.id ?? null, name: project?.name ?? null, checkedAt: new Date().toISOString(), status: 'ERROR', message: error.message});
        }
      }
      health.projects = results;
      health.observationDiagnosticCount=results.reduce((n,r)=>n+(r.observationDiagnosticCount||0),0);
      health.observationCoverage=health.observationDiagnosticCount?'PARTIAL':'AVAILABLE';
      health.pendingNotifications = results.reduce((sum, result) => sum + (result.pendingNotifications || 0), 0);
      health.status = results.some(result => result.status === 'ERROR') ? 'ERROR' : results.some(result => result.status === 'WARNING')||['FAILED','UNKNOWN'].includes(health.notificationCheck?.state) ? 'WARNING' : 'HEALTHY';
      delete health.error;
    } catch (error) {health.status = 'ERROR'; health.error = error.message; await save(); throw error;}
    health.lastCheckedAt = new Date().toISOString();
    health.coverage = health.projects.length ? 'REGISTERED_PROJECTS' : 'NO_REGISTERED_PROJECTS';
    await save();
    if (args.includes('--once') || stopping) break;
    progress('sleep', interval * 1000 + 10000);
    await new Promise(resolve => {wake = resolve; timer = setTimeout(resolve, interval * 1000);}); wake = null;
  } while (!stopping);
} finally {
  if (stopping) {health.status = 'STOPPED'; await save();}
}
