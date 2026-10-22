#!/usr/bin/env node

import { mkdir, readFile, rename, stat, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {stateDir} from '../lib/paths.mjs';

const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "Interrupt", "SessionEnd"];
const install = process.argv.includes("--install");
if (process.argv.some((argument) => argument.startsWith("--") && !["--check", "--install"].includes(argument))) throw new Error("usage: install-session-runtime-hook.mjs [--check|--install]");
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const hooksPath = path.join(codexHome, "hooks.json");
const observerPath = path.join(codexHome, 'pm-server-observer.json');
const observer = {version:1,stateDir:stateDir()};
const hookScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "session-runtime-hook.mjs");
const command = `node "${hookScript.replaceAll('"', '\\"')}"`;
const isManaged = (handler) => handler?.type === "command" && typeof handler.command === "string" && (handler.command.includes("session-runtime-hook.mjs") || handler.command.includes("/hooks/session-runtime.mjs"));

async function readConfiguration() {
  try {
    const metadata = await stat(hooksPath);
    const configuration = JSON.parse(await readFile(hooksPath, "utf8"));
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error("hooks.json root must be an object");
    if (configuration.hooks !== undefined && (!configuration.hooks || typeof configuration.hooks !== "object" || Array.isArray(configuration.hooks))) throw new Error("hooks.json hooks must be an object");
    return { configuration, mode: metadata.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { configuration: { description: "User-level Codex lifecycle hooks.", hooks: {} }, mode: 0o600 };
    if (error instanceof SyntaxError) throw new Error(`cannot parse existing ${hooksPath}: ${error.message}`);
    throw error;
  }
}

function installed(configuration) {
  return events.every((event) => (configuration.hooks?.[event] || []).some((group) => (group.hooks || []).some((handler) => handler?.type === "command" && handler.command === command)));
}

const { configuration, mode } = await readConfiguration();
if (!install) {
  let bindingMatches=false;
  try{const binding=JSON.parse(await readFile(observerPath,'utf8'));bindingMatches=binding.version===1&&binding.stateDir===observer.stateDir;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  if (installed(configuration)&&bindingMatches) { console.log(`INSTALLED: ${hooksPath}`); process.exit(0); }
  console.warn(`MISSING: global Codex session-runtime Hook is not installed or is outdated at ${hooksPath}`);
  process.exit(3);
}

try {const backup=hooksPath+'.pm-server-backup-'+Date.now();await copyFile(hooksPath,backup);console.log(`BACKUP: ${backup}`);}catch(e){if(e.code!=='ENOENT')throw e;}
configuration.hooks ||= {};
for (const event of events) {
  const groups = Array.isArray(configuration.hooks[event]) ? configuration.hooks[event] : [];
  const preserved = [];
  for (const group of groups) {
    const handlers = Array.isArray(group?.hooks) ? group.hooks.filter((handler) => !isManaged(handler)) : [];
    if (handlers.length) preserved.push({ ...group, hooks: handlers });
  }
  preserved.push({ hooks: [{ type: "command", command, timeout: 3 }] });
  configuration.hooks[event] = preserved;
}
await mkdir(codexHome, { recursive: true, mode: 0o700 });
await mkdir(path.join(codexHome, "state"), { recursive: true, mode: 0o700 });
const temporary = path.join(codexHome, `.hooks.${process.pid}.${Date.now()}.tmp`);
await writeFile(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode });
await rename(temporary, hooksPath);
const observerTemporary=observerPath+'.'+process.pid+'.tmp';
try {const backup=observerPath+'.pm-server-backup-'+Date.now();await copyFile(observerPath,backup);console.log(`BACKUP: ${backup}`);}catch(error){if(error.code!=='ENOENT')throw error;}
await writeFile(observerTemporary,JSON.stringify(observer)+'\n',{mode:0o600});
await rename(observerTemporary,observerPath);
console.log(`INSTALLED: ${hooksPath}`);
console.log("REVIEW REQUIRED: open Codex CLI, enter /hooks, and trust the current user-level Hook definition. Codex Desktop cannot complete this trust step.");
