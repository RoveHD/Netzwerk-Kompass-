import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIncident, IncidentEngine } from '../lib/incident-analysis.js';
import { buildMeshEvidence } from '../lib/mesh-evidence.js';

const base=1700000000000,at=offset=>new Date(base+offset).toISOString(),mac=id=>`02:00:00:00:00:${String(id).padStart(2,'0')}`;
const hosts={master:'192.168.1.1',c:'192.168.1.2',b:'192.168.1.3',internet:'1.1.1.1',second:'8.8.8.8'};
const target=(host,ms=3,kind=host===hosts.master?'gateway':[hosts.internet,hosts.second].includes(host)?'internet':'repeater')=>({host,kind,ok:ms!==null,ms,status:ms===null?'no_reply':'ok'});
const ping=(offset,results,extra={})=>({type:'ping',at:at(offset),sourceDeviceId:'local',appSessionId:'app-local',sourceSession:'runtime',epoch:1,measurementStartedAt:at(-60000),interfaceId:'nic',pcMac:mac(1),routingConfirmed:true,ipv4:['192.168.1.20'],results,...extra});
const peer=(offset,results,extra={})=>ping(offset,results,{sourceDeviceId:'peer',appSessionId:'app-peer',sourceSession:'peer-runtime',interfaceId:'peer-nic',pcMac:mac(4),remote:true,clockUncertaintyMs:20,...extra});
const incident=(extra={})=>({id:'incident',sourceDeviceId:'local',appSessionId:'app-local',sourceSession:'runtime',epoch:1,measurementStartedAt:at(-60000),interfaceId:'nic',startedAt:at(0),lastAbnormalAt:at(1000),endedAt:at(1000),status:'after-window',endReason:'recovered',...extra});
const mesh=(offset=-1000)=>({type:'fritzbox',at:at(offset),host:'fritz.box',sessionId:'router-runtime',appSessionId:'central',mesh:{available:true,schemaVersion:'8.7',nodes:[{id:'pc',mac:mac(1),ip:'192.168.1.20'},{id:'c',mac:mac(2),ip:hosts.c,name:'C',role:'SLAVE'},{id:'b',mac:mac(3),ip:hosts.b,name:'B',role:'SLAVE'},{id:'master',mac:mac(10),ip:hosts.master,name:'Master',role:'MASTER'},{id:'peer',mac:mac(4),ip:'192.168.1.30'}],links:[{id:'pc-c',from:'pc',to:'c',type:'LAN',state:'CONNECTED'},{id:'c-b',from:'c',to:'b',type:'WLAN',state:'CONNECTED'},{id:'b-master',from:'b',to:'master',type:'LAN',state:'CONNECTED'},{id:'peer-c',from:'peer',to:'c',type:'LAN',state:'CONNECTED'}]}});
const run=(records,subject=incident(),now=61000)=>analyzeIncident(subject,records,{now:base+now});
const categories=result=>result.diagnoses.map(item=>item.category);
const pair=(results,extra={})=>[ping(0,results,extra),ping(1000,results,extra)];
const symptoms=[target(hosts.c,3),target(hosts.b,180),target(hosts.master,200),target(hosts.internet,220),target(hosts.second,null)];
const wanSymptoms=[target(hosts.master,3),target(hosts.internet,190),target(hosts.second,null)];
const routerSymptoms=[target(hosts.master,200),target(hosts.internet,3),target(hosts.second,4)];

