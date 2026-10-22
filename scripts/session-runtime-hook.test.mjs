import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scripts = path.dirname(fileURLToPath(import.meta.url));
const installer = path.join(scripts, "install-session-runtime-hook.mjs");
const hook = path.join(scripts, "session-runtime-hook.mjs");

test("installer preserves unrelated hooks and is idempotent", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-hook-install-"));
  const hooksPath = path.join(codexHome, "hooks.json");
  await writeFile(hooksPath, `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } })}\n`);
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_SESSION_RUNTIME_CSV: path.join(codexHome,"state","session-runtime.csv") };
  assert.throws(() => execFileSync(process.execPath, [installer, "--check"], { env, encoding: "utf8" }), (error) => error.status === 3);
  const installOutput = execFileSync(process.execPath, [installer, "--install"], { env, encoding: "utf8" });
  assert.match(installOutput, /open Codex CLI, enter \/hooks/);
  assert.match(installOutput, /Codex Desktop cannot complete this trust step/);
  execFileSync(process.execPath, [installer, "--install"], { env, encoding: "utf8" });
  execFileSync(process.execPath, [installer, "--check"], { env, encoding: "utf8" });
  const configuration = JSON.parse(await readFile(hooksPath, "utf8"));
  const stopHandlers = configuration.hooks.Stop.flatMap((group) => group.hooks);
  assert.equal(stopHandlers.filter((handler) => handler.command === "true").length, 1);
  assert.equal(stopHandlers.filter((handler) => handler.command.includes("session-runtime-hook.mjs")).length, 1);
});

test("packaged hook creates the rebuildable global cache", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-hook-runtime-"));
  execFileSync(process.execPath, [hook], {
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_SESSION_RUNTIME_CSV: path.join(codexHome,"state","session-runtime.csv") },
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-a", turn_id: "turn-a", cwd: "/project", model: "model-a" }),
    encoding: "utf8",
  });
  const cache = await readFile(path.join(codexHome, "state", "session-runtime.csv"), "utf8");
  assert.match(cache, /session-a,running,turn-a,/);
  assert.doesNotMatch(cache, /\/project|model-a/);
});

test("tool activity refreshes observation time without resetting the current status time", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-hook-status-time-"));
  const state = path.join(codexHome, "state");
  const oldTime = "2026-01-01T00:00:00.000Z";
  await mkdir(state, { recursive: true });
  const cachePath = path.join(state, "session-runtime.csv");
  await writeFile(cachePath, `session_id,status,current_turn_id,status_at,last_seen_at\nsession-a,running,turn-a,${oldTime},${oldTime}\n`);
  const env = { ...process.env, CODEX_HOME: codexHome, CODEX_SESSION_RUNTIME_CSV: path.join(codexHome,"state","session-runtime.csv") };
  execFileSync(process.execPath, [hook], {
    env,
    input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: "session-a", turn_id: "turn-a" }),
  });
  let fields = (await readFile(cachePath, "utf8")).trimEnd().split("\n")[1].split(",");
  assert.equal(fields[1], "running");
  assert.equal(fields[3], oldTime);
  assert.notEqual(fields[4], oldTime);
  execFileSync(process.execPath, [hook], {
    env,
    input: JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "session-a", turn_id: "turn-a" }),
  });
  fields = (await readFile(cachePath, "utf8")).trimEnd().split("\n")[1].split(",");
  assert.equal(fields[1], "waiting");
  assert.notEqual(fields[3], oldTime);
});

test("packaged hook prunes expired cache rows", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-hook-prune-"));
  const state = path.join(codexHome, "state");
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, "session-runtime.csv"), "session_id,name,status,current_turn_id,status_at,last_seen_at,cwd,model\nexpired,,ended,,2020-01-01T00:00:00.000Z,2020-01-01T00:00:00.000Z,/old,\n");
  execFileSync(process.execPath, [hook], {
    env: { ...process.env, CODEX_HOME: codexHome, CODEX_SESSION_RUNTIME_CSV: path.join(codexHome,"state","session-runtime.csv") },
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-new", cwd: "/project" }),
    encoding: "utf8",
  });
  const cache = await readFile(path.join(state, "session-runtime.csv"), "utf8");
  assert.doesNotMatch(cache, /expired/);
  assert.match(cache, /session-new,idle/);
  assert.doesNotMatch(cache, /\/old|\/project/);
});
