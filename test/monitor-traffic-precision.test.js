import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const fake={getTrafficCounters:async()=>[],discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{},warnings:[]}),pingMany:async()=>[]};
const monitor=probes=>{const m=new Monitor({...fake,...probes});m.state.selectedInterfaceId='1';m.state.network.interfaces=[{id:'1',mac:'02:00:00:00:00:01',ipv4:[]}];return m;};
const full=now=>({host:'fritz.box',updatedAt:new Date(now).toISOString(),device:{uptimeSeconds:100},wan:{totalBytesReceived:1000,totalBytesSent:500,downstreamMbps:100,upstreamMbps:20,sampling:{from:new Date(now-20).toISOString(),to:new Date(now).toISOString()}},mesh:{available:true,nodes:[],links:[]},hosts:[],deviceTraffic:[]});
const slim=(now,{devices,received=2000,sent=1000,uptime=101,bytes=1000}={})=>({kind:'traffic',host:'fritz.box',updatedAt:new Date(now).toISOString(),collection:{from:new Date(now-20).toISOString(),to:new Date(now).toISOString(),durationMs:20,responseBytes:bytes},device:{uptimeSeconds:uptime},wan:{totalBytesReceived:received,totalBytesSent:sent,source:'tr064-wan-byte-counters',scope:'internet',sampling:{from:new Date(now-20).toISOString(),to:new Date(now).toISOString()}},...(devices===undefined?{}:{deviceTraffic:devices,deviceTrafficCapability:{available:devices.some(row=>row.available),source:'mesh-wan-counters',scope:'internet'}})});
const device=(timestamp,received=1000,sent=500)=>({id:'mac:02:00:00:00:00:02',mac:'02:00:00:00:00:02',name:'Gaming-PC',ip:'192.168.1.20',source:'mesh-wan-counters',scope:'internet',available:true,lastUpdateMs:timestamp,totalBytesReceived:received,totalBytesSent:sent,observedAt:new Date(timestamp+2000).toISOString()});
const router=(m,now,callback)=>{m.applyFritz(full(now));m.lastFritz=now;m.fritzClient={connected:true,pollTraffic:callback,poll:async()=>full(Date.now()),disconnect(){this.connected=false;}};return m.fritzClient;};

test('PC counters use their persistent worker once a second and close it with monitoring',async t=>{
  let now=Date.now(),reads=0,closed=0;t.mock.method(Date,'now',()=>now);
  const m=monitor({getTrafficCounters:()=>assert.fail('one-shot probe must not run'),createTrafficMonitor:()=>({getTrafficCounters:async({signal,timeoutMs})=>{assert.equal(signal.aborted,false);assert.equal(timeoutMs,4000);reads++;return [{id:'1',receivedBytes:reads*125000,sentBytes:reads*25000}];},close(){closed++;}})});
  try {
    await m.refreshTrafficCounters();assert.equal(m.state.traffic.downloadMbps,null);
    now+=999;await m.refreshTrafficCounters();assert.equal(reads,1);
    now++;await m.refreshTrafficCounters();assert.equal(reads,2);assert.equal(m.state.traffic.downloadMbps,1);assert.equal(m.state.traffic.uploadMbps,.2);
    const row=m.history.snapshot().records.filter(row=>row.type==='traffic').at(-1);assert.equal(row.downloadDeltaBytes,125000);assert.equal(Date.parse(row.at)-Date.parse(row.intervalStartedAt),1000);
    m.setMonitoring(false);now+=5000;await m.refreshTrafficCounters();assert.equal(reads,2);
    m.setMonitoring(true);await m.refreshTrafficCounters();assert.equal(reads,3);assert.equal(m.state.traffic.downloadMbps,null);
  }finally{await m.close();}
  assert.equal(closed,1);
});

