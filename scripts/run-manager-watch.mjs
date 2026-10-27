#!/usr/bin/env node
import { acquireProcessLock } from "./process-lock.mjs";
import { taskLogResources, readAbsoluteLogEvidence } from './task-log-resources.mjs';

import { testingResources, readRepositoryFile } from "./testing-dashboard.mjs";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (["--once", "--no-server"].includes(key)) args.set(key, "true");
  else args.set(key, process.argv[++index]);
}

const repository = await realpath(path.resolve(args.get("--repo") || process.cwd()));
const codexHome = process.env.PROJECT_MANAGER_HOST_HOME || process.env.CODEX_HOME || process.env.DSH_HOME || path.join(os.homedir(), ".codex");
const runtimeCsvPath = path.resolve(process.env.CODEX_SESSION_RUNTIME_CSV || path.join(codexHome, "state", "session-runtime.csv"));
const intervalSeconds = Number(args.get("--interval") || 60);
const serverPort = Number(args.get("--port") ?? 9999);
if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) throw new Error("--interval must be a positive integer");
if (!Number.isInteger(serverPort) || serverPort < 0 || serverPort > 65535) throw new Error("--port must be an integer from 0 to 65535");
await readFile(path.join(repository, "TASKS.csv"), "utf8");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const watcher = path.join(scriptDir, "watch-active-tasks.mjs");
await readFile(watcher, "utf8");
const repositoryKey = createHash("sha256").update(repository).digest("hex").slice(0, 16);
const lockPath = path.join(os.tmpdir(), `codex-project-manager-watch-${repositoryKey}.lock`);
const interactive = process.stdout.isTTY || process.env.PROJECT_MANAGER_FORCE_TTY === "1";
const screenWidth = 84;
const eventClients = new Set();
const fileWatchers = [];
let changeTimer;

const dashboard = {
  status: "STARTING",
  startedAt: localTimestamp(),
  lastActionAt: "—",
  lastCheckedAt: "Not checked yet",
  runs: 0,
  webView: args.has("--once") || args.has("--no-server") ? "Disabled" : "Starting",
  message: "Preparing the active-task recovery watcher",
};

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

async function projectRuntimeCsv() {
  const taskRows = parseCsv(await readRepositoryFile(repository, "TASKS.csv", "utf8"));
  const taskHeaders = taskRows[0] || [];
  const sessionColumns = ["execution_thread_id", "manager_thread_id"].map((header) => taskHeaders.indexOf(header)).filter((index) => index >= 0);
  const registered = new Set(taskRows.slice(1).flatMap((row) => sessionColumns.map((index) => row[index]).filter(Boolean)));
  const runtimeRows = parseCsv(await readFile(runtimeCsvPath, "utf8"));
  const runtimeHeaders = runtimeRows[0] || [];
  const sessionColumn = runtimeHeaders.indexOf("session_id");
  if (sessionColumn < 0) throw new Error("session runtime cache missing session_id");
  const publishedHeaders = ["session_id", "status", "current_turn_id", "status_at", "last_seen_at"];
  const selectedColumns = publishedHeaders.map((header) => runtimeHeaders.indexOf(header));
  if (selectedColumns.some((index) => index < 0)) throw new Error("session runtime cache missing required columns");
  return Buffer.from(encodeCsv([publishedHeaders, ...runtimeRows.slice(1)
    .filter((row) => registered.has(row[sessionColumn]))
    .map((row) => selectedColumns.map((index) => row[index] || ""))]));
}

async function allowedDashboardPath(urlPath) {
  const relative = decodeURIComponent(urlPath === "/" ? "TASKS.html" : urlPath.replace(/^\/+/, ""));
  if (relative === "session-runtime.csv") return { relative, target: runtimeCsvPath };
  if (["TASKS.html", "TASKS.csv"].includes(relative)) return { relative, target: path.resolve(repository, relative) };
  const rows = parseCsv(await readRepositoryFile(repository, "TASKS.csv", "utf8"));
  const detailColumn = (rows[0] || []).indexOf("detail_path");
  if (detailColumn < 0) throw new Error("TASKS.csv missing detail_path");
  const details = new Set(rows.slice(1).map((row) => row[detailColumn]).filter(Boolean));
  const resources=await testingResources(repository,rows,parseCsv);
  const logs=await taskLogResources(repository,rows);
  for(const directory of [...resources.directories,...logs.directories]) watchTestingDirectory(directory);
  return (details.has(relative)||resources.allowed.has(relative)||logs.allowed.has(relative)) ? { relative, target: path.resolve(repository, relative) } : null;
}

