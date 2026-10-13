// FRITZ! Mesh Topology v5 (2026-06-19) and its nine published schemata:
// https://fritz.support/resources/Mesh-Topology.pdf
// UIDs resolve references inside one snapshot only. Never compare UIDs across polls.
const SCHEMAS = new Set(['1.0','1.5','1.6','1.9','4.11','5.0','6.7','7.8','8.7']);
const TYPES = new Set(['LAN','WLAN','PLC','DECT']);
const list = value => Array.isArray(value) ? value : [];
const clean = (value, max=200) => typeof value === 'string' ? value.slice(0,max) : null;
const macAddress = value => typeof value === 'string' && /^(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}$/i.test(value) && !/^(?:00[:-]){5}00$|^(?:ff[:-]){5}ff$/i.test(value) ? value.replaceAll('-',':').toUpperCase() : null;
const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 8640000000000000 ? value : typeof value === 'string' && value.trim() && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const pair = (a,b) => [a,b].sort().join('|');
const unknownPath = (status,reason) => ({status,reason,nodeIds:[],hops:[]});

// A single graph path must be unique, including its physical links. Choosing a
// shortest path would hide PLC buses, DBDC/MLO parallel links and real loops.
function findPath(nodes, links, start, master) {
  const adjacency = new Map(nodes.map(node=>[node.id,[]]));
  for(const link of links) if(link.state==='CONNECTED' && TYPES.has(link.type)) {
    adjacency.get(link.from)?.push({to:link.to,link});
    adjacency.get(link.to)?.push({to:link.from,link});
  }
  const search = blocked => {
    const parents=new Map([[start,null]]),queue=[start];
    for(let i=0;i<queue.length;i++) {
      if(queue[i]===master)break;
      for(const edge of adjacency.get(queue[i])||[]) if(edge.link!==blocked && !parents.has(edge.to)) {parents.set(edge.to,{from:queue[i],link:edge.link});queue.push(edge.to);}
    }
    return parents.has(master)?parents:null;
  };
  const parents=search();
  if(!parents)return unknownPath('missing','Kein durch verbundene, bekannte Links belegter PC→Master-Pfad. Das beweist keinen Geräteausfall.');
  const nodeIds=[master],hops=[];
  for(let id=master;id!==start;) {
    const edge=parents.get(id),reversed=edge.link.from!==edge.from;
    hops.unshift({...edge.link,from:edge.from,to:id,fromInterfaceMac:reversed?edge.link.toInterfaceMac:edge.link.fromInterfaceMac,toInterfaceMac:reversed?edge.link.fromInterfaceMac:edge.link.toInterfaceMac,receiveRateMbps:reversed?edge.link.transmitRateMbps:edge.link.receiveRateMbps,transmitRateMbps:reversed?edge.link.receiveRateMbps:edge.link.transmitRateMbps});
    id=edge.from;nodeIds.unshift(id);
  }
  if(hops.some(hop=>search(links.find(link=>link.id===hop.id))))return unknownPath('ambiguous','Mehrere gemeldete Verbindungen oder Pfade führen zum Master; der tatsächlich genutzte Weg ist unbekannt.');
  return {status:'confirmed',reason:'Eindeutiger Pfad aus den verbundenen Links dieses Snapshots; kein Nachweis tatsächlicher Paketweiterleitung.',nodeIds,hops};
}