test('A: simultaneous PC→C→B→Master observations localize only the real C→B segment',()=>{
  const topology=mesh(),evidence=buildMeshEvidence(topology,{pcMac:mac(1),now:base}),linkId=evidence.path.hops.find(hop=>hop.type==='WLAN').id;
  const change={type:'mesh_change',at:at(1000),sessionId:'router-runtime',interval:{from:at(-1000),to:at(1000)},changes:[{kind:'rate-drop',linkId}]};
  const result=run([topology,...pair(symptoms),change]);assert.ok(categories(result).includes('mesh_backhaul'));assert.equal(result.pathBoundary.from,`mac:${mac(2)}`);assert.equal(result.pathBoundary.to,`mac:${mac(3)}`);assert.equal(result.pathBoundary.linkId,linkId);assert.equal(result.diagnoses.find(item=>item.category==='mesh_backhaul').confidence,'Stark unterstützt');assert.match(result.diagnoses[0].support.join(' '),/rate-drop zwischen/);
  assert.equal(result.path.status,'confirmed');assert.ok(!JSON.stringify(result).includes('Ursachenwahrscheinlichkeit":100'));
});
test('A: independently bad router/repeater samples do not fabricate paired hop evidence',()=>{
  const records=[mesh(),...pair([target(hosts.c,3)]),ping(300,[target(hosts.b,100)]),ping(1300,[target(hosts.b,100)]),ping(400,[target(hosts.master,100)]),ping(1400,[target(hosts.master,100)])];
  const result=run(records,incident({lastAbnormalAt:at(1500),endedAt:at(1500)}));assert.ok(!categories(result).includes('mesh_backhaul'));assert.equal(result.pathBoundary,null);
});
test('B: two Internet targets bad during simultaneous good LAN/router samples support WAN scope',()=>{
  const result=run([mesh(),...pair(wanSymptoms)]);assert.ok(categories(result).includes('wan'));assert.ok(!categories(result).includes('mesh_backhaul'));
});
test('B: central WAN counters correlate with a peer incident without rewriting either app session',()=>{
  const records=[mesh(),peer(0,wanSymptoms),peer(1000,wanSymptoms),{type:'fritzbox',at:at(1000),host:'fritz.box',sessionId:'router-runtime',appSessionId:'central',wan:{downloadMbps:95,uploadMbps:1,downstreamMbps:100,upstreamMbps:20,intervalStartedAt:at(0),downloadDeltaBytes:11875000,uploadDeltaBytes:125000}}];
  const saved=JSON.stringify(records),result=run(records,incident({sourceDeviceId:'peer',appSessionId:'app-peer',sourceSession:'peer-runtime',interfaceId:'peer-nic'}));
  assert.ok(categories(result).includes('wan_load'));assert.equal(result.traffic.wanUtilization.downloadPercent,95);assert.equal(result.traffic.wan.download.average,95);assert.equal(JSON.stringify(records),saved);
});
test('WAN classification requires repeated simultaneous router+Internet measurements',()=>{
  const records=[...pair([target(hosts.master,3)]),ping(200,[target(hosts.internet,100),target(hosts.second,100)]),ping(1200,[target(hosts.internet,100),target(hosts.second,100)])];
  const result=run(records,incident({endedAt:at(1500),lastAbnormalAt:at(1500)}));assert.ok(!categories(result).includes('wan'));assert.ok(!categories(result).includes('wan_load'));
});
test('C: measured adapter deltas overlap the incident; reset, old epoch and gaps are excluded',()=>{
  const traffic={...ping(1000,[]),type:'traffic',adapterHealth:{available:true,reset:false,intervalStartedAt:at(0),delta:{receivedErrors:2,sentErrors:0,receivedDiscards:0,sentDiscards:0}}};
  assert.ok(categories(run([...pair([target(hosts.master,100)]),traffic])).includes('local_adapter'));
  for(const extra of [{epoch:2},{interfaceId:'different'},{sourceSession:'restarted'},{adapterHealth:{...traffic.adapterHealth,reset:true}},{adapterHealth:{...traffic.adapterHealth,intervalStartedAt:at(-20000)}},{adapterHealth:{...traffic.adapterHealth,delta:{unknownErrorCounter:20}}}])assert.ok(!categories(run([...pair([target(hosts.master,100)]),{...traffic,...extra}])).includes('local_adapter'));
});
test('D: slow router ICMP with good external forwarding never localizes a Mesh forwarding fault',()=>{
  const result=run([mesh(),...pair(routerSymptoms),peer(0,routerSymptoms),peer(1000,routerSymptoms)]);assert.ok(categories(result).includes('router_icmp'));assert.ok(!categories(result).includes('mesh_backhaul'));assert.ok(!categories(result).includes('shared_mesh'));
});
test('E: only one of two precisely paired PCs is bad, with no numeric causal probability',()=>{
  const result=run([mesh(),...pair(symptoms),peer(0,[target(hosts.master,3)]),peer(1000,[target(hosts.master,3)])]);assert.ok(categories(result).includes('pc_path'));assert.equal(result.diagnoses.find(item=>item.category==='pc_path').confidence,'Plausibler Verdacht');
});

test('A simultaneously bad third PC contradicts exclusive attribution to the incident PC',()=>{
  const records=[mesh(),...pair(symptoms),peer(0,[target(hosts.master,3)]),peer(1000,[target(hosts.master,3)]),
    peer(0,[target(hosts.master,100)],{sourceDeviceId:'peer-other',pcMac:mac(5)}),peer(1000,[target(hosts.master,110)],{sourceDeviceId:'peer-other',pcMac:mac(5)})];
  const result=run(records);
  assert.ok(result.affectedSources.includes('peer-other'));
  assert.ok(!categories(result).includes('pc_path'));
  assert.ok(!result.diagnoses.some(diagnosis=>diagnosis.title.includes('Nur dieser')));
});

test('Every Mesh boundary or local-access evidence round must confirm the same routed PC adapter',()=>{
  for(const extra of [{routingConfirmed:false},{routingConfirmed:undefined},{pcMac:mac(9)}]) {
    for(const samples of [symptoms,[target(hosts.c,100),target(hosts.master,100)]]) {
      const result=run([mesh(),ping(0,samples),ping(1000,samples,extra)]);
      assert.equal(result.pathBoundary,null);
      assert.ok(!categories(result).includes('mesh_backhaul'));assert.ok(!categories(result).includes('local_access'));
      assert.match(result.limitations.join(' '),/nicht in allen Messrunden/);
    }
  }
});

