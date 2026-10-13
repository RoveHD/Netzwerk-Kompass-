import { randomUUID, createHash } from 'node:crypto';
import { summarize, PING_WARNING_MS, PING_SPIKE_MS, isLatencySpike } from './analysis.js';
import { buildMeshEvidence } from './mesh-evidence.js';
import { correlateLagTraffic, prepareLagTraffic } from '../public/lag-incidents.js';
import { ADAPTER_COUNTERS } from './adapter-health.js';

const list = value => Array.isArray(value) ? value : [];
const time = value => typeof value==='string'?Date.parse(value):NaN;
const source = record => typeof record.sourceDeviceId==='string'&&record.sourceDeviceId?record.sourceDeviceId.slice(0,80):'local';
const measurementError = result => result?.status==='measurement_error' || Boolean(result?.error) && result?.timeout!==true;
const good = result => result?.ok === true && !measurementError(result) && Number.isFinite(result.ms) && result.ms >= 0;
const abnormal = result => result && !measurementError(result) && (result.ok === false || isLatencySpike(result));
const normal = result => good(result)&&result.ms<=PING_WARNING_MS;
const overlaps = (from,to,start,end) => Number.isFinite(from) && Number.isFinite(to) && from <= end && to >= start;
const observedInterval = (record,interval=record.interval) => Number.isFinite(time(interval?.from))&&Number.isFinite(time(interval?.to))&&time(interval.to)>=time(interval.from)&&time(interval.to)<=time(record.at);
const remote = record => record.remote===true || source(record)!=='local';
const clockUsable = record => record.clockReliable!==false && (!remote(record) || Number.isFinite(record.clockUncertaintyMs) && record.clockUncertaintyMs>=0 && record.clockUncertaintyMs<=1000);
const saneText = (text,max=180) => typeof text === 'string' ? text.slice(0,max) : '';
const SESSION_FIELDS=['sourceSession','sourceSessionId','appSessionId','epoch','measurementStartedAt','interfaceId'];
const streamKey = record => JSON.stringify([source(record),...SESSION_FIELDS.map(key=>typeof record[key]==='string'?record[key].slice(0,200):typeof record[key]==='number'?record[key]:null)]);
const matchesIncident = (record,incident) => source(record)===(incident.sourceDeviceId||'local') && SESSION_FIELDS.every(key=>!Object.hasOwn(incident,key) || (record[key]??null)===(incident[key]??null));
const uniqueRecords = records => {
  const seen=new Set();return list(records).filter(record=>{
    if(!record||!Number.isFinite(time(record.at)))return false;
    const rawKey=record.recordId?`${streamKey(record)}:${record.recordId}`:record.sequence!=null?`${streamKey(record)}:${record.sequence}:${record.type}`:JSON.stringify([streamKey(record),record.type,record.at,record.results||null,record.interfaceId,record.intervalStartedAt,record.kind||null,record.incidentId||null,record.type==='event'?record.capture||null:null]);
    const key=createHash('sha256').update(rawKey).digest('hex');
    if(seen.has(key))return false;seen.add(key);return true;
  }).sort((a,b)=>time(a.at)-time(b.at));
};

