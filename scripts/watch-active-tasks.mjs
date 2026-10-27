#!/usr/bin/env node

import {codexReference,runtimeEvidence,cachedRuntimeSession} from '../lib/codex-runtime-observer.mjs';
import {deliverReminder} from '../lib/reminder-delivery.mjs';
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
  const turn = 'business-event';
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
    // Ordinary activity does not resolve an unhandled business event.
  }
  const candidates = active.filter((row) => {
    const runtime = usable.get(row[column.id]);
    if (!runtime) return false;
    if (["running", "waiting"].includes(runtime.execution.status)) return false;
    const generation = recoveryGeneration(row, column, runtime.execution);
    const deduped = false; // Persisted business-event policy below owns deduplication/backoff.
    return ageSeconds(runtime.execution.statusAt, now) >= graceSeconds && !deduped;
  });
  const warningCandidates = manager ? active.flatMap((row) => {
    const reasons = warningsByTask.get(row[column.id]) || [];
    if (!reasons.length) return [];
    const generation = `warning:${createHash("sha256").update(JSON.stringify({ dispatch: row[column.dispatch_id], execution: row[column.execution_thread_id], manager, reasons })).digest("hex").slice(0, 16)}`;
    const same = row[column.recovery_turn_id] === generation;
    // Legacy permanent mutes expire after one hour; new pauses require a reason and deadline.
    // Persisted business-event policy below owns warning cooling.
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
    try{saved=JSON.parse(await readFile(monitorFile,'utf8'));if(saved.version!==1||!saved.tasks||typeof saved.tasks!=='object'||Array.isArray(saved.tasks))throw new Error('invalid monitor snapshot');}catch(e){if(e.code!=='ENOENT')throw e;}
    const scope=row=>monitorScope(Object.fromEntries(headers.map((h,i)=>[h,row[i]])),projectManager);
    let invalidated=false;
    for(const row of rows.slice(1)){
      const old=saved.tasks[row[col.id]],same=monitorScopeMatches(old?.scope,Object.fromEntries(headers.map((h,i)=>[h,row[i]])),projectManager);
      if(old&&!same&&(runtimeFields.some(field=>old[field])||old.checkpoint||old.reminders))invalidated=true;
      for(const field of runtimeFields)row[col[field]]=same?old[field]||'':'';
    }
    const result=await action(rows,saved);
    result.changed ||= invalidated;
    if(result.changed){
      const tasks=Object.fromEntries(rows.slice(1).map(row=>[row[col.id],{...((monitorScopeMatches(saved.tasks[row[col.id]]?.scope,Object.fromEntries(headers.map((h,i)=>[h,row[i]])),projectManager))?saved.tasks[row[col.id]]:{}),scope:scope(row),...Object.fromEntries(runtimeFields.map(h=>[h,row[col[h]]]))}]));
      const temporary=monitorFile+'.'+process.pid+'.tmp';
      await writeFile(temporary,JSON.stringify({version:1,tasks})+'\n',{mode:0o600});await rename(temporary,monitorFile);
    }
    return result;
  }finally{await lock.release();}
}