test('Shared Mesh evidence requires routed matching PC identities on both sides of every paired round',()=>{
  for(const side of ['local','peer'])for(const extra of [{routingConfirmed:false},{pcMac:mac(9)}]) {
    const localExtra=side==='local'?extra:{},peerExtra=side==='peer'?extra:{};
    const result=run([mesh(),ping(0,symptoms),ping(1000,symptoms,localExtra),peer(0,[target(hosts.master,100)]),peer(1000,[target(hosts.master,110)],peerExtra)]);
    assert.ok(!categories(result).includes('shared_mesh'));
  }
});
test('E: both PCs bad identifies shared actual Mesh links, not a manual repeater guess',()=>{
  const result=run([mesh(),...pair(symptoms),peer(0,[target(hosts.master,150)]),peer(1000,[target(hosts.master,170)])]);const shared=result.diagnoses.find(item=>item.category==='shared_mesh');assert.ok(shared);assert.match(shared.section,new RegExp(mac(2)));assert.match(shared.section,new RegExp(mac(3)));
  const separate=mesh();separate.mesh.nodes.push({id:'other',mac:mac(5),ip:'192.168.1.5'});separate.mesh.links=separate.mesh.links.filter(link=>link.id!=='peer-c');separate.mesh.links.push({id:'peer-other',from:'peer',to:'other',state:'CONNECTED',type:'LAN'},{id:'other-master',from:'other',to:'master',state:'CONNECTED',type:'WLAN'});
  assert.ok(!categories(run([separate,...pair(symptoms),peer(0,[target(hosts.master,150)]),peer(1000,[target(hosts.master,170)])])).includes('shared_mesh'));
});
test('Two PCs measured at disjoint instants are not claimed as simultaneous',()=>{
  const result=run([mesh(),...pair(symptoms),peer(550,[target(hosts.master,3)]),peer(1550,[target(hosts.master,3)])],incident({endedAt:at(1700),lastAbnormalAt:at(1700)}));assert.ok(!categories(result).includes('pc_path'));
});
test('Clock uncertainty, missing clock state and uncertainty plus offset exclude peer causality',()=>{
  for(const extra of [{clockUncertaintyMs:1200},{clockUncertaintyMs:undefined},{clockUncertaintyMs:-1},{clockReliable:false},{clockUncertaintyMs:400}]) {
    const offset=extra.clockUncertaintyMs===400?200:0;const result=run([mesh(),...pair(symptoms),peer(offset,[target(hosts.master,3)],extra),peer(1000+offset,[target(hosts.master,3)],extra)]);assert.ok(!categories(result).includes('pc_path'));
  }
  const result=run([mesh(),...pair(symptoms),peer(0,[target(hosts.master,3)],{remote:undefined,clockUncertaintyMs:2000})]);assert.match(result.limitations.join(' '),/Zeitsynchronisierung/);
});
test('Missing, old, unknown and future Mesh snapshots never localize an incident retrospectively',()=>{
  for(const topology of [null,mesh(-90001),mesh(1),{...mesh(),mesh:{...mesh().mesh,schemaVersion:'future'}},{...mesh(),mesh:{...mesh().mesh,truncated:true}}]) {
    const result=run([topology,...pair(symptoms)].filter(Boolean));assert.notEqual(result.path.status,'confirmed');assert.ok(!categories(result).includes('mesh_backhaul'));
  }
});
test('Session/epoch/source runtime changes do not contaminate own or peer window statistics',()=>{
  const records=[...pair([target(hosts.master,100)]),ping(500,[target(hosts.master,2)],{sourceSession:'old'}),ping(700,[target(hosts.master,2)],{epoch:2}),peer(0,[target(hosts.master,3)],{sourceSession:'first'}),peer(1000,[target(hosts.master,3)],{sourceSession:'second'})];
  const result=run(records);assert.equal(result.windows.during.targets[0].sent,2);assert.ok(!categories(result).includes('pc_path'));
});
test('Errors and duplicate measurements are distinct from missing network replies',()=>{
  const error=target(hosts.master,null);error.status='measurement_error';const first=ping(0,[error]);const result=run([first,first,{...first,sequence:2},ping(1000,[{...error,status:undefined,error:'Messfehler'}])]);assert.equal(result.windows.during.targets[0].sent,0);assert.equal(result.windows.during.targets[0].measurementErrors,2);assert.deepEqual(categories(result),['unknown']);
});
test('Before/after windows are exactly 60 seconds and completeness requires target coverage',()=>{
  const records=[];for(let offset=-60000;offset<=61000;offset+=1000)records.push(ping(offset,[target(hosts.master,offset>=0&&offset<=1000?100:3)]));
  const result=run(records);assert.equal(result.windows.before.from,at(-60000));assert.equal(result.windows.before.targets[0].sent,60);assert.equal(result.windows.after.targets[0].sent,60);assert.equal(result.windows.before.complete,true);assert.equal(result.windows.after.complete,true);
  assert.equal(run(records.filter(record=>Date.parse(record.at)<=base+59000)).windows.after.complete,false);
});
test('Future traffic and unrelated router logs do not establish load or radio causes',()=>{
  const result=run([...pair(wanSymptoms),{type:'fritzbox',at:at(2000),wan:{downloadMbps:100,downstreamMbps:100}},{type:'router_event',at:at(1000),interval:{from:at(0),to:at(1000)},message:'Benutzer angemeldet'}],incident(),1000);assert.ok(!categories(result).includes('wan_load'));assert.ok(!categories(result).includes('possible_radio'));
});

