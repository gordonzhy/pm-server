// 隔离测试客户端：真实登录换取 Cookie，不给服务端增加认证绕过开关。
import { startWorkbench as startServer } from './workbench-server.mjs';
import { readPassword } from './workbench-auth.mjs';
const credentials=new Map();
export async function startWorkbench(options) {
  const instance=await startServer(options),origin=new URL(instance.url).origin;
  const response=await globalThis.fetch(new URL('auth/login',instance.url),{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:await readPassword(instance.passwordFile)})});
  if(!response.ok){await instance.close();throw new Error('测试客户端登录失败');}
  credentials.set(origin,response.headers.get('set-cookie').split(';')[0]);
  const close=instance.close;
  instance.close=async()=>{credentials.delete(origin);await close();};
  return instance;
}
export function browserStorageState(instance) {
  const [name,value]=credentials.get(new URL(instance.url).origin).split('=');
  return {cookies:['127.0.0.1','localhost'].map(domain=>({name,value,domain,path:'/',expires:-1,httpOnly:true,secure:false,sameSite:'Lax'})),origins:[]};
}
export function fetch(url,options={}) {
  const headers=new Headers(options.headers);
  if(!headers.has('Cookie'))headers.set('Cookie',credentials.get(new URL(url).origin)||'');
  return globalThis.fetch(url,{...options,headers});
}
