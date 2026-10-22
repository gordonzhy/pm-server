import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDependencyGraph,taskPosture} from '../assets/workbench-graph.mjs';
const task=(project,id,deps=[],status='待办')=>({id,key:`${project}:${id}`,project_id:project,project:{name:project},dependencyIds:deps,status,title:'任务 '+id});
test('同名任务依赖只连接同项目，不创造跨项目边',()=>{
  const tasks=[task('甲','A'),task('甲','B',['A']),task('乙','A'),task('乙','B',['A'])],graph=buildDependencyGraph(tasks);
  assert.equal(graph.nodes.length,4);assert.equal(graph.edges.length,2);
  assert.deepEqual(graph.edges.map(e=>[e.source,e.target]),[['甲:A','甲:B'],['乙:A','乙:B']]);
  assert.equal(graph.lanes.length,2);
});
test('两端不在筛选集合中的依赖不绘线，并标出被筛掉的前置任务',()=>{
  const graph=buildDependencyGraph([task('甲','B',['A']),task('乙','A')]);assert.equal(graph.edges.length,0);
  assert.deepEqual(graph.nodes.find(n=>n.key==='甲:B').hiddenDependencies,['A']);assert.equal(graph.nodes.length,2);
});
test('DAG 布局保持前置到后续的方向，合流依赖和各项目节点互不覆盖',()=>{
  const tasks=[task('甲','A'),task('甲','B',['A']),task('甲','C',['A']),task('甲','D',['B','C']),task('乙','A')],graph=buildDependencyGraph(tasks),byKey=new Map(graph.nodes.map(n=>[n.key,n]));
  for(const edge of graph.edges)assert.ok(byKey.get(edge.source).x+byKey.get(edge.source).width<byKey.get(edge.target).x);
  for(let i=0;i<graph.nodes.length;i++)for(let j=i+1;j<graph.nodes.length;j++){const a=graph.nodes[i],b=graph.nodes[j];assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);}
  for(const n of graph.nodes)assert.ok(n.x+n.width<=graph.width&&n.y+n.height<=graph.height);
});
test('图拒绝循环和重复组合身份，空筛选仍有合法画布',()=>{
  assert.throws(()=>buildDependencyGraph([task('甲','A',['B']),task('甲','B',['A'])]),/存在环/);assert.throws(()=>buildDependencyGraph([task('甲','A'),task('甲','A')]),/重复/);
  const graph=buildDependencyGraph([]);assert.equal(graph.nodes.length,0);assert.equal(graph.edges.length,0);assert.ok(graph.width>0&&graph.height>0);
});
test('可开始与等待依赖只计算待办，不能改变正式状态或混用其他项目',()=>{
  const done=task('甲','A',[],'已完成'),todo=task('甲','B',['A']);assert.equal(taskPosture(todo,[done,todo]),'ready');assert.equal(todo.status,'待办');
  assert.equal(taskPosture(todo,[{...done,status:'进行中'},todo]),'waiting');assert.equal(taskPosture(todo,[todo]),'waiting');assert.equal(taskPosture({...todo,status:'受阻'},[done,todo]),'blocked');assert.equal(taskPosture({...todo,status:'进行中'},[done,todo]),'active');
});