function engineHarness(initial=0,maxRecords=8000){let elapsed=initial;const updates=[];const engine=new IncidentEngine({now:()=>base+elapsed,onUpdate:update=>updates.push(update),maxRecords});return {engine,updates,set:value=>{elapsed=value;},send:(offset,results,extra={})=>{elapsed=offset;engine.ingest(ping(offset,results,extra));}};}
test('Sparse precision batches do not recover an unmeasured affected target',()=>{
  const h=engineHarness();h.send(0,[target(hosts.internet,null)]);h.send(250,[target(hosts.master,3)]);h.send(500,[target(hosts.master,3)]);assert.equal(h.engine.open.size,1);assert.equal(h.engine.incidents[0].endedAt,null);
  h.send(1000,[target(hosts.internet,3)]);assert.equal(h.engine.open.size,0);assert.equal(h.engine.incidents[0].endReason,'recovered');
});
test('Recovery requires every affected target to recover across sparse batches',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,100),target(hosts.internet,null)]);h.send(250,[target(hosts.master,2)]);assert.equal(h.engine.open.size,1);h.send(500,[target(hosts.internet,2)]);assert.equal(h.engine.open.size,0);assert.equal(h.engine.incidents[0].endReason,'recovered');
});
test('Measurement errors or slow successful ICMP responses do not prove recovery',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,100)]);h.send(1000,[target(hosts.master,100)]);assert.equal(h.engine.incidents.length,1);assert.equal(h.engine.open.size,1);h.send(2000,[{...target(hosts.master,null),status:'measurement_error'}]);assert.equal(h.engine.open.size,1);
});
test('Gaps close observation with unknown recovery, even when the next sample is good',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,null)]);h.send(11000,[target(hosts.master,3)]);assert.equal(h.engine.incidents[0].endReason,'measurement_gap');assert.equal(h.engine.incidents[0].status,'after-window');assert.equal(h.engine.open.size,0);h.engine.tick(true);assert.match(h.updates.at(-1).incident.limitations.join(' '),/ohne gemessene Erholung/);
  const quality=engineHarness();quality.send(0,[target(hosts.master,100)]);quality.send(2500,[target(hosts.master,3)],{quality:{gap:true}});assert.equal(quality.engine.incidents[0].endReason,'measurement_gap');
});
test('Unrelated good targets cannot postpone a gap in the affected measurements',()=>{
  const h=engineHarness();h.send(0,[target(hosts.internet,null)]);h.send(5000,[target(hosts.master,3)]);h.set(10001);h.engine.tick();assert.equal(h.engine.incidents[0].endReason,'measurement_gap');
});
test('New epochs and source runtimes start a new observation instead of recovering the old one',()=>{
  for(const extra of [{epoch:2},{sourceSession:'restarted'},{appSessionId:'other'},{interfaceId:'other-adapter'},{measurementStartedAt:at(1000)}]){const h=engineHarness();h.send(0,[target(hosts.master,100)]);h.send(1000,[target(hosts.master,3)],extra);assert.equal(h.engine.incidents[0].endReason,'source_changed');assert.equal(h.engine.open.size,0);}
});
test('Delayed, explicitly late and future samples cannot start or rewind a live incident',()=>{
  const h=engineHarness(20000);h.engine.ingest(ping(0,[target(hosts.master,100)]));h.engine.ingest(ping(20000,[target(hosts.master,100)],{late:true}));h.engine.ingest(ping(20500,[target(hosts.master,100)]));assert.equal(h.engine.incidents.length,0);
  h.send(20000,[target(hosts.master,100)]);h.set(21000);h.engine.ingest(ping(19500,[target(hosts.master,3)]));assert.equal(h.engine.open.size,1);assert.equal(h.engine.incidents[0].lastAbnormalAt,at(20000));
});
test('Record IDs/sequences are scoped to the source and source runtime, not global',()=>{
  const h=engineHarness();h.engine.ingest(ping(0,[target(hosts.master,100)],{recordId:'same',sequence:1}));h.engine.ingest(peer(0,[target(hosts.master,100)],{recordId:'same',sequence:1}));assert.equal(h.engine.incidents.length,2);assert.equal(h.engine.open.size,2);
  h.engine.ingest(ping(0,[target(hosts.master,100)],{recordId:'same',sequence:1}));assert.equal(h.engine.records.length,2);
});
test('After-window finalizes after 60 seconds even when no new record makes the engine dirty',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,100)]);h.send(1000,[target(hosts.master,3)]);h.engine.tick(true);assert.equal(h.engine.incidents[0].status,'after-window');h.set(61000);h.engine.tick();assert.equal(h.engine.incidents[0].status,'complete');assert.equal(h.updates.at(-1).persist,true);assert.equal(h.updates.at(-1).incident.windows.after.complete,false);
});
test('Close preserves observed recovery reasons and marks active observations as stopped',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,100)]);h.send(1000,[target(hosts.master,3)]);h.send(2000,[target(hosts.internet,null)]);h.engine.close();assert.equal(h.engine.open.size,0);assert.equal(h.engine.incidents[0].endReason,'monitoring_stopped');assert.equal(h.engine.incidents[1].endReason,'recovered');assert.ok(h.engine.incidents.every(item=>item.status==='complete'));const count=h.updates.length;h.engine.close();h.send(3000,[target(hosts.master,100)]);assert.equal(h.updates.length,count);
});
test('Engine owns immutable bounded records and emits no recursively nested analysis or Maps',()=>{
  const h=engineHarness(0,3),input=ping(0,[target(hosts.master,100)]);h.engine.ingest(input);input.results[0].ms=3;assert.equal(h.engine.records[0].results[0].ms,100);
  for(let offset=1000;offset<=5000;offset+=1000)h.send(offset,[target(hosts.master,100)]);assert.equal(h.engine.records.length,3);h.engine.tick(true);h.set(8000);h.engine.tick(true);const output=h.updates.at(-1).incident;assert.ok(!('result'in output));assert.ok(!('targetStates'in output));assert.ok(Buffer.byteLength(JSON.stringify(output))<64000);
});
test('Result compacts high-detail topology and targets below the 64 KiB history ceiling',()=>{
  const heavy=mesh();heavy.mesh.nodes=Array.from({length:256},(_,i)=>({id:`id-${i}`.padEnd(200,'x'),name:'😀'.repeat(80),mac:mac(i),ip:`192.168.1.${i}`,role:i===0?'MASTER':'SLAVE',interfaces:Array.from({length:32},(_,j)=>({id:`if${j}`.padEnd(200,'x'),mac:mac(j),type:'LAN'}))}));heavy.mesh.links=[];
  const targets=Array.from({length:64},(_,i)=>({...target(`host-${i}`.padEnd(253,'x'),100,'custom'),label:'😀'.repeat(80)}));const records=[heavy,ping(-60000,targets),ping(-1000,targets),...pair(targets),ping(2000,targets),ping(61000,targets)];const result=run(records);assert.ok(Buffer.byteLength(JSON.stringify(result))<62000);assert.equal(result.topology?.mesh.truncated??result.detailsTruncated,true);
});
test('Manual Spiellag marker opens a five-second observation without fabricating an abnormal ping',()=>{
  const h=engineHarness();const marker={...ping(0,[]),type:'event',title:'Spiellag markiert',note:'Spiel stockt'};delete marker.results;h.engine.ingest(marker);assert.equal(h.engine.incidents.length,1);assert.equal(h.engine.incidents[0].trigger,'manual');assert.equal(h.engine.incidents[0].lastAbnormalAt,null);assert.equal(h.engine.open.size,0);
  h.engine.tick(true);assert.deepEqual(categories(h.updates.at(-1).incident),['unknown']);assert.match(h.updates.at(-1).incident.limitations.join(' '),/kein Nachweis/);assert.equal(h.updates.at(-1).incident.durationMs,0);
  h.send(1000,[target(hosts.master,3)]);h.set(5000);h.engine.tick(true);const result=h.updates.at(-1).incident;assert.equal(result.endReason,'manual_window_elapsed');assert.equal(result.endedAt,at(5000));assert.equal(result.durationMs,5000);assert.deepEqual(categories(result),['unknown']);assert.equal(result.status,'after-window');h.set(65000);h.engine.tick();assert.equal(h.engine.incidents[0].status,'complete');assert.equal(h.updates.at(-1).incident.windows.after.complete,false);
});
test('Manual marking can contain real measured symptoms; unrelated events never start incidents',()=>{
  const h=engineHarness();h.engine.ingest({...ping(0,[]),type:'event',title:'Spiellag markiert'});h.send(1000,wanSymptoms);h.send(2000,wanSymptoms);h.set(5000);h.engine.tick(true);const manual=h.updates.filter(update=>update.kind==='updated'&&update.incident.trigger==='manual').at(-1).incident;assert.ok(categories(manual).includes('wan'));assert.equal(manual.lastAbnormalAt,null);
  const other=engineHarness();other.engine.ingest({...ping(0,[]),type:'event',title:'Router getrennt'});assert.equal(other.engine.incidents.length,0);
});
test('Closing a manual observation preserves the observed cutoff instead of a future end',()=>{
  const h=engineHarness();h.engine.ingest({...ping(0,[]),type:'event',title:'Spiellag markiert'});h.set(2000);h.engine.close();assert.equal(h.engine.incidents[0].endedAt,at(2000));assert.equal(h.engine.incidents[0].endReason,'monitoring_stopped');assert.equal(h.updates.at(-1).incident.durationMs,2000);
});
test('Unrelated topology links and future inner intervals cannot strengthen the suspect path',()=>{
  const topology=mesh(),evidence=buildMeshEvidence(topology,{pcMac:mac(1),now:base}),linkId=evidence.path.hops.find(hop=>hop.type==='WLAN').id;
  for(const change of [{kind:'rate-drop',linkId:'unrelated-link'},{kind:'rate-drop',linkId,interval:{from:at(2000),to:at(3000)}}]) {
    const record={type:'mesh_change',at:at(1000),sessionId:'router-runtime',interval:{from:at(0),to:at(1000)},changes:[change]},result=run([topology,...pair(symptoms),record]);assert.equal(result.diagnoses.find(item=>item.category==='mesh_backhaul').confidence,'Plausibler Verdacht');assert.ok(!categories(result).includes('mesh_change'));
  }
});
test('Bounded incident retention also bounds active state when many sources send observations',()=>{
  const h=engineHarness();for(let i=0;i<70;i++)h.engine.ingest(peer(0,[target(hosts.master,100)],{sourceDeviceId:`peer-${i}`}));assert.equal(h.engine.incidents.length,50);assert.equal(h.engine.open.size,50);
});
test('Explicitly absent epoch never becomes a wildcard for later epochs in 60-second windows',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,100)],{epoch:null});h.send(1000,[target(hosts.master,100)],{epoch:2});h.engine.tick(true);const old=h.updates.filter(update=>update.kind==='updated'&&update.incident.epoch===null).at(-1).incident;assert.equal(old.windows.during.targets[0].sent,1);assert.equal(old.windows.after.targets.length,0);
});
test('Delayed records from a retired runtime cannot close or revive the current runtime',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,100)]);h.send(1000,[target(hosts.master,100)],{sourceSession:'new'});h.set(2000);h.engine.ingest(ping(1500,[target(hosts.master,3)]));assert.equal(h.engine.open.size,1);assert.equal(h.engine.incidents[0].sourceSession,'new');assert.equal(h.engine.incidents[0].endedAt,null);assert.equal(h.engine.incidents.length,2);
  h.engine.ingest(ping(1800,[target(hosts.master,100)]));assert.equal(h.engine.incidents.length,2);assert.equal(h.engine.incidents[0].lastAbnormalAt,at(1000));
});
test('A Mesh snapshot of a different gateway never supplies the PC-path localization',()=>{
  const topology=mesh();topology.mesh.nodes.find(node=>node.role==='MASTER').ip='192.168.2.1';const result=run([topology,...pair(symptoms)]);assert.equal(result.path.status,'unknown');assert.ok(!categories(result).includes('mesh_backhaul'));assert.match(result.path.reason,/nicht dem gemessenen Gateway/);
});

