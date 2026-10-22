import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { socketPath } from './task-monitor-service.mjs';
import { inspectPause, pauseScope } from './task-monitor-policy.mjs';
const scripts = path.dirname(fileURLToPath(import.meta.url));
const headers = 'id,status,modified_at,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,recovery_turn_id,recovery_state,recovery_state_at';
const execution = '11111111-1111-4111-8111-111111111111', manager = '22222222-2222-4222-8222-222222222222';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pm-shared-monitor-'))), state = path.join(root, 'state'), queue = path.join(root, 'queue.log'), fake = path.join(root, 'codex');
  await mkdir(state); await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PROJECT_MANAGER_QUEUE_LOG"\n'); await chmod(fake, 0o755);
  const cache = path.join(root, 'runtime.csv'), now = new Date().toISOString(), old = new Date(Date.now() - 300000).toISOString();
  // Manager observation is deliberately absent: its activity must not gate reminders.
  await writeFile(cache, `session_id,status,current_turn_id,status_at,last_seen_at\n${execution},idle,turn-1,${old},${now}\n`);
  const projects = [];
  for (let i = 0; i < 2; i++) {
    const repo = path.join(root, `repo-${i}`); await mkdir(repo);
    await writeFile(path.join(repo, 'TASKS.csv'), `${headers}\nTEST-${i},进行中,${old},dispatch-${i},${execution},turn-1,${manager},,,\n`);
    projects.push({id: `project-${i}`, name: `测试项目${i}`, root: repo, csvPath: path.join(repo, 'TASKS.csv')});
  }
  const registry = {version: 1, revision: 1, projects, pending: [], removed: []};
  await writeFile(path.join(state, 'registry.json'), JSON.stringify(registry));
  const env = {...process.env, CODEX_HOME: path.join(root, 'codex-home'), CODEX_SESSION_RUNTIME_CSV: cache, PROJECT_MANAGER_CODEX_BIN: fake, PROJECT_MANAGER_QUEUE_LOG: queue};
  t.after(async () => {
    try { execFileSync(process.execPath, [path.join(scripts, 'manage-task-monitor.mjs'), '--state-dir', state, '--stop'], {env, stdio: 'pipe'}); } catch {}
    await rm(root, {recursive: true, force: true});
  });
  const run = (file, args = []) => execFileSync(process.execPath, [path.join(scripts, file), '--state-dir', state, ...args], {env, encoding: 'utf8', stdio: 'pipe'});
  return {root, state, queue, projects, registry, run};
}
test('pause scope fails open on corruption and resumes on deadline, route, turn or status change', () => {
  const task = {status: '进行中', dispatch_id: 'd1', execution_thread_id: execution, execution_turn_id: 't1', manager_thread_id: manager};
  const paused = {...task, monitor_pause_until: '2099-01-01T00:00:00Z', monitor_pause_reason: '等批处理', monitor_pause_scope: JSON.stringify(pauseScope(task, 'runtime-1'))};
  assert.equal(inspectPause(paused, 'runtime-1').paused, true);
  assert.equal(inspectPause(paused, undefined).paused, true);
  for (const delta of [{status:'待办'}, {dispatch_id:'d2'}, {execution_turn_id:'t2'}, {manager_thread_id:'other'}, {monitor_pause_until:'2020-01-01T00:00:00Z'}, {monitor_pause_scope:'bad'}]) assert.equal(inspectPause({...paused, ...delta}, 'runtime-1').clear, true);
  assert.equal(inspectPause(paused, 'runtime-2').clear, true);
});
test('shared monitor checks only registered projects and deduplicates across ticks', async t => {
  const fx = await fixture(t);
  fx.registry.pending.push(fx.registry.projects.pop()); await writeFile(path.join(fx.state,'registry.json'), JSON.stringify(fx.registry));
  fx.run('run-task-monitor.mjs', ['--once']); fx.run('run-task-monitor.mjs', ['--once']);
  const health = JSON.parse(await readFile(path.join(fx.state, 'task-monitor.json'), 'utf8'));
  assert.equal(health.status, 'HEALTHY'); assert.equal(health.projects.length, 1); assert.ok(health.lastCheckedAt);
  const messages = (await readFile(fx.queue,'utf8')).split('PROJECT_MANAGER_RECONCILIATION').length-1;
  assert.equal(messages, 1);
});
test('one broken registered project does not prevent remaining projects being checked', async t => {
  const fx = await fixture(t); await rm(fx.projects[0].csvPath);
  fx.run('run-task-monitor.mjs', ['--once']);
  const health = JSON.parse(await readFile(path.join(fx.state, 'task-monitor.json'),'utf8'));
  assert.equal(health.status, 'ERROR'); assert.equal(health.projects[0].status, 'ERROR'); assert.equal(health.projects[1].status, 'HEALTHY');
  assert.match(await readFile(fx.queue,'utf8'), /PROJECT_MANAGER_RECONCILIATION/);
  assert.ok(!(await readFile(fx.queue,'utf8')).includes('TEST-1'));
});
test('detached service starts, reports fresh checks, reuses one process, and follows removal', async t => {
  const fx = await fixture(t);
  const started = JSON.parse(fx.run('manage-task-monitor.mjs', ['--interval','1']));
  assert.equal(started.state, 'STARTED');
  const healthy = await waitFor(fx, health => health.serviceStatus === 'RUNNING');
  assert.equal(healthy.status, 'HEALTHY'); assert.equal(healthy.fresh, true);
  const reused = JSON.parse(fx.run('manage-task-monitor.mjs'));
  assert.equal(reused.state, 'REUSED'); assert.equal(reused.pid, started.pid);
  fx.registry.removed.push(...fx.registry.projects); fx.registry.projects = [];
  await writeFile(path.join(fx.state,'registry.json'),JSON.stringify(fx.registry));
  const deadline = Date.now()+4000;
  let health;
  do {health=JSON.parse(await readFile(path.join(fx.state,'task-monitor.json'),'utf8')); if (!health.projects.length && health.status==='HEALTHY') break; await new Promise(resolve=>setTimeout(resolve,50));} while(Date.now()<deadline);
  assert.equal(health.projects.length,0); assert.equal(health.coverage, 'NO_REGISTERED_PROJECTS');
  fx.run('manage-task-monitor.mjs',['--stop']);
  do {health=JSON.parse(await readFile(path.join(fx.state,'task-monitor.json'),'utf8')); if(health.status==='STOPPED') break; await new Promise(resolve=>setTimeout(resolve,25));} while(Date.now()<deadline);
  assert.equal(health.status,'STOPPED');
});

