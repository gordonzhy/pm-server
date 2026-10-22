import {t as tr,ui,locale,message,enumLabel} from './i18n.mjs';
// A lightweight overview uses graph geometry, while the page keeps its natural vertical scroll.
export function createGraphMinimap({graph,scroller,panel,map,toggle,isActive,onNavigate,collapsed=false,onCollapse}) {
  const NS='http://www.w3.org/2000/svg',make=(tag,attrs)=>{const n=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attrs))n.setAttribute(key,value);return n;};
  let model={nodes:[],lanes:[],edges:[],width:1,height:1},frame=0,viewport=null,dragging=false;
  function sync(){
    frame=0;
    const bounds=graph.getBoundingClientRect(),scrollBounds=scroller.getBoundingClientRect();
    panel.hidden=!isActive()||!model.nodes.length||bounds.bottom<=0||bounds.top>=innerHeight;
    map.toggleAttribute('hidden',collapsed);toggle.textContent=collapsed?tr('展开'):tr('收起');toggle.setAttribute('aria-expanded',String(!collapsed));
    if(panel.hidden||!viewport||!bounds.width||!bounds.height)return;
    const sx=model.width/bounds.width,sy=model.height/bounds.height;
    const left=Math.max(bounds.left,scrollBounds.left,0),right=Math.min(bounds.right,scrollBounds.right,innerWidth),top=Math.max(bounds.top,0),bottom=Math.min(bounds.bottom,innerHeight);
    for(const [key,value] of Object.entries({x:Math.max(0,(left-bounds.left)*sx),y:Math.max(0,(top-bounds.top)*sy),width:Math.max(0,(right-left)*sx),height:Math.max(0,(bottom-top)*sy)}))viewport.setAttribute(key,value);
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(sync);}
  function render(value){
    model=value;map.replaceChildren();map.setAttribute('viewBox',`0 0 ${model.width} ${model.height}`);
    for(const lane of model.lanes)map.append(make('rect',{x:0,y:lane.top,width:model.width,height:lane.height,fill:lane.accent,opacity:.09}));
    const positions=new Map(model.nodes.map(n=>[n.key,n]));
    for(const edge of model.edges){const a=positions.get(edge.source),b=positions.get(edge.target);map.append(make('line',{x1:a.x+a.width,y1:a.y+a.height/2,x2:b.x,y2:b.y+b.height/2,class:'minimap-edge'}));}
    for(const node of model.nodes)map.append(make('rect',{x:node.x,y:node.y,width:node.width,height:node.height,class:'minimap-node','data-posture':node.task.posture,'data-key':node.key}));
    viewport=make('rect',{id:'minimap-viewport','vector-effect':'non-scaling-stroke'});map.append(viewport);
    document.getElementById('minimap-count').textContent=ui`${model.nodes.length} 项`;schedule();
  }
  function navigate(x,y){
    if(!model.nodes.length)return;
    onNavigate?.();
    const bounds=graph.getBoundingClientRect(),scrollBounds=scroller.getBoundingClientRect();
    const targetX=Math.max(0,Math.min(model.width,x)),targetY=Math.max(0,Math.min(model.height,y));
    scroller.scrollTo({left:scroller.scrollLeft+bounds.left-scrollBounds.left+targetX*bounds.width/model.width-scroller.clientWidth/2,behavior:'instant'});
    window.scrollTo({top:scrollY+bounds.top+targetY*bounds.height/model.height-innerHeight/2,behavior:'instant'});schedule();
  }
  function point(event){const rect=map.getBoundingClientRect();navigate((event.clientX-rect.left)/rect.width*model.width,(event.clientY-rect.top)/rect.height*model.height);}
  map.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();map.focus({preventScroll:true});dragging=true;map.setPointerCapture(event.pointerId);point(event);});
  map.addEventListener('pointermove',event=>{if(dragging)point(event);});
  for(const type of ['pointerup','pointercancel','lostpointercapture'])map.addEventListener(type,()=>{dragging=false;});
  map.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();
    if(!viewport)return;
    const x=Number(viewport.getAttribute('x')),y=Number(viewport.getAttribute('y')),w=Number(viewport.getAttribute('width')),h=Number(viewport.getAttribute('height'));
    navigate(event.key==='Home'?0:event.key==='End'?model.width:x+w/2+(event.key==='ArrowRight'?w*.8:event.key==='ArrowLeft'?-w*.8:0),event.key==='Home'?0:event.key==='End'?model.height:y+h/2+(event.key==='ArrowDown'?h*.8:event.key==='ArrowUp'?-h*.8:0));
  });
  toggle.onclick=()=>{collapsed=!collapsed;onCollapse?.(collapsed);schedule();};
  window.addEventListener('scroll',schedule,{passive:true});window.addEventListener('resize',schedule,{passive:true});scroller.addEventListener('scroll',schedule,{passive:true});new ResizeObserver(schedule).observe(graph);
  return {render,schedule};
}
