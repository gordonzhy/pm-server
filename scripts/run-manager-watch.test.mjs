import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile, symlink, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(scripts, "run-manager-watch.mjs");
const manager = path.join(scripts, "manage-dashboard-service.mjs");

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "project-manager-runner-")));
  const repo = path.join(root, "repo");
  const spool = path.join(root, "spool");
  const state = path.join(root, "state");
  const queueLog = path.join(root, "queue.log");
  const fakeCodex = path.join(root, "codex");
  const runtimeCsv = path.join(root, "session-runtime.csv");
  await Promise.all([mkdir(repo), mkdir(spool), mkdir(state)]);
  await writeFile(path.join(repo, "TASKS.csv"), "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at\n");
  await writeFile(path.join(repo, "TASKS.html"), "<!doctype html><title>Test dashboard</title>\n");
  await writeFile(runtimeCsv, "session_id,name,status,current_turn_id,status_at,last_seen_at\n");
  await writeFile(fakeCodex, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$PROJECT_MANAGER_QUEUE_LOG\"\n");
  await chmod(fakeCodex, 0o755);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return {
    port,
    repo,
    env: {
      ...process.env,
      PM_SERVER_STATE_DIR: path.join(root,"server-state"),
      PROJECT_MANAGER_EVENT_DIR: spool,
      PROJECT_MANAGER_STATE_DIR: state,
      PROJECT_MANAGER_CODEX_BIN: fakeCodex,
      PROJECT_MANAGER_QUEUE_LOG: queueLog,
      CODEX_SESSION_RUNTIME_CSV: runtimeCsv,
    },
  };
}

