// A spanning forest arranges reported links; its layout parents are not a claim
// about forwarding/uplink direction. Every extra physical link remains present.
export const TOPOLOGY_GEOMETRY=Object.freeze({nodeWidth:220,nodeHeight:104,levelGap:220,siblingGap:38,componentGap:72,padding:40,extraLaneGap:14});
export function buildTopology(mesh = {}) {
  const sourceNodes = Array.isArray(mesh?.nodes) ? mesh.nodes : [];
  const sourceLinks = Array.isArray(mesh?.links) ? mesh.links : [];
  const byId = new Map();
  for (const item of sourceNodes.slice(0, 256)) if (item && typeof item.id === 'string' && item.id && !byId.has(item.id)) byId.set(item.id, { ...item });
  const nodes = [...byId.values()]; const links = []; const dangling = []; const seen = new Set();
  for (const [index, item] of sourceLinks.slice(0, 1024).entries()) {
    if (!item || typeof item.from !== 'string' || typeof item.to !== 'string') continue;
    const id = typeof item.id === 'string' && item.id ? item.id : `legacy-${index}`;
    if (seen.has(id)) continue; seen.add(id);
    const link = { ...item, id };
    if (!byId.has(link.from) || !byId.has(link.to)) dangling.push(link); else links.push(link);
  }
  const g=TOPOLOGY_GEOMETRY,stable=node=>node.mac?.toUpperCase()||node.name||node.ip||node.id;
  const rank=node=>node.role?.toUpperCase()==='MASTER'?0:node.role?.toUpperCase()==='SLAVE'||/repeater/i.test(node.model||'')?1:2;
  const order=(a,b)=>rank(a)-rank(b)||String(stable(a)).localeCompare(String(stable(b)))||a.id.localeCompare(b.id);
  const neighbors = new Map(nodes.map(item => [item.id, new Set()]));
  for (const link of links) if (link.state === 'CONNECTED'&&link.from!==link.to) { neighbors.get(link.from).add(link.to); neighbors.get(link.to).add(link.from); }
  const pending = new Set(byId.keys()); const components = [],treeLinkIds=new Set(); let top = g.padding; let maxDepth = 0;
  const ordered = nodes.slice().sort(order);
  for (const root of ordered) {
    if (!pending.has(root.id)) continue;
    const component = []; const queue = [{ id: root.id, depth: 0 }],children=new Map([[root.id,[]]]); pending.delete(root.id);
    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]; component.push(entry);
      Object.assign(byId.get(entry.id),{depth:entry.depth,component:components.length,width:g.nodeWidth,height:g.nodeHeight,layoutParentId:entry.parentId||null});
      for (const id of [...neighbors.get(entry.id)].sort((a,b)=>order(byId.get(a),byId.get(b)))) if (pending.delete(id)) {
        queue.push({ id, depth: entry.depth + 1,parentId:entry.id });children.set(id,[]);children.get(entry.id).push(id);
        const candidates=links.filter(link=>link.state==='CONNECTED'&&(link.from===id&&link.to===entry.id||link.to===id&&link.from===entry.id)).sort((a,b)=>String(a.type||'').localeCompare(String(b.type||''))||a.id.localeCompare(b.id));
        treeLinkIds.add(candidates[0].id);
      }
    }
    // Disjoint subtree spans reserve real room for every descendant. Centering
    // parents inside their own span keeps branches intact instead of interleaving.
    const spans=new Map();
    for(const entry of component.slice().reverse()) {
      const childIds=children.get(entry.id);
      spans.set(entry.id,Math.max(g.nodeHeight,childIds.reduce((sum,id)=>sum+spans.get(id),0)+Math.max(0,childIds.length-1)*g.siblingGap));
      maxDepth=Math.max(maxDepth,entry.depth);
    }
    const ids=new Set(component.map(entry=>entry.id)),extras=links.filter(link=>ids.has(link.from)&&ids.has(link.to)&&!treeLinkIds.has(link.id));
    const contentTop=top+extras.length*g.extraLaneGap+24,placements=[{id:root.id,top:contentTop}];
    for(let index=0;index<placements.length;index++) {
      const entry=placements[index],node=byId.get(entry.id),span=spans.get(entry.id);
      Object.assign(node,{x:g.padding+node.depth*(g.nodeWidth+g.levelGap),y:entry.top+(span-g.nodeHeight)/2,subtreeTop:entry.top,subtreeBottom:entry.top+span,children:children.get(entry.id)});
      let childTop=entry.top;for(const id of node.children){placements.push({id,top:childTop});childTop+=spans.get(id)+g.siblingGap;}
    }
    for(const [index,link]of extras.entries())link.extraLaneY=top+(index+.5)*g.extraLaneGap;
    top=contentTop+spans.get(root.id)+g.componentGap;components.push(component.map(entry=>entry.id));
  }
  const extraLinks=links.filter(link=>!treeLinkIds.has(link.id));
  for(const [index,link]of extraLinks.entries()) {
    // Disconnected cross-component links travel in a shared exterior alley.
    if(link.extraLaneY==null)link.extraLaneY=top+(index+.5)*g.extraLaneGap;
  }
  const crossComponent=extraLinks.some(link=>byId.get(link.from).component!==byId.get(link.to).component);
  const width=Math.max(640,g.padding*2+g.nodeWidth+maxDepth*(g.nodeWidth+g.levelGap)+60),height=Math.max(230,top+(crossComponent?extraLinks.length*g.extraLaneGap:0));
  for(const [index,link]of links.entries()) {
    const from=byId.get(link.from),to=byId.get(link.to),isTree=treeLinkIds.has(link.id);
    if(isTree) {
      const child=from.layoutParentId===to.id?from:to,parent=child===from?to:from;
      const x=parent.x+g.nodeWidth+g.levelGap*.24,y1=parent.y+g.nodeHeight/2,y2=child.y+g.nodeHeight/2;
      link.geometry={isTree:true,points:[{x:parent.x+g.nodeWidth,y:y1},{x,y:y1},{x,y:y2},{x:child.x,y:y2}],label:{x:child.x-146,y:y2-30,width:132,height:60}};
    } else {
      const fromY=from.y+g.nodeHeight*.28,toY=to.y+g.nodeHeight*.7;
      const shaft1=from.x+g.nodeWidth+10+(index%6)*6,shaft2=to.x+g.nodeWidth+13+((index+3)%6)*6,lane=link.extraLaneY;
      link.geometry={isTree:false,points:[{x:from.x+g.nodeWidth,y:fromY},{x:shaft1,y:fromY},{x:shaft1,y:lane},{x:shaft2,y:lane},{x:shaft2,y:toY},{x:to.x+g.nodeWidth,y:toY}],label:null};
    }
  }
  for(const node of nodes)node.extraLinkCount=extraLinks.filter(link=>link.from===node.id||link.to===node.id).length;
  return { nodes, links, dangling, components, width,height,byId,treeLinks:links.filter(link=>treeLinkIds.has(link.id)),extraLinks };
}