export function buildMeshEvidence(snapshot, {pcMac,pcIp,repeaterHost,now=Date.now(),maxAgeMs=120000}={}) {
  const mesh=snapshot?.mesh;
  const observedMs=timestamp(snapshot?.at),nowMs=timestamp(now);
  const version=clean(mesh?.schemaVersion,30);
  const schema={version,status:!version?'missing':SCHEMAS.has(version)?version==='8.7'?'supported':'supported-legacy':'unknown'};
  const evidence={status:'unavailable',reason:null,observedAt:observedMs===null?null:new Date(observedMs).toISOString(),ageMs:observedMs!==null&&nowMs!==null?nowMs-observedMs:null,schema,nodes:[],links:[],complete:false,path:unknownPath('unknown','Keine belastbare Mesh-Beobachtung.'),limitations:[],context:{pcMac:macAddress(pcMac),pcIp:clean(pcIp,45),repeaterHost:clean(repeaterHost)}};
  const stop=(status,reason)=>{evidence.status=status;evidence.reason=reason;evidence.path=unknownPath(status,reason);return evidence;};
  if(!mesh || mesh.available===false || !Array.isArray(mesh.nodes) || !Array.isArray(mesh.links))return stop('unavailable','Kein erfolgreich erhobener Mesh-Snapshot. Eine fehlende Abfrage beweist keine Unterbrechung.');
  if(schema.status==='missing' || schema.status==='unknown')return stop('unsupported',schema.status==='missing'?'Mesh-Schemaversion fehlt; Linksemantik bleibt unbekannt.':`Unbekannte Mesh-Schemaversion ${version}; Links werden nicht als Pfadbeleg interpretiert.`);
  if(observedMs===null || nowMs===null || observedMs>nowMs)return stop('unknown','Beobachtungszeit fehlt, ist ungültig oder liegt in der Zukunft.');
  if(evidence.ageMs>(numeric(maxAgeMs)??120000))return stop('stale','Mesh-Snapshot ist älter als das zulässige Beobachtungsfenster.');
  if(schema.status==='supported-legacy')evidence.limitations.push('Älteres dokumentiertes Schema; LAN-Upstream-Markierung wird nicht vorausgesetzt.');
  let incomplete=mesh.truncated===true || mesh.nodes.length>256 || mesh.links.length>1024;
  const uidCounts=new Map(),macCounts=new Map();
  for(const node of mesh.nodes.slice(0,256)) {const mac=macAddress(node?.mac);if(node?.id)uidCounts.set(node.id,(uidCounts.get(node.id)||0)+1);if(mac)macCounts.set(mac,(macCounts.get(mac)||0)+1);}
  const byUid=new Map();
  for(const raw of mesh.nodes.slice(0,256)) {
    const mac=macAddress(raw?.mac);
    if(!mac || typeof raw?.id!=='string' || !raw.id || uidCounts.get(raw.id)!==1 || macCounts.get(mac)!==1){incomplete=true;continue;}
    const interfaces=list(raw.interfaces).slice(0,32).map(iface=>({id:clean(iface?.id),mac:macAddress(iface?.mac),type:TYPES.has(iface?.type)?iface.type:null,isUpstream:typeof iface?.isUpstream==='boolean'?iface.isUpstream:null}));
    if(list(raw.interfaces).length>32)incomplete=true;
    const node={id:`mac:${mac}`,mac,name:clean(raw.name,80),ip:clean(raw.ip,45),role:clean(raw.role,30),interfaces};
    evidence.nodes.push(node);byUid.set(raw.id,node);
  }
  const linkIds=new Set();
  for(const raw of mesh.links.slice(0,1024)) {
    if(raw?.id && linkIds.has(raw.id)) {incomplete=true;continue;}
    if(raw?.id)linkIds.add(raw.id);
    const from=byUid.get(raw?.from),to=byUid.get(raw?.to);
    if(!from || !to || from===to || !['CONNECTED','DISCONNECTED'].includes(raw?.state)){incomplete=true;continue;}
    const fromIf=from.interfaces.filter(iface=>iface.id===raw.fromInterface),toIf=to.interfaces.filter(iface=>iface.id===raw.toInterface);
    if((raw.fromInterface && fromIf.length!==1) || (raw.toInterface && toIf.length!==1))incomplete=true;
    const fromMac=fromIf.length===1?fromIf[0].mac:null,toMac=toIf.length===1?toIf[0].mac:null;
    const id=pair(`${from.id}/${fromMac||'?'}`,`${to.id}/${toMac||'?'}`);
    evidence.links.push({id,from:from.id,to:to.id,fromInterfaceMac:fromMac,toInterfaceMac:toMac,type:TYPES.has(raw.type)?raw.type:null,state:raw.state,receiveRateMbps:numeric(raw.receiveRateMbps??raw.rateMbps),transmitRateMbps:numeric(raw.transmitRateMbps)});
    if(!TYPES.has(raw.type))incomplete=true;
  }
  // Parallel links lacking distinct interface MACs cannot be correlated over time.
  const identityCounts=new Map();for(const link of evidence.links)identityCounts.set(link.id,(identityCounts.get(link.id)||0)+1);
  for(const link of evidence.links)link.identityAmbiguous=identityCounts.get(link.id)>1;
  if(incomplete)evidence.limitations.push('Snapshot ist begrenzt oder enthält nicht eindeutig identifizierbare Knoten, Endpunkte oder Linktypen.');
  if(evidence.links.some(link=>link.identityAmbiguous))evidence.limitations.push('Parallele Links haben keine eindeutige stabile Schnittstellenidentität.');
  evidence.complete=!incomplete;
  evidence.status=incomplete?'partial':'available';
  evidence.reason=incomplete?'Nur Teilbeobachtung; ein eindeutiger Gesamtpfad und verschwundene Geräte sind nicht sicher ableitbar.':'Mesh-Snapshot mit dokumentiertem Schema und stabilen MAC-Identitäten.';
  const pcMatches=evidence.context.pcMac?evidence.nodes.filter(node=>node.mac===evidence.context.pcMac || node.interfaces.some(iface=>iface.mac===evidence.context.pcMac)):[];
  const masters=evidence.nodes.filter(node=>node.role?.toUpperCase()==='MASTER');
  if(!evidence.context.pcMac)evidence.path=unknownPath('unknown','PC-MAC fehlt; IP-Adresse und gewählter Repeater belegen keinen Mesh-Pfad.');
  else if(pcMatches.length!==1)evidence.path=unknownPath(pcMatches.length?'ambiguous':'missing',pcMatches.length?'PC-MAC passt zu mehreren Knoten.':'PC-MAC wird nicht eindeutig im Snapshot gemeldet.');
  else if(masters.length!==1)evidence.path=unknownPath(masters.length?'ambiguous':'missing','Kein einzelner Mesh-Master ist eindeutig gemeldet.');
  else if(incomplete)evidence.path=unknownPath('partial','Unvollständiger Snapshot kann alternative Pfade verbergen.');
  else evidence.path=findPath(evidence.nodes,evidence.links,pcMatches[0].id,masters[0].id);
  return evidence;
}

