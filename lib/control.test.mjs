import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtemp,rm,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareSocket,socketPath,request} from '../scripts/task-monitor-service.mjs';
test('control endpoint closing without a response is unavailable, never a health proof',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pm-control-eof-'));await prepareSocket(directory);const server=createServer(socket=>{socket.on('error',()=>{});socket.resume();socket.end();});
 await new Promise(resolve=>server.listen(socketPath(directory),resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await unlink(socketPath(directory)).catch(()=>{});await rm(directory,{recursive:true,force:true});});
 assert.equal(await request(directory),null);
});

test('control peer closing before handshake is unavailable rather than a failed stop',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'pm-control-reset-'));await prepareSocket(directory);
 const server=createServer(socket=>{socket.on('error',()=>{});socket.destroy();});
 await new Promise(resolve=>server.listen(socketPath(directory),resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await unlink(socketPath(directory)).catch(()=>{});await rm(directory,{recursive:true,force:true});});
 const results=await Promise.all(Array.from({length:20},()=>request(directory)));
 assert.ok(results.every(value=>value===null));
});