const element = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = String(text); return item; };
const rate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mbit/s` : null;
const typeLabel = type => ({ LAN: 'LAN / Kabel', Ethernet: 'LAN / Kabel', WLAN: 'WLAN', PLC: 'Powerline', DECT: 'DECT' })[type] || 'Verbindungstyp unbekannt';
const roleLabel = item => item.role?.toUpperCase() === 'MASTER' ? 'Mesh-Master' : item.role?.toUpperCase() === 'SLAVE' ? (/repeater/i.test(item.model || '') ? 'Mesh-Repeater' : 'Mesh-Gerät') : 'Gerät';
function domKey(value) { let hash = 2166136261; for (const char of String(value)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619); return (hash >>> 0).toString(16); }

export function topologyEvidenceLines(evidence, comparison) {
  const lines=[];
  if(evidence) {
    if(evidence.path?.status==='confirmed') {
      const names=new Map((evidence.nodes||[]).map(node=>[node.id,node.name||node.mac||'Gerät']));
      lines.push(`Gemeldeter PC→Master-Pfad: ${(evidence.path.nodeIds||[]).map(id=>names.get(id)||'Gerät').join(' → ')}`);
      lines.push(evidence.path.reason);
    } else lines.push(`PC→Master-Pfad nicht belegt: ${evidence.path?.reason||evidence.reason||'Keine belastbare Beobachtung.'}`);
    lines.push(...(evidence.limitations||[]));
  }
  if(comparison) {
    const labels={'node-missing':'Knoten nicht mehr gemeldet','node-new':'Knoten neu gemeldet','link-disconnected':'Link als getrennt gemeldet','link-restored':'Link wieder als verbunden gemeldet','link-missing':'Link nicht mehr gemeldet','link-added':'Link neu gemeldet','technology-changed':'Verbindungstechnologie geändert','rate-drop':'Lokale Linkrate gefallen','uplink-changed':'Gemeldeter Uplink geändert','link-identity-ambiguous':'Linkzuordnung mehrdeutig'};
    const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('de-DE'):'Zeit unbekannt';
    for(const change of (comparison.changes||[]).slice(0,32)) {
      const interval=change.interval||comparison.interval;
      const detail=change.kind==='rate-drop'?` · ${rate(change.beforeMbps)||'–'} → ${rate(change.afterMbps)||'–'}`:change.kind==='technology-changed'?` · ${typeLabel(change.before)} → ${typeLabel(change.after)}`:'';
      lines.push(`${labels[change.kind]||'Topologieänderung'}${change.name?` · ${change.name}`:''}${detail} · beobachtet zwischen ${time(interval?.from)} und ${time(interval?.to)}${change.reason?` · ${change.reason}`:''}`);
    }
    if(comparison.status!=='compared')lines.push(comparison.reason||'Kein belastbarer Vergleich zweier Mesh-Beobachtungen.');
    else if(comparison.changes?.length)lines.push('Der genaue Änderungszeitpunkt und die Ursache sind unbekannt.');
  }
  return lines.filter(Boolean);
}

// Evidence IDs are MAC-based; resolve transient UIDs only inside this drawing.
export function topologyLinkOnPath(mesh,link,evidence) {
  if(evidence?.path?.status!=='confirmed')return false;
  const nodes=Array.isArray(mesh?.nodes)?mesh.nodes:[];
  const from=nodes.find(node=>node.id===link.from),to=nodes.find(node=>node.id===link.to);
  if(!from?.mac||!to?.mac)return false;
  const fromId=`mac:${from.mac.toUpperCase()}`,toId=`mac:${to.mac.toUpperCase()}`;
  const fromInterface=from.interfaces?.find(iface=>iface.id===link.fromInterface)?.mac?.toUpperCase()||null;
  const toInterface=to.interfaces?.find(iface=>iface.id===link.toInterface)?.mac?.toUpperCase()||null;
  const key=(a,b)=>[a,b].sort().join('|');
  const identity=key(`${fromId}/${fromInterface||'?'}`,`${toId}/${toInterface||'?'}`);
  return (evidence.path.hops||[]).some(hop=>hop.id===identity);
}

export function topologyLinkKey(mesh,link) {
  const nodes=Array.isArray(mesh?.nodes)?mesh.nodes:[],from=nodes.find(node=>node.id===link.from),to=nodes.find(node=>node.id===link.to);
  if(!from?.mac||!to?.mac)return null;
  const endpoint=(node,id)=>`${node.mac.toUpperCase()}/${node.interfaces?.find(iface=>iface.id===id)?.mac?.toUpperCase()||'?'}`;
  return [endpoint(from,link.fromInterface),endpoint(to,link.toInterface)].sort().join('|')+`/${link.type||'?'}`;
}
export function topologyPathData(points) {
  return points.map((point,index)=>`${index?'L':'M'} ${point.x} ${point.y}`).join(' ');
}

export function renderTopology(parent, mesh, state = {}, prefix = 'live') {
  const graph=buildTopology(mesh),wrapper=element('div','mesh-topology');
  wrapper.append(element('p','mesh-topology-note','Baumanordnung der gemeldeten Verbindungen · Master links, nachfolgende Knoten rechts. Zusätzliche Links bleiben sichtbar. Die Anordnung allein belegt keine Uplink-Richtung.'));
  const evidence=state.evidence||mesh?.evidence,comparison=state.comparison||mesh?.comparison;
  const isSuspect=link=>evidence?.path?.status==='confirmed'&&state.suspectLinkId&&topologyLinkOnPath(mesh,link,evidence)&&topologyLinkOnPath(mesh,link,{path:{status:'confirmed',hops:[{id:state.suspectLinkId}]}});
  if(state.suspectLinkId&&graph.links.some(isSuspect))wrapper.append(element('p','mesh-topology-note','Orange: durch Messvergleiche eingegrenzter Verdachtsabschnitt. Das ist kein bestätigter Defekt dieser Verbindung.'));
  const evidenceLines=topologyEvidenceLines(evidence,comparison);
  if(evidenceLines.length){const panel=element('div','mesh-topology-evidence');for(const line of evidenceLines)panel.append(element('p','mesh-topology-note',line));wrapper.append(panel);}
  for(const incident of (Array.isArray(state.incidents)?state.incidents:[]).slice(0,16))if(typeof incident?.href==='string'&&/^#[a-zA-Z0-9_-]+$/.test(incident.href)){const anchor=element('a','mesh-topology-incident',incident.title||'Zeitlich passende Lag-Phase ansehen');anchor.href=incident.href;wrapper.append(anchor);}
  if(mesh?.truncated)wrapper.append(element('p','mesh-topology-note',`Begrenzter Snapshot: ${graph.nodes.length} von ${mesh.totalNodes??'?'} Knoten gespeichert.`));
  if(!graph.nodes.length){wrapper.append(element('p','fritzbox-empty','Keine Topologie von der Box gemeldet.'));parent.append(wrapper);return;}
  wrapper.append(element('p','mesh-topology-summary',`${graph.nodes.length} Knoten · ${graph.links.filter(link=>link.state==='CONNECTED').length} aktive Verbindungen · ${graph.extraLinks.length} Zusatzlinks · ${graph.components.length} Gruppen aus gemeldeten aktiven Links`));
  if(graph.dangling.length)wrapper.append(element('p','mesh-topology-note',`${graph.dangling.length} gemeldete Verbindungen haben einen nicht enthaltenen Endpunkt und werden nicht eingezeichnet.`));
  const toolbar=element('div','mesh-topology-toolbar'),zoomLabel=element('output','mesh-zoom-value');zoomLabel.setAttribute('aria-label','Vergrößerung');
  const scroll=element('div','mesh-topology-scroll');scroll.setAttribute('aria-label','Mesh-Stammbaum, horizontal und vertikal scrollbar');scroll.tabIndex=0;
  const plane=element('div','mesh-topology-plane'),canvas=element('div','mesh-topology-canvas');canvas.style.width=`${graph.width}px`;canvas.style.height=`${graph.height}px`;
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width',graph.width);svg.setAttribute('height',graph.height);svg.setAttribute('role','group');svg.setAttribute('aria-label','Gemeldete Mesh-Verbindungen');
  const svgElement=(tag,attrs,text,container=svg)=>{const item=document.createElementNS(svg.namespaceURI,tag);for(const [key,value]of Object.entries(attrs))item.setAttribute(key,value);if(text!=null)item.textContent=String(text);container.append(item);return item;};
  const buttons=new Map(),lines=new Map(),detail=element('div','mesh-topology-detail');let showLinkSelection=()=>{};
  const nodeName=node=>node?.name||node?.ip||node?.model||node?.mac||'Unbenanntes Gerät';
  const linkText=link=>{const from=graph.byId.get(link.from),to=graph.byId.get(link.to);return `${nodeName(from)} ↔ ${nodeName(to)} · ${typeLabel(link.type)} · ${link.state==='CONNECTED'?'verbunden':link.state==='DISCONNECTED'?'getrennt':'Zustand unbekannt'}`;};
  for(const link of [...graph.extraLinks,...graph.treeLinks]) {
    const confirmed=topologyLinkOnPath(mesh,link,evidence),classes=`mesh-link${link.type==='WLAN'?' mesh-link-wlan':''}${link.state==='DISCONNECTED'?' mesh-link-disconnected':''}${!link.geometry.isTree?' mesh-link-extra':''}${confirmed?' mesh-link-pc-path':''}${isSuspect(link)?' mesh-link-suspect':''}`;
    const group=svgElement('g',{'data-link-id':link.id,class:'mesh-link-group',role:'button',tabindex:'0','aria-label':linkText(link),'aria-pressed':'false'});
    svgElement('title',{},`${linkText(link)}${link.geometry.isTree?'':' · Zusatzverbindung'}`,group);
    const path=topologyPathData(link.geometry.points);
    svgElement('path',{d:path,class:classes},null,group);svgElement('path',{d:path,class:'mesh-link-hit'},null,group);
    if(link.geometry.label) {
      const label=link.geometry.label,cx=label.width/2;
      svgElement('rect',{...label,rx:5,class:'mesh-link-label-background'},null,group);
      const caption=svgElement('svg',{...label,overflow:'hidden',class:'mesh-link-caption'},null,group);
      svgElement('text',{x:cx,y:16,'text-anchor':'middle',class:'mesh-link-label'},({LAN:'LAN / Kabel',Ethernet:'LAN / Kabel',WLAN:'WLAN',PLC:'Powerline',DECT:'DECT'})[link.type]||'Typ unbekannt',caption);
      if(link.state==='CONNECTED') {
        svgElement('text',{x:cx,y:33,'text-anchor':'middle',class:'mesh-link-rate'},`RX ${rate(link.receiveRateMbps??link.rateMbps)||'–'}`,caption);
        svgElement('text',{x:cx,y:49,'text-anchor':'middle',class:'mesh-link-rate'},`TX ${rate(link.transmitRateMbps)||'–'}`,caption);
      }
    }
    const activate=()=>showLinkSelection(link.id);
    group.addEventListener('click',activate);group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}});lines.set(link.id,group);
  }
  canvas.append(svg);
  const clearSelection=()=>{for(const button of buttons.values()){button.classList.remove('is-selected');button.setAttribute('aria-pressed','false');}for(const line of lines.values()){line.classList.remove('is-selected');line.setAttribute('aria-pressed','false');}};
  const showSelection=id=>{
    const selected=graph.byId.get(id);if(!selected)return;state.selectedId=id;state.selectedMac=selected.mac?.toUpperCase()||null;state.selectedLinkKey=null;state.selectedLinkId=null;clearSelection();
    buttons.get(id)?.classList.add('is-selected');buttons.get(id)?.setAttribute('aria-pressed','true');detail.replaceChildren(element('h4','',nodeName(selected)));
    detail.append(element('p','',[roleLabel(selected),selected.model,selected.ip].filter(Boolean).join(' · ')));
    if(selected.extraLinkCount)detail.append(element('p','mesh-topology-note',`${selected.extraLinkCount} zusätzliche gemeldete Links. Aus parallelen Verbindungen oder Schleifen lässt sich der tatsächliche Uplink nicht allein aus der Baumanordnung bestimmen.`));
    const connections=graph.links.filter(link=>link.from===id||link.to===id);
    if(!connections.length)detail.append(element('p','mesh-topology-note','Keine Verbindung für diesen Knoten gemeldet. Ein isolierter Knoten beweist keinen Geräteausfall.'));
    for(const link of connections){const control=element('button','button button-secondary mesh-topology-connection',linkText(link));control.type='button';control.addEventListener('click',()=>showLinkSelection(link.id));detail.append(control);}
  };
  showLinkSelection=(id,notify=true)=>{
    const link=graph.links.find(item=>item.id===id);if(!link)return;clearSelection();state.selectedLinkId=id;state.selectedLinkKey=topologyLinkKey(mesh,link);lines.get(id)?.classList.add('is-selected');lines.get(id)?.setAttribute('aria-pressed','true');
    const from=graph.byId.get(link.from),to=graph.byId.get(link.to);detail.replaceChildren(element('h4','','Gemeldete Verbindung'),element('p','',linkText(link)));
    if(isSuspect(link))detail.append(element('p','mesh-topology-note','Verdachtsabschnitt dieses Vorfalls: Die Belege und Gegenbelege stehen in der Diagnose. Ein Defekt oder eine Funkstörung ist damit nicht nachgewiesen.'));
    detail.append(element('p','',`RX zu ${nodeName(from)}: ${rate(link.receiveRateMbps??link.rateMbps)||'unbekannt'} · TX zu ${nodeName(to)}: ${rate(link.transmitRateMbps)||'unbekannt'}`));
    detail.append(element('p','mesh-topology-note',`${link.geometry.isTree?'Verbindung im dargestellten Baum':'Zusatzverbindung außerhalb der Baumanordnung'}. Linkraten beschreiben die lokale Verbindung und keinen gemessenen Internetdurchsatz.`));
    for(const node of from===to?[from]:[from,to]){const control=element('button','button button-secondary mesh-topology-connection',`${nodeName(node)} auswählen`);control.type='button';control.addEventListener('click',()=>showSelection(node.id));detail.append(control);}
    if(notify&&typeof state.onLinkSelect==='function')state.onLinkSelect(link,{from,to});
  };
  for(const item of graph.nodes) {
    const button=element('button',`mesh-node${item.role?.toUpperCase()==='MASTER'?' mesh-node-master':''}`);button.type='button';button.id=`mesh-${prefix}-${domKey(item.id)}`;button.dataset.nodeId=item.id;
    button.style.left=`${item.x}px`;button.style.top=`${item.y}px`;button.title=[nodeName(item),item.model,item.ip].filter(Boolean).join(' · ');
    button.append(element('span','mesh-node-role',roleLabel(item)),element('strong','',nodeName(item)),element('span','mesh-node-address',item.ip||item.model||'IP unbekannt'));
    if(item.extraLinkCount)button.append(element('span','mesh-node-extra',`+${item.extraLinkCount} Links`));
    button.addEventListener('click',()=>showSelection(item.id));buttons.set(item.id,button);canvas.append(button);
  }
  plane.append(canvas);scroll.append(plane);
  let zoom=typeof state.zoom==='number'&&Number.isFinite(state.zoom)?Math.min(1.5,Math.max(.35,state.zoom)):1;
  const applyZoom=value=>{
    const next=Math.round(Math.min(1.5,Math.max(.35,value))*100)/100,centerX=(scroll.scrollLeft+scroll.clientWidth/2)/zoom,centerY=(scroll.scrollTop+scroll.clientHeight/2)/zoom;
    zoom=next;state.zoom=zoom;canvas.style.transform=`scale(${zoom})`;plane.style.width=`${Math.ceil(graph.width*zoom)}px`;plane.style.height=`${Math.ceil(graph.height*zoom)}px`;zoomLabel.textContent=`${Math.round(zoom*100)} %`;
    scroll.scrollLeft=Math.max(0,centerX*zoom-scroll.clientWidth/2);scroll.scrollTop=Math.max(0,centerY*zoom-scroll.clientHeight/2);
  };
  const centerNode=node=>{if(!node)return;scroll.scrollLeft=Math.max(0,node.x*zoom-24);scroll.scrollTop=Math.max(0,(node.y+node.height/2)*zoom-scroll.clientHeight/2);};
  const tool=(label,action,title)=>{const button=element('button','button button-secondary',label);button.type='button';if(title)button.title=title;button.addEventListener('click',action);toolbar.append(button);return button;};
  tool('−',()=>applyZoom(zoom-.15),'Verkleinern');toolbar.append(zoomLabel);tool('+',()=>applyZoom(zoom+.15),'Vergrößern');
  tool('Einpassen',()=>{applyZoom(Math.min(1,(scroll.clientWidth-24)/graph.width,(scroll.clientHeight-24)/graph.height));scroll.scrollLeft=0;scroll.scrollTop=0;},'Baum soweit möglich einpassen; große Netze bleiben scrollbar');
  tool('Master',()=>centerNode(graph.nodes.find(item=>item.role?.toUpperCase()==='MASTER')||graph.nodes[0]),'Zum gemeldeten Master springen');
  tool('Auswahl',()=>centerNode(graph.byId.get(state.selectedId)), 'Zum ausgewählten Knoten springen');
  scroll.addEventListener('wheel',event=>{if(event.ctrlKey){event.preventDefault();applyZoom(zoom+(event.deltaY<0?.1:-.1));}},{passive:false});
  scroll.addEventListener('scroll',()=>{state.scrollLeft=scroll.scrollLeft;state.scrollTop=scroll.scrollTop;});
  wrapper.append(toolbar,scroll,detail);
  if(graph.extraLinks.length) {
    const disclosure=element('details','mesh-extra-links');disclosure.open=state.extraLinksExpanded??graph.extraLinks.length<=4;
    disclosure.append(element('summary','',`${graph.extraLinks.length} Zusatzverbindungen · parallel, quer oder nicht aktiv`),element('p','mesh-topology-note','Diese Links bleiben vollständig gemeldet. Sie sind keine weiteren erfundenen Eltern im Stammbaum. Auswählen hebt die tatsächliche Verbindung hervor.'));
    const list=element('div','mesh-extra-link-list');
    for(const link of graph.extraLinks){const control=element('button','button button-secondary mesh-topology-connection',linkText(link));control.type='button';control.addEventListener('click',()=>showLinkSelection(link.id));list.append(control);}disclosure.append(list);disclosure.addEventListener('toggle',()=>{state.extraLinksExpanded=disclosure.open;});wrapper.append(disclosure);
  }
  parent.append(wrapper);applyZoom(zoom);
  const selectedLink=state.selectedLinkKey&&graph.links.filter(link=>topologyLinkKey(mesh,link)===state.selectedLinkKey);
  const byMac=state.selectedMac&&graph.nodes.find(item=>item.mac?.toUpperCase()===state.selectedMac);
  if(selectedLink?.length===1)showLinkSelection(selectedLink[0].id,false);
  else showSelection(byMac?.id||(!state.selectedMac&&graph.byId.has(state.selectedId)?state.selectedId:null)||graph.nodes.find(item=>item.role?.toUpperCase()==='MASTER')?.id||graph.nodes[0].id);
  if(state.viewInitialized){scroll.scrollLeft=state.scrollLeft||0;scroll.scrollTop=state.scrollTop||0;}
  else {centerNode(graph.nodes.find(item=>item.role?.toUpperCase()==='MASTER')||graph.nodes[0]);state.viewInitialized=true;}
}
