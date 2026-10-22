import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const watcher = path.join(scripts, "watch-active-tasks.mjs");
const headers = "id,status,priority,boundary,title,dependencies,executor,created_at,modified_at,detail_path,dispatch_id,execution_thread_id,execution_turn_id,manager_thread_id,manager_turn_id,recovery_turn_id,recovery_state,recovery_state_at";
const execution = "11111111-1111-4111-8111-111111111111";
const manager = "22222222-2222-4222-8222-222222222222";
const old = "2026-01-01T00:00:00Z";

async function fixture(executionState = "idle", managerState = "idle") {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "project-manager-recovery-")));
  const repo = path.join(root, "repo");
  const queueLog = path.join(root, "queue.log");
  const fakeCodex = path.join(root, "codex");
  const runtimeCsv = path.join(root, "session-runtime.csv");
  const runtimeNow = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await mkdir(repo);
  await writeFile(path.join(repo, "TASKS.csv"), `${headers}\nTEST-001,进行中,P0,Test,Test,[],AI,2026-01-01T00:00:00+08:00,2026-01-01T00:00:00+08:00,test.md,dispatch-test,${execution},turn-1,${manager},manager-turn,,,\n`);
  await writeFile(path.join(repo, "test.md"), "# TEST-001 Test\n\n## 任务日志\n\n- 2026-01-01T00:00:00Z 项目经理：创建测试任务，依据本地夹具。\n\n## 后续说明\n\n保留原文。\n");
  await writeFile(runtimeCsv, `session_id,name,status,current_turn_id,status_at,last_seen_at\n${execution},Execution,${executionState},turn-1,${runtimeNow},${runtimeNow}\n${manager},Manager,${managerState},manager-turn,${runtimeNow},${runtimeNow}\n`);
  await writeFile(fakeCodex, "#!/bin/sh\nprintf '%s\\0' \"$*\" >> \"$PROJECT_MANAGER_QUEUE_LOG\"\n");
  await chmod(fakeCodex, 0o755);
  return { repo, queueLog, runtimeCsv, env: { ...process.env, PM_SERVER_STATE_DIR: path.join(root,"server-state"), PROJECT_MANAGER_CODEX_BIN: fakeCodex, PROJECT_MANAGER_QUEUE_LOG: queueLog, CODEX_SESSION_RUNTIME_CSV: runtimeCsv } };
}

function stateFile(fx){return path.join(fx.env.PM_SERVER_STATE_DIR,'monitor',createHash('sha256').update(fx.repo).digest('hex')+'.json');}
async function state(fx){return JSON.parse(await readFile(stateFile(fx),'utf8'));}

function watch(fx) {
  execFileSync(process.execPath, [watcher, "--repo", fx.repo, "--grace", "0", "--stale-after", "1800"], { env: fx.env });
}

async function queues(fx) {
  try { return (await readFile(fx.queueLog, "utf8")).split("\0").filter(Boolean); }
  catch { return []; }
}

