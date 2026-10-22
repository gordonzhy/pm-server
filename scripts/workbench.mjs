#!/usr/bin/env node
import path from 'node:path';
import { Registry, defaultStateDir } from './workbench-registry.mjs';
import { projectSnapshot } from './workbench-data.mjs';
import { loadProjectConfig, resolveProjectPaths } from './project-config-v2.mjs';
const args=process.argv.slice(2), command=args[0], get=(key,fallback)=>args.includes(key)?args[args.indexOf(key)+1]:fallback;
const registry=new Registry(get('--state-dir',defaultStateDir()));
try {
  if(command==='request') {
    // 未显式给出的 csv/name/group 从项目级配置补齐；显式参数优先。
    const repo=get('--repo');
    let csvPath=get('--csv'), name=get('--name'), group=get('--group');
    if(repo && (!csvPath || !name || !group)) {
      const loaded=await loadProjectConfig(repo);
      if(loaded.found) {
        if(!loaded.ok) throw new Error(`project-manager.config.json 无效：${loaded.errors.join('；')}`);
        const resolved=resolveProjectPaths(loaded.config, repo);
        csvPath=csvPath || resolved.csvPath;
        name=name || loaded.config.project.name;
        group=group || loaded.config.project.group;
      }
    }
    if(repo&&!csvPath)csvPath=path.resolve(repo,"TASKS.csv");
    // --auto remains accepted for older Skill clients; every request now registers
    // immediately unless the project is blacklisted.
    const result=await registry.request({csvPath,root:repo,name,group});
    console.log(JSON.stringify(result));
  } else if(command==='list' || command==='collect') {
    const state=await registry.read();
    if(command==='collect') state.projects=await Promise.all(state.projects.map(projectSnapshot));
    console.log(JSON.stringify(state));
  } else throw new Error('用法：workbench.mjs request [--csv <绝对路径>] [--repo <根目录>] [--name <项目名称>] [--group <分组>] [--auto] [--state-dir <目录>]；指定 --repo 时 csv/name/group 可由 project-manager.config.json 补齐。list / collect。有效项目自动注册，黑名单项目返回 removed；添加、移除、恢复和取消屏蔽请在页面操作。');
} catch(error) {console.error(error.message);process.exitCode=1;}
