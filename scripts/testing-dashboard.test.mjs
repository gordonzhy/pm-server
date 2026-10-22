import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,mkdir,symlink,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {testingResources,readRepositoryFile} from './testing-dashboard.mjs';
test('serves only explicit test evidence, blocks traversal/source/env and escaping symlinks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'test-allowlist-')),outside=await mkdtemp(path.join(os.tmpdir(),'test-private-'));
 try{
 await mkdir(path.join(root,'evidence/qa'),{recursive:true});await mkdir(path.join(root,'tasks'));
 await writeFile(path.join(root,'tasks/QA-001.md'),'- 测试清单：evidence/qa/suite.json\n');
 await writeFile(path.join(root,'evidence/qa/suite.json'),JSON.stringify({report:'evidence/qa/report.md',scenarios:'../private.csv',issues:'evidence/qa/issues.csv',runs:'evidence/qa/runs.jsonl'}));
 await writeFile(path.join(root,'evidence/qa/report.md'),'report');await writeFile(path.join(root,'evidence/qa/issues.csv'),'evidence\nevidence/qa/photo.png;app/source.ts;../private.csv;evidence/qa/escape.txt\n');await writeFile(path.join(root,'evidence/qa/runs.jsonl'),'');await writeFile(path.join(root,'evidence/qa/photo.png'),'png');await writeFile(path.join(outside,'secret.txt'),'secret');await symlink(path.join(outside,'secret.txt'),path.join(root,'evidence/qa/escape.txt'));
 const csv=s=>s.trim().split('\n').map(x=>x.split(',')),tasks=[['task_type','detail_path'],['测试','tasks/QA-001.md']];
 const {allowed}=await testingResources(root,tasks,csv);
 assert(allowed.has('evidence/qa/photo.png'));assert(allowed.has('evidence/qa/issues.csv'));assert(!allowed.has('../private.csv'));assert(!allowed.has('app/source.ts'));assert(!allowed.has('evidence/qa/escape.txt'));
 assert.equal((await testingResources(root,[['detail_path'],['tasks/QA-001.md']],csv)).allowed.size,0);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});

test('registered detail reads canonical in-repository files but never outside symlink bytes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'detail-root-')),outside=await mkdtemp(path.join(os.tmpdir(),'detail-secret-'));
 try{
  await mkdir(path.join(root,'tasks'));await writeFile(path.join(root,'tasks/real.md'),'public detail');await symlink(path.join(root,'tasks/real.md'),path.join(root,'tasks/safe.md'));
  await writeFile(path.join(outside,'secret.md'),'SYNTHETIC_OUTSIDE_SECRET');await symlink(path.join(outside,'secret.md'),path.join(root,'tasks/escape.md'));
  assert.equal(await readRepositoryFile(root,'tasks/real.md','utf8'),'public detail');assert.equal(await readRepositoryFile(root,'tasks/safe.md','utf8'),'public detail');
  await assert.rejects(readRepositoryFile(root,'tasks/escape.md','utf8'),{code:'EACCES'});await assert.rejects(readRepositoryFile(root,'../secret.md','utf8'),{code:'EACCES'});
  const {allowed}=await testingResources(root,[['task_type','detail_path'],['测试','tasks/escape.md']],x=>x.split('\n').map(line=>line.split(',')));assert.equal(allowed.size,0);
 }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