test("manager running does not suppress inactive execution reminder", async () => {
  const fx = await fixture("idle", "running");
  await writeFile(fx.runtimeCsv, (await readFile(fx.runtimeCsv, "utf8")).replaceAll(old, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")));
  watch(fx);
  assert.equal((await queues(fx)).length, 1);
});

test("running execution needs no recovery", async () => {
  const fx = await fixture("running", "idle");
  await writeFile(fx.runtimeCsv, (await readFile(fx.runtimeCsv, "utf8")).replaceAll(old, new Date().toISOString().replace(/\.\d{3}Z$/, "Z")));
  watch(fx);
  assert.deepEqual(await queues(fx), []);
});

test("running status stays fresh when activity is recent but the status began earlier", async () => {
  const fx = await fixture("running", "running");
  const runtime = await readFile(fx.runtimeCsv, "utf8");
  const aged = runtime.split("\n").map((line, index) => {
    if (!index || !line) return line;
    const fields = line.split(",");
    fields[4] = old;
    return fields.join(",");
  }).join("\n");
  await writeFile(fx.runtimeCsv, aged);
  watch(fx);
  assert.deepEqual(await queues(fx), []);
});

test("idle manager and execution queue exactly once per execution turn", async () => {
  const fx = await fixture();
  watch(fx);
  watch(fx);
  const lines = await queues(fx);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`--thread ${manager}`));
  assert.match(lines[0], /PROJECT_MANAGER_RECONCILIATION/);
  const body = lines[0].split("--message ")[1];
  for(const privateValue of [fx.repo,"TEST-001","turn-1","manager-turn",execution])assert.ok(!body.includes(privateValue));
  const csv = await readFile(path.join(fx.repo, "TASKS.csv"), "utf8");
  assert.equal((await state(fx)).tasks["TEST-001"].recovery_state,"sent");
  const columns = headers.split(",");
  const active = csv.split("\n")[1].split(",");
  assert.equal(active[columns.indexOf("modified_at")], "2026-01-01T00:00:00+08:00");
  await assert.rejects(access(path.join(fx.repo, "TASKS.html")));
});

test("inactive evidence remains usable beyond the active freshness window", async () => {
  const fx = await fixture();
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const lines = (await readFile(fx.runtimeCsv, "utf8")).trimEnd().split("\n");
  const aged = lines.slice(1).map((line) => {
    const fields = line.split(",");
    fields[4] = twoHoursAgo;
    fields[5] = twoHoursAgo;
    return fields.join(",");
  });
  await writeFile(fx.runtimeCsv, `${lines[0]}\n${aged.join("\n")}\n`);
  watch(fx);
  assert.equal((await queues(fx)).length, 1);
});

test("a new execution turn forms a new recovery generation", async () => {
  const fx = await fixture();
  watch(fx);
  const runtime = await readFile(fx.runtimeCsv, "utf8");
  await writeFile(fx.runtimeCsv, runtime.replace(`${execution},Execution,idle,turn-1,`, `${execution},Execution,idle,turn-2,`));
  watch(fx);
  assert.equal((await queues(fx)).length, 2);
});

test("runtime turns drive recovery when workers never update TASKS.csv", async () => {
  const fx = await fixture();
  const csvPath = path.join(fx.repo, "TASKS.csv");
  await writeFile(csvPath, (await readFile(csvPath, "utf8")).replace(`,turn-1,${manager}`, `,,${manager}`));
  watch(fx);
  const runtime = await readFile(fx.runtimeCsv, "utf8");
  await writeFile(fx.runtimeCsv, runtime.replace(`${execution},Execution,idle,turn-1,`, `${execution},Execution,idle,turn-2,`));
  watch(fx);
  assert.equal((await queues(fx)).length, 2);
  const csv = await readFile(csvPath, "utf8");
  assert.equal((await state(fx)).tasks["TEST-001"].recovery_state,"sent");
});

test("missing execution routes remain diagnostic after the registration window", async () => {
  const fx=await fixture(),csvPath=path.join(fx.repo,'TASKS.csv');
  await writeFile(csvPath,(await readFile(csvPath,'utf8')).replace(`,dispatch-test,${execution},`,',dispatch-test,,'));
  watch(fx);watch(fx);assert.deepEqual(await queues(fx),[]);
  await assert.rejects(state(fx),e=>e.code==='ENOENT');
});

test("missing global runtime cache remains diagnostic without manager messages or lifecycle changes", async () => {
  const fx=await fixture();fx.env.CODEX_SESSION_RUNTIME_CSV=path.join(path.dirname(fx.runtimeCsv),'missing.csv');
  const csv=await readFile(path.join(fx.repo,'TASKS.csv'),'utf8');watch(fx);watch(fx);
  assert.deepEqual(await queues(fx),[]);assert.equal(await readFile(path.join(fx.repo,'TASKS.csv'),'utf8'),csv);
  await assert.rejects(state(fx),e=>e.code==='ENOENT');
});

