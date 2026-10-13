const selector='.history-scroll-list,.history-table-wrap,.table-scroll,.fritzbox-table-wrap,.fritzbox-host-actions,.fritzbox-warnings,.fritzbox-log,.targets-list,.events-list,.diagnosis-list,.network-warnings,.ai-archive-result,.ping-target-options,.mesh-topology-detail,.lag-phases-list,.lag-traffic-device-table,.lag-traffic-intervals,.lag-window-table';
const saved=new WeakMap();
const bound=new WeakSet();
function regions(root) { return [...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)]; }
function memory(root) { if(!saved.has(root))saved.set(root,new Map());return saved.get(root); }
export function scrollRegionKey(root,item,index) { const disclosure=item.closest('[data-disclosure-key]')?.dataset.disclosureKey;return `${root.dataset?.scrollScope||'default'}:${item.dataset?.scrollKey||item.id||(disclosure?`${disclosure}:${item.className}`:index)}`; }
export function captureScroll(root) {
  if(!root)return;
  const positions=memory(root);
  regions(root).forEach((item,index)=>{if(item.getClientRects().length)positions.set(scrollRegionKey(root,item,index),{top:item.scrollTop,left:item.scrollLeft});});
}
export function restoreScroll(root) {
  if(!root)return;
  const positions=memory(root);
  regions(root).forEach((item,index)=>{
    const identity=scrollRegionKey(root,item,index),position=positions.get(identity);
    if(position&&item.getClientRects().length){item.scrollTop=position.top;item.scrollLeft=position.left;}
    if(!item.hasAttribute('tabindex'))item.tabIndex=0;
    if(!item.hasAttribute('role'))item.setAttribute('role','region');
    if(!item.hasAttribute('aria-label'))item.setAttribute('aria-label',(item.querySelector('thead')?.innerText?.trim().replace(/\s+/g,' ').slice(0,100)||'Liste')+' – separat scrollbar');
    if(!bound.has(item)) {
      item.addEventListener('scroll',()=>{if(item.getClientRects().length)positions.set(identity,{top:item.scrollTop,left:item.scrollLeft});},{passive:true});
      bound.add(item);
    }
  });
}
export function clearScroll(root) { if(root)saved.delete(root); }
