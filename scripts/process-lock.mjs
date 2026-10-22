// Kernel-owned local mutex. Crash releases the bound port; no stale-file deletion.
// Different paths can hash to the same port: this fails closed rather than sharing ownership.
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {mkdir, realpath, readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
export async function runtimeLockPath(repository) {
  return path.join(os.tmpdir(), `pm-server-runtime-${createHash('sha256').update(await realpath(repository)).digest('hex').slice(0,16)}.lock`);
}
export async function acquireProcessLock(filename, {timeoutMs=5000}={}) {
  if(!Number.isFinite(timeoutMs)||timeoutMs<0)throw new Error('invalid process lock timeout');
  await mkdir(path.dirname(filename),{recursive:true,mode:0o700});
  filename=path.join(await realpath(path.dirname(filename)),path.basename(filename));
  try {const previous=JSON.parse(await readFile(filename,'utf8'));if(Number.isInteger(previous.pid)&&previous.pid>0){try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')previous.pid=null;else throw e;}if(previous.pid)throw new Error('legacy live lock owner; stop old writer before migration');}}catch(e){if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
  const port=20000+createHash('sha256').update(filename).digest().readUInt32BE(0)%40000;
  const deadline=Date.now()+timeoutMs;
  while(true) {
    const server=createServer(socket=>socket.destroy());
    try {
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen({port,host:'127.0.0.1',exclusive:true},resolve);});
      let released=false;
      return {filename,release:async()=>{if(!released){released=true;await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}};
    } catch(error) {
      if(error.code!=='EADDRINUSE')throw error;
      if(Date.now()>=deadline)throw new Error(`timed out waiting for process lock: ${filename}`);
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
}
export async function withProcessLock(filename,action,options) {const lock=await acquireProcessLock(filename,options);try{return await action();}finally{await lock.release();}}