async function waitFor(fx, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try {last = JSON.parse(fx.run('manage-task-monitor.mjs', ['--status']));}
    catch (error) {try {last = JSON.parse(error.stdout);} catch {}}
    if (last && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`monitor condition timed out: ${JSON.stringify(last)}`);
}
test('supervisor recovers crashed and frozen workers without duplicate reminders; explicit stop stays disabled', async t => {
  const fx = await fixture(t);
  const started = JSON.parse(fx.run('manage-task-monitor.mjs', ['--ensure', '--interval', '1']));
  const first = await waitFor(fx, health => health.ready && health.phase === 'sleep');
  process.kill(first.workerPid, 'SIGKILL');
  const recovered = await waitFor(fx, health => health.ready && health.restartCount === 1 && health.workerPid !== first.workerPid);
  assert.equal(recovered.pid, started.pid);
  await waitFor(fx, health => health.phase === 'sleep');
  process.kill(recovered.workerPid, 'SIGSTOP');
  const resumed = await waitFor(fx, health => health.ready && health.restartCount === 2, 16000);
  assert.notEqual(resumed.workerPid, recovered.workerPid);
  assert.equal((await readFile(fx.queue, 'utf8')).split('PROJECT_MANAGER_RECONCILIATION').length - 1, 2);
  assert.match(await readFile(path.join(fx.state, 'task-monitor-events.jsonl'), 'utf8'), /worker progress timeout/);
  fx.run('manage-task-monitor.mjs', ['--stop']);
  assert.equal(JSON.parse(fx.run('manage-task-monitor.mjs', ['--ensure'])).state, 'DISABLED');
  const stopped = JSON.parse(await readFile(path.join(fx.state, 'task-monitor.json'), 'utf8'));
  assert.equal(stopped.status, 'STOPPED');
  assert.equal(stopped.stopReason, 'explicit-stop');
});
test('global registry corruption exhausts recovery budget and exits; next ensure can recreate supervisor', async t => {
  const fx = await fixture(t);
  await writeFile(path.join(fx.state, 'registry.json'), '{broken');
  fx.run('manage-task-monitor.mjs', ['--ensure', '--interval', '1']);
  await waitFor(fx, health => health.state === 'STOPPED');
  const failed = JSON.parse(await readFile(path.join(fx.state, 'task-monitor.json'), 'utf8'));
  assert.equal(failed.status, 'FAILED'); assert.match(failed.error, /recovery budget exhausted/);
  await writeFile(path.join(fx.state, 'registry.json'), JSON.stringify(fx.registry));
  fx.run('manage-task-monitor.mjs', ['--ensure', '--interval', '1']);
  assert.equal((await waitFor(fx, health => health.ready)).projects.length, 2);
});
test('live foreign PID in stale lock is never killed by ensure or stop', async t => {
  const fx = await fixture(t);
  await writeFile(path.join(fx.state, 'task-monitor.lock'), JSON.stringify({pid: process.pid, instance: 'foreign'}));
  assert.throws(() => fx.run('manage-task-monitor.mjs', ['--ensure']));
  assert.equal(JSON.parse(fx.run('manage-task-monitor.mjs', ['--stop'])).state, 'STOPPED');
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('supervised project failure is isolated and supervisor death ends worker without overwriting service identity', async t => {
  const fx = await fixture(t); await rm(fx.projects[0].csvPath);
  const started = JSON.parse(fx.run('manage-task-monitor.mjs', ['--interval', '1']));
  const healthy = await waitFor(fx, health => health.ready);
  assert.equal(healthy.status, 'ERROR'); assert.equal(healthy.restartCount, 0);
  assert.equal(healthy.projects[1].status, 'HEALTHY');
  process.kill(started.pid, 'SIGKILL');
  await waitFor(fx, health => health.state === 'STOPPED');
  const deadline = Date.now() + 4000;
  let alive = true;
  while (Date.now() < deadline) {
    try {process.kill(healthy.workerPid, 0);} catch (error) {if (error.code === 'ESRCH') {alive = false; break;} throw error;}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(alive, false, 'orphan worker must exit on IPC disconnect');
  const snapshot = JSON.parse(await readFile(path.join(fx.state, 'task-monitor.json'), 'utf8'));
  assert.equal(snapshot.pid, started.pid, 'worker must not overwrite supervisor identity');
  fx.run('manage-task-monitor.mjs', ['--ensure', '--interval', '1']);
  assert.equal((await waitFor(fx, health => health.ready)).restartCount, 0);
});

test('malformed individual registration is an isolated error rather than a global recovery loop', async t => {
  const fx = await fixture(t);
  fx.registry.projects[0].csvPath = null;
  await writeFile(path.join(fx.state, 'registry.json'), JSON.stringify(fx.registry));
  fx.run('manage-task-monitor.mjs', ['--ensure', '--interval', '1']);
  const health = await waitFor(fx, result => result.ready);
  assert.equal(health.projects[0].status, 'ERROR');
  assert.equal(health.projects[1].status, 'HEALTHY');
  assert.equal(health.serviceStatus, 'RUNNING'); assert.equal(health.restartCount, 0);
});

test('crashed in-flight delivery remains visible and retries after its short lease, independent of warning dedup', async t => {
  const fx = await fixture(t);
  fx.registry.projects = fx.registry.projects.slice(0, 1);
  await writeFile(path.join(fx.state, 'registry.json'), JSON.stringify(fx.registry));
  const fake = path.join(fx.root, 'codex');
  await writeFile(fake, '#!/bin/sh\nprintf ".start\\n" >> "$PROJECT_MANAGER_QUEUE_LOG"\nexec /bin/sleep 30\n');
  fx.run('manage-task-monitor.mjs', ['--ensure', '--interval', '1']);
  const until = Date.now() + 5000;
  while (true) {
    try {if ((await readFile(fx.queue,'utf8')).includes('.start')) break;} catch {}
    assert.ok(Date.now() < until, 'delivery must begin');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const first = await waitFor(fx, result => result.workerPid);
  await writeFile(fake, '#!/bin/sh\nprintf ".delivered\\n" >> "$PROJECT_MANAGER_QUEUE_LOG"\n');
  process.kill(first.workerPid, 'SIGKILL');
  const recovered = await waitFor(fx, result => result.restartCount === 1 && result.ready && result.status === 'WARNING');
  assert.equal(recovered.pendingNotifications, 1);
  assert.equal(recovered.projects[0].pendingNotifications, 1);
  assert.equal(await readFile(fx.queue, 'utf8'), '.start\n');
  const csv = fx.registry.projects[0].csvPath;
  const statePath=path.join(fx.state,'monitor',createHash('sha256').update(fx.registry.projects[0].root).digest('hex')+'.json');
  const saved=JSON.parse(await readFile(statePath,'utf8'));saved.tasks['TEST-0'].recovery_state_at=new Date(Date.now()-61000).toISOString();await writeFile(statePath,JSON.stringify(saved));
  const retried = await waitFor(fx, result => result.status === 'HEALTHY' && result.pendingNotifications === 0);
  assert.equal(retried.restartCount, 1);
  assert.equal(await readFile(fx.queue,'utf8'), '.start\n.delivered\n');
  assert.equal(JSON.parse(await readFile(statePath,'utf8')).tasks['TEST-0'].recovery_state,'sent');
  assert.doesNotMatch(await readFile(csv,'utf8'),/,sent,/);
});

test('rapid explicit stop and successor startup retain a reachable control endpoint', async t => {
  const fx = await fixture(t);
  for (let i = 0; i < 3; i++) {
    const started = JSON.parse(fx.run('manage-task-monitor.mjs', ['--interval', '1']));
    const healthy = await waitFor(fx, result => result.ready);
    assert.equal(healthy.pid, started.pid);
    fx.run('manage-task-monitor.mjs', ['--stop']);
    assert.equal((await waitFor(fx, result => result.state === 'STOPPED')).state, 'STOPPED');
  }
  const last = JSON.parse(fx.run('manage-task-monitor.mjs', ['--interval', '1']));
  assert.equal((await waitFor(fx, result => result.ready)).pid, last.pid);
});


test('explicit stop closes a continuously active incomplete control connection', async t => {
  const fx = await fixture(t);
  fx.run('manage-task-monitor.mjs', ['--interval', '1']);
  await waitFor(fx, result => result.ready);
  const client = connect(socketPath(fx.state));
  client.on('error', () => {});
  await new Promise(resolve => client.once('connect', resolve));
  client.write('{');
  const timer = setInterval(() => {if (!client.destroyed) client.write(' ');}, 50);
  try {
    const result = await new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(scripts, 'manage-task-monitor.mjs'), '--state-dir', fx.state, '--stop'], {stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data', chunk => stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.once('exit',code=>resolve({code,stdout,stderr}));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, 'STOPPED');
    assert.equal(client.destroyed, true);
  } finally {clearInterval(timer);client.destroy();}
});
test('missing observations stay diagnostic without recurring messages, while known interruptions notify current manager',async t=>{
 const f=await fixture(t),project=f.projects[0],current='33333333-3333-4333-8333-333333333333';
 await writeFile(path.join(project.root,'project-manager.config.json'),JSON.stringify({configVersion:1,project:{name:'Demo',prefix:'DEMO'},taskSystem:{csv:'TASKS.csv',detailsDir:'tasks'},manager:{threadId:current,registeredAt:new Date().toISOString()}}));
 const cache=path.join(f.root,'runtime.csv');await writeFile(cache,'session_id,status,current_turn_id,status_at,last_seen_at\n');
 const a=f.run('watch-active-tasks.mjs',['--repo',project.root]);
 const b=f.run('watch-active-tasks.mjs',['--repo',project.root]);
 assert.match(a,/CODEX_PM_DIAGNOSTIC observation_coverage/);assert.match(b,/CODEX_PM_DIAGNOSTIC observation_coverage/);
 await assert.rejects(readFile(f.queue),e=>e.code==='ENOENT');
 const now=new Date().toISOString(),old=new Date(Date.now()-300000).toISOString();
 await writeFile(cache,`session_id,status,current_turn_id,status_at,last_seen_at\n${execution},interrupted,turn-1,${old},${now}\n`);
 f.run('watch-active-tasks.mjs',['--repo',project.root]);
 const sent=await readFile(f.queue,'utf8');assert.ok(sent.includes(current));assert.ok(!sent.includes(manager));
 const rows=await readFile(path.join(project.root,'TASKS.csv'),'utf8');assert.ok(rows.includes(manager));assert.ok(!rows.includes(current));
});