export function compareMeshSnapshots(previous,current,{maxGapMs=120000,rateDropRatio=0.3,minRateDropMbps=10}={}) {
  const from=timestamp(previous?.at),to=timestamp(current?.at);
  const result={status:'unavailable',reason:null,interval:{from:from===null?null:new Date(from).toISOString(),to:to===null?null:new Date(to).toISOString()},changes:[]};
  const stop=reason=>{result.reason=reason;return result;};
  if(from===null || to===null || to<=from)return stop('Zwei zeitlich geordnete Mesh-Beobachtungen fehlen.');
  if(to-from>(numeric(maxGapMs)??120000))return stop('Beobachtungslücke ist zu groß; keine kontinuierliche Topologieänderung ableitbar.');
  if((previous?.host && current?.host && previous.host!==current.host) || (previous?.sessionId && current?.sessionId && previous.sessionId!==current.sessionId))return stop('Router oder Abfragesitzung hat gewechselt; neue Vergleichsbasis erforderlich.');
  const before=buildMeshEvidence(previous,{now:from}),after=buildMeshEvidence(current,{now:to});
  if(before.status!=='available' || after.status!=='available')return stop('Mindestens ein Snapshot fehlt, ist unvollständig oder verwendet ein unbekanntes Schema; kein Disconnect-Beweis.');
  if(before.schema.version!==after.schema.version)return stop('Mesh-Schema hat gewechselt; neue Vergleichsbasis erforderlich.');
  result.status='compared';result.reason='Änderungen wurden zwischen zwei Snapshots beobachtet. Der genaue Zeitpunkt und die Ursache sind unbekannt.';
  const add=(kind,fields)=>result.changes.push({kind,...fields,interval:{...result.interval}});
  const oldNodes=new Map(before.nodes.map(node=>[node.id,node])),newNodes=new Map(after.nodes.map(node=>[node.id,node]));
  for(const [id,node]of oldNodes)if(!newNodes.has(id))add('node-missing',{nodeId:id,name:node.name,reason:'Knoten im aktuellen Snapshot nicht mehr gemeldet; kein Beweis eines Geräteausfalls.'});
  for(const [id,node]of newNodes)if(!oldNodes.has(id))add('node-new',{nodeId:id,name:node.name,reason:'Knoten erstmals in dieser Vergleichsbasis gemeldet.'});
  const group=links=>{const groups=new Map();for(const link of links){const key=pair(link.from,link.to);groups.set(key,[...(groups.get(key)||[]),link]);}return groups;};
  const oldGroups=group(before.links),newGroups=group(after.links);
  const ratio=numeric(rateDropRatio);const threshold=ratio!==null&&ratio>0&&ratio<=1?ratio:0.3,minimum=numeric(minRateDropMbps)??10;
  const compareLink=(oldLink,newLink)=>{
    const ends={nodeIds:[oldLink?.from||newLink.from,oldLink?.to||newLink.to],linkId:oldLink?.id||newLink.id};
    if(oldLink?.state==='CONNECTED' && (!newLink || newLink.state==='DISCONNECTED'))add(newLink?'link-disconnected':'link-missing',{...ends,reason:newLink?'Box meldet diesen Link jetzt als getrennt.':'Aktiver Link nicht mehr gemeldet; kein sicherer Disconnect-Beweis.'});
    if(newLink?.state==='CONNECTED' && (!oldLink || oldLink.state==='DISCONNECTED'))add(oldLink?'link-restored':'link-added',{...ends,reason:oldLink?'Box meldet den zuvor getrennten Link jetzt als verbunden.':'Aktiver Link im aktuellen Snapshot neu gemeldet.'});
    if(oldLink && newLink && oldLink.state==='CONNECTED' && newLink.state==='CONNECTED') {
      if(oldLink.type!==newLink.type)add('technology-changed',{...ends,before:oldLink.type,after:newLink.type});
      else for(const direction of ['receiveRateMbps','transmitRateMbps']) {
        // RX/TX are relative to node_1. Reverse them if snapshot endpoints reversed.
        const oldRate=oldLink[direction],newRate=newLink[oldLink.from===newLink.from?direction:direction==='receiveRateMbps'?'transmitRateMbps':'receiveRateMbps'];
        if(oldRate!==null && newRate!==null && oldRate>0 && oldRate-newRate>=minimum && (oldRate-newRate)/oldRate>=threshold)add('rate-drop',{...ends,direction,receiverNodeId:direction==='receiveRateMbps'?oldLink.from:oldLink.to,beforeMbps:oldRate,afterMbps:newRate,dropPercent:100*(oldRate-newRate)/oldRate,reason:'Gemeldete lokale Linkrate fällt; kein Beweis eines Internetdurchsatzverlusts.'});
      }
    }
  };
  for(const key of new Set([...oldGroups.keys(),...newGroups.keys()])) {
    const oldLinks=oldGroups.get(key)||[],newLinks=newGroups.get(key)||[];
    if(oldLinks.length===1 && newLinks.length===1 && oldLinks[0].id===newLinks[0].id)compareLink(oldLinks[0],newLinks[0]);
    else {
      const oldById=new Map(oldLinks.filter(link=>!link.identityAmbiguous).map(link=>[link.id,link])),newById=new Map(newLinks.filter(link=>!link.identityAmbiguous).map(link=>[link.id,link]));
      if(oldLinks.some(link=>link.identityAmbiguous)||newLinks.some(link=>link.identityAmbiguous))add('link-identity-ambiguous',{nodeIds:key.split('|'),reason:'Parallele Links können nicht eindeutig über Snapshots zugeordnet werden.'});
      else for(const id of new Set([...oldById.keys(),...newById.keys()]))compareLink(oldById.get(id),newById.get(id));
    }
  }
  const oldMasters=before.nodes.filter(node=>node.role?.toUpperCase()==='MASTER'),newMasters=after.nodes.filter(node=>node.role?.toUpperCase()==='MASTER');
  if(oldMasters.length===1 && newMasters.length===1 && oldMasters[0].id===newMasters[0].id)for(const node of after.nodes) {
    if(node.id===newMasters[0].id || !oldNodes.has(node.id))continue;
    const oldPath=findPath(before.nodes,before.links,node.id,oldMasters[0].id),newPath=findPath(after.nodes,after.links,node.id,newMasters[0].id);
    if(oldPath.status==='confirmed' && newPath.status==='confirmed' && oldPath.nodeIds[1]!==newPath.nodeIds[1])add('uplink-changed',{nodeId:node.id,beforeNodeId:oldPath.nodeIds[1],afterNodeId:newPath.nodeIds[1]});
  }
  return result;
}