test('Slow or failed local counter reads back off with bounded intervals and recover gradually',async t=>{
  let now=Date.now(),reads=0,duration=700,fail=false;t.mock.method(Date,'now',()=>now);
  const m=monitor({getTrafficCounters:async()=>{reads++;now+=duration;if(fail)throw new Error('fixture timeout');return [{id:'1',receivedBytes:reads,sentBytes:reads}];}});
  try {
    await m.refreshTrafficCounters();assert.equal(m.trafficIntervalMs,1400);assert.equal(m.state.traffic.quality.limited,true);
    now+=699;await m.refreshTrafficCounters();assert.equal(reads,1);
    now++;duration=0;await m.refreshTrafficCounters();assert.equal(reads,2);assert.equal(m.trafficIntervalMs,1000);
    fail=true;
    for(let n=0;n<8;n++){now+=10000;await m.refreshTrafficCounters();}
    assert.equal(m.trafficIntervalMs,10000);assert.equal(m.state.traffic.downloadMbps,null);assert.equal(m.previousCounter,null);
  }finally{await m.close();}
});

test('Pause, reset and interface change discard old local traffic responses and their errors',async t=>{
  for(const change of ['pause','reset','interface'])for(const fail of [false,true]) {
    const gate=deferred(),m=monitor({getTrafficCounters:()=>gate.promise});
    try {
      const pending=m.refreshTrafficCounters();
      if(change==='pause'){m.setMonitoring(false);m.setMonitoring(true);}else if(change==='reset')m.resetMeasurements();else{m.state.selectedInterfaceId='2';m.resetMeasurements();}
      if(fail)gate.reject(new Error('old response'));else gate.resolve([{id:'1',receivedBytes:9999999,sentBytes:9999999}]);
      await pending;assert.equal(m.state.traffic.at,null);assert.equal(m.previousCounter,null);assert.equal(m.state.lastError,null);assert.equal(m.history.snapshot().records.filter(row=>row.type==='traffic').length,0);
    }finally{await m.close();}
  }
});

test('Local traffic reads do not overlap and long gaps do not create a momentary rate',async t=>{
  let now=Date.now(),reads=0;t.mock.method(Date,'now',()=>now);
  const gate=deferred(),m=monitor({getTrafficCounters:()=>{reads++;return reads===1?gate.promise:Promise.resolve([{id:'1',receivedBytes:1000000,sentBytes:1000000}]);}});
  try {
    const first=m.refreshTrafficCounters();now+=1200;const second=m.refreshTrafficCounters();assert.equal(reads,1);gate.resolve([{id:'1',receivedBytes:1,sentBytes:1}]);await Promise.all([first,second]);
    now+=11000;await m.refreshTrafficCounters();assert.equal(m.state.traffic.downloadMbps,null);assert.equal(m.state.traffic.intervalStartedAt,null);
  }finally{await m.close();}
});

test('Closing monitoring aborts the counter worker and does not persist its late failure',async()=>{
  const gate=deferred();let stops=0;
  const m=monitor({createTrafficMonitor:()=>({getTrafficCounters:()=>gate.promise,close(){stops++;gate.reject(new Error('closed fixture'));}})});
  const pending=m.refreshTrafficCounters();await m.close();await pending;
  assert.equal(stops,1);assert.equal(m.state.traffic.at,null);assert.equal(m.state.lastError,null);assert.equal(m.history.snapshot().records.filter(row=>row.type==='traffic').length,0);
});

test('FRITZ WAN polls run at two seconds and device queries at least five seconds apart',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const requested=[],m=monitor();
  router(m,now,async({includeDevices})=>{requested.push({at:now,includeDevices});return slim(now,{devices:includeDevices?[device(now)]:undefined});});
  try {
    await m.refreshFritzTraffic();now+=1999;await m.refreshFritzTraffic();assert.equal(requested.length,1);
    now++;await m.refreshFritzTraffic();now+=2000;await m.refreshFritzTraffic();now+=2000;await m.refreshFritzTraffic();
    assert.deepEqual(requested.map(row=>row.includeDevices),[true,false,false,true]);assert.ok(requested.filter(row=>row.includeDevices)[1].at-requested[0].at>=5000);
  }finally{await m.close();}
});

