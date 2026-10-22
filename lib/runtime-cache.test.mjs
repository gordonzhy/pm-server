import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {upsertRuntimeSession,sessionRef,parseCsv} from './runtime-cache.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
async function fixture(t){const root=await mkdtemp(path.join(os.tmpdir(),'pm-event-'));t.after(()=>rm(root,{recursive:true,force:true}));return path.join(root,'runtime.csv');}
test('same native IDs across hosts and instances remain independent',async t=>{
 const csv=await fixture(t);
 for(const [host,instance] of [['codex','main'],['claude-code','main'],['dsh','main'],['codex','other']])await upsertRuntimeSession({runtimeCsv:csv,sessionId:'same',host,instance,status:'running'});
 const rows=parseCsv(await readFile(csv,'utf8'));assert.equal(rows.length,5);assert.equal(new Set(rows.slice(1).map(r=>r[0])).size,4);
 assert.ok(rows.some(r=>r[0]===sessionRef('claude-code','main','same')));
});
test('late, duplicate and retired turn events cannot end a new turn',async t=>{
 const csv=await fixture(t),base={runtimeCsv:csv,sessionId:'same',host:'codex',instance:'main'};
 await upsertRuntimeSession({...base,status:'running',turnId:'a',sequence:1,occurredAt:'2026-10-18T01:00:00Z',eventId:'1'});
 await upsertRuntimeSession({...base,status:'running',turnId:'b',sequence:2,occurredAt:'2026-10-18T02:00:00Z',eventId:'2'});
 assert.equal((await upsertRuntimeSession({...base,status:'idle',turnId:'a',sequence:3,occurredAt:'2026-10-18T03:00:00Z'})).ignored,true);
 assert.equal((await upsertRuntimeSession({...base,status:'idle',turnId:'b',eventId:'2'})).ignored,true);
 const row=parseCsv(await readFile(csv,'utf8'))[1];assert.equal(row[1],'running');assert.equal(row[2],'b');
});
test('independent processes merge updates without losing sessions',async t=>{
 const csv=await fixture(t),module=fileURLToPath(new URL('./runtime-cache.mjs',import.meta.url));
 await Promise.all(Array.from({length:8},(_,i)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`import {upsertRuntimeSession} from ${JSON.stringify(module)};await upsertRuntimeSession(${JSON.stringify({runtimeCsv:csv,sessionId:'s'+i,host:'dsh',status:'running'})});`],{stdio:['ignore','pipe','pipe']});
  let stderr='';child.stderr.on('data',c=>stderr+=c);child.on('error',reject);child.on('exit',code=>code?reject(new Error(stderr)):resolve());
 })));
 assert.equal(parseCsv(await readFile(csv,'utf8')).length,9);
});
