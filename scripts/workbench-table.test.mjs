import test from 'node:test';
import assert from 'node:assert/strict';
import {tableColumns,columnValue,matchesColumnFilters,sortTableTasks} from '../assets/workbench-table.mjs';
const task=(id,project,fields={})=>({id,key:`${project}:${id}`,project_id:project,project:{name:project,group:'工程'},posture:'waiting',status:'待办',priority:'P0',title:id,dependencies:'[]',...fields});
test('所有实际CSV扩展字段可成为表格列，内部模型字段不暴露',()=>{
  const columns=tableColumns([task('A','甲',{dispatch_id:'dispatch-A',custom_field:'custom'})]),keys=columns.map(c=>c.key);
  assert.ok(keys.includes('custom_field')&&keys.includes('dispatch_id')&&keys.includes('source_project'));
  assert.ok(!keys.includes('key')&&!keys.includes('project_id')&&!keys.includes('project'));
});
test('跨项目整表排序支持自然编号与优先级、升降序，不改原任务集合',()=>{
  const tasks=[task('TASK-10','甲',{priority:'P10'}),task('TASK-2','乙',{priority:'P2'}),task('TASK-1','甲',{priority:'P0'})],before=structuredClone(tasks);
  assert.deepEqual(sortTableTasks(tasks,'id','asc').map(t=>t.id),['TASK-1','TASK-2','TASK-10']);
  assert.deepEqual(sortTableTasks(tasks,'priority','desc').map(t=>t.priority),['P10','P2','P0']);assert.deepEqual(tasks,before);
});
test('日期按真实时刻排序，不按带不同时区的ISO文字顺序排序',()=>{
  const earlier=task('早','甲',{modified_at:'2026-10-13T10:00:00+08:00'}),later=task('晚','乙',{modified_at:'2026-10-13T03:00:00Z'}),missing=task('缺失','甲',{modified_at:''});
  assert.deepEqual(sortTableTasks([later,missing,earlier],'modified_at','asc').map(t=>t.id),['早','晚','缺失']);assert.deepEqual(sortTableTasks([earlier,missing,later],'modified_at','desc').map(t=>t.id),['晚','早','缺失']);
});
test('列筛选按AND组合，项目按稳定身份筛选，文本包含不区分大小写',()=>{
  const a=task('A','uuid-A',{title:'API Upgrade'}),b=task('B','uuid-B',{title:'API Upgrade'});a.project.name=b.project.name='同名项目';
  assert.equal(matchesColumnFilters(a,{source_project:'uuid-A',title:'api',status:'待办'}),true);
  assert.equal(matchesColumnFilters(b,{source_project:'uuid-A',title:'API'}),false);assert.equal(matchesColumnFilters(a,{title:'api',status:'已完成'}),false);
});
test('日期、依赖、路由和任意扩展字段均可筛选及排序',()=>{
  const a=task('A','甲',{created_at:'2026-10-13T10:00:00+08:00',dependencies:'[DEV-001]',dispatch_id:'dispatch-2',custom:'alpha'}),b=task('B','乙',{created_at:'2026-10-12T10:00:00+08:00',dependencies:'[]',dispatch_id:'dispatch-10',custom:'beta'});
  assert.equal(matchesColumnFilters(a,{created_at:'2026-10-13',dependencies:'DEV',dispatch_id:'-2',custom:'ALPHA'}),true);assert.equal(matchesColumnFilters(b,{created_at:'2026-10-13'}),false);assert.deepEqual(sortTableTasks([b,a],'dispatch_id','asc').map(t=>t.id),['A','B']);assert.equal(columnValue(a,'source_group'),'工程');
});

test('日期筛选兼容表格实际显示的本地日期时间',()=>{const value='2026-10-13T10:00:00+08:00',record=task('A','甲',{created_at:value}),display=new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});assert.equal(matchesColumnFilters(record,{created_at:display}),true);});