test('Fast FRITZ traffic preserves full topology time and WAN-only polls retain device rates',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const m=monitor();
  const data=full(now);data.deviceTraffic=[device(now-3000)];m.applyFritz(data);
  const originalAt=m.state.fritzbox.updatedAt,originalMesh=m.state.fritzbox.mesh;
  try {
    now+=2000;m.applyFritzTraffic(slim(now,{devices:[device(now-1000,1250000,250500)]}));
    const rows=m.state.fritzbox.deviceTraffic;assert.equal(rows[0].rateAvailable,true);assert.equal(rows[0].intervalStartedAt,new Date(now-5000).toISOString());assert.equal(rows[0].intervalEndedAt,new Date(now-1000).toISOString());
    now+=2000;m.applyFritzTraffic(slim(now,{received:3000,sent:1500}));
    assert.equal(m.state.fritzbox.updatedAt,originalAt);assert.equal(m.state.fritzbox.mesh,originalMesh);assert.equal(m.state.fritzbox.history.length,1);assert.equal(m.state.fritzbox.deviceTraffic,rows);
    const records=m.history.snapshot().records.filter(row=>row.kind==='traffic');assert.equal(records.length,2);assert.equal(records[0].mesh,undefined);assert.equal(records[0].hosts,undefined);assert.equal(records[1].deviceTraffic,undefined);
    assert.equal(m.state.fritzbox.wan.counterUpdateFrequencyKnown,false);assert.equal(m.state.fritzbox.wan.timingUncertaintyMs,20);assert.ok(m.state.fritzbox.wan.downloadMbps>0);
  }finally{await m.close();}
});

test('Full and slim WAN observations share a baseline and reject missing router uptime',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const m=monitor();
  try {
    m.applyFritz(full(now));now+=2000;m.applyFritzTraffic(slim(now));assert.ok(m.state.fritzbox.wan.downloadMbps>0);
    now+=2000;const data=full(now);data.device.uptimeSeconds=102;data.wan.totalBytesReceived=3000;data.wan.totalBytesSent=1500;m.applyFritz(data);assert.ok(m.state.fritzbox.wan.downloadMbps>0);
    now+=2000;m.applyFritzTraffic(slim(now,{uptime:null,received:4000}));assert.equal(m.state.fritzbox.wan.downloadMbps,null);
  }finally{await m.close();}
});

test('WAN counters without a source observation window do not form a rate baseline',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const m=monitor();
  try {
    const initial=full(now);delete initial.wan.sampling;m.applyFritz(initial);assert.equal(m.fritzPrevious,null);assert.equal(m.state.fritzbox.wan.sampling,null);
    now+=2000;m.applyFritzTraffic(slim(now,{received:15001000}));assert.equal(m.state.fritzbox.wan.downloadMbps,null);assert.equal(m.state.fritzbox.wan.timingUncertaintyMs,null);
    now+=2000;m.applyFritzTraffic(slim(now,{received:15251000}));assert.equal(m.state.fritzbox.wan.downloadMbps,1);
  }finally{await m.close();}
});

test('Receipt time does not shift an earlier WAN observation to produce a false traffic peak',async t=>{
  const start=Date.now();let now=start+10000;t.mock.method(Date,'now',()=>now);const m=monitor();
  try {
    const data=full(start);data.wan.sampling={from:new Date(start).toISOString(),to:new Date(start).toISOString()};data.wan.totalBytesReceived=0;m.applyFritz(data);
    now+=2000;const current=slim(now,{received:15000000});current.wan.sampling={from:new Date(now).toISOString(),to:new Date(now).toISOString()};m.applyFritzTraffic(current);
    assert.equal(m.state.fritzbox.wan.downloadMbps,10);assert.equal(m.state.fritzbox.wan.intervalStartedAt,new Date(start).toISOString());
  }finally{await m.close();}
});

test('Full and fast archives preserve router clock metadata and mark future counter times unsuitable for lag timing',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const m=monitor();
  try {
    const initial=full(now);initial.deviceTraffic=[{...device(now+60000),observedAt:new Date(now).toISOString(),counterAgeBasis:'router-vs-pc-clock-unverified'}];m.applyFritz(initial);
    now+=2000;const future={...device(now+60000,1001000,500500),observedAt:new Date(now).toISOString(),counterAgeBasis:'router-vs-pc-clock-unverified'};m.applyFritzTraffic(slim(now,{devices:[future]}));
    const records=m.history.snapshot().records.filter(row=>row.type==='fritzbox');assert.equal(records.length,2);
    for(const record of records){const row=record.deviceTraffic[0];assert.equal(row.counterAgeBasis,'router-vs-pc-clock-unverified');assert.ok(Number.isSafeInteger(row.lastUpdateMs));assert.ok(Number.isFinite(Date.parse(row.observedAt)));assert.equal(row.counterTimingAvailable,false);assert.match(row.counterTimingReason,/Zuordnung/);}
    assert.equal(m.state.fritzbox.deviceTraffic[0].rateAvailable,true,'Router-clock delta remains calculable, while its correlation to a PC lag is unknown');
  }finally{await m.close();}
});

