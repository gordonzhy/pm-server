import test from 'node:test';
import assert from 'node:assert/strict';
import {shareView,sharedProjectId} from './share-view.mjs';

test('new internal fields stay private and aliases are stable only within one share',()=>{
 const principal={shareId:'fictional-share-one'},other={shareId:'fictional-share-two'};
 const data={id:'private-project',available:true,name:'PRIVATE_CANARY',root:'PRIVATE_CANARY',manager:{threadId:'PRIVATE_CANARY',future:{secret:'PRIVATE_CANARY'}},future:{secret:'PRIVATE_CANARY'},tasks:[{id:'private-task',status:'进行中',priority:'P1',dependencyIds:[],title:'PRIVATE_CANARY',timing:{issues:['PRIVATE_CANARY']},future:{secret:'PRIVATE_CANARY'}}]};
 const view=shareView(data,principal);
 assert.ok(!JSON.stringify(view).includes('PRIVATE_CANARY'));
 assert.ok(!JSON.stringify(view).includes('private-project'));
 assert.equal(view.id,sharedProjectId(principal,data.id));assert.notEqual(view.id,shareView(data,other).id);
 assert.equal(view.tasks[0].id,shareView(data,principal).tasks[0].id);
 assert.notEqual(view.tasks[0].id,shareView(data,other).tasks[0].id);
 assert.equal(view.tasks[0].status,'进行中');assert.equal(view.tasks[0].priority,'P1');assert.equal(view.counts['进行中'],1);
});