function watchWarning(fx) {
  try { watch(fx); } catch (error) { assert.equal(error.status, 3); }
}

test("manager can pause a warning with deadline and reason; a changed dispatch notifies again", async () => {
  const fx = await fixture();
  await writeFile(fx.runtimeCsv,(await readFile(fx.runtimeCsv,'utf8')).replace(`${execution},Execution,idle`,`${execution},Execution,unknown`));
  watchWarning(fx);
  const csvPath = path.join(fx.repo, "TASKS.csv");
  const first = await readFile(csvPath, "utf8");
  const generation = (await state(fx)).tasks["TEST-001"].recovery_turn_id;
  pause(fx);
  watchWarning(fx);
  assert.equal((await queues(fx)).length, 1);
  assert.equal(await readFile(csvPath,"utf8"),first);
  assert.ok((await state(fx)).tasks["TEST-001"].monitor_pause_until);
  await writeFile(csvPath, (await readFile(csvPath, "utf8")).replace("dispatch-test,", "dispatch-next,"));
  watchWarning(fx);
  assert.equal((await queues(fx)).length, 2);
});

const pauser = path.join(scripts, 'pause-task-monitor.mjs');
function pause(fx, extra = []) {
  execFileSync(process.execPath, [pauser, '--repo', fx.repo, '--task', 'TEST-001', '--until', new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/, 'Z'), '--reason', '等待定时批处理', '--actor', '项目经理', ...extra], {env: fx.env});
}
test('pause is stored outside project, preserves task files, expires and suppresses repeat checks', async () => {
  const fx = await fixture();
  pause(fx); pause(fx); watch(fx); watch(fx);
  assert.deepEqual(await queues(fx), []);
  const detail = await readFile(path.join(fx.repo, 'test.md'), 'utf8');
  assert.doesNotMatch(detail,/等待定时批处理/);assert.match(detail,/## 后续说明\n\n保留原文/);
  const saved=await state(fx);saved.tasks['TEST-001'].monitor_pause_until='2020-01-01T00:00:00Z';
  await writeFile(stateFile(fx),JSON.stringify(saved));
  watch(fx); watch(fx); assert.equal((await queues(fx)).length, 1);
});
test('new runtime turn or execution session cancels a pause', async () => {
  for (const change of ['turn', 'session']) {
    const fx = await fixture(); pause(fx);
    if (change === 'turn') await writeFile(fx.runtimeCsv, (await readFile(fx.runtimeCsv, 'utf8')).replace(`${execution},Execution,idle,turn-1`, `${execution},Execution,idle,turn-2`));
    else {
      const next = '33333333-3333-4333-8333-333333333333';
      await writeFile(path.join(fx.repo, 'TASKS.csv'), (await readFile(path.join(fx.repo, 'TASKS.csv'), 'utf8')).replace(`dispatch-test,${execution}`, `dispatch-test,${next}`));
      await writeFile(fx.runtimeCsv, (await readFile(fx.runtimeCsv, 'utf8')).replace(execution, next));
    }
    watch(fx); assert.equal((await queues(fx)).length, 1);
  }
});
test('nonactive lifecycle statuses receive no runtime reminders', async () => {
  for (const state of ['待办', '受阻', '待确认']) {
    const fx = await fixture();
    await writeFile(path.join(fx.repo, 'TASKS.csv'), (await readFile(path.join(fx.repo, 'TASKS.csv'), 'utf8')).replace('TEST-001,进行中,', `TEST-001,${state},`));
    watch(fx); assert.deepEqual(await queues(fx), []);
  }
});
test('manual resume changes application state and missing reason or deadline fails without project mutation', async () => {
  const fx = await fixture(); const csvPath = path.join(fx.repo, 'TASKS.csv'), before = await readFile(csvPath, 'utf8');
  assert.throws(() => execFileSync(process.execPath, [pauser, '--repo', fx.repo, '--task', 'TEST-001', '--actor', '项目经理'], {env: fx.env, stdio: 'pipe'}));
  assert.equal(await readFile(csvPath, 'utf8'), before);
  pause(fx);
  execFileSync(process.execPath, [pauser, '--repo', fx.repo, '--task', 'TEST-001', '--resume', '--reason', '批处理已结束', '--actor', '项目经理'], {env: fx.env});
  watch(fx); assert.equal((await queues(fx)).length, 1);
  assert.doesNotMatch(await readFile(path.join(fx.repo,'test.md'),'utf8'),/恢复执行会话监测/);
  assert.equal(await readFile(csvPath,'utf8'),before);
});
test('activity in the same turn rearms the next inactive episode', async () => {
  const fx = await fixture(); watch(fx);
  const cache = await readFile(fx.runtimeCsv, 'utf8');
  await writeFile(fx.runtimeCsv, cache.replace(`${execution},Execution,idle`, `${execution},Execution,running`)); watch(fx);
  await writeFile(fx.runtimeCsv, cache); watch(fx);
  assert.equal((await queues(fx)).length, 2);
});
test('failed queue delivery remains retryable', async () => {
  const fx = await fixture();
  const fake = fx.env.PROJECT_MANAGER_CODEX_BIN;
  const original = await readFile(fake, 'utf8'); await writeFile(fake, '#!/bin/sh\nexit 1\n');
  assert.throws(() => watch(fx), error => error.status === 2);
  await writeFile(fake, original); watch(fx); assert.equal((await queues(fx)).length, 1);
});


test('malformed task CSV is rejected without rewriting task facts', async () => {
  const fx = await fixture();
  const file = path.join(fx.repo, 'TASKS.csv'), original = await readFile(file, 'utf8');
  const variants = [original.replace('priority,', 'id,'), original + original.split('\n')[1] + '\n', original.replace('TEST-001,进行中', 'TEST-001,进行中,EXTRA'), original + '"unterminated'];
  for (const candidate of variants) {
    await writeFile(file, candidate);
    assert.throws(() => watch(fx));
    assert.equal(await readFile(file, 'utf8'), candidate);
  }
  assert.deepEqual(await queues(fx), []);
});


test("background recovery uses the saved backend in the explicit state directory without inherited notification variables", async () => {
  const fx = await fixture(),directory=fx.env.PM_SERVER_STATE_DIR;
  await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'notification-config.json'),JSON.stringify({version:1,backend:'codex'}));
  const env={...fx.env,PM_SERVER_STATE_DIR:path.join(directory,'different-default'),PATH:path.dirname(fx.env.PROJECT_MANAGER_CODEX_BIN)+path.delimiter+process.env.PATH,PROJECT_MANAGER_CODEX_BIN:'',PROJECT_MANAGER_NOTIFY_BIN:'',PROJECT_MANAGER_NOTIFY_DISABLED:''};
  execFileSync(process.execPath,[watcher,'--repo',fx.repo,'--state-dir',directory,'--grace','0','--stale-after','1800'],{env});
  assert.equal((await queues(fx)).length,1);
  assert.equal((await state(fx)).tasks['TEST-001'].recovery_state,'sent');
});
test('missing manager is a notification capability diagnostic, not an observation alert',async()=>{
 const fx=await fixture(),file=path.join(fx.repo,'TASKS.csv');
 await writeFile(file,(await readFile(file,'utf8')).replace(`,${manager},manager-turn`,',,manager-turn'));
 fx.env.CODEX_SESSION_RUNTIME_CSV=path.join(path.dirname(fx.runtimeCsv),'missing.csv');
 assert.doesNotThrow(()=>watch(fx));
 assert.deepEqual(await queues(fx),[]);
});