function windowStats(records, from, to) {
  const targets = new Map();
  for (const record of records) {
    if (record.type !== 'ping' || time(record.at) < from || time(record.at) > to || !clockUsable(record)) continue;
    for (const result of list(record.results)) {
      if(typeof result?.host!=='string'||!result.host||!good(result)&&!abnormal(result)&&!measurementError(result))continue;
      const key = `${streamKey(record)}:${result.host}`;
      if (!targets.has(key)) {if(targets.size>=64)continue;targets.set(key,{sourceDeviceId:saneText(source(record),80),streamKey:streamKey(record),host:saneText(result.host,253),label:saneText(result.label||result.host,80),kind:result.kind==='router'?'gateway':result.kind,samples:[],seen:new Set()});}
      const target=targets.get(key),sampleKey=`${record.at}:${result.ok}:${result.ms}:${result.status||''}`;
      if(target.seen.has(sampleKey))continue;target.seen.add(sampleKey);
      target.samples.push({...result,status:measurementError(result)?'measurement_error':result.status,at:record.at,quality:result.quality||record.quality});
    }
  }
  return [...targets.values()].map(({samples,seen,...target})=>({...target,...summarize(samples,target.kind),firstAt:samples[0]?.at,lastAt:samples.at(-1)?.at}));
}
const isBad = target => target && (target.maxMs >= PING_SPIKE_MS || target.lossPercent > 0);
const isGood = target => target && target.sent >= 2 && target.received === target.sent && target.maxMs <= PING_WARNING_MS && !target.measurementErrors;
const iso = value => Number.isFinite(value)?new Date(value).toISOString():null;
const positive = value => typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function trafficCoverage(intervals,points,from,to,now) {
  const spans=list(intervals).map(row=>({from:Math.max(from,time(row.overlapStart||row.start)),to:Math.min(to,time(row.overlapEnd||row.end))})).filter(row=>Number.isFinite(row.from)&&Number.isFinite(row.to)&&row.to>=row.from).sort((a,b)=>a.from-b.from);
  let coveredMs=0,maxGapMs=0,cursor=from;
  for(const row of spans){maxGapMs=Math.max(maxGapMs,row.from-cursor);coveredMs+=Math.max(0,row.to-Math.max(cursor,row.from));cursor=Math.max(cursor,row.to);}
  maxGapMs=Math.max(maxGapMs,to-cursor);
  const pointTimes=list(points).map(row=>time(row.at)).filter(Number.isFinite),observedFrom=spans[0]?.from??pointTimes[0],observedTo=spans.at(-1)?.to??pointTimes.at(-1),duration=to-from;
  return {mode:spans.length?'intervals':pointTimes.length?'points':'unknown',observedFrom:iso(observedFrom),observedTo:iso(observedTo),coveredMs,coveragePercent:duration>0?Math.min(100,coveredMs/duration*100):null,maxGapMs:Math.max(0,maxGapMs),complete:now>=to&&duration>0&&coveredMs/duration>=.99&&maxGapMs<=1000,samples:spans.length||pointTimes.length,containsBoundaryIntervals:list(intervals).some(row=>time(row.start)<from||time(row.end)>to)};
}
function trafficWindow(pcIndex,routerIndex,from,to,now,{maxDevices=4,knownDevices=[]}={}) {
  const pc=correlateLagTraffic(pcIndex,{start:from,end:to}).pc,central=correlateLagTraffic(routerIndex,{start:from,end:to});
  const interval=row=>({from:iso(time(row.start)),to:iso(time(row.end)),start:iso(time(row.start)),end:iso(time(row.end)),overlapStart:iso(Math.max(from,time(row.start))),overlapEnd:iso(Math.min(to,time(row.end))),...Object.fromEntries(['downloadMbps','uploadMbps','downloadBytes','uploadBytes','estimatedDownloadBytes','estimatedUploadBytes','overlapMs','intervalMs','timingUncertaintyMs'].map(key=>[key,positive(row[key])])),bytesDerived:row.bytesDerived===true,measurementBasis:saneText(row.measurementBasis,60)});
  const compact=value=>({download:value.download,upload:value.upload,samples:value.samples,coverage:trafficCoverage(value.intervals,value.points,from,to,now),intervals:list(value.intervals).slice(0,4).map(interval),intervalsTruncated:list(value.intervals).length>4});
  const devices=central.devices.map(device=>{
    const peak=list(device.intervalsDetail).slice().sort((a,b)=>(b.downloadMbps+b.uploadMbps)-(a.downloadMbps+a.uploadMbps))[0];
    return {id:saneText(device.id,100),label:saneText(device.label,80),ip:saneText(device.ip,45),mac:saneText(device.mac,17),downloadMbps:positive(device.intervalRateDownloadMbps),uploadMbps:positive(device.intervalRateUploadMbps),peakMbps:peak?positive(peak.downloadMbps+peak.uploadMbps):null,peakInterval:peak?interval(peak):null,intervals:device.intervals,intervalsDetail:list(device.intervalsDetail).slice(0,4).map(interval),intervalsTruncated:list(device.intervalsDetail).length>4,coverage:trafficCoverage(device.intervalsDetail,[],from,to,now)};
  }).sort((a,b)=>(b.peakMbps??-1)-(a.peakMbps??-1));
  const measuredIds=new Set(devices.map(device=>device.id));
  for(const device of knownDevices)if(!measuredIds.has(device.id))devices.push({id:saneText(device.id,100),label:saneText(device.label,80),ip:saneText(device.ip,45),mac:saneText(device.mac,17),downloadMbps:null,uploadMbps:null,intervals:0,intervalsDetail:[],reason:saneText(device.reason||'Keine passenden Geräte-Zählerintervalle verfügbar.',180)});
  return {from:iso(from),to:iso(to),pc:compact(pc),wan:compact(central.wan),wanUtilization:central.wanUtilization,deviceCount:devices.length,unavailableDeviceCount:devices.length-measuredIds.size,devicesTruncated:devices.length>maxDevices||central.truncated,devices:devices.slice(0,maxDevices)};
}
function packetEvidence(records,incident,start,end) {
  return records.filter(record=>record.type==='event'&&record.kind==='incident-packets'&&!remote(record)&&(incident.sourceDeviceId||'local')==='local'&&record.incidentId===incident.id).map(record=>{
    const capture=record.capture||{},from=time(capture.startedAt),to=time(capture.endedAt);
    if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to>time(record.at)||!overlaps(from,to,start,end+60000)||to<start)return null;
    const relation=from<=end&&to>=start?'overlap':'after';
    return {startedAt:iso(from),endedAt:iso(to),relation,status:saneText(capture.status,30),quality:['unknown','observed','incomplete'].includes(capture.quality)?capture.quality:'unknown',...Object.fromEntries(['sentPackets','receivedPackets','sentBytes','receivedBytes','retransmits','sampleIntervalMs'].map(key=>[key,positive(capture[key])])),losses:{events:positive(capture.losses?.events),buffers:positive(capture.losses?.buffers)},scope:'local-stack-events',deliveryBeyondRouter:'unknown',causeEvidence:false};
  }).filter(Boolean).slice(-4);
}

