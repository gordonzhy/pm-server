#!/usr/bin/env node
// 用户级 supervisor：worker 必须持续报告有期限的工作进度，无法恢复则整体失败退出。
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultStateDir } from './workbench-registry.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { atomicJSON, prepareSocket, request, socketPath } from './task-monitor-service.mjs';
const args = process.argv.slice(2), get = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--once') continue;
  if (!['--state-dir', '--interval'].includes(args[i]) || !args[++i]) throw new Error('usage: run-task-monitor.mjs [--state-dir directory] [--interval seconds] [--once]');
}
const directory = path.resolve(get('--state-dir', defaultStateDir())), interval = Number(get('--interval', '60'));
if (!Number.isInteger(interval) || interval < 1) throw new Error('--interval must be a positive integer');
const scripts = path.dirname(fileURLToPath(import.meta.url));
if (args.includes('--once')) {
  const child = spawn(process.execPath, [path.join(scripts, 'task-monitor-worker.mjs'), ...args], {stdio: 'inherit'});
  child.once('error', error => {console.error(error); process.exitCode = 1;});
  child.once('exit', code => {process.exitCode = code ?? 1;});
} else {
  await supervise();
}
async function supervise() {
  await mkdir(directory, {recursive: true, mode: 0o700}); await prepareSocket(directory);
  const lockPath = path.join(directory, 'task-monitor.lock'), healthPath = path.join(directory, 'task-monitor.json');
  const instance = randomUUID();
  if (await request(directory)) throw new Error('task monitor already running');
  const instanceLock = await acquireProcessLock(lockPath, {timeoutMs: 1000});
  let worker, stopping = false, failure, phaseDeadline = 0, restartTimer, watchdog;
  let failures = [], stopReason = 'signal';
  const health = {kind: 'project-manager-task-monitor', pid: process.pid, instance, stateDir: directory, skillRoot: path.dirname(scripts), interval,
    startedAt: new Date().toISOString(), lastCheckedAt: null, status: 'STARTING', serviceStatus: 'STARTING', projects: [], coverage: 'UNKNOWN', restartCount: 0};
  const events = await open(path.join(directory, 'task-monitor-events.jsonl'), 'a', 0o600);
  const event = async (type, details = {}) => {await events.writeFile(JSON.stringify({at: new Date().toISOString(), instance, type, ...details}) + '\n');};
  let saves = Promise.resolve();
  const save = () => {
    const snapshot = JSON.parse(JSON.stringify(health));
    saves = saves.then(() => atomicJSON(healthPath, snapshot));
    return saves;
  };
  const killWorker = signal => {
    if (!worker) return;
    try {if (process.platform !== 'win32') process.kill(-worker.pid, signal); else worker.kill(signal);} catch (error) {if (error.code !== 'ESRCH') throw error;}
  };
  let finish;
  const done = new Promise(resolve => {finish = resolve;});
  function stop(reason = 'signal') {
    if (stopping) return;
    stopping = true; stopReason = reason; clearTimeout(restartTimer); clearInterval(watchdog);
    killWorker('SIGTERM');
    const force = setTimeout(() => {killWorker('SIGKILL'); finish();}, 1000);
    if (!worker) {clearTimeout(force); finish();} else worker.once('exit', () => {clearTimeout(force); finish();});
  }
  const fatal = error => {failure = error; stop('fatal');};
  const connections = new Set();
  const server = createServer(connection => {
    connections.add(connection); connection.once('close', () => connections.delete(connection));
    let input = ''; connection.setTimeout(1500, () => connection.destroy());
    connection.on('data', chunk => {input += chunk; if (input.length > 4096) connection.destroy();});
    connection.on('end', () => {
      try {
        const command = JSON.parse(input);
        if (command.stateDir !== directory || !['status', 'stop'].includes(command.operation)) throw new Error('invalid monitor control request');
        connection.end(JSON.stringify({...health, ready: health.serviceStatus === 'RUNNING', fresh: Date.now() < phaseDeadline, workerPid: worker?.pid ?? null}) + '\n',()=>{if(command.operation==='stop')stop('explicit-stop');});
      } catch {connection.destroy();}
    });
    connection.on('error', () => {});
  });
  // 唯一锁已取得且控制端点不可达，才删除遗留 socket；不向陈旧 PID 发停止信号。
  await unlink(socketPath(directory)).catch(error => {if (error.code !== 'ENOENT') throw error;});
  try {
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(socketPath(directory), resolve);});
    server.on('error', fatal);
    await chmod(socketPath(directory), 0o600);
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
    await event('started'); await save();
    function launch() {
      if (stopping) return;
      health.serviceStatus = health.restartCount ? 'RECOVERING' : 'STARTING'; health.phase = 'worker-start';
      phaseDeadline = Date.now() + 10000;
      worker = spawn(process.execPath, [path.join(scripts, 'task-monitor-worker.mjs'), '--state-dir', directory, '--interval', String(interval)],
        {detached: process.platform !== 'win32', stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
      health.workerPid = worker.pid;
      let timedOut = false, ended = false;
      worker.on('message', message => {
        if (stopping) return;
        if (message?.type === 'progress' && Number.isFinite(message.timeoutMs) && message.timeoutMs > 0) {
          health.phase = message.phase; phaseDeadline = Date.now() + Math.min(message.timeoutMs, Math.max(interval * 1000 + 10000, 50000));
        } else if (message?.type === 'health') {
          const result = message.health;
          health.status = result.status; health.projects = result.projects; health.coverage = result.coverage || health.coverage;
          health.pendingNotifications = result.pendingNotifications || 0;
          health.notificationCheck = result.notificationCheck;
          health.confirmationWatch = result.confirmationWatch;
          health.lastCheckedAt = result.lastCheckedAt; health.error = result.error;
          health.serviceStatus = result.lastCheckedAt ? 'RUNNING' : 'STARTING';
          save().catch(fatal);
        }
      });
      const exited = async (code, signal, error) => {
        if (ended) return; ended = true;
        // worker 被杀时，其检查子进程也必须结束，避免重复执行/遗留。
        killWorker('SIGKILL'); worker = null;
        if (stopping) return;
        try {
          const now = Date.now(); failures = failures.filter(at => now - at < 60000); failures.push(now);
          health.restartCount++; health.serviceStatus = 'RECOVERING'; health.status = 'RECOVERING';
          health.error = error?.message || (timedOut ? `worker progress timeout: ${health.phase}` : `worker exited: ${code ?? signal}`);
          await event('worker-failed', {code, signal, reason: health.error, restartCount: health.restartCount}); await save();
          if (failures.length >= 4) {fatal(new Error(`worker recovery budget exhausted: ${health.error}`)); return;}
          restartTimer = setTimeout(launch, Math.min(5000, 250 * 2 ** (failures.length - 1)));
        } catch (error) {fatal(error);}
      };
      worker.once('error', error => {void exited(null, null, error);});
      worker.once('exit', (code, signal) => {void exited(code, signal);});
      health.timeoutWorker = () => {timedOut = true; killWorker('SIGKILL');};
    }
    watchdog = setInterval(() => {
      if (worker && Date.now() > phaseDeadline) health.timeoutWorker?.();
    }, 100);
    launch(); await done;
    delete health.timeoutWorker;
    health.serviceStatus = failure ? 'FAILED' : 'STOPPED'; health.status = health.serviceStatus;
    health.stoppedAt = new Date().toISOString(); health.stopReason = stopReason;
    if (failure) health.error = failure.message;
    await event(failure ? 'failed' : 'stopped', {reason: failure?.message || stopReason}); await save();
    if (failure) process.exitCode = 1;
  } finally {
    clearTimeout(restartTimer); clearInterval(watchdog); killWorker('SIGKILL');
    // 控制端点必须在仍持独占锁时关闭和移除，避免删掉后继实例的 socket。
    const serverClosed = new Promise(resolve => server.close(() => resolve()));
    for (const connection of connections) connection.destroy();
    await serverClosed;
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    try {await events.close(); await unlink(socketPath(directory)).catch(() => {});} finally {await instanceLock.release();}
  }
}