test("foreground runner supports an explicit one-shot check", async () => {
  const fx = await fixture();
  const output = execFileSync(process.execPath, [runner, "--repo", fx.repo, "--once"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    encoding: "utf8",
  });
  assert.match(output, /\x1b\[2J\x1b\[H/);
  assert.match(output, /CODEX PROJECT MANAGER · RECOVERY WATCH/);
  assert.match(output, /STATUS\s+HEALTHY/);
  assert.match(output, /STARTED\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(output, /LAST CHECKED\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(output, /LAST ACTION\s+—/);
  assert.doesNotMatch(output, /LAST EXECUTION/);
  assert.match(output, /RUNS\s+1/);
  assert.match(output, /WEB VIEW\s+Disabled/);
  assert.match(output, /One-time check completed successfully/);
});

test("foreground runner records an action only when recovery is sent", async () => {
  const fx = await fixture();
  const execution = "11111111-1111-4111-8111-111111111111";
  const manager = "22222222-2222-4222-8222-222222222222";
  const now = new Date(Date.now() - 2 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await writeFile(path.join(fx.repo, "TASKS.csv"), `id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at\nTEST-001,进行中,P0,Test,Test,[],AI,2026-01-01T00:00:00+08:00,2026-01-01T00:00:00+08:00,test.md,dispatch-test,${execution},turn-1,${manager},manager-turn,,,\n`);
  await writeFile(fx.env.CODEX_SESSION_RUNTIME_CSV, `session_id,name,status,current_turn_id,status_at,last_seen_at\n${execution},Execution,idle,turn-1,${now},${now}\n${manager},Manager,idle,manager-turn,${now},${now}\n`);
  await mkdir(path.join(fx.env.PM_SERVER_STATE_DIR,'monitor'),{recursive:true});
  await writeFile(path.join(fx.env.PM_SERVER_STATE_DIR,'monitor',createHash('sha256').update(fx.repo).digest('hex')+'.json'),JSON.stringify({version:1,tasks:{'TEST-001':{scope:JSON.stringify(['dispatch-test',execution,'','codex:default:'+manager]),reminders:{recovery:{generation:'fixture',attempts:0,queuedAt:Date.now()-600001,nextAt:0}}}}}));
  const output = execFileSync(process.execPath, [runner, "--repo", fx.repo, "--once"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    encoding: "utf8",
  });
  assert.match(output, /LAST CHECKED\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(output, /LAST ACTION\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(await readFile(fx.env.PROJECT_MANAGER_QUEUE_LOG, "utf8"), /PROJECT_MANAGER_RECONCILIATION/);
});

test("foreground runner restores the latest recorded recovery action", async () => {
  const fx = await fixture();
  await writeFile(path.join(fx.repo, "TASKS.csv"), "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at\nTEST-001,受阻,P0,Test,Test,[],AI,2026-01-01T00:00:00+08:00,2026-09-21T10:11:12Z,test.md,dispatch-test,execution,turn-1,manager,manager-turn,turn-1,sent,2026-09-21T10:11:12Z\n");
  const output = execFileSync(process.execPath, [runner, "--repo", fx.repo, "--once"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    encoding: "utf8",
  });
  assert.match(output, /LAST ACTION\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(output, /LAST ACTION\s+—/);
});

test("foreground runner distinguishes partial observation coverage from an alert", async () => {
  const fx = await fixture();
  const taskPath=path.join(fx.repo,'TASKS.csv'),columns=(await readFile(taskPath,'utf8')).trim().split(',');
  const task={id:'DEMO-001',status:'进行中',priority:'P1',boundary:'Demo',title:'Demo',dependencies:'[]',executor:'AI',created_at:new Date().toISOString(),modified_at:new Date().toISOString(),detail_path:'test.md',manager_thread_id:'22222222-2222-4222-8222-222222222222'};
  await writeFile(taskPath,columns.join(',')+'\n'+columns.map(h=>task[h]||'').join(',')+'\n');
  fx.env.CODEX_SESSION_RUNTIME_CSV = path.join(path.dirname(fx.repo), "missing.csv");
  const output = execFileSync(process.execPath, [runner, "--repo", fx.repo, "--once"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    encoding: "utf8",
  });
  assert.match(output, /STATUS\s+OBSERVATION_PENDING/);
  assert.match(output, /LAST CHECKED\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(output, /LAST ACTION\s+—/);
  assert.match(output, /Observation coverage is partial/);
});

test("foreground runner defaults to a sixty-second interval", async () => {
  const fx = await fixture();
  const child = spawn(process.execPath, [runner, "--repo", fx.repo, "--port", "0"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runner did not expose its default interval\n${output}\n${errorOutput}`)), 3000);
    child.stdout.on("data", () => {
      if (output.includes("INTERVAL") && output.includes("60 seconds") && output.includes("HEALTHY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.match(output, /INTERVAL\s+60 seconds/);
  assert.match(output, /WEB VIEW\s+http:\/\/127\.0\.0\.1:\d+\/TASKS\.html/);
});

test("foreground runner serves only dashboard data, runtime observation, and indexed task details", async () => {
  const fx = await fixture();
  const child = spawn(process.execPath, [runner, "--repo", fx.repo, "--port", "0"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  const base = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runner did not expose its web view\n${output}\n${errorOutput}`)), 3000);
    child.stdout.on("data", () => {
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/TASKS\.html/);
      if (match && output.includes("HEALTHY")) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
  });
  const dashboard = await fetch(`${base}/TASKS.html`);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Test dashboard/);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.repository, fx.repo);
  assert.equal(health.pid, child.pid);
  assert.equal(health.webView, `${base}/TASKS.html`);
  const csv = await fetch(`${base}/TASKS.csv`);
  assert.equal(csv.status, 200);
  assert.match(await csv.text(), /^id,status,/);
  await writeFile(path.join(fx.repo, "TASKS.csv"), "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at\nTEST-001,进行中,P1,Test,Test,[],AI,2026-01-01T00:00:00+08:00,2026-01-01T00:00:00+08:00,test.md,dispatch-test,local-session,,,,,,,\n");
  await writeFile(fx.env.CODEX_SESSION_RUNTIME_CSV, "session_id,name,status,current_turn_id,status_at,last_seen_at,cwd,model\nlocal-session,Local,running,turn-1,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,/local,model-a\nforeign-session,Other,waiting,turn-2,2026-01-01T00:00:00Z,2026-01-01T00:00:00Z,/private,model-b\n");
  const runtime = await fetch(`${base}/session-runtime.csv`);
  assert.equal(runtime.status, 200);
  const runtimeBody = await runtime.text();
  assert.match(runtimeBody, /^session_id,status,/);
  assert.match(runtimeBody, /local-session,running/);
  assert.doesNotMatch(runtimeBody, /foreign-session|\/private|model-b|\/local|model-a/);
  const eventController = new AbortController();
  const events = await fetch(`${base}/events`, { signal: eventController.signal });
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type"), /text\/event-stream/);
  const reader = events.body.getReader();
  const decoder = new TextDecoder();
  let eventText = decoder.decode((await reader.read()).value);
  assert.match(eventText, /data: connected/);
  await writeFile(path.join(fx.repo, "TASKS.csv"), "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at\nTEST-001,待办,P1,Test,Changed,[],AI,2026-01-01T00:00:00+08:00,2026-01-01T00:00:00+08:00,test.md,,,,,,,,\n");
  const changed = await Promise.race([
    reader.read(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("no SSE change event")), 2000)),
  ]);
  eventText = decoder.decode(changed.value);
  assert.match(eventText, /data: updated/);
  eventController.abort();
  assert.equal((await fetch(`${base}/package.json`)).status, 404);
  child.kill("SIGTERM");
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
});

test("manager starts, reuses, and stops one background service per repository", async () => {
  const fx = await fixture();
  const run = (...flags) => JSON.parse(execFileSync(process.execPath, [manager, "--repo", fx.repo, "--port", String(fx.port), ...flags], {
    env: fx.env,
    encoding: "utf8",
    timeout: 10000,
  }));
  try {
    const first = run();
    assert.equal(first.state, "started");
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/TASKS\.html$/);
    assert.equal((await fetch(first.url)).status, 200);
    const second = run();
    assert.equal(second.state, "running");
    assert.equal(second.pid, first.pid);
    assert.equal(second.url, first.url);
    assert.equal(run("--status").state, "running");
    assert.equal(run("--stop").state, "stopped");
    const restarted = run();
    assert.equal(restarted.state, "started");
    assert.notEqual(restarted.pid, first.pid);
    assert.equal(restarted.url, first.url);
    assert.equal((await fetch(restarted.url)).status, 200);
  } finally {
    assert.equal(run("--stop").state, "stopped");
    assert.equal(run("--status").state, "stopped");
  }
});

test("manager refuses a port occupied by another process without stopping it", async () => {
  const fx = await fixture();
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const port = occupied.address().port;
  try {
    fx.port = port;
    assert.throws(() => execFileSync(process.execPath, [manager, "--repo", fx.repo, "--port", String(fx.port)], {
      env: fx.env,
      encoding: "utf8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    }), (error) => /已被其他进程占用/.test(String(error.stderr)));
    assert.equal(occupied.listening, true);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("concurrent managers reuse each isolated service with explicit test ports", async () => {
  const projects = await Promise.all([fixture(), fixture()]);
  const launch = (fx) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manager, "--repo", fx.repo, "--port", String(fx.port)], {
      env: fx.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(JSON.parse(stdout));
      else reject(new Error(`manager exited ${code}: ${stderr}`));
    });
  });
  try {
    const results = await Promise.all([
      launch(projects[0]), launch(projects[0]), launch(projects[0]),
      launch(projects[1]), launch(projects[1]),
    ]);
    assert.equal(new Set(results.slice(0, 3).map((result) => result.pid)).size, 1);
    assert.equal(new Set(results.slice(3).map((result) => result.pid)).size, 1);
    assert.notEqual(results[0].pid, results[3].pid);
    assert.notEqual(new URL(results[0].url).port, new URL(results[3].url).port);
    assert.equal((await fetch(results[0].url)).status, 200);
    assert.equal((await fetch(results[3].url)).status, 200);
  } finally {
    for (const fx of projects) {
      const stopped = JSON.parse(execFileSync(process.execPath, [manager, "--repo", fx.repo, "--port", String(fx.port), "--stop"], {
        env: fx.env,
        encoding: "utf8",
        timeout: 10000,
      }));
      assert.equal(stopped.state, "stopped");
    }
  }
});

test("foreground runner stops on SIGTERM and removes its lock", async () => {
  const fx = await fixture();
  const child = spawn(process.execPath, [runner, "--repo", fx.repo, "--interval", "60", "--port", "0"], {
    env: { ...fx.env, PROJECT_MANAGER_FORCE_TTY: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { errorOutput += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`runner did not start\n${output}\n${errorOutput}`)), 3000);
    child.stdout.on("data", () => {
      if (output.includes("STATUS") && output.includes("HEALTHY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  child.kill("SIGTERM");
  const code = await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(code, 0);
  assert.match(output, /STATUS\s+STOPPED/);
  assert.match(output, /Stopped by SIGTERM/);

  const repositoryKey = (await import("node:crypto")).createHash("sha256").update(path.resolve(fx.repo)).digest("hex").slice(0, 16);
  await assert.rejects(stat(path.join(os.tmpdir(), `codex-project-manager-watch-${repositoryKey}.lock`)), { code: "ENOENT" });
});

test("indexed details enforce realpath on HTTP reads including file and directory symlinks", async () => {
  const fx = await fixture();
  await mkdir(path.join(fx.repo,"tasks"));
  const outside=path.join(path.dirname(fx.repo),"synthetic-outside");await mkdir(outside);
  await writeFile(path.join(fx.repo,"tasks/normal.md"),"PUBLIC_DETAIL");await writeFile(path.join(outside,"secret.md"),"SYNTHETIC_OUTSIDE_SECRET");
  await symlink(path.join(fx.repo,"tasks/normal.md"),path.join(fx.repo,"tasks/safe.md"));await symlink(path.join(outside,"secret.md"),path.join(fx.repo,"tasks/escape.md"));await symlink(outside,path.join(fx.repo,"tasks/outside"));
  const header=(await readFile(path.join(fx.repo,"TASKS.csv"),"utf8")).trim();
  await writeFile(path.join(fx.repo,"TASKS.csv"),header+"\n"+[["TEST-001","tasks/normal.md"],["TEST-002","tasks/safe.md"],["TEST-003","tasks/escape.md"],["TEST-004","tasks/outside/secret.md"]].map(([id,file])=>[id,"待办","P1","QA","Test","[]","QA","2026-10-09T00:00:00Z","2026-10-09T00:00:00Z",file,...Array(8).fill("")].join(",")).join("\n")+"\n");
  const child=spawn(process.execPath,[runner,"--repo",fx.repo,"--port","0"],{env:{...fx.env,PROJECT_MANAGER_FORCE_TTY:"1"},stdio:["ignore","pipe","pipe"]});let output="",errors="";child.stdout.on("data",x=>output+=x);child.stderr.on("data",x=>errors+=x);
  try {
    const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("Temporary server failed "+errors)),4000);child.stdout.on("data",()=>{const match=output.match(/http:\/\/127\.0\.0\.1:(\d+)\/TASKS.html/);if(match){clearTimeout(timer);resolve("http://127.0.0.1:"+match[1]);}});});
    for(const [file,expected] of [["tasks/normal.md",200],["tasks/safe.md",200],["tasks/escape.md",403],["tasks/outside/secret.md",403],["tasks/unregistered.md",404]]) {
      const response=await fetch(base+"/"+file);assert.equal(response.status,expected);assert(!(await response.text()).includes("SYNTHETIC_OUTSIDE_SECRET"));
    }
  } finally {if(child.exitCode===null && child.signalCode===null){const done=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await done;}await rm(path.dirname(fx.repo),{recursive:true,force:true});}
});