const testingWatchers=new Set();
function watchTestingDirectory(directory){
  if(testingWatchers.has(directory)) return;
  try {const w=watch(directory,notifyDashboard);w.on("error",()=>{});fileWatchers.push(w);testingWatchers.add(directory);}catch{}
}
function contentType(relative) {
  const extension=path.extname(relative);
  const media={".pdf":"application/pdf", ".json":"application/json", ".jsonl":"application/x-ndjson", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".webp":"image/webp", ".mp4":"video/mp4", ".webm":"video/webm", ".txt":"text/plain", ".log":"text/plain"};
  if(media[extension]) return media[extension];
  if (relative.endsWith(".html")) return "text/html; charset=utf-8";
  if (relative.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "text/markdown; charset=utf-8";
}

async function serveDashboard(request, response) {
  try {
    if (!["GET", "HEAD"].includes(request.method || "")) {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/health") {
      const body = Buffer.from(JSON.stringify({
        repository,
        pid: process.pid,
        status: dashboard.status,
        webView: dashboard.webView,
        lastCheckedAt: dashboard.lastCheckedAt,
      }));
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (requestUrl.pathname === "/events") {
      response.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      if (request.method === "HEAD") { response.end(); return; }
      eventClients.add(response);
      response.write("event: change\ndata: connected\n\n");
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if(requestUrl.pathname==='/task-log-file'){
      const rows=parseCsv(await readRepositoryFile(repository,'TASKS.csv','utf8'));
      const file=await readAbsoluteLogEvidence(repository,rows,requestUrl.searchParams.get('card'),requestUrl.searchParams.get('ref'));
      if(file.contentType==='application/octet-stream')response.setHeader('Content-Disposition','attachment');
      response.writeHead(200,{'Content-Type':file.contentType,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});response.end(request.method==='HEAD'?undefined:file.body);return;
    }
    const resource = await allowedDashboardPath(requestUrl.pathname);
    if (!resource) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
      return;
    }
    if (resource.relative !== "session-runtime.csv" && resource.target !== repository && !resource.target.startsWith(`${repository}${path.sep}`)) throw new Error("unsafe dashboard path");
    const body = resource.relative === "session-runtime.csv" ? await projectRuntimeCsv() : await readRepositoryFile(repository, resource.relative);
    if([".html",".htm",".svg"].includes(path.extname(resource.relative).toLowerCase())&&resource.relative!=="TASKS.html")response.setHeader("Content-Disposition","attachment");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType(resource.relative),
      "Content-Length": body.length,
      "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const code = error?.code === "ENOENT" ? 404 : ["EACCES","ELOOP"].includes(error?.code) ? 403 : 500;
    response.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(code === 404 ? "Not found\n" : code === 403 ? "Forbidden\n" : "Dashboard server error\n");
  }
}

function notifyDashboard() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => {
    for (const client of eventClients) client.write("event: change\ndata: updated\n\n");
  }, 100);
}

function watchDashboardFiles() {
  for (const [directory, filename] of [
    [repository, "TASKS.csv"],
    [path.dirname(runtimeCsvPath), path.basename(runtimeCsvPath)],
  ]) {
    try {
      const watcher = watch(directory, (_event, changed) => {
        if (changed === null || String(changed) === filename) notifyDashboard();
      });
      watcher.on("error", (error) => {
        dashboard.message = `Dashboard notification watcher unavailable: ${error.message}`;
        render();
      });
      fileWatchers.push(watcher);
    } catch (error) {
      dashboard.message = `Dashboard notification watcher unavailable: ${error.message}`;
    }
  }
}

