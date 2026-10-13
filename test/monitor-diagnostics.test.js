import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Monitor} from '../lib/monitor.js';
import {buildMeshEvidence} from '../lib/mesh-evidence.js';

const network={interfaces:[{id:'pc',mac:'02:00:00:00:00:03',gateway:'192.168.1.1',ipv4:[{address:'192.168.1.3',prefixLength:24}]}],defaultInterfaceId:'pc',neighbors:[],wifi:{connected:false}};
const probes={discoverNetwork:async()=>structuredClone(network),pingMany:async hosts=>hosts.map(host=>({host,ok:true,ms:2,status:'Success',routeInterfaceId:'pc'})),getTrafficCounters:async()=>[]};
const mesh=()=>({available:true,schemaVersion:'8.7',nodes:[1,2,3].map(id=>({id:String(id),mac:`02:00:00:00:00:0${id}`,ip:`192.168.1.${id}`,role:id===1?'MASTER':id===2?'SLAVE':'CLIENT',interfaces:[{id:`i${id}`,mac:`02:00:00:00:01:0${id}`,type:id===2?'WLAN':'LAN',isUpstream:id!==1}]})),links:[{id:'a',from:'1',to:'2',fromInterface:'i1',toInterface:'i2',type:'WLAN',state:'CONNECTED',receiveRateMbps:100,transmitRateMbps:100},{id:'b',from:'2',to:'3',fromInterface:'i2',toInterface:'i3',type:'LAN',state:'CONNECTED',receiveRateMbps:1000,transmitRateMbps:1000}]});

test('precision schedules only gateway and selected repeater at 250ms, retaining actual intervals',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const calls=[];
  const m=new Monitor({...probes,pingMany:async hosts=>{calls.push(hosts);return probes.pingMany(hosts);}});m.maintenance=async()=>{};
  await m.refresh();m.setRepeater('192.168.1.2');m.selectRepeater('192.168.1.2');await m.setMeasurement({mode:'precision'});
  try {
    await m.tick({background:true});now+=250;await m.tick({background:true});
    assert.deepEqual(calls[1].sort(),['192.168.1.1','192.168.1.2']);
    now+=750;await m.tick({background:true});assert.ok(calls[2].includes('1.1.1.1'));
    const record=m.history.snapshot().records.filter(r=>r.type==='ping').at(-1);
    assert.equal(record.pcMac,network.interfaces[0].mac);assert.equal(record.routingConfirmed,true);
    assert.equal(record.results.find(r=>r.host==='1.1.1.1').quality.actualIntervalMs,1000);
  } finally {await m.close();}
});

test('historical Mesh projection preserves interfaces, path, changes and absence of invented paths',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const m=new Monitor(probes);await m.refresh();
  const data={host:'fritz.box',device:{uptimeSeconds:100},mesh:mesh(),hosts:[],wan:{},wlan:[]};
  try {
    m.applyFritz(data);let record=m.history.snapshot().records.find(r=>r.type==='fritzbox');
    assert.equal(buildMeshEvidence(record,{pcMac:network.interfaces[0].mac,now}).path.status,'confirmed');
    assert.equal(m.state.targets.find(target=>target.host==='192.168.1.2').meshAutomatic,true);
    now+=30000;const changed=structuredClone(data);changed.mesh.links[0].receiveRateMbps=20;m.applyFritz(changed);
    const change=m.history.snapshot().records.find(r=>r.type==='mesh_change');assert.equal(change.changes[0].kind,'rate-drop');assert.equal(Date.parse(change.interval.to)-Date.parse(change.interval.from),30000);
    m.state.network.defaultInterfaceId='other';now+=30000;m.applyFritz(changed);
    assert.notEqual(m.state.fritzbox.mesh.evidence.path.status,'confirmed');assert.ok(!m.state.targets.some(target=>target.meshAutomatic));
  }finally{await m.close();}
});

