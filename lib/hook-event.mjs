// Streaming JSON validation retains only bounded, top-level observation metadata.
// Payload strings and nested values are validated and discarded as they arrive.
const fields=new Set(['hook_event_name','session_id','turn_id','occurred_at','sequence','event_id']);
export async function readHookEvent(stream,{maxBytes=64*1024*1024,maxDepth=64,deadline=Date.now()+1800}={}) {
 const decoder=new TextDecoder('utf-8',{fatal:true}),result=Object.create(null),seen=new Set(),stack=[];
 let root=false,done=false,mode='',token='',capture=false,isKey=false,escape=false,unicode=0,bytes=0;
 const fail=()=>{throw new Error('invalid or excessive hook metadata');};
 const context=()=>stack.at(-1);
 const wantsValue=()=>{const c=context();return c&&(c.kind==='object'?c.state==='value':['value','first'].includes(c.state));};
 function value(v,container=false){
  const c=context();if(!wantsValue())fail();
  if(c.kind==='object'&&stack.length===1&&fields.has(c.key)){
   if(container||seen.has(c.key))fail();seen.add(c.key);
   if(v===null&&['turn_id','occurred_at','sequence','event_id'].includes(c.key)){c.state='comma';return;}
   if(c.key==='sequence'){if(!Number.isSafeInteger(v)||v<0)fail();}
   else if(typeof v!=='string'||!v||v.length>4096)fail();
   if(c.key==='occurred_at'&&!Number.isFinite(Date.parse(v)))fail();
   result[c.key]=v;
  }
  c.state='comma';
 }
 function punctuation(ch){
  const c=context();
  if(ch==='{'||ch==='['){
   if(!root){if(ch!=='{')fail();root=true;}else value(undefined,true);
   if(stack.length>=maxDepth)fail();stack.push({kind:ch==='{'?'object':'array',state:'first',key:''});return;
  }
  if(!c)fail();
  if(ch==='}'||ch===']'){
   if(c.kind!==(ch==='}'?'object':'array')||!['first','comma'].includes(c.state))fail();
   stack.pop();if(!stack.length)done=true;return;
  }
  if(ch===':'&&c.kind==='object'&&c.state==='colon'){c.state='value';return;}
  if(ch===','&&c.state==='comma'){c.state=c.kind==='object'?'key':'value';return;}
  fail();
 }
 function finishAtom(){
  if(!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token))fail();
  value(JSON.parse(token));mode='';token='';
 }
 function consume(text){
  for(let i=0;i<text.length;i++){
   if((i&4095)===0&&Date.now()>deadline)fail();
   const ch=text[i];
   if(mode==='string'){
    if(unicode){if(!/[0-9a-fA-F]/.test(ch))fail();unicode--;}
    else if(escape){if(ch==='u')unicode=4;else if(!'"\\/bfnrt'.includes(ch))fail();escape=false;}
    else if(ch==='\\')escape=true;
    else if(ch==='"'){
     if(capture){const v=JSON.parse(token+'"');if(isKey){context().key=v;context().state='colon';}else value(v);}
     else if(isKey){context().key='';context().state='colon';}else value(undefined);
     mode='';token='';continue;
    }else if(ch.charCodeAt(0)<32)fail();
    if(capture){token+=ch;if(isKey&&token.length>256){capture=false;token='';}else if(!isKey&&token.length>24578)fail();}
    continue;
   }
   if(mode==='atom'){
    if(!/[\s,}\]]/.test(ch)){token+=ch;if(token.length>128)fail();continue;}
    finishAtom();
   }
   if(/[ \t\r\n]/.test(ch))continue;
   if(done)fail();
   if('{}[]:,'.includes(ch)){punctuation(ch);continue;}
   const c=context();isKey=c?.kind==='object'&&['first','key'].includes(c.state);
   if(ch==='"'){
    if(!isKey&&!wantsValue())fail();
    capture=isKey||stack.length===1&&fields.has(c?.key);token=capture?'"':'';mode='string';continue;
   }
   if(isKey||!wantsValue())fail();mode='atom';token=ch;
  }
 }
 for await(const chunk of stream){bytes+=Buffer.byteLength(chunk);if(bytes>maxBytes)fail();consume(decoder.decode(chunk,{stream:true}));}
 consume(decoder.decode());if(mode==='atom')finishAtom();if(mode||!done||stack.length)fail();return result;
}