async function startDashboardServer() {
  const server = createServer((request, response) => void serveDashboard(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverPort, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : serverPort;
  dashboard.webView = `http://127.0.0.1:${port}/TASKS.html`;
  await writeLockRecord();
  watchDashboardFiles();
  return server;
}

async function closeDashboardServer(server) {
  if (!server) return;
  clearTimeout(changeTimer);
  for (const watcher of fileWatchers) watcher.close();
  fileWatchers.length = 0;
  for (const client of eventClients) client.end();
  eventClients.clear();
  await new Promise((resolve) => server.close(resolve));
}

function localTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

async function latestRecordedAction() {
  const rows = parseCsv(await readRepositoryFile(repository, "TASKS.csv", "utf8"));
  const headers = rows[0] || [];
  const stateColumn = headers.indexOf("recovery_state");
  const timeColumn = headers.indexOf("recovery_state_at");
  if (stateColumn < 0 || timeColumn < 0) return "—";
  const timestamps = rows.slice(1)
    .filter((row) => ["sent", "warning-sent"].includes(row[stateColumn]))
    .map((row) => Date.parse(row[timeColumn]))
    .filter(Number.isFinite);
  return timestamps.length ? localTimestamp(new Date(Math.max(...timestamps))) : "—";
}

let processLock;
async function acquireLock() {
  processLock = await acquireProcessLock(lockPath + ".guard", {timeoutMs:1000});
  try {
    const previousPid = lockOwner(await readFile(lockPath, "utf8"));
    if (Number.isInteger(previousPid) && previousPid > 0) {
      try {
        process.kill(previousPid, 0);
        throw new Error(`watcher already running for this repository (pid ${previousPid})`);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await unlink(lockPath).catch(() => undefined);
  } catch (error) {
    if (error.code !== "ENOENT") {await processLock.release(); processLock = null; throw error;}
  }
  const lock = await open(lockPath, "wx", 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, repository, webView: null }));
  await lock.close();
}

function lockOwner(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Number(typeof parsed === "object" && parsed ? parsed.pid : parsed);
  } catch { return Number(raw.trim()); }
}

async function writeLockRecord() {
  const temporary = `${lockPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ pid: process.pid, repository, webView: dashboard.webView }), { mode: 0o600 });
  await rename(temporary, lockPath);
}

async function releaseLock() {
  try {
    const owner = lockOwner(await readFile(lockPath, "utf8"));
    if (owner === process.pid) await unlink(lockPath);
  } catch {}
  await processLock?.release(); processLock = null;
}

async function checkOnce() {
  return new Promise((resolve, reject) => {
    let action = false,diagnostic=false;
    const child = spawn(process.execPath, [watcher, "--repo", repository], {
      env: { ...process.env, CODEX_PM_REPORT_ACTION: "1" },
      stdio: ["inherit", "pipe", "inherit"],
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if(chunk.includes("CODEX_PM_DIAGNOSTIC"))diagnostic=true;
      if (chunk.includes("CODEX_PM_ACTION reconciliation-sent") || chunk.includes("CODEX_PM_ACTION recovery-sent") || chunk.includes("CODEX_PM_ACTION warning-sent")) action = true;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ warning: false, action,diagnostic });
      else if (code === 3) resolve({ warning: true, action,diagnostic });
      else reject(new Error(`watcher check failed: ${signal || `exit ${code}`}`));
    });
  });
}

function visibleLength(value) {
  return [...String(value)].length;
}

function truncate(value, width) {
  const text = String(value);
  if (visibleLength(text) <= width) return text;
  return `${[...text].slice(0, Math.max(0, width - 1)).join("")}…`;
}

function row(label, value) {
  const innerWidth = screenWidth - 4;
  const labelWidth = 16;
  const content = `${String(label).padEnd(labelWidth)}${truncate(value, innerWidth - labelWidth)}`;
  return `│ ${content.padEnd(innerWidth)} │`;
}

function render() {
  const line = "─".repeat(screenWidth - 2);
  const title = "CODEX PROJECT MANAGER · RECOVERY WATCH";
  const lines = [
    `┌${line}┐`,
    `│ ${title.padEnd(screenWidth - 4)} │`,
    `├${line}┤`,
    row("STATUS", dashboard.status),
    row("PROJECT", repository),
    row("MANAGER", "TASKS.csv routing"),
    row("PROCESS", process.pid),
    row("INTERVAL", args.has("--once") ? "One-time check" : `${intervalSeconds} seconds`),
    row("WEB VIEW", dashboard.webView),
    row("STARTED", dashboard.startedAt),
    row("LAST CHECKED", dashboard.lastCheckedAt),
    row("LAST ACTION", dashboard.lastActionAt),
    row("RUNS", dashboard.runs),
    `├${line}┤`,
    row("MESSAGE", dashboard.message),
    row("CONTROL", args.has("--once") ? "Exits after this check" : "Press Ctrl+C to stop"),
    `└${line}┘`,
  ];
  if (interactive) process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${lines.join("\n")}\n`);
}

dashboard.lastActionAt = await latestRecordedAction();
await acquireLock();
let stopping = false;
let timer;
let dashboardServer;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  await closeDashboardServer(dashboardServer);
  await releaseLock();
  dashboard.status = "STOPPED";
  dashboard.message = `Stopped by ${signal}`;
  render();
  process.exit(0);
}
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

try {
  if (!args.has("--once") && !args.has("--no-server")) dashboardServer = await startDashboardServer();
  render();
  do {
    dashboard.runs += 1;
    dashboard.status = "CHECKING";
    dashboard.message = "Checking active task and session state"
    render();
    try {
      const check = await checkOnce();
      dashboard.status = check.warning ? "WARNING" : check.diagnostic?"OBSERVATION_PENDING":"HEALTHY";
      dashboard.lastCheckedAt = localTimestamp();
      if (check.action) dashboard.lastActionAt = localTimestamp();
      dashboard.message = check.warning
        ? "Session monitoring unavailable; task data and Web view remain available"
        : check.diagnostic?"Observation coverage is partial; the manager can reconcile during later coordination":args.has("--once")
          ? "One-time check completed successfully"
          : `Next check in ${intervalSeconds} seconds`;
      render();
    } catch (error) {
      dashboard.status = "ERROR";
      dashboard.message = error instanceof Error ? error.message : String(error);
      render();
      throw error;
    }
    if (args.has("--once")) break;
    await new Promise((resolve) => { timer = setTimeout(resolve, intervalSeconds * 1000); });
  } while (!stopping);
} finally {
  await closeDashboardServer(dashboardServer);
  await releaseLock();
}
