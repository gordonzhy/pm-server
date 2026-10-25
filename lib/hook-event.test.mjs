import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readHookEvent} from './hook-event.mjs';
const parse=(text,options)=>readHookEvent(Readable.from([Buffer.from(text)]),options);
test('streams large payloads before and after metadata without retaining them',async()=>{
 for(const size of [1100000,8*1024*1024]){
  const event=await parse(JSON.stringify({tool_input:{image:'A'.repeat(size)},session_id:'demo-\u96ea',hook_event_name:'PostToolUse',sequence:7,tool_response:'private fixture content'}));
  assert.deepEqual({...event},{session_id:'demo-雪',hook_event_name:'PostToolUse',sequence:7});
 }
});
test('byte chunks preserve UTF-8 and escaped metadata',async()=>{
 const text='{"tool_response":[{"x":"\\\"\\u1234"}],"session_id":"雪\\u2603","hook_event_name":"Stop","sequence":2}';
 const event=await readHookEvent(Readable.from([...Buffer.from(text)].map(x=>Buffer.from([x]))));
 assert.equal(event.session_id,'雪☃');assert.equal(event.hook_event_name,'Stop');
});
test('rejects malformed, ambiguous, nested, excessive and invalid UTF-8 metadata',async()=>{
 for(const text of ['{}x','{"session_id":"x",}','{"x":[1,]}','{"session_id":"a","session_id":"b"}','{"session_id":{}}','{"sequence":1.2}','{"sequence":9007199254740992}','{"occurred_at":"bad"}','{"x":"\\q"}','{"x":01}','{"x":"\n"}','{"session_id":"'+ 'a'.repeat(4097)+'"}','{"x":'+'['.repeat(65)+'0'+']'.repeat(65)+'}','[]',''])await assert.rejects(parse(text));
 await assert.rejects(readHookEvent(Readable.from([Buffer.from([0xff])])));
 await assert.rejects(parse('{"x":"123456"}',{maxBytes:8}));
 await assert.rejects(parse('{}',{deadline:Date.now()-1}));
});
test('valid skipped scalars and containers do not become top-level metadata',async()=>{
 assert.deepEqual({...await parse('{"x":[true,false,null,-1.2e+3,{"session_id":"hidden"}],"hook_event_name":"SessionStart","session_id":"demo"}')},{hook_event_name:'SessionStart',session_id:'demo'});
});

test('optional null metadata preserves absence without allowing duplicate ambiguity',async()=>{
 const result=await parse('{"session_id":"demo","turn_id":null,"sequence":null,"event_id":null,"occurred_at":null}');
 assert.deepEqual({...result},{session_id:'demo'});
 await assert.rejects(parse('{"turn_id":null,"turn_id":"other"}'));
});

test('unknown large keys are validated and skipped with bounded storage',async()=>{
 assert.deepEqual({...await parse(JSON.stringify({['k'.repeat(1100000)]:'ignored',session_id:'demo'}))},{session_id:'demo'});
});
