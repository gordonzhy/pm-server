#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { open, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createServer as createProbeServer } from "node:net";
import { acquireProcessLock } from "./process-lock.mjs";
import { readProjectConfig } from "./project-config.mjs";

const argumentsList = process.argv.slice(2);
const command = argumentsList.includes("--status") ? "status" : argumentsList.includes("--stop") ? "stop" : "ensure";
const repoIndex = argumentsList.indexOf("--repo");
if (repoIndex < 0 || !argumentsList[repoIndex + 1]) throw new Error("--repo <repository-root> is required");
const repository = await realpath(path.resolve(argumentsList[repoIndex + 1]));
await readFile(path.join(repository, "TASKS.csv"), "utf8");
await readFile(path.join(repository, "TASKS.html"), "utf8");
const key = createHash("sha256").update(repository).digest("hex").slice(0, 16);
const lockPath = path.join(os.tmpdir(), `codex-project-manager-watch-${key}.lock`);
const startupLockPath = path.join(os.tmpdir(), `codex-project-manager-start-${key}.lock`);
const logPath = path.join(os.tmpdir(), `codex-project-manager-watch-${key}.log`);
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-manager-watch.mjs");

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

function explainLoopbackError(error) {
  if (error?.code === "EPERM" || error?.cause?.code === "EPERM") {
    throw new Error("当前执行沙箱不能访问本机回环地址；请在允许本机回环访问的环境中检查服务");
  }
}

async function record() {
  try {
    const raw = (await readFile(lockPath, "utf8")).trim();
    const parsed = JSON.parse(raw);
    return typeof parsed === "number" ? { pid: parsed, legacy: true } : parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return { invalid: true };
  }
}

async function verifiedService() {
  const current = await record();
  if (current?.invalid) throw new Error(`无法读取服务锁：${lockPath}`);
  if (!current || !alive(current.pid)) return null;
  if (current.legacy) {
    const url = "http://127.0.0.1:8765/TASKS.html";
    try {
      const response = await fetch("http://127.0.0.1:8765/TASKS.csv", { signal: AbortSignal.timeout(1000) });
      if (response.ok && await response.text() === await readFile(path.join(repository, "TASKS.csv"), "utf8")) {
        return { pid: current.pid, url, legacy: true };
      }
    } catch (error) { explainLoopbackError(error); }
    throw new Error(`服务锁属于存活进程，但无法核实看板：${lockPath}`);
  }
  if (current.repository !== repository) throw new Error(`服务锁的项目路径不匹配：${lockPath}`);
  if (!current.webView) return null;
  try {
    const healthUrl = new URL("/health", current.webView);
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    if (response.ok) {
      const health = await response.json();
      if (health.repository === repository && health.pid === current.pid && health.webView === current.webView) {
        return { pid: current.pid, url: current.webView, status: health.status };
      }
    }
  } catch (error) { explainLoopbackError(error); }
  throw new Error(`服务进程仍在，但健康检查失败：${lockPath}`);
}

function output(state, service = {}) {
  process.stdout.write(`${JSON.stringify({ state, repository, ...service })}\n`);
}

async function assertPortAvailable(port) {
  const probe = createProbeServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") throw new Error(`本项目看板端口 ${port} 已被其他进程占用；请核对共享工作台身份，隔离测试可显式指定 --port`);
    throw error;
  } finally {
    if (probe.listening) await new Promise((resolve) => probe.close(resolve));
  }
}

async function withStartupLock(action) {
  const lock = await acquireProcessLock(startupLockPath, {timeoutMs:12000});
  try { return await action(); } finally { await lock.release(); }
}

if (command === "status") {
  const service = await verifiedService();
  output(service ? "running" : "stopped", service || {});
} else await withStartupLock(async () => {
if (command === "stop") {
  const service = await verifiedService();
  if (!service) output("stopped");
  else {
    process.kill(service.pid, "SIGTERM");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const current = await record();
      if (!current || current.pid !== service.pid) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const current = await record();
    output(current?.pid === service.pid ? "stopping" : "stopped", { pid: service.pid });
  }
} else {
  let service = await verifiedService();
  if (service) output("running", service);
  else {
    const config = await readProjectConfig(repository);
    const portIndex = argumentsList.indexOf("--port");
    const port = portIndex < 0 ? config.port : Number(argumentsList[portIndex + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port 必须是 1–65535 的端口号");
    await assertPortAvailable(port);
    const log = openSync(logPath, "a", 0o600);
    const child = spawn(process.execPath, [runner, "--repo", repository, "--port", String(port)], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    child.unref();
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { service = await verifiedService(); }
      catch (error) {
        if (child.exitCode !== null) throw error;
      }
      if (service) break;
      if (child.exitCode !== null) break;
    }
    if (!service) throw new Error(`看板服务启动后未通过健康检查；端口 ${port} 可能被占用，请查看 ${logPath}`);
    output("started", { ...service, logPath });
  }
}
});