export function analyzeIncident(incident, records, { now = Date.now() } = {}) {
  records=uniqueRecords(records).filter(record=>time(record.at)<=now);
  const start=time(incident.startedAt),end=incident.trigger==='manual'?time(incident.endedAt)||Math.min(now,time(incident.observationEndAt)):time(incident.endedAt||incident.lastAbnormalAt||incident.startedAt);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||!Number.isFinite(now))throw new TypeError('Vorfall benötigt gültige, geordnete Beobachtungszeiten.');
  const context=records.find(record=>record.type==='ping'&&matchesIncident(record,incident)&&time(record.at)>=start&&time(record.at)<=end)||{};
  incident={...Object.fromEntries(SESSION_FIELDS.map(key=>[key,context[key]??null])),...incident};
  const own=records.filter(record=>matchesIncident(record,incident));
  const pings=own.filter(record=>record.type==='ping'&&time(record.at)>=start&&time(record.at)<=end);
  const during=windowStats(own,start,end),before=windowStats(own,start-60000,start-1),after=windowStats(own,end+1,end+60000);
  const peers=windowStats(records.filter(record=>source(record)!==incident.sourceDeviceId),start-500,end+500);
  const anchor=pings.find(clockUsable)||own.filter(record=>record.type==='network'&&time(record.at)<=start&&clockUsable(record)).at(-1)||own.find(record=>record.type==='event'&&time(record.at)===start&&clockUsable(record))||{};
  // A later snapshot cannot establish the topology at the start of an incident.
  const prior=records.filter(record=>record.type==='fritzbox'&&record.kind!=='traffic'&&record.mesh&&!remote(record)&&time(record.at)<=start).at(-1);
  const mesh=buildMeshEvidence(prior,{pcMac:anchor.routingConfirmed===true?anchor.pcMac:null,pcIp:typeof anchor.ipv4?.[0]==='string'?anchor.ipv4[0]:anchor.ipv4?.[0]?.address,now:start,maxAgeMs:90000});
  const central=records.filter(record=>record.type==='fritzbox'&&!remote(record)&&(!prior?.host||record.host===prior.host)&&(!prior?.sessionId||record.sessionId===prior.sessionId));
  const changes=records.filter(record=>record.type==='mesh_change' && !remote(record) && time(record.at)<=end+60000 && observedInterval(record) && (!prior?.sessionId||record.sessionId===prior.sessionId) && overlaps(time(record.interval?.from),time(record.interval?.to),start,end));
  const changeFacts=changes.flatMap(record=>list(record.changes).map(change=>({...change,interval:change.interval||record.interval})).filter(change=>observedInterval(record,change.interval)&&overlaps(time(change.interval.from),time(change.interval.to),start,end)));
  const adapter=own.filter(record=>record.type==='traffic'&&clockUsable(record)&&record.adapterHealth?.available===true&&record.adapterHealth?.reset!==true&&time(record.at)-time(record.adapterHealth?.intervalStartedAt)>0&&time(record.at)-time(record.adapterHealth?.intervalStartedAt)<=15000&&overlaps(time(record.adapterHealth?.intervalStartedAt),time(record.at),start,end)&&ADAPTER_COUNTERS.some(key=>Number.isSafeInteger(record.adapterHealth?.delta?.[key])&&record.adapterHealth.delta[key]>0));
  // PC epochs are private to that PC. Router counters use the central router's
  // own session; imposing the peer's appSessionId silently loses shared WAN data.
  const pcTraffic=correlateLagTraffic(own.filter(record=>record.type==='traffic'&&clockUsable(record)),{start,end,appSessionId:incident.appSessionId,measurementStartedAt:incident.measurementStartedAt||anchor.measurementStartedAt,epoch:incident.epoch,interfaceId:incident.interfaceId||anchor.interfaceId});
  const sharedTraffic=correlateLagTraffic(central,{start,end});
  const traffic={...sharedTraffic,pc:pcTraffic.pc};
  const pcIndex=prepareLagTraffic(own.filter(record=>record.type==='traffic'&&clockUsable(record)&&record.quality?.gap!==true&&(!record.intervalStartedAt||!Number.isFinite(time(incident.measurementStartedAt))||time(record.intervalStartedAt)>=time(incident.measurementStartedAt)))),routerIndex=prepareLagTraffic(central.filter(clockUsable));
  const observedDevices=to=>prepareLagTraffic(central.filter(record=>time(record.at)<=to)).sources.filter(source=>source.kind==='device');
  const trafficComparison={before:trafficWindow(pcIndex,routerIndex,start-60000,start,now),during:trafficWindow(pcIndex,routerIndex,start,end,now,{maxDevices:128,knownDevices:observedDevices(end)}),after:trafficWindow(pcIndex,routerIndex,end,end+60000,now)};
  const packetCaptures=packetEvidence(records,incident,start,end);
  const router=during.find(item=>item.kind==='gateway'),internet=during.filter(item=>item.kind==='internet');
  if(mesh.path.status==='confirmed'&&router&&/^\d+\.\d+\.\d+\.\d+$/.test(router.host)) {
    const master=mesh.nodes.find(node=>node.id===mesh.path.nodeIds.at(-1));
    if(master?.ip&&master.ip!==router.host)mesh.path={status:'unknown',reason:'Gemeldeter Mesh-Master entspricht nicht dem gemessenen Gateway; dieser Snapshot belegt den PC-Pfad nicht.',nodeIds:[],hops:[]};
  }
  const resultAt=(record,host)=>list(record.results).find(result=>result.host===host);
  const usesPath=(record,pcMac)=>record.routingConfirmed===true&&typeof record.pcMac==='string'&&record.pcMac.replaceAll('-',':').toUpperCase()===pcMac;
  const simultaneous=predicate=>{
    const seen=new Set();return pings.filter(record=>{if(!clockUsable(record)||record.quality?.gap===true||!predicate(record)||seen.has(record.at))return false;seen.add(record.at);return true;});
  };
  const peerPairs=(peer,predicate,{ownMac,peerMac}={})=>{
    const frames=records.filter(record=>record.type==='ping'&&streamKey(record)===peer.streamKey&&clockUsable(record)&&record.quality?.gap!==true&&time(record.at)>=start-500&&time(record.at)<=end+500&&(!peerMac||usesPath(record,peerMac)));
    const used=new Set();let count=0;
    for(const frame of simultaneous(record=>abnormal(resultAt(record,router.host))&&(!ownMac||usesPath(record,ownMac)))) {
      const match=frames.find((record,index)=>!used.has(index)&&Math.abs(time(record.at)-time(frame.at))+(record.clockUncertaintyMs||0)+(frame.clockUncertaintyMs||0)<=500&&predicate(resultAt(record,router.host)));
      if(match){used.add(frames.indexOf(match));count++;}
    }
    return count;
  };
  const candidates=[];
  const add=(category,title,section,support,contradictions,missing,nextTest,strong=false)=>candidates.push({category,title,section,confidence:strong?'Stark unterstützt':'Plausibler Verdacht',support,contradictions,missing,nextTest});
  const describe=target=>`${target.label}: Max. ${target.maxMs??'unbekannt'} ms, ${target.sent-target.received}/${target.sent} ICMP-Antworten fehlen (${target.firstAt} – ${target.lastAt}).`;
  const limitations=['ICMP-Priorisierung kann von der Weiterleitung von Spiel-/TCP-Paketen abweichen. Ein fehlender Ping ist kein nachgewiesener Verbindungsabbruch.'];
  if(traffic.devices.length)limitations.push('Geräteintervalle verwenden gemeldete Routerzeitpunkte. Die Routeruhr wurde nicht mit der PC-Uhr abgeglichen; eine dargestellte Überschneidung bestätigt keine sekundengenaue Gleichzeitigkeit. Geräteaktivität ist kein Ursachenbeweis.');
  if(start<now-300000)limitations.push('Langer Vorfall: der hochauflösende Analysepuffer umfasst höchstens fünf Minuten und ist mengenbegrenzt. Frühere Abschnitte können fehlen; die angezeigten Kennzahlen beziehen sich nur auf verfügbare Messpunkte.');
  if(incident.trigger==='manual')limitations.push('Manuell markierter Lag-Zeitpunkt mit höchstens 5 s Beobachtungsfenster; die Markierung ist kein Nachweis einer Ping- oder Netzwerkstörung.');
  if(incident.endReason&&incident.endReason!=='recovered')limitations.push('Beobachtung endete ohne gemessene Erholung; Messlücke, Sitzungswechsel oder Stoppen sind kein Netzausfallbeleg.');
  if(mesh.path.status!=='confirmed')limitations.push(mesh.path.reason);
  else limitations.push(`Pfad zuletzt beobachtet ${mesh.observedAt}; Änderungen zwischen den Routerabfragen bleiben unbekannt.`);
  if(anchor.routingConfirmed!==true)limitations.push('Windows-Routing über den ausgewählten Adapter ist nicht bestätigt; keine automatische PC-Pfadlokalisierung.');
  else if(pings.some(record=>!usesPath(record,mesh.context.pcMac)))limitations.push('Routing oder PC-MAC ist nicht in allen Messrunden für diesen Mesh-Pfad bestätigt; nur passende bestätigte Runden dienen als Pfadbeleg.');
  if(records.some(record=>remote(record)&&!clockUsable(record)))limitations.push('Peer-Daten mit unklarer oder über 1 s unsicherer Zeitsynchronisierung sind aus dem zeitgleichen Vergleich ausgeschlossen.');
  const missing=['Direkte Airtime-, SNR- und WLAN-Retry-Messungen der Backhaul-Strecken sind nicht verfügbar.'];
  if(!traffic.devices.length)missing.push('Gerätebezogener Traffic nicht verfügbar.');
  if(!prior)missing.push('Kein Mesh-Snapshot vor dem Vorfall.');
  if(!peers.length)missing.push('Kein zeitlich passender Vergleich eines zweiten PCs. Ein nicht erreichbarer Mess-Agent ist kein WLAN-Ausfallbeleg.');
  let pathBoundary=null;
  if(mesh.path.status==='confirmed') {
    const nodes=mesh.path.nodeIds.map(id=>mesh.nodes.find(node=>node.id===id));
    const first=nodes[1],access=mesh.path.hops[0];
    if(access?.type==='LAN'&&first?.role==='SLAVE'&&router&&first.ip!==router.host) {
      const pairs=simultaneous(record=>usesPath(record,mesh.context.pcMac)&&abnormal(resultAt(record,first.ip))&&abnormal(resultAt(record,router.host))&&!internet.some(item=>normal(resultAt(record,item.host))));
      if(pairs.length>=2)add('local_access','Auffälligkeit bereits am direkt angeschlossenen Repeater','PC / Adapter / LAN / Port / direkt angeschlossener Repeater',
        [`Bestätigter gemeldeter LAN-Hop ${nodes[0].name||'PC'} → ${first.name||first.ip}.`,`${pairs.length} gemeinsame Messrunden: erster Repeater und Gateway auffällig; keine gleichzeitig gute Internetantwort.`,describe(during.find(item=>item.host===first.ip)),describe(router)],
        ['ICMP-Priorisierung der Geräte bleibt möglich. Ein Kabeldefekt ist damit nicht nachgewiesen.'],['Kein Messpunkt innerhalb von Adapter, Kabel oder Port.'],'Vorhandenen Port bzw. direkten Routeranschluss vergleichen; Adapterzähler zeitgleich prüfen.');
    }
    const measured=nodes.slice(1).map(node=>({node,stats:during.find(item=>item.host===node?.ip)}));
    for(let i=1;i<measured.length;i++) {
      const near=measured[i-1],far=measured[i],beyond=measured.slice(i);
      if(!isGood(near.stats)||!isBad(far.stats)||beyond.some(item=>!isBad(item.stats)))continue;
      const pairs=simultaneous(record=>usesPath(record,mesh.context.pcMac)&&normal(resultAt(record,near.node.ip))&&beyond.every(item=>abnormal(resultAt(record,item.node.ip)))&&!internet.some(item=>normal(resultAt(record,item.host))));
      if(pairs.length<2)continue;
      const link=mesh.path.hops.find(hop=>hop.from===near.node.id&&hop.to===far.node.id);
      pathBoundary={from:near.node.id,to:far.node.id,linkId:link?.id||null,type:link?.type||null};
      const relevant=changeFacts.filter(change=>link&&change.linkId===link.id&&['link-disconnected','link-restored','technology-changed','rate-drop'].includes(change.kind));
      add(link?.type==='WLAN'?'mesh_backhaul':'lan_path','Auffälligkeit beginnt hinter einem erreichbaren Pfadknoten',`${near.node.name||near.node.ip} → ${far.node.name||far.node.ip}`,
        [`${pairs.length} gemeinsame Messrunden: naher Knoten ≤50 ms, nachfolgender Knoten auffällig.`,describe(near.stats),...beyond.map(item=>describe(item.stats)),...relevant.slice(0,4).map(item=>`${item.kind} zwischen ${item.interval.from} und ${item.interval.to}; genauer Änderungszeitpunkt unbekannt.`)],
        ['ICMP-Antworten einzelner Mesh-Geräte können gedrosselt werden.'],missing,
        'PC testweise direkt hinter dem verdächtigen Abschnitt anschließen und dieselben Ziele vergleichen; falls möglich mit vorhandenem LAN-Backhaul gegenprüfen.',relevant.length>0);
      break;
    }
  }
  if(adapter.length)add('local_adapter','Lokale Adapterfehler im überlappenden Intervall','PC / Netzwerkadapter',adapter.slice(0,5).map(record=>`${record.adapterHealth.intervalStartedAt} – ${record.at}: ${ADAPTER_COUNTERS.filter(key=>record.adapterHealth.delta[key]>0).map(key=>`${key} +${record.adapterHealth.delta[key]}`).join(', ')}`),['Treiberzähler unterscheiden Kabel, Port und Treiberproblem nicht.'],['Keine direkte Kabeldiagnose.'],'Mit anderem vorhandenem LAN-Kabel/Port oder direktem Routeranschluss vergleichen.');
  const wanPairs=router?simultaneous(record=>normal(resultAt(record,router.host))&&internet.length>=2&&internet.every(item=>abnormal(resultAt(record,item.host)))):[];
  const routerForwardPairs=router?simultaneous(record=>abnormal(resultAt(record,router.host))&&internet.some(item=>normal(resultAt(record,item.host)))):[];
  if(isGood(router)&&internet.length>=2&&internet.every(isBad)&&wanPairs.length>=2) {
    const busy=traffic.wanUtilization.overload;
    add(busy?'wan_load':'wan','Lokaler Router stabil, mehrere Internetziele auffällig','FRITZ!Box → WAN / Internet',
      [describe(router),...internet.map(describe),...(busy?[`WAN-Auslastung im überlappenden Zählerintervall: Download ${traffic.wanUtilization.downloadPercent?.toFixed(1)??'?'} %, Upload ${traffic.wanUtilization.uploadPercent?.toFixed(1)??'?'} % der gemeldeten Anschlussrate.`]:[])],
      ['ICMP-Drosselung und gemeinsame externe Routingstrecken bleiben möglich.'],['Keine Messung innerhalb des Anbieternetzes.'],busy?'Upload/Download kontrolliert pausieren und Leerlauf vergleichen. Ein Lasttest nur bewusst außerhalb des Spiels kann Warteschlangenbildung prüfen.':'Router-WAN-Ereignisse und einen weiteren unabhängigen Internetdienst zeitgleich prüfen.',busy);
  } else if(isBad(router)) {
    const goodInternet=routerForwardPairs.length>=2?internet.filter(isGood):[];
    add(goodInternet.length?'router_icmp':'router_path',goodInternet.length?'Router-Ping auffällig, Weiterleitung zu externen Zielen unauffällig':'Lokaler Weg zur FRITZ!Box auffällig',pathBoundary?'Siehe eingegrenzten Mesh-Abschnitt':'PC → FRITZ!Box',
      [describe(router),...goodInternet.map(describe)],goodInternet.length?['Unauffällige Antworten hinter dem Router sprechen gegen einen allgemeinen Ausfall des Übertragungswegs.']:[],mesh.path.status==='confirmed'?[]:['Topologie oder Zwischenmesspunkte fehlen.'],goodInternet.length?'ICMP-Priorisierung mit Router-Ereignissen und Anwendungsmessung vergleichen.':'Nahen Repeater und die nachfolgenden Knoten desselben realen Pfads gleichzeitig messen.');
  }
  const matchingPeers=peers.filter(item=>router&&item.host===router.host);
  const pairedGoodPeers=matchingPeers.filter(item=>isGood(item)&&peerPairs(item,normal)>=2);
  const peerBad=matchingPeers.filter(item=>isBad(item)&&peerPairs(item,abnormal)>=2);
  if(router&&pairedGoodPeers.length&&!peerBad.length&&isBad(router))add('pc_path','Nur dieser beobachtete PC zeigt die Auffälligkeit','Netzwerkpfad dieses PCs',[describe(router),...pairedGoodPeers.map(item=>`${item.sourceDeviceId}: ${describe(item)}`)],['Nicht getestete Geräte bleiben unbekannt.'],mesh.path.status==='confirmed'?[]:['Eindeutiger Mesh-Pfad fehlt.'],'PCs an den Repeateranschlüssen gegeneinander tauschen oder direkt am Router vergleichen.');
  if(isBad(router)&&peerBad.length&&mesh.path.status==='confirmed'&&routerForwardPairs.length<2) {
    const shared=new Set(mesh.path.hops.map(hop=>hop.id));
    for(const peer of peerBad) {
      const peerAnchor=records.find(record=>streamKey(record)===peer.streamKey&&record.type==='ping'&&clockUsable(record)&&time(record.at)>=start-500&&time(record.at)<=end+500);
      const peerPath=buildMeshEvidence(prior,{pcMac:peerAnchor?.routingConfirmed===true?peerAnchor.pcMac:null,now:start,maxAgeMs:90000});
      if(peerPath.path.status!=='confirmed'){shared.clear();break;}
      if(peerPairs(peer,abnormal,{ownMac:mesh.context.pcMac,peerMac:peerPath.context.pcMac})<2){shared.clear();break;}
      const ids=new Set(peerPath.path.hops.map(hop=>hop.id));for(const id of shared)if(!ids.has(id))shared.delete(id);
    }
    if(shared.size)add('shared_mesh','Mehrere PCs auffällig auf gemeinsam gemeldeten Mesh-Abschnitten',[...shared].join(' · '),[describe(router),...peerBad.map(item=>`${item.sourceDeviceId}: ${describe(item)}`)],['Gemeinsame Auffälligkeit lokalisiert nicht allein einen Defekt.'],['Direkte Weiterleitungs-/Retry-Zähler der gemeinsamen Links fehlen.'],'Vor und hinter dem gemeinsamen Abschnitt gleichzeitig messen.');
  }
  if(internet.some(isBad)&&internet.some(isGood)&&simultaneous(record=>internet.some(item=>abnormal(resultAt(record,item.host)))&&internet.some(item=>normal(resultAt(record,item.host)))).length>=2)add('external_target','Ein externes Ziel oder sein Weg ist auffällig','Externes Ziel / Routing',internet.map(describe),[],['Spielserver kann ICMP anders behandeln.'],'Zusätzlich den tatsächlichen Spielserver bzw. die Anwendungsmessung vergleichen.');
  const dns=own.filter(record=>record.type==='dns'&&record.ok===false&&time(record.at)>=start&&time(record.at)<=end);
  if(dns.length)add('dns','DNS-Auflösung im Vorfall fehlgeschlagen','Windows / DNS',dns.map(record=>`${record.at}: Namensauflösung fehlgeschlagen.`),isBad(router)?['Gleichzeitige lokale Netzprobleme können DNS-Fehler erklären.']:[],['Auflösung beinhaltet Windows-Cache.'],'IP-Erreichbarkeit und DNS-Auflösung zeitgleich vergleichen.');
  const observedChanges=changeFacts.slice(0,20);
  const pathIds=new Set(mesh.path.hops.map(hop=>hop.id)),nodeIds=new Set(mesh.path.nodeIds);
  const relevantChanges=observedChanges.filter(change=>mesh.path.status!=='confirmed'||pathIds.has(change.linkId)||nodeIds.has(change.nodeId)||list(change.nodeIds).some(id=>nodeIds.has(id)));
  if(relevantChanges.length)add('mesh_change','Mesh-Zustand hat sich im Beobachtungsfenster geändert','Gemeldete Mesh-Verbindungen',relevantChanges.map(change=>`${change.kind}: zwischen ${change.interval.from} und ${change.interval.to}`),['Der genaue Änderungszeitpunkt zwischen den Abfragen ist unbekannt.','Zeitliche Nähe allein beweist keine Ursache des Lags.'],['Eine Linkratenänderung beweist keine Interferenz.'],'Betroffene Linkraten und Pfadziele weiter beobachten; Routerereignisse auf Kanal-/DFS-Hinweise prüfen.');
  const wlanEvents=records.filter(record=>record.type==='router_event'&&!remote(record)&&observedInterval(record)&&(record.category==='wlan'||/\bWLAN\b|\bDFS\b|Kanal|Radar/i.test(record.message||''))&&overlaps(time(record.interval?.from),time(record.interval?.to),start,end));
  if(wlanEvents.length)add('possible_radio','Router meldet WLAN-/Kanalereignisse im Beobachtungsfenster','Funknetz',wlanEvents.slice(0,8).map(record=>`${record.interval.from} – ${record.interval.to}: ${saneText(record.message)}`),['Protokolleintrag ist keine direkte Interferenzmessung.'],missing,'Mit Router-/Repeaterereignissen und einem vorhandenen LAN-Vergleich eingrenzen.');
  const trafficIncreases=[];
  for(const [key,label]of [['pc','PC-Adapter'],['wan','FRITZ!Box-WAN']]) {
    const baseline=trafficComparison.before[key],current=trafficComparison.during[key];
    if(baseline.coverage.mode!=='intervals'||baseline.coverage.coveragePercent<80||baseline.coverage.coveredMs<48000||baseline.coverage.samples<3||baseline.coverage.maxGapMs>10000||baseline.coverage.containsBoundaryIntervals||current.coverage.mode!=='intervals'||current.coverage.samples<2||current.coverage.coveragePercent<80||current.coverage.containsBoundaryIntervals)continue;
    for(const [direction,name]of [['download','Download'],['upload','Upload']])if(positive(baseline[direction]?.average)!=null&&positive(current[direction]?.average)!=null&&current[direction].average>=baseline[direction].average*2&&current[direction].average-baseline[direction].average>=5)trafficIncreases.push(`${label} ${name}: vorher ${baseline[direction].average.toFixed(1)}, im Vorfall ${current[direction].average.toFixed(1)} Mbit/s; Baseline ${baseline.coverage.coveredMs/1000} s, ${baseline.coverage.samples} Zählerintervalle.`);
  }
  if(trafficIncreases.length)add('traffic_change','Gemessener Datenverkehr steigt gegenüber der Baseline','Getrennte PC-/WAN-Zähler',trafficIncreases,['Zeitlicher Anstieg beweist weder Überlastung noch die Ursache des Lags.','Aktive Geräte werden nicht allein wegen ihres Verkehrs als Verursacher bezeichnet.'],['Keine direkte Warteschlangen- oder Anwendungszustellungsmessung.'],'Mit kontrolliertem Leerlauf vergleichen; PC-, WAN- und Gerätezähler getrennt betrachten.');
  const retransmitCaptures=packetCaptures.filter(capture=>capture.relation==='overlap'&&['complete','stopped'].includes(capture.status)&&capture.quality!=='unknown'&&capture.retransmits>0);
  if(retransmitCaptures.length)add('tcp_retransmit','Lokale Windows-TCP-Retransmits in zeitlich überlappender Erfassung','Lokaler TCP-Stack',retransmitCaptures.map(capture=>`${capture.startedAt} – ${capture.endedAt}: ${capture.retransmits} Retransmit-Ereignisse im gesamten Erfassungsintervall.`),['Kein Nachweis von Spiel-/UDP-Paketverlust oder einer Ursache im Mesh.','Die Ereignisse sind innerhalb dieses Intervalls nicht dem genauen Lag-Zeitpunkt zugeordnet; Zustellung hinter dem Router bleibt unbekannt.'],['ETW-Ereignisse beschreiben lokale Beobachtung; verlorene ETW-Ereignisse sind kein Netzwerkpaketverlust.'],'Mit Anwendungsdaten und zeitgleichen Pfadmessungen vergleichen.');
  if(packetCaptures.some(capture=>capture.relation==='after'))limitations.push('Paketaufzeichnung nach dem Lag: späterer Zustand, kein Beleg für die Ursache des vorherigen Vorfalls.');
  if(!candidates.length)candidates.push({category:'unknown',title:'Ursache nicht eindeutig bestimmbar.',section:'Nicht lokalisierbar',confidence:'Unklar',support:[...during.filter(isBad).map(describe),...(incident.trigger==='manual'?[`Manuelle Lag-Markierung ${incident.startedAt}; keine Netzwerkstörung aus der Markierung abgeleitet.`]:[])],contradictions:[],missing,nextTest:'FRITZ!Box verbinden, PC-MAC/Topologie prüfen und einen zweiten PC als Vergleich koppeln.'});
  candidates.sort((a,b)=>Number(b.confidence==='Stark unterstützt')-Number(a.confidence==='Stark unterstützt'));
  const affected=list(incident.affectedHosts).length?incident.affectedHosts:during.filter(isBad).map(item=>item.host);
  const expectedHosts=affected.length?affected:during.map(target=>target.host);
  const completeWindow=(targets,from,to)=>expectedHosts.length>0&&expectedHosts.every(host=>targets.some(target=>target.host===host&&time(target.firstAt)<=from+1000&&time(target.lastAt)>=to-1000&&target.maxIntervalMs<=10000&&!target.measurementErrors&&!target.measurementGaps));
  const summaries=targets=>targets.map(({streamKey,...target})=>target);
  const safeNode=node=>({id:saneText(node?.id,200),name:saneText(node?.name,80),ip:saneText(node?.ip,45),mac:saneText(node?.mac,17),role:saneText(node?.role,30),interfaces:list(node?.interfaces).slice(0,4).map(iface=>({id:saneText(iface?.id,200),mac:saneText(iface?.mac,17),type:saneText(iface?.type,30),isUpstream:iface?.isUpstream===true}))});
  const safeLink=link=>Object.fromEntries(['id','from','to','fromInterface','toInterface','type','state'].map(key=>[key,saneText(link?.[key],200)]).concat(['receiveRateMbps','transmitRateMbps'].map(key=>[key,Number.isFinite(link?.[key])?link[key]:null])));
  const safeDetail=value=>Object.fromEntries(Object.entries(value||{}).map(([key,value])=>[saneText(key,40),typeof value==='string'?saneText(value,80):typeof value==='number'&&Number.isFinite(value)?value:typeof value==='boolean'?value:null]));
  const compactTraffic=value=>({...value,points:list(value?.points).slice(0,12).map(safeDetail),intervals:list(value?.intervals).slice(0,12).map(safeDetail),detailsTruncated:list(value?.points).length>12||list(value?.intervals).length>12});
  const metadata=Object.fromEntries(['id','sourceDeviceId',...SESSION_FIELDS,'trigger','note','observationEndAt','startedAt','lastAbnormalAt','lastSeenAt','endedAt','status','endReason'].map(key=>[key,typeof incident[key]==='string'?saneText(incident[key],200):incident[key]??null]));
  const result={...metadata,updatedAt:new Date(now).toISOString(),durationMs:Math.max(0,end-start),affectedHosts:affected.slice(0,32).map(host=>saneText(host,253)),
    affectedSources:[incident.sourceDeviceId||'local',...new Set(peerBad.map(item=>item.sourceDeviceId))].slice(0,8),
    windows:{before:{from:new Date(start-60000).toISOString(),to:incident.startedAt,complete:completeWindow(before,start-60000,start),targets:summaries(before)},during:{from:incident.startedAt,to:new Date(end).toISOString(),complete:completeWindow(during,start,end),targets:summaries(during)},after:{from:new Date(end).toISOString(),to:new Date(end+60000).toISOString(),complete:now>=end+60000&&completeWindow(after,end,end+60000),targets:summaries(after)}},
    topology:prior?{at:prior.at,mesh:{schemaVersion:saneText(prior.mesh?.schemaVersion,30),nodes:list(prior.mesh?.nodes).slice(0,24).map(safeNode),links:list(prior.mesh?.links).slice(0,48).map(safeLink),truncated:prior.mesh?.truncated===true||list(prior.mesh?.nodes).length>24||list(prior.mesh?.links).length>48}}:null,
    path:{...mesh.path,nodeIds:mesh.path.nodeIds.slice(0,24),hops:mesh.path.hops.slice(0,24),truncated:mesh.path.nodeIds.length>24},pathNodes:mesh.nodes.filter(node=>mesh.path.nodeIds.includes(node.id)).slice(0,24).map(safeNode),pathBoundary,meshChanges:observedChanges.map(change=>({kind:saneText(change.kind,60),linkId:saneText(change.linkId,200),nodeId:saneText(change.nodeId,200),interval:change.interval})),
    traffic:{pc:compactTraffic(traffic.pc),wan:compactTraffic(traffic.wan),wanUtilization:traffic.wanUtilization,devices:traffic.devices.slice(0,8).map(device=>({...device,id:saneText(device.id,100),ip:saneText(device.ip,45),mac:saneText(device.mac,17),label:saneText(device.label,80),intervalsDetail:list(device.intervalsDetail).slice(0,8).map(safeDetail)})),capabilityReason:saneText(traffic.capabilityReason,320)},
    trafficComparison,packetCaptures,
    adapterErrors:adapter.slice(0,8).map(record=>({at:record.at,intervalStartedAt:record.adapterHealth.intervalStartedAt,delta:Object.fromEntries(ADAPTER_COUNTERS.map(key=>[key,record.adapterHealth.delta[key]??null]))})),
    diagnoses:candidates.map(candidate=>({...candidate,title:saneText(candidate.title,180),section:saneText(candidate.section,220),support:candidate.support.slice(0,8).map(text=>saneText(text,420)),contradictions:candidate.contradictions.slice(0,6).map(text=>saneText(text,420)),missing:candidate.missing.slice(0,8).map(text=>saneText(text,320)),nextTest:saneText(candidate.nextTest,420)})),limitations,missing,classification:'Beobachtung und regelbasierte Ableitung; keine kalibrierte Ursachenwahrscheinlichkeit.'};
  // History records have a 64 KiB ceiling. Aggregates retain all measurements;
  // only detail lists are compacted, explicitly, when this result is too large.
  if(Buffer.byteLength(JSON.stringify(result))>62000) {
    result.detailsTruncated=true;result.topology=null;result.path.truncated=true;result.path.hops=result.path.hops.slice(0,8);result.pathNodes=result.pathNodes.slice(0,8);
    for(const window of Object.values(result.windows))window.targets=window.targets.slice(0,16);
    result.traffic.devices=result.traffic.devices.slice(0,4);
    for(const [name,window]of Object.entries(result.trafficComparison)){
      for(const device of window.devices){device.intervalsTruncated=device.intervalsTruncated||list(device.intervalsDetail).length>1;device.intervalsDetail=list(device.intervalsDetail).slice(0,1);delete device.peakInterval;delete device.coverage;}
      if(name!=='during'){window.devicesTruncated=window.devicesTruncated||window.devices.length>2;window.devices=window.devices.slice(0,2);}
      window.pc.intervalsTruncated=window.pc.intervals.length>0;window.wan.intervalsTruncated=window.wan.intervals.length>0;window.pc.intervals=[];window.wan.intervals=[];
    }
    for(const candidate of result.diagnoses){candidate.support=candidate.support.slice(0,4);candidate.missing=candidate.missing.slice(0,4);}
  }
  if(Buffer.byteLength(JSON.stringify(result))>62000) {
    result.detailsTruncated=true;result.path.truncated=true;result.path.hops=[];result.pathNodes=result.pathNodes.slice(0,4);result.meshChanges=result.meshChanges.slice(0,8);
    for(const window of Object.values(result.windows))window.targets=window.targets.slice(0,8);
    result.traffic.devices=[];for(const candidate of result.diagnoses){candidate.support=candidate.support.slice(0,2);candidate.missing=candidate.missing.slice(0,3);}
    for(const window of Object.values(result.trafficComparison))for(const device of window.devices){device.intervalsTruncated=device.intervalsTruncated||device.intervalsDetail.length>0;device.intervalsDetail=[];}
  }
  while(Buffer.byteLength(JSON.stringify(result))>62000&&result.trafficComparison.during.devices.length){
    result.detailsTruncated=true;result.trafficComparison.during.devices.pop();result.trafficComparison.during.devicesTruncated=true;
  }
  return result;
}

