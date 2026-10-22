// 监测服务的确定性控制协议；Unix socket 握手不依赖缓存 PID 发信号。
import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rename, writeFile } from 'node:fs/promises';
export function socketPath(directory) {
  const hash = createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 24);
  const parent = path.join(os.tmpdir(), `pm-monitor-${process.getuid?.() ?? 'user'}`);
  const result = path.join(parent, `${hash}.sock`);
  if (Buffer.byteLength(result) > 100) throw new Error('monitor control socket path exceeds platform limit; use a shorter TMPDIR');
  return result;
}
export async function prepareSocket(directory) { await mkdir(path.dirname(socketPath(directory)), {recursive: true, mode: 0o700}); }
export async function atomicJSON(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  await rename(temporary, file);
}
export function request(directory, operation = 'status') {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath(directory)); let output = '';
    client.setTimeout(1500, () => client.destroy(new Error('monitor control request timed out')));
    client.once('connect', () => client.end(JSON.stringify({operation, stateDir: directory}) + '\n'));
    client.on('data', chunk => {output += chunk; if (output.length > 1_000_000) client.destroy(new Error('monitor response too large'));});
    client.once('error', error => {if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) resolve(null); else reject(error);});
    client.once('end', () => {
      try {
        if(!output.trim()){resolve(null);return;}
        const result = JSON.parse(output);
        if (result.kind !== 'project-manager-task-monitor' || result.stateDir !== directory) throw new Error('monitor control identity mismatch');
        resolve(result);
      } catch (error) {reject(error);}
    });
  });
}
