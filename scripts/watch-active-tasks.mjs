#!/usr/bin/env node

import {codexReference,runtimeEvidence,cachedRuntimeSession} from '../lib/codex-runtime-observer.mjs';
import { createHash } from "node:crypto";
import { readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireProcessLock, runtimeLockPath } from './process-lock.mjs';
import { inspectPause, pauseFields, monitorScope, monitorScopeMatches } from './task-monitor-policy.mjs';
import {mkdir} from 'node:fs/promises';
import {stateDir,runtimeCsv} from '../lib/paths.mjs';
import {loadProjectConfig} from './project-config-v2.mjs';
import {sendNotification,notificationConfiguration,registeredManagerReference} from '../lib/notifications.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const repository = await realpath(path.resolve(args.get("--repo") || process.cwd()));
const projectConfig=await loadProjectConfig(repository);
if(!projectConfig.ok)throw new Error('Invalid project configuration');
const projectManager=projectConfig.config.manager?registeredManagerReference(projectConfig.config.manager.threadId):null;
if(projectConfig.config.manager&&!projectManager)throw new Error('Invalid or incompatible registered project manager');
const effectiveManager=(row,column)=>projectManager||row[column.manager_thread_id];
const graceSeconds = Number(args.get("--grace") ?? 120);
const routeGraceSeconds = 120;
const staleSeconds = Number(args.get("--stale-after") || 1800);
const inactiveStaleSeconds = Number(args.get("--inactive-stale-after") || 86_400);
const pendingLeaseSeconds = Number(args.get("--pending-lease") ?? 60);
const warningIntervalSeconds = Number(args.get("--warning-interval") || 3_600);
const hostHome = process.env.PROJECT_MANAGER_HOST_HOME || process.env.CODEX_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.codex');
const codexHome = hostHome;
// 投递后端：显式命令优先；DSH（只设 DSH_HOME）默认停用，避免假装已唤醒经理。
const notifyDisabled = (await notificationConfiguration(process.env,args.get('--state-dir')||stateDir())).state !== 'CONFIGURED_NOT_DELIVERY_VERIFIED';
const runtimeCsvPath = runtimeCsv();
const monitorDirectory=path.join(args.get('--state-dir') || stateDir(),'monitor');
await mkdir(monitorDirectory,{recursive:true,mode:0o700});
const monitorFile=path.join(monitorDirectory,createHash('sha256').update(repository).digest('hex')+'.json');
if (!Number.isInteger(pendingLeaseSeconds) || pendingLeaseSeconds < 1) throw new Error("--pending-lease must be a positive integer");
if (!Number.isInteger(graceSeconds) || graceSeconds < 0) throw new Error("--grace must be a non-negative integer");
if (!Number.isInteger(staleSeconds) || staleSeconds < 60) throw new Error("--stale-after must be at least 60 seconds");
if (!Number.isInteger(inactiveStaleSeconds) || inactiveStaleSeconds < staleSeconds) throw new Error("--inactive-stale-after must be an integer no smaller than --stale-after");
if (!Number.isInteger(warningIntervalSeconds) || warningIntervalSeconds < 60) throw new Error("--warning-interval must be at least 60 seconds");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(field); field = ""; }
    else if (character === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += character;
  }
  if (quoted) throw new Error("unterminated quoted CSV field");
  if (field || row.length) { row.push(field.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function encodeCsv(rows) {
  const encode = (value) => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${rows.map((row) => row.map(encode).join(",")).join("\n")}\n`;
}

function timestamp() { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z"); }
function ageSeconds(value, now) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? (now - parsed) / 1000 : Infinity; }



const csvPath = path.join(repository, "TASKS.csv");
const required = ["id", "status", "modified_at", "dispatch_id", "execution_thread_id", "execution_turn_id", "manager_thread_id", "recovery_turn_id", "recovery_state", "recovery_state_at"];
const runtimeRequired = ["session_id", "status", "status_at", "last_seen_at"];

function warning(message) {
  console.warn(`WARNING: session recovery monitoring skipped: ${message}`);
}

function recoveryGeneration(row, column, execution) {
  const turn = execution?.turnId || row[column.execution_turn_id] || row[column.dispatch_id];
  return `recovery:${createHash('sha256').update(JSON.stringify([row[column.dispatch_id], row[column.execution_thread_id], turn,effectiveManager(row,column)])).digest('hex').slice(0, 16)}`;
}

async function readRuntimeCache() {
  let rows;
  try { rows = parseCsv(await readFile(runtimeCsvPath, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return { error: `global runtime cache not found at ${runtimeCsvPath}`, errorKind: 'MISSING' };
    return { error: `cannot read global runtime cache at ${runtimeCsvPath}: ${error.message}` };
  }
  const headers = rows[0] || [];
  const missing = runtimeRequired.filter((field) => !headers.includes(field));
  if (missing.length) return { error: `global runtime cache is missing fields: ${missing.join(", ")}` };
  const column = Object.fromEntries(headers.map((header, index) => [header, index]));
  const sessions = new Map();
  for (const row of rows.slice(1)) {
    const sessionId = row[column.session_id];
    if (!sessionId) continue;
    if (sessions.has(sessionId)) return { error: `global runtime cache contains duplicate session_id ${sessionId}` };
    sessions.set(sessionId, {
      status: row[column.status],
      statusAt: row[column.status_at],
      lastSeenAt: row[column.last_seen_at],
      turnId: column.current_turn_id === undefined ? "" : row[column.current_turn_id],
    });
  }
  for(const [reference] of [...sessions]){const codex=codexReference(reference);if(codex){const value=cachedRuntimeSession(Object.fromEntries(sessions),reference);sessions.set(codex.reference,value);sessions.set(codex.id,value);}}
  return { sessions };
}

function inspect(rows, sessions, now, runtimeError = "",runtimeMissing=false) {
  const headers = rows[0] || [];
  for (const field of required) if (!headers.includes(field)) throw new Error(`TASKS.csv missing runtime field: ${field}`);
  const column = Object.fromEntries(headers.map((header, index) => [header, index]));
  let changed = false;
  const resetNotification = row => {
    for (const field of ['recovery_turn_id', 'recovery_state', 'recovery_state_at']) row[column[field]] = '';
    row[column.modified_at] = timestamp(); changed = true;
  };
  const paused = new Set();
  for (const row of rows.slice(1)) {
    const task = Object.fromEntries(headers.map((field, i) => [field, row[i]]));
    const pause = inspectPause(task, sessions.get(task.execution_thread_id)?.turnId);
    if (pause.paused) paused.add(task.id);
    if (pause.clear) {
      for (const field of pauseFields) if (column[field] !== undefined) row[column[field]] = '';
      resetNotification(row);
      if (pause.error) warning(`${task.id}: ${pause.error}; monitoring resumed`);
    }
  }
  const active = rows.slice(1).filter((row) => row[column.status] === "进行中" && !paused.has(row[column.id]));
  const managers = new Set(active.map((row) => effectiveManager(row,column)).filter(Boolean));

  if (!active.length) return { column, active, manager: null, candidates: [], warningCandidates: [], changed, warnings: [],diagnostics:[] };
  const manager = [...managers][0];
  const warnings = [],diagnostics=[];
  const warningsByTask = new Map();
  const addWarning = (taskId, message) => {
    warnings.push(message);
    warningsByTask.set(taskId, [...(warningsByTask.get(taskId) || []), message]);
  };
  const usable = new Map();
  const resolveSession = (sessionId, role, taskId) => {
    if (!sessionId) { diagnostics.push( `${taskId} has no ${role} session route`); return null; }
    const session = sessions.get(sessionId);
    if (!session) { diagnostics.push( `${taskId} references ${role} session ${sessionId}, which is absent from the global cache`); return null; }
    if (!["running", "waiting", "idle", "interrupted", "ended"].includes(session.status)) {
      addWarning(taskId, `${taskId} ${role} session ${sessionId} has unusable status ${session.status || "empty"}`);
      return null;
    }
    const freshnessLimit = ["running", "waiting"].includes(session.status) ? staleSeconds : inactiveStaleSeconds;
    if (runtimeEvidence(session,now,{activeSeconds:staleSeconds,inactiveSeconds:inactiveStaleSeconds})!=='CURRENT') {
      addWarning(taskId, `${taskId} ${role} session ${sessionId} has stale runtime evidence`);
      return null;
    }
    return session;
  };
  for (const row of active) {
    const taskId = row[column.id];
    if(projectManager&&registeredManagerReference(row[column.manager_thread_id])!==projectManager)diagnostics.push(`${taskId} task manager route awaits reconciliation`);
    else if(!effectiveManager(row,column))diagnostics.push(`${taskId} has no manager session route; notification unavailable`);
    if (runtimeError) { if(runtimeMissing)diagnostics.push(`${taskId}: ${runtimeError}`);else addWarning(taskId, `${taskId}: ${runtimeError}`); continue; }
    // A newly activated task may briefly lack its execution route while thread creation returns.
    if (!row[column.execution_thread_id] && ageSeconds(row[column.modified_at], now) < routeGraceSeconds) continue;
    if(!row[column.dispatch_id])diagnostics.push(`${taskId} dispatch identity awaits reconciliation`);
    const execution = resolveSession(row[column.execution_thread_id], "execution", taskId);
    if (execution && effectiveManager(row,column)) usable.set(taskId, { execution });
    // A return to activity ends the previous inactive episode, even in the same turn.
    if (execution && ['running', 'waiting'].includes(execution.status) && row[column.recovery_state]) resetNotification(row);
  }
  const candidates = active.filter((row) => {
    const runtime = usable.get(row[column.id]);
    if (!runtime) return false;
    if (["running", "waiting"].includes(runtime.execution.status)) return false;
    const generation = recoveryGeneration(row, column, runtime.execution);
    const deduped = row[column.recovery_turn_id] === generation && (row[column.recovery_state] === 'sent'
      || (row[column.recovery_state] === 'pending' && ageSeconds(row[column.recovery_state_at], now) < pendingLeaseSeconds));
    return ageSeconds(runtime.execution.statusAt, now) >= graceSeconds && !deduped;
  });
  const warningCandidates = manager ? active.flatMap((row) => {
    const reasons = warningsByTask.get(row[column.id]) || [];
    if (!reasons.length) return [];
    const generation = `warning:${createHash("sha256").update(JSON.stringify({ dispatch: row[column.dispatch_id], execution: row[column.execution_thread_id], manager, reasons })).digest("hex").slice(0, 16)}`;
    const same = row[column.recovery_turn_id] === generation;
    // Legacy permanent mutes expire after one hour; new pauses require a reason and deadline.
    if (same && ageSeconds(row[column.recovery_state_at], now) < (row[column.recovery_state] === "pending" ? pendingLeaseSeconds : warningIntervalSeconds) && ["warning-sent", "pending", "warning-muted"].includes(row[column.recovery_state])) return [];
    return [{ row, generation, reasons }];
  }) : [];
  return { column, active, manager, candidates, warningCandidates, usable, changed, warnings,diagnostics };
}

async function mutate(action) {
  const lock=await acquireProcessLock(monitorFile+'.lock',{timeoutMs:2000});
  try {
    const rows=parseCsv(await readFile(csvPath,'utf8')),headers=rows[0]||[];
    if(!headers.length||new Set(headers).size!==headers.length||rows.slice(1).some(r=>r.length!==headers.length))throw new Error('invalid TASKS.csv shape');
    const ids=rows.slice(1).map(r=>r[headers.indexOf('id')]);
    if(ids.some(id=>!id)||new Set(ids).size!==ids.length)throw new Error('TASKS.csv task IDs must be nonempty and unique');
    const runtimeFields=['recovery_turn_id','recovery_state','recovery_state_at',...pauseFields];
    for(const field of runtimeFields)if(!headers.includes(field)){headers.push(field);for(const row of rows.slice(1))row.push('');}
    const col=Object.fromEntries(headers.map((h,i)=>[h,i]));
    let saved={version:1,tasks:{}};
    try{saved=JSON.parse(await readFile(monitorFile,'utf8'));if(saved.version!==1||!saved.tasks)throw new Error('invalid monitor snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}
    const scope=row=>monitorScope(Object.fromEntries(headers.map((h,i)=>[h,row[i]])),projectManager);
    let invalidated=false;
    for(const row of rows.slice(1)){
      const old=saved.tasks[row[col.id]],same=monitorScopeMatches(old?.scope,Object.fromEntries(headers.map((h,i)=>[h,row[i]])),projectManager);
      if(old&&!same&&runtimeFields.some(field=>old[field]))invalidated=true;
      for(const field of runtimeFields)row[col[field]]=same?old[field]||'':'';
    }
    const result=await action(rows);
    result.changed ||= invalidated;
    if(result.changed){
      const tasks=Object.fromEntries(rows.slice(1).map(row=>[row[col.id],{scope:scope(row),...Object.fromEntries(runtimeFields.map(h=>[h,row[col[h]]]))}]));
      const temporary=monitorFile+'.'+process.pid+'.tmp';
      await writeFile(temporary,JSON.stringify({version:1,tasks})+'\n',{mode:0o600});await rename(temporary,monitorFile);
    }
    return result;
  }finally{await lock.release();}
}

const runtime = await readRuntimeCache();
const claimed = await mutate((rows) => {
  const result = inspect(rows, runtime.sessions || new Map(), Date.now(), runtime.error || "",runtime.errorKind==='MISSING');
  const now = new Date().toISOString();
  for (const row of result.candidates) {
    const generation = recoveryGeneration(row, result.column, result.usable.get(row[result.column.id])?.execution);
    row[result.column.recovery_turn_id] = generation;
    row[result.column.recovery_state] = "pending";
    row[result.column.recovery_state_at] = now;
    row[result.column.modified_at] = now;
    result.changed = true;
  }
  for (const item of result.warningCandidates) {
    item.row[result.column.recovery_turn_id] = item.generation;
    item.row[result.column.recovery_state] = "pending";
    item.row[result.column.recovery_state_at] = now;
    item.row[result.column.modified_at] = now;
    result.changed = true;
  }
  return { ...result,
    tasks: result.candidates.map((row) => ({ id: row[result.column.id], dispatch: row[result.column.dispatch_id], execution: row[result.column.execution_thread_id], manager: effectiveManager(row,result.column), claimedAt: row[result.column.recovery_state_at], generation: recoveryGeneration(row, result.column, result.usable.get(row[result.column.id])?.execution) })),
    warningTasks: result.warningCandidates.map((item) => ({ id: item.row[result.column.id], dispatch: item.row[result.column.dispatch_id], execution: item.row[result.column.execution_thread_id], manager: effectiveManager(item.row,result.column), claimedAt: item.row[result.column.recovery_state_at], generation: item.generation, reasons: item.reasons })),
  };
});

async function reportPending() {
  let saved;try{saved=JSON.parse(await readFile(monitorFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const pending=Object.values(saved?.tasks||{}).filter(t=>t.recovery_state==='pending').length;
  if(process.env.CODEX_PM_REPORT_ACTION==='1')console.log(`CODEX_PM_PENDING ${pending}`);
  return pending;
}

if(claimed.diagnostics.length)console.log(`CODEX_PM_DIAGNOSTIC observation_coverage ${claimed.diagnostics.length}`);
for (const message of claimed.warnings) warning(message);
if (runtime.error && runtime.errorKind!=='MISSING' && !claimed.warnings.length) warning(runtime.error);
if (!claimed.tasks.length && !claimed.warningTasks.length) {
  const pending = await reportPending();
  if (pending) warning(`${pending} notification(s) await confirmation; pending lease ${pendingLeaseSeconds}s`);
  process.exit(claimed.warnings.length || runtime.error&&runtime.errorKind!=='MISSING' || pending ? 3 : 0);
}
if (!claimed.manager) { warning("active task has no manager_thread_id; cannot notify manager"); process.exit(3); }

async function deliver(kind, tasks, messageFor, successState) {
  if (!tasks.length) return true;
  // 重新核对 claim 身份；锁贯穿外部排队和确认，避免路由变更后向旧经理发送。
  const result = await mutate(async rows => {
    const col = Object.fromEntries(rows[0].map((field, index) => [field, index]));
    const latestConfig=await loadProjectConfig(repository);
    if(!latestConfig.ok|| (latestConfig.config.manager?registeredManagerReference(latestConfig.config.manager.threadId):null)!==projectManager)return {changed:false,sent:true,count:0};
    const eligible = tasks.flatMap(task => {
      const row = rows.slice(1).find(item => item[col.id] === task.id);
      if (!row || row[col.status] !== '进行中' || row[col.dispatch_id] !== task.dispatch
          || row[col.execution_thread_id] !== task.execution || effectiveManager(row,col) !== claimed.manager
          || row[col.recovery_turn_id] !== task.generation || row[col.recovery_state] !== 'pending'
          || row[col.recovery_state_at] !== task.claimedAt) return [];
      const currentTask = Object.fromEntries(rows[0].map((field, i) => [field, row[i]]));
      if (inspectPause(currentTask, runtime.sessions?.get(task.execution)?.turnId).paused) return [];
      return [{task, row}];
    });
    if (!eligible.length) return {changed: false, sent: true, count: 0};
    let sent = false;
    if (notifyDisabled) {
      console.warn(`WARNING: manager notification delivery disabled; ${eligible.length} ${kind} reminder(s) were not delivered and remain unconfirmed. Configure PROJECT_MANAGER_NOTIFY_BIN/PROJECT_MANAGER_NOTIFY_ARGS, or an explicitly configured PROJECT_MANAGER_CODEX_BIN for a verified legacy backend.`);
    } else {
      const message = messageFor(eligible.map(item => item.task));
      try{sent=(await sendNotification({manager:claimed.manager,message,kind,directory:args.get('--state-dir')||stateDir()})).state==='ACCEPTED';}
      catch(error){sent=false;console.error(`manager ${kind} delivery failed: ${error.message}`);}
    }
    const now = timestamp();
    for (const {task, row} of eligible) {
      row[col.recovery_state] = sent ? successState : '';
      row[col.recovery_turn_id] = sent ? task.generation : '';
      row[col.recovery_state_at] = sent ? now : '';
      row[col.modified_at] = now;
    }
    return {changed: true, sent, count: eligible.length};
  });
  if (result.sent && result.count && process.env.CODEX_PM_REPORT_ACTION === '1') console.log(`CODEX_PM_ACTION ${kind}-sent ${result.count}`);
  return result.sent;
}
const decisionHelp = '请通过已授权的本机工作台或 CLI 核对任务、回调与成果，再决定下一步。不要仅凭运行观察推断停止或完成。通知被接受不代表经理已处理。';
const recoveryMessage = () => `PROJECT_MANAGER_RECONCILIATION · 有执行活动结束，需要经理核对。\n${decisionHelp}`;
async function deliverGroups(kind,tasks,message,state){
  let ok=true;
  for(const manager of new Set(tasks.map(t=>t.manager))){claimed.manager=manager;ok=(await deliver(kind,tasks.filter(t=>t.manager===manager),message,state))&&ok;}
  return ok;
}
const recoverySent = await deliverGroups("recovery", claimed.tasks, recoveryMessage, "sent");
const warningMessage = () => `PROJECT_MANAGER_WARNING · 部分运行观察需要经理检查。\n${decisionHelp}`;
const warningSent = await deliverGroups("warning", claimed.warningTasks, warningMessage, "warning-sent");
const pending = await reportPending();
if (!recoverySent || !warningSent) process.exit(2);
if (claimed.warnings.length || pending) process.exit(3);
