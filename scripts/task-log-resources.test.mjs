import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { logEvidencePath, taskLogResources, readAbsoluteLogEvidence } from './task-log-resources.mjs';
test('log evidence resolves annotated root paths and card-relative paths without external or hidden grants',()=>{
  assert.equal(logEvidencePath('docs/报告.md 补记前第20行：原文','tasks/T-1.md'),'docs/报告.md');
  assert.equal(logEvidencePath('../docs/a.txt#section','tasks/T-1.md'),'docs/a.txt');
  for(const ref of ['https://example.com/a.md','.secret/config.json','../.codex/settings.json','javascript:alert(1)','../../etc/passwd','docs/%2eenv.json'])assert.equal(logEvidencePath(ref,'tasks/T-1.md'),null,ref);
});
test('only valid registered task logs expose exact existing safe evidence files',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pm-log-files-'));
  try{
    await mkdir(path.join(root,'tasks'));await mkdir(path.join(root,'docs'));await writeFile(path.join(root,'docs/report.md'),'proof');await writeFile(path.join(root,'docs/unlisted.md'),'private');await symlink('/etc/hosts',path.join(root,'docs/out.txt'));
    const log={version:1,events:[{id:'a',at:'2026-10-14T10:00:00+08:00',actor:'经理',type:'checkpoint',title:'报告完成',detail:'已记录检查结果。',evidence:[{label:'报告',ref:'docs/report.md'},{label:'缺失',ref:'docs/missing.md'},{label:'越界',ref:'docs/out.txt'}]}]};
    await writeFile(path.join(root,'tasks/T.md'),'# T\n## 任务日志\n```yaml\n'+JSON.stringify(log)+'\n```');
    const resources=await taskLogResources(root,[['detail_path'],['tasks/T.md']]);
    assert.deepEqual([...resources.allowed],['docs/report.md']);assert.ok(resources.directories.has(path.join(root,'docs')));
    assert.equal((await taskLogResources(root,[['detail_path'],['tasks/missing.md']])).allowed.size,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('absolute evidence requires exact registered reference, with limited public skill-reference exception',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'pm-absolute-log-'));
  try{
    await mkdir(path.join(root,'tasks'));await writeFile(path.join(root,'report.md'),'local proof');
    const report=path.join(root,'report.md'),skillRef=new URL('../contracts/task-log.md',import.meta.url).pathname;
    const refs=[report,skillRef,'/etc/hosts'];
    const log={version:1,events:[{id:'a',at:'2026-10-14T10:00:00+08:00',actor:'经理',type:'checkpoint',title:'检查报告',detail:'已留存结果与依据。',evidence:refs.map(ref=>({label:'依据',ref}))}]};
    await writeFile(path.join(root,'tasks/T.md'),'# T\n## 任务日志\n```yaml\n'+JSON.stringify(log)+'\n```');
    const rows=[['detail_path'],['tasks/T.md']];
    assert.equal((await readAbsoluteLogEvidence(root,rows,'tasks/T.md',report)).body.toString(),'local proof');
    assert.match((await readAbsoluteLogEvidence(root,rows,'tasks/T.md',skillRef)).body.toString(),/任务日志/);
    for(const [card,ref] of [['tasks/T.md','/etc/hosts'],['tasks/other.md',report],['tasks/T.md',path.join(root,'not-listed.md')]])await assert.rejects(()=>readAbsoluteLogEvidence(root,rows,card,ref));
    assert.equal(logEvidencePath(report,'tasks/T.md'),null);
  }finally{await rm(root,{recursive:true,force:true});}
});
