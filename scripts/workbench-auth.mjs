import path from 'node:path';
import { constants } from 'node:fs';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const passwordPath = stateDir => path.join(stateDir, 'password.txt');
export const authorizationFor = password => 'Basic '+Buffer.from('admin:'+password, 'utf8').toString('base64');

// 密码仅留在运行状态目录；拒绝符号链接、宽松权限和空文件，绝不回退为匿名访问。
export async function readPassword(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 4096) throw new Error('密码文件必须是仅本人可读写的普通文件（chmod 600）');
    const password = (await file.readFile('utf8')).replace(/\r?\n$/, '');
    if (password.length < 16 || /[\r\n\x00]/.test(password)) throw new Error('密码文件必须包含至少16个字符的单行密码');
    return password;
  } finally { await file.close(); }
}
export async function ensurePassword(stateDir) {
  await mkdir(stateDir, {recursive:true, mode:0o700});
  const filename = passwordPath(stateDir);
  try {
    const file = await open(filename, 'wx', 0o600);
    try { await file.writeFile(randomBytes(24).toString('base64url')+'\n'); }
    finally { await file.close(); }
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  return {filename, password:await readPassword(filename)};
}
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a,b) => timingSafeEqual(Buffer.from(hash(a),'hex'),Buffer.from(hash(b),'hex'));
const COOKIE='workbench_session';
// 浏览器有持久 Cookie 上限；每次有效访问续期，服务端会话本身不设过期时间。
export const COOKIE_MAX_AGE=400*24*60*60;
const MAX_STATE_BYTES=8*1024*1024;
const shareValid=s=>s&&typeof s.id==='string'&&typeof s.digest==='string'&&/^[0-9a-f]{64}$/.test(s.digest)&&Array.isArray(s.projectIds)&&s.projectIds.length>0&&s.projectIds.every(id=>typeof id==='string')&&Number.isFinite(s.expiresAt)&&Number.isFinite(s.createdAt)&&typeof s.label==='string'&&typeof s.revoked==='boolean';
const sessionValid=s=>s&&/^[0-9a-f]{64}$/.test(s.key)&&['owner','viewer'].includes(s.role)&&Number.isFinite(s.createdAt)&&typeof s.secure==='boolean'&&(s.role==='owner'||(typeof s.shareId==='string'&&Array.isArray(s.projectIds)&&s.projectIds.length>0&&s.projectIds.every(id=>typeof id==='string')));
async function readState(filename){
  const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await file.stat();if(!info.isFile()||(info.mode&0o077)||info.size>MAX_STATE_BYTES)throw new Error('认证状态文件必须是600权限的普通文件，且不超过8MB');return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
}
export async function createWorkbenchAuth({stateDir,password,now=Date.now}) {
  const filename=path.join(stateDir,'auth-state.json');
  let activePassword=password,shares=[],sessions=new Map(),chain=Promise.resolve(),failures=0,resetAt=0;
  function serial(action){const result=chain.then(action);chain=result.catch(()=>{});return result;}
  async function persist(nextShares,nextSessions,nextPassword=activePassword){
    const payload=JSON.stringify({version:1,passwordHash:hash(nextPassword),shares:nextShares,sessions:[...nextSessions.values()]},null,2)+'\n';
    if(Buffer.byteLength(payload)>MAX_STATE_BYTES)throw new Error('认证状态已达存储上限，请减少分享范围或登录设备数量');
    const temporary=filename+'.'+randomBytes(8).toString('hex')+'.tmp';
    try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(payload);await file.sync();}finally{await file.close();}await rename(temporary,filename);}finally{await unlink(temporary).catch(()=>{});}
  }
  let data,migrate=false;
  try{data=await readState(filename);}catch(error){if(error.code!=='ENOENT')throw error;migrate=true;try{data=await readState(path.join(stateDir,'shares.json'));}catch(legacyError){if(legacyError.code!=='ENOENT')throw legacyError;}}
  if(data){
    if(data.version!==1||typeof data.passwordHash!=='string'||!Array.isArray(data.shares)||data.shares.length>1000||data.shares.some(s=>!shareValid(s))||(!migrate&&(!Array.isArray(data.sessions)||data.sessions.length>2048||data.sessions.some(s=>!sessionValid(s))||new Set(data.sessions.map(s=>s.key)).size!==data.sessions.length)))throw new Error('认证状态文件格式无效');
    if(data.passwordHash===hash(password)){shares=data.shares;sessions=new Map((migrate?[]:data.sessions).map(s=>[s.key,s]));}
  }
  // 初始化、迁移或改密码均持久化当前密码指纹，避免改回旧密码复活旧会话。
  if(!data||migrate||data.passwordHash!==hash(password))await persist(shares,sessions);
  function valid(session){return !!session&&sessions.get(session.key)===session;}
  function cookie(req,value,seconds,secure){return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${secure||req.socket.encrypted?'; Secure':''}`;}
  function cookieValue(req){const values=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));return values.length===1?values[0].slice(COOKIE.length+1):null;}
  function principal(req,res){
    const value=cookieValue(req);if(!value)return null;const session=sessions.get(hash(value));if(!valid(session))return null;
    if(res&&!res.headersSent)res.setHeader('Set-Cookie',cookie(req,value,COOKIE_MAX_AGE,session.secure));return session;
  }
  function checkPassword(value){if(typeof value==='string'&&equal(value,activePassword))return {ok:true};if(now()>=resetAt){failures=0;resetAt=now()+60000;}return {ok:false,limited:++failures>30,retryAfter:Math.max(1,Math.ceil((resetAt-now())/1000))};}
  const metadata=({digest,...rest})=>rest;
  return {
    principal,valid,checkPassword,
    syncPassword:value=>serial(async()=>{if(value===activePassword)return false;const empty=new Map();await persist([],empty,value);activePassword=value;shares=[];sessions=empty;failures=0;return true;}),
    issue:(req,res,identity,secure)=>serial(async()=>{
      const old=principal(req),next=new Map(sessions);if(old)next.delete(old.key);if(next.size>=2048)throw new Error('登录会话已满，请稍后重试');
      const value=randomBytes(32).toString('base64url'),key=hash(value),session={key,role:identity.role,createdAt:now(),secure:!!secure};
      if(identity.role==='viewer'){session.shareId=identity.shareId;session.projectIds=[...identity.projectIds];}
      next.set(key,session);await persist(shares,next);sessions=next;res.setHeader('Set-Cookie',cookie(req,value,COOKIE_MAX_AGE,session.secure));return session;
    }),
    logout:(req,res,secure)=>serial(async()=>{const session=principal(req);if(session){const next=new Map(sessions);next.delete(session.key);await persist(shares,next);sessions=next;}res.setHeader('Set-Cookie',cookie(req,'',0,session?.secure||secure));}),
    healthCredential:req=>equal(req.headers.authorization||'',authorizationFor(activePassword)),
    list:()=>shares.map(metadata),
    create:input=>serial(async()=>{
      if(!Array.isArray(input.projectIds)||!input.projectIds.length||input.projectIds.length>1000||input.projectIds.some(id=>typeof id!=='string')||!Number.isInteger(input.hours)||input.hours<1||input.hours>168||typeof input.label!=='string'||!input.label.trim()||input.label.length>100)throw new Error('请选择项目、名称和1至168小时有效期');
      const active=shares.filter(s=>!s.revoked&&s.expiresAt>now());if(active.length>=1000)throw new Error('分享链接数量已达上限');
      const token=randomBytes(32).toString('base64url'),share={id:randomBytes(16).toString('hex'),digest:hash(token),label:input.label.trim(),projectIds:[...new Set(input.projectIds)],createdAt:now(),expiresAt:now()+input.hours*3600000,revoked:false};
      const next=[...active,share];await persist(next,sessions);shares=next;return {...metadata(share),token};
    }),
    revoke:id=>serial(async()=>{if(!shares.some(s=>s.id===id))throw new Error('分享不存在');const next=shares.map(s=>s.id===id?{...s,revoked:true}:s);await persist(next,sessions);shares=next;return {id};}),
    redeem(token){if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token))return null;const digest=hash(token),share=shares.find(s=>s.digest===digest&&!s.revoked&&s.expiresAt>now());return share?{role:'viewer',shareId:share.id,projectIds:share.projectIds}:null;},
    flush:()=>chain
  };
}
