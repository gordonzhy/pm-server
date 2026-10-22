import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { apply, RUNTIME_HEADERS } from "./observer.js";

function makeCtx() {
  const handlers = new Map();
  const warnings = [];
  return {
    ctx: {
      on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
      logger: { info() {}, warn(message) { warnings.push(String(message)); } },
    },
    fire(event, payload) { return handlers.get(event)?.(payload); },
    handlers,
    warnings,
  };
}

const sleep = () => new Promise((resolve) => setTimeout(resolve, 30));

test("三个生命周期事件写出 5 列观察缓存", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pm-observer-"));
  const runtimeCsv = path.join(dir, "state", "session-runtime.csv");
  const { ctx, fire, handlers } = makeCtx();
  const writer = apply(ctx, { runtimeCsv });
  assert.deepEqual([...handlers.keys()], ["agent/created", "agent/status", "agent/disposed"]);

  fire("agent/created", { agent: { id: "s-1", session: { id: "s-1" } } });
  fire("agent/status", { agent: { id: "s-1" }, status: "running", turnId: "turn-7" });
  fire("agent/status", { agent: { id: "s-1" }, status: "idle" });
  fire("agent/disposed", { agent: { id: "s-1" } });
  await writer.flush().catch(()=>{});

  const rows = (await readFile(runtimeCsv, "utf8")).trim().split("\n").map((line) => line.split(","));
  assert.deepEqual(rows[0], RUNTIME_HEADERS);
  assert.equal(rows.length, 2);
  const row = Object.fromEntries(rows[0].map((header, index) => [header, rows[1][index]]));
  assert.equal(row.session_id, "s-1");
  assert.equal(row.status, "ended");
  assert.equal(row.current_turn_id, "turn-7");
  assert.match(row.status_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(row.last_seen_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("未知状态归为 unknown，且多个会话各自一行", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pm-observer-"));
  const runtimeCsv = path.join(dir, "session-runtime.csv");
  const { ctx, fire } = makeCtx();
  const writer = apply(ctx, { runtimeCsv });
  fire("agent/status", { agent: { id: "s-a" }, status: "teleporting" });
  fire("agent/status", { agent: { id: "s-b" }, status: "waiting" });
  await writer.flush().catch(()=>{});

  const rows = (await readFile(runtimeCsv, "utf8")).trim().split("\n").slice(1).map((line) => line.split(","));
  const byId = Object.fromEntries(rows.map((row) => [row[0], row[1]]));
  assert.deepEqual(byId, { "s-a": "unknown", "s-b": "waiting" });
});

test("schema 不符时不覆盖缓存，只告警一次", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pm-observer-"));
  const runtimeCsv = path.join(dir, "session-runtime.csv");
  await writeFile(runtimeCsv, "wrong,schema\nx,y\n", "utf8");
  const { ctx, fire, warnings } = makeCtx();
  const writer = apply(ctx, { runtimeCsv });
  fire("agent/created", { agent: { id: "s-1" } });
  fire("agent/created", { agent: { id: "s-2" } });
  await writer.flush().catch(()=>{});
  assert.equal(await readFile(runtimeCsv, "utf8"), "wrong,schema\nx,y\n");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /schema/);
});