export class IncidentEngine {
  constructor({now=()=>Date.now(),onUpdate=()=>{},maxRecords=8000}={}) {
    this.now=now;this.onUpdate=onUpdate;this.maxRecords=Math.max(1,Math.min(8000,Number.isSafeInteger(maxRecords)?maxRecords:8000));
    this.records=[];this.incidents=[];this.open=new Map();this.latest=new Map();this.sourceStreams=new Map();this.retiredStreams=new Set();this.dirty=false;this.lastPublish=0;this.seen=new Set();this.recordBytes=new WeakMap();this.closed=false;
  }
  finish(incident,reason) {incident.endedAt=incident.lastAbnormalAt;incident.endReason=reason;incident.status='after-window';this.dirty=true;}
  addIncident(incident,key) {
    this.incidents.unshift(incident);if(key)this.open.set(key,incident);
    while(this.incidents.length>50){const removed=this.incidents.pop();for(const [openKey,value]of this.open)if(value===removed)this.open.delete(openKey);}
    this.onUpdate({kind:'started',incident:metadataSnapshot(incident)});
  }
  ingest(record) {
    if(this.closed||!record||!Number.isFinite(time(record.at)))return;
    let serialized;try{serialized=JSON.stringify(record);}catch{return;}
    const bytes=Buffer.byteLength(serialized);if(bytes>64000)return;
    const sourceKey=streamKey(record);
    if(time(record.at)>this.now()+1000)return;
    const rawKey=record.recordId?`${sourceKey}:${record.recordId}`:record.sequence!=null?`${sourceKey}:${record.sequence}:${record.type}`:`${sourceKey}:${serialized}`;
    const key=createHash('sha256').update(rawKey).digest('hex');
    if(this.seen.has(key))return;this.seen.add(key);
    if(this.seen.size>this.maxRecords*2)this.seen=new Set([...this.seen].slice(-this.maxRecords));
    // Own a bounded snapshot: callers can reuse probe result objects afterwards.
    record=JSON.parse(serialized);this.recordBytes.set(record,bytes);
    this.records.push(record);this.records.sort((a,b)=>time(a.at)-time(b.at));
    const cutoff=this.now()-300000;
    this.records=this.records.filter(item=>time(item.at)>=cutoff).slice(-this.maxRecords);
    let total=this.records.reduce((sum,item)=>sum+(this.recordBytes.get(item)||0),0);
    while(total>8*1024*1024){total-=this.recordBytes.get(this.records.shift())||0;}
    this.dirty=true;
    if(record.type==='event'&&!remote(record)&&/^Spiel[-\s]?lag markiert$/i.test(record.title||'')) {
      const markedAt=time(record.at);
      if(record.late!==true&&markedAt>=this.now()-10000&&markedAt<=this.now())this.addIncident({id:randomUUID(),sourceDeviceId:source(record),...Object.fromEntries(SESSION_FIELDS.map(key=>[key,record[key]??null])),trigger:'manual',note:saneText(record.note,200),startedAt:record.at,observationEndAt:new Date(markedAt+5000).toISOString(),lastAbnormalAt:null,lastSeenAt:record.at,endedAt:null,status:'active',endReason:null,affectedHosts:[]});
      return;
    }
    if(record.type!=='ping'||!clockUsable(record))return;
    const at=time(record.at);
    // Buffered, future and out-of-order samples are history, not a new live state.
    if(record.late===true || at<this.now()-10000 || at>this.now() || at<(this.latest.get(sourceKey)??-Infinity))return;
    const previousStream=this.sourceStreams.get(source(record));
    if(this.retiredStreams.has(sourceKey)||previousStream&&at<previousStream.at)return;
    if(previousStream&&previousStream.key!==sourceKey)this.retiredStreams.add(previousStream.key);
    this.sourceStreams.set(source(record),{key:sourceKey,at});
    if(this.sourceStreams.size>256)this.sourceStreams=new Map([...this.sourceStreams].slice(-256));
    if(this.retiredStreams.size>512)this.retiredStreams=new Set([...this.retiredStreams].slice(-512));
    this.latest.set(sourceKey,at);
    if(this.latest.size>256)this.latest=new Map([...this.latest].slice(-256));
    for(const [key,previous]of this.open)if(key!==sourceKey&&previous.sourceDeviceId===source(record)){this.finish(previous,'source_changed');this.open.delete(key);}
    const bad=list(record.results).some(abnormal),active=this.open.get(sourceKey);
    if(active&&!active.endedAt&&(record.quality?.gap===true||at-time(active.lastSeenAt)>10000)){this.finish(active,'measurement_gap');this.open.delete(sourceKey);}
    const current=this.open.get(sourceKey);
    if(bad) {
      const incident=current||{id:randomUUID(),sourceDeviceId:source(record),...Object.fromEntries(SESSION_FIELDS.map(key=>[key,record[key]??null])),startedAt:record.at,lastAbnormalAt:record.at,lastSeenAt:record.at,endedAt:null,status:'active',endReason:null,affectedHosts:[],targetStates:new Map()};
      incident.lastAbnormalAt=record.at;incident.lastSeenAt=record.at;
      for(const result of list(record.results))if(typeof result?.host==='string'&&abnormal(result)&&incident.affectedHosts.length<32&&!incident.affectedHosts.includes(result.host))incident.affectedHosts.push(result.host);
      if(!current)this.addIncident(incident,sourceKey);
    }
    const pending=this.open.get(sourceKey);
    if(pending) {
      let measuredAffected=false;
      for(const result of list(record.results))if(pending.affectedHosts.includes(result?.host)&&(good(result)||abnormal(result))) {
        measuredAffected=true;const previous=pending.targetStates.get(result.host);
        // Contradictory samples with identical timestamps cannot prove recovery.
        if(!previous||at>previous.at||abnormal(result))pending.targetStates.set(result.host,{at,normal:good(result)&&result.ms<PING_SPIKE_MS});
      }
      if(measuredAffected)pending.lastSeenAt=record.at;
      if(!bad&&pending.affectedHosts.length&&pending.affectedHosts.every(host=>{const state=pending.targetStates.get(host);return state?.normal===true&&at-state.at<=10000;})) {this.finish(pending,'recovered');this.open.delete(sourceKey);}
    }
  }
  tick(force=false) {
    const now=this.now();
    for(const [key,incident] of this.open)if(now-time(incident.lastSeenAt)>10000){this.finish(incident,'measurement_gap');this.open.delete(key);}
    for(const incident of this.incidents)if(incident.trigger==='manual'&&!incident.endedAt&&now>=time(incident.observationEndAt)) {incident.endedAt=incident.observationEndAt;incident.endReason='manual_window_elapsed';incident.status='after-window';this.dirty=true;}
    if(this.incidents.some(incident=>incident.status!=='complete'&&incident.endedAt&&now-time(incident.endedAt)>=60000))this.dirty=true;
    if(!force&&(!this.dirty||now-this.lastPublish<2000))return;
    this.lastPublish=now;this.dirty=false;
    for(const incident of this.incidents) {
      if(incident.status==='complete')continue;
      const result=analyzeIncident(incident,this.records,{now});
      if(this.closed||incident.endedAt&&now-time(incident.endedAt)>=60000){incident.status='complete';result.status='complete';}
      incident.result=result;
      // Never recursively embed previous analyses on subsequent updates.
      delete result.result;
      this.onUpdate({kind:'updated',incident:result,persist:result.status==='complete'||now-(incident.lastPersistedAt||0)>=10000});
      if(result.status==='complete'||now-(incident.lastPersistedAt||0)>=10000)incident.lastPersistedAt=now;
    }
  }
  close(){if(this.closed)return;for(const incident of this.open.values())this.finish(incident,'monitoring_stopped');for(const incident of this.incidents)if(incident.trigger==='manual'&&!incident.endedAt){incident.endedAt=new Date(Math.min(this.now(),time(incident.observationEndAt))).toISOString();incident.endReason='monitoring_stopped';incident.status='after-window';}this.open.clear();this.closed=true;this.dirty=true;this.tick(true);}
}

function metadataSnapshot(incident) {
  const {targetStates,result,lastPersistedAt,...metadata}=incident;
  return {...metadata,affectedHosts:[...incident.affectedHosts]};
}
