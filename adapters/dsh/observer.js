import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runtimeCsv as defaultRuntimeCsv} from '../../lib/paths.mjs';
import {RUNTIME_HEADERS,RUNTIME_STATUSES,upsertRuntimeSession} from '../../lib/runtime-cache.mjs';
export {RUNTIME_HEADERS,RUNTIME_STATUSES,defaultRuntimeCsv};
export const name='pm-server-observer';
function agentSessionId(agent){const id=agent?.id??agent?.session?.id;return typeof id==='string'&&id?id:undefined;}
export function createRuntimeCacheWriter(config){
 let chain=Promise.resolve();
 return {runtimeCsv:config.runtimeCsv,upsert(sessionId,status,turnId){const next=()=>upsertRuntimeSession({runtimeCsv:config.runtimeCsv,sessionId,status,turnId,host:config.legacy?undefined:'dsh',instance:config.instance||'default',retentionSeconds:Number(config.retainSeconds??86400),maxRows:Number(config.maxRows??1000)});chain=chain.then(next,next);return chain;},flush(){return chain;}};
}
/**
 * Cordis 插件入口：只写观察缓存，不做任何其他注册。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{runtimeCsv?:string, retainSeconds?:number, maxRows?:number}} [config]
 */
export function apply(ctx, config = {}) {
  const writer = createRuntimeCacheWriter({
    runtimeCsv: config.runtimeCsv ? path.resolve(config.runtimeCsv) : defaultRuntimeCsv(),
    retainSeconds: config.retainSeconds,
    instance: config.instance,
    legacy: Boolean(config.runtimeCsv),
    maxRows: config.maxRows,
  })
  let warned = false
  const warn = (error) => {
    if (warned) return
    warned = true
    try { ctx.logger?.warn?.(`[pm-observer] 运行观察写入失败：${error?.message || error}`) } catch { /* 忽略 */ }
  }
  const update = (agent, status, turnId) => {
    const sessionId = agentSessionId(agent)
    if (!sessionId) return
    writer.upsert(sessionId, status, turnId).catch(warn)
  }
  const markerFile = path.join(path.dirname(writer.runtimeCsv), `pm-observer-dsh-${encodeURIComponent(config.instance||'default')}.json`)
  void mkdir(path.dirname(markerFile), { recursive: true, mode: 0o700 })
    .then(() => writeFile(markerFile, `${JSON.stringify({
      name,
      version: '0.1.0',
      runtimeCsv: writer.runtimeCsv,
      pid: process.pid,
      at: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }))
    .catch(() => { /* 标记失败不影响观察 */ })
  try {
    ctx.on('agent/created', ({ agent }) => update(agent, 'idle'))
    ctx.on('agent/status', ({ agent, status, turnId }) => update(agent, status, turnId))
    ctx.on('agent/disposed', ({ agent }) => update(agent, 'ended'))
    ctx.logger?.info?.(`[pm-observer] 观察器已加载：${writer.runtimeCsv}`)
  } catch (error) {
    warn(error)
  }
  return writer
}