test('peer replay is durable and deduplicated without contaminating local charts',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'kompass-peer-monitor-'));const m=new Monitor(probes,{dataDir:dir});
  m.schedule=()=>{};m.scheduleGames=()=>{};
  const row={type:'ping',at:new Date().toISOString(),sourceDeviceId:'peer-1',sequence:1,remote:true,clockReliable:false,results:[{host:'192.168.1.1',kind:'gateway',ms:350,ok:true}]};
  try {
    await m.start();m.ingestPeer(row);m.ingestPeer(row);await m.flushRaw();
    assert.equal(m.history.entries.filter(entry=>JSON.parse(entry.json).sourceDeviceId==='peer-1').length,1);
    assert.equal(m.historySnapshot().records.filter(r=>r.remote).length,0);
    await m.close();
    const second=new Monitor(probes,{dataDir:dir});second.schedule=()=>{};second.scheduleGames=()=>{};
    await second.start();second.ingestPeer(row);assert.equal(second.history.entries.filter(entry=>JSON.parse(entry.json).sourceDeviceId==='peer-1').length,1);await second.close();
  }finally{await m.close();await rm(dir,{recursive:true,force:true});}
});

test('configured retention is applied before persisted incidents are loaded',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'kompass-retention-'));const at=new Date(Date.now()-40*86400000).toISOString();
  await writeFile(path.join(dir,'settings.json'),JSON.stringify({historyPolicy:{eventDays:365}}));
  await writeFile(path.join(dir,'history.jsonl'),JSON.stringify({type:'incident',at,incident:{id:'older',startedAt:at,updatedAt:at,status:'complete'}})+'\n');
  const m=new Monitor(probes,{dataDir:dir});m.schedule=()=>{};m.scheduleGames=()=>{};
  try {await m.start();assert.ok(m.listIncidents().some(i=>i.id==='older'));await m.close();assert.match(await readFile(path.join(dir,'history.jsonl'),'utf8'),/older/);}
  finally{await m.close();await rm(dir,{recursive:true,force:true});}
});

test('legacy peer topology becomes scan and local cursor IDs stay paired with local records',async()=>{
  const m=new Monitor(probes),at=new Date(Date.now()-1000).toISOString();
  try {
    m.log({type:'event',at,title:'local-first'});
    assert.doesNotThrow(()=>m.ingestPeer({type:'topology',at,sourceDeviceId:'legacy-peer',sequence:1,devices:[]}));
    m.log({type:'event',at,title:'local-second'});
    assert.equal(m.history.entries.map(row=>JSON.parse(row.json)).find(row=>row.remote).type,'scan');
    const first=m.historySnapshot();
    assert.equal(first.total,2);assert.equal(first.records.length,first.recordIds.length);
    for(let i=0;i<first.records.length;i++)assert.equal(JSON.parse(m.history.entries.find(row=>row.sequence===first.recordIds[i]).json).recordId,first.records[i].recordId);
    m.ingestPeer({type:'traffic',at,sourceDeviceId:'legacy-peer',sequence:2,downloadMbps:2});
    m.log({type:'event',at,title:'local-third'});
    const delta=m.historySnapshot(1,first.cursor);
    assert.equal(delta.incremental,true);assert.equal(delta.total,3);
    assert.deepEqual(delta.records.map(row=>row.title),['local-third']);assert.equal(delta.recordIds.length,1);
    assert.equal(JSON.parse(m.history.entries.find(row=>row.sequence===delta.recordIds[0]).json).title,'local-third');
  }finally{await m.close();}
});

