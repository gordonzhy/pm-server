#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from './workbench-registry.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { atomicJSON, request } from './task-monitor-service.mjs';
const args = process.argv.slice(2), get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
for (let i = 0; i < args.length; i++) {
  if (['--status', '--stop', '--ensure'].includes(args[i])) continue;
  if (!['--state-dir', '--interval'].includes(args[i]) || !args[++i]) throw new Error('unknown or incomplete argument');
}
if (args.filter(arg => ['--status', '--stop', '--ensure'].includes(arg)).length > 1) throw new Error('--status, --stop and --ensure are exclusive');
const interval = Number(get('--interval', '60'));
if (!Number.isInteger(interval) || interval < 1) throw new Error('--interval must be a positive integer');
const directory = path.resolve(get('--state-dir', defaultStateDir())), scripts = path.dirname(fileURLToPath(import.meta.url));
const startLock = path.join(directory, 'task-monitor-start.lock'), controlPath = path.join(directory, 'task-monitor-control.json');
async function current() {
  const health = await request(directory);
  if (health && health.skillRoot !== path.dirname(scripts)) throw new Error('monitor skill identity mismatch; no automatic replacement');
  return health;
}
async function control() {try {return JSON.parse(await readFile(controlPath, 'utf8'));} catch (error) {if (error.code === 'ENOENT') return {}; throw error;}}
if (args.includes('--status')) {
  const health = await current();
  console.log(JSON.stringify(health ? {state: 'RUNNING', ...health} : {state: 'STOPPED', stateDir: directory, enabled: (await control()).enabled ?? null}));
  if (!health || !health.fresh || health.serviceStatus !== 'RUNNING' || health.status !== 'HEALTHY') process.exitCode = 3;
} else {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const lock = await acquireProcessLock(startLock);
  try {
    const health = await current(), previous = await control();
    if (args.includes('--stop')) {
      await atomicJSON(controlPath, {enabled: false, changedAt: new Date().toISOString()});
      if (health) await request(directory, 'stop');
      const deadline = Date.now() + 4000;
      while (await current()) {
        if (Date.now() >= deadline) throw new Error('monitor stop did not complete within deadline');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      console.log(JSON.stringify({state: 'STOPPED', stateDir: directory, enabled: false}));
    } else if (args.includes('--ensure') && previous.enabled === false) {
      console.log(JSON.stringify({state: 'DISABLED', stateDir: directory, enabled: false}));
    } else if (health) {
      console.log(JSON.stringify({state: 'REUSED', ...health}));
    } else {
      await atomicJSON(controlPath, {enabled: true, changedAt: new Date().toISOString()});
      const log = await open(path.join(directory, 'task-monitor.log'), 'a', 0o600);
      const child = spawn(process.execPath, [path.join(scripts, 'run-task-monitor.mjs'), '--state-dir', directory, '--interval', String(interval)], {detached: true, stdio: ['ignore', log.fd, log.fd]});
      child.unref(); await log.close();
      // 仅等待控制端点：首轮项目检查可以超过5秒，STARTING不能冒充HEALTHY。
      const deadline = Date.now() + 5000;
      let started;
      while (Date.now() < deadline) {
        started = await current();
        if (started?.pid === child.pid) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!started || started.pid !== child.pid) throw new Error('monitor failed to start; inspect task-monitor.log');
      console.log(JSON.stringify({state: 'STARTED', ...started}));
    }
  } finally {await lock.release();}
}
