import os from 'node:os';
import path from 'node:path';
export function stateDir() {
  if(process.env.PM_SERVER_STATE_DIR)return path.resolve(process.env.PM_SERVER_STATE_DIR);
  if(process.platform==='darwin')return path.join(os.homedir(),'Library','Application Support','pm-server');
  if(process.platform==='win32')return path.join(process.env.LOCALAPPDATA||os.homedir(),'pm-server');
  return path.join(process.env.XDG_STATE_HOME||path.join(os.homedir(),'.local','state'),'pm-server');
}
export const runtimeCsv=()=>process.env.CODEX_SESSION_RUNTIME_CSV||path.join(stateDir(),'session-runtime.csv');