test('Pause, reset and disconnect discard late FRITZ traffic snapshots',async t=>{
  for(const change of ['pause','reset','disconnect']) {
    const gate=deferred(),m=monitor(),now=Date.now();router(m,now,()=>gate.promise);
    try {
      const pending=m.refreshFritzTraffic();
      if(change==='pause'){m.setMonitoring(false);m.setMonitoring(true);}else if(change==='reset')await m.reset();else m.disconnectFritz(false);
      gate.resolve(slim(Date.now(),{received:99999999,devices:[device(Date.now())]}));await pending;
      assert.equal(m.history.snapshot().records.filter(row=>row.kind==='traffic').length,0);assert.notEqual(m.state.fritzbox.wan?.totalBytesReceived,99999999);
    }finally{await m.close();}
  }
});

test('Full router refresh waits for slim poll and a due full refresh takes priority',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);const gate=deferred(),m=monitor();let fullReads=0,slimReads=0;
  const client=router(m,now,()=>{slimReads++;return gate.promise;});client.poll=async()=>{fullReads++;return full(now);};
  try {
    const fast=m.refreshFritzTraffic(),complete=m.refreshFritz();assert.equal(fullReads,0);
    now+=100;gate.resolve(slim(now));await Promise.all([fast,complete]);assert.equal(fullReads,1);assert.equal(m.state.fritzbox.history.length,2);
    now+=60000;await m.refreshFritzTraffic();assert.equal(fullReads,2);assert.equal(slimReads,1);
  }finally{await m.close();}
});

test('Slow, large and failing FRITZ queries back off within bounded WAN and device intervals',async t=>{
  let now=Date.now(),fail=false;t.mock.method(Date,'now',()=>now);const m=monitor();
  router(m,now,async()=>{now+=1800;if(fail)throw new Error('fixture failure');return slim(now,{devices:[],bytes:500000});});
  try {
    await m.refreshFritzTraffic();assert.equal(m.fritzTrafficIntervalMs,3600);assert.equal(m.fritzDeviceIntervalMs,25000);
    fail=true;
    for(let n=0;n<6;n++){now+=15000;m.lastFritz=now;await m.refreshFritzTraffic();}
    assert.equal(m.fritzTrafficIntervalMs,15000);assert.ok(m.fritzDeviceIntervalMs<=60000);assert.equal(m.state.fritzbox.trafficMeasurement.error,'fixture failure');
  }finally{await m.close();}
});

test('Large device traffic archives are bounded and omissions explicitly counted',async t=>{
  const m=monitor();let now=Date.now();t.mock.method(Date,'now',()=>now);
  try {
    m.applyFritz(full(now));const devices=Array.from({length:180},(_,i)=>({...device(now+i),id:'mac:02:00:00:00:01:'+i,mac:'02:00:00:00:01:'+i,name:'A'.repeat(1000),reason:'B'.repeat(5000)}));
    now+=2000;m.applyFritzTraffic(slim(now,{devices}));
    const row=m.history.snapshot().records.find(row=>row.kind==='traffic');assert.ok(row);assert.equal(row.deviceTrafficCount,180);assert.equal(row.deviceTrafficTruncated,true);assert.ok(row.deviceTraffic.length<=128);assert.ok(Buffer.byteLength(JSON.stringify(row))<64000);
  }finally{await m.close();}
});

test('100 ms inclusively starts router lag capture while lower latencies do not',async()=>{
  let ms=99.9;const m=monitor({pingMany:async hosts=>hosts.map(host=>({host,ok:true,ms,status:'Success'}))});m.maintenance=async()=>{};
  m.state.targets=[m.makeTarget('192.168.1.1','Router','gateway')];m.fritzClient={connected:true,disconnect(){this.connected=false;}};
  try {await m.tick();assert.equal(m.pendingFritzLag,null);ms=100;await m.tick();assert.ok(m.pendingFritzLag);assert.equal(m.state.events.filter(row=>row.title==='Router: Ping-Spitze').length,1);}finally{await m.close();}
});