const pcRate=(from,to,download=1,upload=1,extra={})=>({...ping(to,[]),type:'traffic',intervalStartedAt:at(from),downloadMbps:download,uploadMbps:upload,...extra});
const routerRate=(from,to,download=1,upload=1,extra={})=>({...mesh(to),wan:{intervalStartedAt:at(from),downloadMbps:download,uploadMbps:upload,downloadDeltaBytes:download*(to-from)*125,uploadDeltaBytes:upload*(to-from)*125,downstreamMbps:100,upstreamMbps:20},...extra});
const rateBaseline=(make=pcRate)=>Array.from({length:6},(_,i)=>make(-60000+i*10000,-50000+i*10000));
test('Traffic comparison separates exact 60s windows, measured values, coverage and device peaks',()=>{
  const devices=Array.from({length:6},(_,i)=>({id:`dev${i}`,name:`Gerät ${i}`,mac:mac(20+i),ip:`192.168.1.${100+i}`,intervalStartedAt:at(0),downloadDeltaBytes:(i+1)*125000,uploadDeltaBytes:0,downloadMbps:i+1,uploadMbps:0,rateAvailable:true}));
  const records=[...rateBaseline(),...rateBaseline(routerRate),pcRate(0,500,20),pcRate(500,1000,20),routerRate(0,1000,20,1,{deviceTraffic:devices}),pcRate(1000,61000,2),...pair(wanSymptoms)];
  const result=run(records),comparison=result.trafficComparison;
  assert.equal(comparison.before.from,at(-60000));assert.equal(comparison.before.to,at(0));assert.equal(comparison.during.to,at(1000));assert.equal(comparison.after.to,at(61000));
  assert.equal(comparison.before.pc.download.average,1);assert.equal(comparison.before.pc.coverage.coveredMs,60000);assert.equal(comparison.before.pc.coverage.complete,true);assert.equal(comparison.during.pc.download.average,20);assert.equal(comparison.after.pc.download.average,2);assert.equal(comparison.after.pc.coverage.complete,true);
  assert.equal(comparison.during.devices.length,10);assert.equal(comparison.during.deviceCount,10);assert.equal(comparison.during.unavailableDeviceCount,4);assert.equal(comparison.during.devicesTruncated,false);assert.equal(comparison.during.devices[0].peakMbps,6);assert.equal(comparison.during.devices[0].peakInterval.from,at(0));assert.equal(comparison.during.devices[0].intervalsDetail[0].downloadBytes,750000);assert.equal(comparison.during.pc.intervals[0].downloadBytes,1250000);assert.ok(categories(result).includes('traffic_change'));assert.match(result.diagnoses.find(row=>row.category==='traffic_change').contradictions.join(' '),/weder Überlastung noch/);
});
test('Traffic changes need a sufficient separate baseline and repeated contained during intervals',()=>{
  const subject=incident(),baseline=rateBaseline(),during=[pcRate(0,500,20),pcRate(500,1000,20)];
  for(const records of [baseline.slice(0,2).concat(during),[...baseline,pcRate(0,1000,20)],[...baseline,pcRate(-500,500,20),pcRate(500,1000,20)],[...baseline,...during.map(row=>({...row,epoch:2}))],[...baseline,...during.map(row=>({...row,quality:{gap:true}}))],[...baseline,...during.map(row=>({...row,downloadMbps:3,uploadMbps:1}))],[...baseline,pcRate(2000,2500,20),pcRate(2500,3000,20)]])assert.ok(!categories(run([...pair(wanSymptoms),...records],subject)).includes('traffic_change'));
  const noInterval=baseline.concat(during).map(({intervalStartedAt,...row})=>row);assert.ok(!categories(run(noInterval)).includes('traffic_change'));
});
test('Fast WAN observations never replace or rejuvenate the last real Mesh snapshot',()=>{
  const fast={type:'fritzbox',kind:'traffic',at:at(-100),host:'fritz.box',sessionId:'router-runtime',wan:{}};
  const current=run([mesh(-1000),fast,...pair(symptoms)]);
  assert.equal(current.topology.at,at(-1000));assert.equal(current.path.status,'confirmed');assert.ok(categories(current).includes('mesh_backhaul'));
  const old=run([mesh(-100000),fast,...pair(symptoms)]);
  assert.notEqual(old.path.status,'confirmed');assert.ok(!categories(old).includes('mesh_backhaul'));
});
test('Device detail preserves true intervals and lists known devices without inventing measurements',()=>{
  const devices=Array.from({length:15},(_,i)=>({id:`dev${i}`,name:`Gerät ${i}`,mac:mac(20+i),ip:`192.168.1.${100+i}`,intervalStartedAt:at(-1000),at:at(2000),downloadDeltaBytes:375000,uploadDeltaBytes:75000,rateAvailable:true}));
  const topology=mesh();topology.hosts=[{name:'Ohne Zähler',ip:'192.168.1.222',mac:mac(99)}];
  const result=run([topology,{type:'fritzbox',kind:'traffic',host:'fritz.box',sessionId:'router-runtime',at:at(2100),deviceTraffic:devices},...pair(symptoms)]),window=result.trafficComparison.during;
  assert.equal(window.deviceCount,20);assert.equal(window.devices.length,20);assert.equal(window.unavailableDeviceCount,5);
  const detail=window.devices[0].intervalsDetail[0];assert.equal(detail.start,at(-1000));assert.equal(detail.end,at(2000));assert.equal(detail.overlapStart,at(0));assert.equal(detail.overlapEnd,at(1000));assert.equal(detail.intervalMs,3000);assert.equal(detail.overlapMs,1000);assert.equal(detail.downloadBytes,375000);assert.equal(detail.estimatedDownloadBytes,125000);
  const unknown=window.devices.find(device=>device.mac===mac(99));assert.equal(unknown.downloadMbps,null);assert.equal(unknown.intervals,0);
  assert.ok(!categories(result).includes('traffic_change'));
});
test('Large device lists are bounded with explicit omission counts, never silently top-eight only',()=>{
  const devices=Array.from({length:150},(_,i)=>({id:`dev${i}`,name:`Gerät ${i}`,mac:`02:00:00:00:01:${i.toString(16).padStart(2,'0')}`,intervalStartedAt:at(0),at:at(1000),downloadDeltaBytes:125000,uploadDeltaBytes:0,rateAvailable:true}));
  const result=run([{...mesh(1000),deviceTraffic:devices},...pair(symptoms)]),window=result.trafficComparison.during;
  assert.equal(window.deviceCount,154);assert.equal(window.devicesTruncated,true);assert.ok(window.devices.length>8&&window.devices.length<=128);assert.ok(Buffer.byteLength(JSON.stringify(result))<64000);
});
test('Future router counter times cannot supply traffic evidence for a PC-timed lag',()=>{
  const badClock={type:'fritzbox',kind:'traffic',at:at(0),deviceTraffic:[{id:'future',mac:mac(90),name:'Routeruhr falsch',rateAvailable:true,intervalStartedAt:at(-1000),intervalEndedAt:at(60000),downloadDeltaBytes:61000000,uploadDeltaBytes:0}]};
  const result=run([badClock,...pair(symptoms)]);
  assert.equal(result.traffic.devices.length,0);const row=result.trafficComparison.during.devices.find(device=>device.mac===mac(90));assert.equal(row.intervals,0);assert.match(row.reason,/keine verlässliche Lag-Zuordnung/);
});
test('Automatic lag incidents begin at 100 ms inclusive; losses are independent',()=>{
  const h=engineHarness();h.send(0,[target(hosts.master,99.99)]);assert.equal(h.engine.incidents.length,0);
  h.send(1000,[target(hosts.master,100)]);assert.equal(h.engine.incidents.length,1);
  h.send(2000,[target(hosts.master,99)]);assert.equal(h.engine.open.size,0);
  h.send(3000,[target(hosts.master,null)]);assert.equal(h.engine.incidents.length,2);
});
test('Peer traffic comparison keeps central WAN separate and excludes retired PC sessions',()=>{
  const records=[...rateBaseline(routerRate),routerRate(0,500,25),routerRate(500,1000,25),pcRate(0,1000,900),peer(0,wanSymptoms),peer(1000,wanSymptoms)];
  const result=run(records,incident({sourceDeviceId:'peer',sourceSession:'peer-runtime',appSessionId:'app-peer',interfaceId:'peer-nic'}));
  assert.equal(result.trafficComparison.during.pc.samples,0);assert.equal(result.trafficComparison.during.wan.download.average,25);assert.ok(categories(result).includes('traffic_change'));assert.match(result.diagnoses.find(row=>row.category==='traffic_change').support.join(' '),/FRITZ!Box-WAN/);
});
test('LAN access suspicion needs first real LAN repeater and simultaneous bad gateway without good forwarding',()=>{
  const bad=[target(hosts.c,100),target(hosts.master,130),target(hosts.internet,150)];
  const result=run([mesh(),...pair(bad)]);const diagnosis=result.diagnoses.find(row=>row.category==='local_access');assert.ok(diagnosis);assert.match(diagnosis.section,/Adapter \/ LAN \/ Port/);assert.match(diagnosis.contradictions.join(' '),/Kabeldefekt.*nicht nachgewiesen/);
  const wlan=mesh();wlan.mesh.links[0].type='WLAN';
  for(const records of [[wlan,...pair(bad)],[mesh(),...pair(bad.map(row=>row.host===hosts.internet?target(row.host,3):row))],[mesh(),ping(0,[target(hosts.c,100)]),ping(1000,[target(hosts.master,130)])],[mesh(1),...pair(bad)]])assert.ok(!categories(run(records)).includes('local_access'));
});
const packet=(from,to,extra={})=>({type:'event',kind:'incident-packets',incidentId:'incident',sourceDeviceId:'local',at:at(to),capture:{startedAt:at(from),endedAt:at(to),status:'stopped',quality:'observed',sentPackets:120,receivedPackets:90,retransmits:3,losses:{events:0,buffers:0}},...extra});
test('Packet captures keep overlap versus later observation and never label application loss',()=>{
  const result=run([...pair(wanSymptoms),packet(0,1500),packet(2000,4000)]);assert.deepEqual(result.packetCaptures.map(row=>row.relation),['overlap','after']);assert.ok(categories(result).includes('tcp_retransmit'));assert.ok(result.packetCaptures.every(row=>row.deliveryBeyondRouter==='unknown'&&row.causeEvidence===false));assert.match(result.limitations.join(' '),/nach dem Lag.*kein Beleg/);
  const after=run([packet(1001,15000)]);assert.ok(!categories(after).includes('tcp_retransmit'));assert.equal(after.packetCaptures[0].relation,'after');assert.equal(after.packetCaptures[0].losses.events,0);
  const eventLossOnly=packet(0,1000);eventLossOnly.capture.retransmits=0;eventLossOnly.capture.losses.events=20;assert.ok(!categories(run([eventLossOnly])).includes('tcp_retransmit'));
});
test('Unrelated, remote, invalid, future and unsuccessful packet captures cannot create TCP evidence',()=>{
  const valid=packet(0,1000);
  for(const record of [{...valid,incidentId:'other'},{...valid,sourceDeviceId:'peer'},{...valid,at:at(500)},{...valid,capture:{...valid.capture,startedAt:at(2000)}},{...valid,capture:{...valid.capture,quality:'unknown'}},{...valid,capture:{...valid.capture,status:'needs-admin'}},packet(62000,63000)])assert.ok(!categories(run([record])).includes('tcp_retransmit'));
  const result=run(Array.from({length:8},(_,i)=>packet(i*100,i*100+50)));assert.equal(result.packetCaptures.length,4);assert.ok(Buffer.byteLength(JSON.stringify(result))<62000);
  const simultaneous=run([{...valid,incidentId:'other'},valid,valid]);assert.equal(simultaneous.packetCaptures.length,1);assert.ok(categories(simultaneous).includes('tcp_retransmit'));
});