test('ping watermark prevents replay after monitor dedup eviction but preserves new traffic and retained rollups',async()=>{
  const m=new Monitor(probes),at=new Date(Date.now()-1000).toISOString(),ingested=[];
  m.history.setPolicy(m.historyPolicy);
  m.incidentService={ingest:row=>ingested.push(row),close:async()=>{}};
  const ping={type:'ping',at,sourceDeviceId:'peer-replay',sequence:3,results:[{host:'router',ok:true,ms:4}]};
  try {
    m.ingestPeer(ping);m.peerRecords.clear();m.rollups.seen.clear();
    m.ingestPeer(ping);
    assert.equal(m.rollups.snapshot()[0].count,1);assert.equal(ingested.length,1);
    m.ingestPeer({type:'traffic',at,sourceDeviceId:'peer-replay',sequence:2,downloadMbps:2});
    assert.equal(ingested.length,2);assert.equal(ingested[1].type,'traffic');
    const old={...ping,sequence:4,at:new Date(Date.now()-2*86400000).toISOString()};
    m.ingestPeer(old);
    assert.equal(ingested.length,2,'expired raw history must not create a live incident');
    assert.equal(m.rollups.snapshot().reduce((sum,row)=>sum+row.count,0),2,'new older data still belongs in the longer rollup retention');
    assert.equal(m.rollups.peerSequences.get('peer-replay'),4);
  }finally{await m.close();}
});

test('raw queue bounds all pending batches and durably reports exact dropped counts in the existing logQueue',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'kompass-raw-cap-')),m=new Monitor(probes,{dataDir:dir});
  let release;const blocked=new Promise(resolve=>{release=resolve;});m.logQueue=blocked;
  let accepted=0,dropped=0;
  try {
    for(let i=0;i<160;i++) {
      if(m.appendRaw({type:'event',at:new Date().toISOString(),title:`row-${i}`,detail:'x'.repeat(60000)}))accepted++;else dropped++;
      assert.ok(m.rawQueuedBytes<=4*1024*1024);
    }
    assert.ok(accepted>20);assert.ok(dropped>20);
    assert.equal(m.state.rawPersistence.droppedRecords,dropped);assert.match(m.state.lastError,/Messlücke/);
    const alreadyPublishedQueue=m.logQueue;
    release();await alreadyPublishedQueue;
    assert.equal(m.rawQueuedBytes,0);assert.equal(m.state.rawPersistence.pendingDroppedRecords,0);
    const file=path.join(dir,`messungen-${new Date().toISOString().slice(0,10)}.jsonl`);
    const rows=(await readFile(file,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.equal(rows.filter(row=>row.title?.startsWith('row-')).length,accepted);
    const gaps=rows.filter(row=>row.kind==='measurement-gap');
    assert.equal(gaps.reduce((sum,row)=>sum+row.droppedRecords,0),dropped);
    assert.ok(gaps.every(row=>row.quality.gap&&row.level==='warning'&&row.detail.includes('kein Nachweis eines Netzwerkausfalls')));
    assert.equal(m.history.entries.filter(row=>JSON.parse(row.json).kind==='measurement-gap').length,gaps.length);
  }finally{release();await m.close();await rm(dir,{recursive:true,force:true});}
});

test('one oversized raw entry still persists a gap notice, while awaiting a normal open batch waits for its 500ms gate',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'kompass-raw-gate-')),m=new Monitor(probes,{dataDir:dir});
  try {
    assert.equal(m.appendRaw({type:'event',at:new Date().toISOString(),detail:'x'.repeat(4*1024*1024)}),false);
    await m.logQueue;assert.equal(m.state.rawPersistence.pendingDroppedRecords,0);
    assert.equal(m.appendRaw({type:'event',at:new Date().toISOString(),title:'await-open-batch'}),true);
    const openBatchQueue=m.logQueue;
    assert.ok(m.rawBatch);await openBatchQueue;
    const text=await readFile(path.join(dir,`messungen-${new Date().toISOString().slice(0,10)}.jsonl`),'utf8');
    assert.match(text,/await-open-batch/);assert.match(text,/"droppedRecords":1/);assert.equal(m.rawQueuedBytes,0);
  }finally{await m.close();await rm(dir,{recursive:true,force:true});}
});