const runtime = await readRuntimeCache();
const observedAt=Date.now();
const summary={state:'CHECKED',policyVersion:1,minimumBatchSeconds:600,tasks:[]};
await mutate(async(rows,saved)=>{
 const result=inspect(rows,runtime.sessions||new Map(),observedAt,runtime.error||'',runtime.errorKind==='MISSING');
 const col=result.column;
 for(const message of result.warnings)warning(message);
 if(result.diagnostics.length)console.log(`CODEX_PM_DIAGNOSTIC observation_coverage ${result.diagnostics.length}`);
 const candidates=new Map(result.candidates.map(row=>[row[col.id],{row,kind:'recovery',generation:recoveryGeneration(row,col)}]));
 for(const item of result.warningCandidates)candidates.set(item.row[col.id],{...item,kind:'warning'});
 for(const row of rows.slice(1)){
  const task=Object.fromEntries(rows[0].map((h,i)=>[h,row[i]])),id=task.id;
  const same=monitorScopeMatches(saved.tasks[id]?.scope,task,projectManager);
  const item=same?saved.tasks[id]:{scope:monitorScope(task,projectManager)};
  saved.tasks[id]=item;
  if(task.status!=='进行中'){if(item.reminders||item.checkpoint){delete item.reminders;delete item.checkpoint;result.changed=true;}continue;}
  const candidate=candidates.get(id);
  if(!candidate)continue; // Continue inspecting even while a checkpoint suppresses delivery.
  const manager=effectiveManager(row,col);if(!manager)continue;
  const checkpoint=item.checkpoint;
  if(checkpoint){
   if(!Number.isFinite(checkpoint.until)||!Number.isFinite(checkpoint.createdAt)||!checkpoint.reason||checkpoint.until-checkpoint.createdAt>86400000)throw new Error('INVALID_CHECKPOINT_STATE');
   if(checkpoint.createdAt>observedAt){checkpoint.createdAt=observedAt;checkpoint.until=Math.min(checkpoint.until,observedAt+86400000);result.changed=true;}
   if(checkpoint.until>observedAt){summary.tasks.push({task:id,state:'PROCESSING',nextCheckAt:new Date(checkpoint.until).toISOString()});continue;}
   delete item.checkpoint;item.reminders={};result.changed=true;
  }
  const migrating=!item.reminders;
  item.reminders||={};
  let event=item.reminders[candidate.kind];
  if(!event){
   // Conservatively inherit an old private receipt rather than fan out on upgrade.
   const legacy=Date.parse(task.recovery_state_at);
   const oldReceipt=migrating&&(candidate.kind==='warning'?['warning-sent','pending','warning-muted']:['sent','pending']).includes(task.recovery_state)&&Number.isFinite(legacy);
   event={generation:candidate.generation,attempts:0,queuedAt:observedAt,nextAt:oldReceipt?Math.max(observedAt+600000,legacy+3600000):observedAt};
   item.reminders[candidate.kind]=event;result.changed=true;
  }
  if(!Number.isFinite(event.queuedAt)||!Number.isFinite(event.nextAt)||!Number.isInteger(event.attempts)||event.attempts<0)throw new Error('INVALID_REMINDER_STATE');
  if(event.checkedAt>observedAt){event.queuedAt=observedAt;event.nextAt=observedAt+600000;result.changed=true;}
  event.checkedAt=observedAt;
  if(observedAt<event.nextAt){summary.tasks.push({task:id,kind:candidate.kind,state:'COOLING',nextCheckAt:new Date(event.nextAt).toISOString()});continue;}
  const receipt=await deliverReminder({directory:args.get('--state-dir')||stateDir(),manager,queuedAt:event.queuedAt,now:observedAt});
  event.delivery=receipt.deliveryState||receipt.state;
  if(receipt.state==='ACCEPTED'){
   event.attempts=Math.min(event.attempts+1,6);event.lastAcceptedAt=receipt.acceptedAt;
   event.nextAt=observedAt+Math.min(3600000*2**(event.attempts-1),86400000);
   event.queuedAt=event.nextAt; // A future due event joins the next batching window.
   row[col.recovery_state]=candidate.kind==='warning'?'warning-sent':'sent';row[col.recovery_turn_id]=candidate.generation;row[col.recovery_state_at]=new Date(observedAt).toISOString();
   if(process.env.CODEX_PM_REPORT_ACTION==='1'&&!receipt.coveredByBatch)console.log(`CODEX_PM_ACTION reconciliation-sent 1`);
  }else {event.nextAt=receipt.nextAt;if(receipt.state==='CLOCK_REBASED')event.queuedAt=observedAt;}
  summary.tasks.push({task:id,kind:candidate.kind,state:receipt.state,nextCheckAt:new Date(event.nextAt).toISOString()});result.changed=true;
 }
 const pending=Object.values(saved.tasks).flatMap(t=>Object.values(t.reminders||{})).filter(e=>['FAILED','UNKNOWN'].includes(e.delivery)).length;
 if(process.env.CODEX_PM_REPORT_ACTION==='1')console.log('CODEX_PM_PENDING '+pending);
 if(pending)process.exitCode=3;
 console.log('CODEX_PM_REMINDERS '+JSON.stringify(summary));
 if(result.warnings.length||runtime.error&&runtime.errorKind!=='MISSING')process.exitCode=3;
 return result;
});
