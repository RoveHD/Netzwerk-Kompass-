import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const network={interfaces:[{id:'1',name:'LAN',gateway:'192.168.1.1',ipv4:[{address:'192.168.1.2',prefixLength:30}]},{id:'2',name:'WLAN',gateway:'192.168.2.1',ipv4:[{address:'192.168.2.2',prefixLength:30}]}],defaultInterfaceId:'1',neighbors:[],wifi:{connected:false},warnings:[]};
const fake={discoverNetwork:async()=>structuredClone(network),pingMany:async hosts=>hosts.map(host=>({host,ok:true,ms:2,status:'Success'})),getTrafficCounters:async()=>[]};
test('adapter error intervals reach live state and durable history, reset clears the baseline',async()=>{
  let receivedErrors=100;
  const m=new Monitor({...fake,getTrafficCounters:async()=>[{id:'1',receivedBytes:1000,sentBytes:1000,receivedErrors,sentErrors:0,receivedDiscards:0,sentDiscards:0}]});
  await m.refresh();m.lookupDns=async()=>({address:'192.0.2.1'});
  try {
    await m.maintenance();assert.equal(m.state.traffic.adapterHealth.delta.receivedErrors,null);
    m.previousCounter.time-=5000;m.lastCounters=0;receivedErrors=103;
    await m.maintenance();assert.equal(m.state.traffic.adapterHealth.delta.receivedErrors,3);
    assert.equal(m.history.snapshot().records.filter(row=>row.type==='traffic').at(-1).adapterHealth.delta.receivedErrors,3);
    assert.ok(m.state.events.some(row=>row.title==='PC-Netzwerkkarte meldet Fehler oder verworfene Pakete'));
    m.resetMeasurements();await m.maintenance();assert.equal(m.state.traffic.adapterHealth.delta.receivedErrors,null);
  }finally{await m.close();}
});
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
// Adapter changes reset lastDns, so even a tick with fake probes can otherwise
// perform a real lookup. Race tests below replace this fixture with their gate.
const originalLookupDns=Monitor.prototype.lookupDns;
test.before(()=>{Monitor.prototype.lookupDns=async()=>({address:'192.0.2.1',family:4});});
test.after(()=>{Monitor.prototype.lookupDns=originalLookupDns;});

test('pause discards delayed Ping successes and errors, including quick resume',async()=>{
  for(const resume of [false,true])for(const failure of [false,true]) {
    const gate=deferred();let hosts;
    const m=new Monitor({...fake,pingMany:values=>{hosts=values;return gate.promise;}});
    m.maintenance=async()=>{};await m.refresh();
    const pending=m.tick();m.setMonitoring(false);if(resume)m.setMonitoring(true);
    if(failure)gate.reject(new Error('Delayed paused probe'));else gate.resolve(hosts.map(host=>({host,ok:true,ms:999,status:'Success'})));
    await pending;
    assert.ok(m.state.targets.every(target=>target.samples.length===0));assert.equal(m.state.lastError,null);
    assert.ok(!m.history.snapshot().records.some(record=>record.type==='ping'));
    if(resume){m.pingProbe=fake;await m.tick();assert.ok(m.state.targets.every(target=>target.stats.sent===1));}
    await m.close();
  }
});

test('target disable and re-enable rejects its old reply while other targets keep their results',async()=>{
  const gate=deferred();let hosts;
  const m=new Monitor({...fake,pingMany:values=>{hosts=values;return gate.promise;}});m.maintenance=async()=>{};await m.refresh();
  const target=m.addTarget('192.168.1.3'),pending=m.tick();
  m.toggleTarget(target.id,false);m.addTarget(target.host);
  gate.resolve(hosts.map(host=>({host,ok:true,ms:2,status:'Success'})));await pending;
  assert.equal(target.samples.length,0);assert.equal(m.state.targets[0].stats.sent,1);
  assert.ok(!m.history.snapshot().records.find(record=>record.type==='ping').results.some(row=>row.host===target.host));
  await m.close();
});

test('pause and quick resume discard old DNS answers and immediately permit a fresh check',async()=>{
  for(const failure of [false,true]) {
    const gate=deferred(),m=new Monitor(fake);await m.refresh();m.lastCounters=Date.now();m.lookupDns=()=>gate.promise;
    const pending=m.maintenance();m.setMonitoring(false);m.setMonitoring(true);
    if(failure)gate.reject(new Error('Delayed old DNS error'));else gate.resolve({address:'192.0.2.1'});
    await pending;assert.equal(m.state.dns,null);assert.equal(m.lastDns,0);
    assert.ok(!m.history.snapshot().records.some(record=>record.type==='dns'));
    m.lookupDns=async()=>({address:'192.0.2.1'});await m.maintenance();assert.equal(m.state.dns.ok,true);
    await m.close();
  }
});

test('out-of-order router counters retain the newest device baseline across MAC casing changes',async()=>{
  const m=new Monitor(fake),start=Date.now()-10000;
  const apply=(lastUpdateMs,totalBytesReceived,mac='12:34:56:78:90:AB')=>m.applyFritz({host:'fritz.box',device:{uptimeSeconds:100},wan:{},hosts:[],deviceTraffic:[{mac,available:true,source:'mesh-wan-counters',scope:'internet',lastUpdateMs,totalBytesReceived,totalBytesSent:100}]});
  apply(start,1000);apply(start+1000,201000);assert.equal(m.state.fritzbox.deviceTraffic[0].downloadMbps,1.6);
  apply(start,1000,'12:34:56:78:90:ab');assert.equal(m.state.fritzbox.deviceTraffic[0].downloadMbps,null);
  apply(start+2000,401000,'12:34:56:78:90:ab');
  assert.equal(m.state.fritzbox.deviceTraffic[0].downloadDeltaBytes,200000);assert.equal(m.state.fritzbox.deviceTraffic[0].downloadMbps,1.6);
  // A reset at the same counter time must establish a new baseline.
  apply(start+2000,1000);apply(start+3000,201000);assert.equal(m.state.fritzbox.deviceTraffic[0].downloadDeltaBytes,200000);
  await m.close();
});

test('critical status changes produce red warning events and recover through warning to ok',async()=>{
  let ms=20;
  const m=new Monitor({...fake,pingMany:async hosts=>hosts.map(host=>({host,ok:true,ms,status:'Success'}))});
  m.maintenance=async()=>{};await m.refresh();
  try {
    const gateway=m.state.targets.find(target=>target.kind==='gateway');
    await m.tick();ms=200;await m.tick();
    assert.equal(gateway.stats.status,'critical');
    const critical=m.state.events.find(event=>event.title===`${gateway.label}: Messwerte kritisch`);
    assert.ok(critical);assert.equal(critical.level,'error');
    assert.ok(!m.state.events.some(event=>event.title===`${gateway.label}: wieder unauffällig`));
    assert.ok(m.history.snapshot(1).records.some(record=>record.type==='event'&&record.title===critical.title&&record.level==='error'));
    ms=50;for(let i=0;i<30;i++)await m.tick();
    assert.equal(gateway.stats.status,'warning');
    assert.ok(m.state.events.some(event=>event.title===`${gateway.label}: Messwerte auffällig`&&event.level==='warning'));
    ms=2;for(let i=0;i<30;i++)await m.tick();
    assert.equal(gateway.stats.status,'ok');
    assert.ok(m.state.events.some(event=>event.title===`${gateway.label}: wieder unauffällig`&&event.level==='info'));
  }finally{await m.close();}
});

test('ping spike event uses the shared 30 ms boundary for local and internet targets',async()=>{
  let ms=30;
  const m=new Monitor({...fake,pingMany:async hosts=>hosts.map(host=>({host,ok:true,ms,status:'Success'}))});
  m.maintenance=async()=>{};await m.refresh();
  try {
    const gateway=m.state.targets.find(target=>target.kind==='gateway');
    const internet=m.state.targets.find(target=>target.kind==='internet');
    await m.tick();
    assert.ok(!m.state.events.some(event=>event.title.endsWith(': Ping-Spitze')));
    ms=31;await m.tick();
    assert.ok(m.state.events.some(event=>event.title===`${gateway.label}: Ping-Spitze`));
    assert.ok(m.state.events.some(event=>event.title===`${internet.label}: Ping-Spitze`));
  } finally {await m.close();}
});

test('speedtest records only real Internet pings observed during each load phase',async()=>{
  let internet,round=0;
  const probes={...fake,discoverNetwork:async()=>structuredClone(network),pingMany:async hosts=>{
    round++;
    return hosts.map(host=>({host,ok:host===internet&&round!==3,ms:host===internet?(round===1?14:round===2?18:22):1,status:'Success'}));
  }};
  const m=new Monitor(probes);m.maintenance=async()=>{};await m.refresh();
  try {
    internet=m.state.targets.find(target=>target.kind==='internet'&&target.host==='1.1.1.1').host;
    m.addTarget('192.168.1.88','Custom');
    m.speedTestPingTarget=internet;m.speedTestPingSamples={download:[],upload:[]};
    m.state.speedTest={running:true,phase:'download',pingDuringDownloadMs:null,pingDuringDownloadCount:0,pingDuringUploadMs:null,pingDuringUploadCount:0};
    await m.tick();await m.tick();await m.tick();
    assert.equal(m.state.speedTest.pingDuringDownloadMs,16);
    assert.equal(m.state.speedTest.pingDuringDownloadCount,2);
    assert.equal(m.state.speedTest.pingDuringUploadMs,null);
    m.state.speedTest.phase='upload';await m.tick();
    assert.equal(m.state.speedTest.pingDuringUploadMs,22);
    assert.equal(m.state.speedTest.pingDuringUploadCount,1);
  } finally {await m.close();}
});

test('one-off Internet ping does not contend with the monitor single-flight probe',async()=>{
  const gate=deferred();let oneOffCalls=0,workerCalls=0;
  const probes={...fake,pingMany:async hosts=>{oneOffCalls++;return hosts.map(host=>({host,ok:true,ms:23,status:'Success'}));},createPingMonitor:()=>({pingMany:async()=>{workerCalls++;return gate.promise;}})};
  const m=new Monitor(probes);
  try {
    const monitored=m.pingProbe.pingMany(['1.1.1.1']);
    const measured=await m.measureInternetPing({host:'1.1.1.1',label:'Internet · Cloudflare'});
    assert.deepEqual(measured,{ms:23,target:'Internet · Cloudflare (1.1.1.1)'});
    assert.equal(workerCalls,1);assert.equal(oneOffCalls,1);
    gate.resolve([]);await monitored;
  } finally {await m.close();}
});

test('delayed monitor pings cannot be assigned to a later phase or speedtest run',async()=>{
  const first=deferred(),second=deferred();let call=0;
  const m=new Monitor({...fake,pingMany:async()=> (++call===1?first.promise:second.promise)});m.maintenance=async()=>{};await m.refresh();
  try {
    const host='1.1.1.1';
    m.speedTestPingTarget=host;m.speedTestPingSamples={download:[],upload:[]};
    m.state.speedTest={running:true,phase:'download',pingDuringDownloadMs:null,pingDuringDownloadCount:0,pingDuringUploadMs:null,pingDuringUploadCount:0};
    const oldPhase=m.tick();m.state.speedTest.phase='upload';first.resolve([{host,ok:true,ms:17,status:'Success'}]);await oldPhase;
    assert.deepEqual(m.speedTestPingSamples,{download:[],upload:[]});

    m.state.speedTest.phase='download';const oldRun=m.tick();
    m.state.speedTest={running:true,phase:'download',pingDuringDownloadMs:null,pingDuringDownloadCount:0,pingDuringUploadMs:null,pingDuringUploadCount:0};
    second.resolve([{host,ok:true,ms:19,status:'Success'}]);await oldRun;
    assert.deepEqual(m.speedTestPingSamples,{download:[],upload:[]});
    assert.equal(m.state.speedTest.pingDuringDownloadMs,null);
  } finally {await m.close();}
});

test('multiple repeaters keep IDs and samples when promoted and never replace the PC connection',async()=>{
  const m=new Monitor(fake);m.maintenance=async()=>{};await m.refresh();
  try {
    const first=m.addTarget('192.168.1.3','Existing');await m.tick();const samples=first.samples;
    assert.equal(m.setRepeater(first.host,'First'),first);assert.equal(first.samples,samples);assert.equal(first.stats.sent,1);
    assert.equal(m.state.repeaterHost,null);m.selectRepeater(first.host);
    const second=m.setRepeater('192.168.1.4','Second');await m.tick();
    assert.equal(m.state.targets.filter(t=>t.kind==='repeater').length,2);assert.equal(first.stats.sent,2);assert.equal(second.stats.sent,1);assert.equal(m.state.repeaterHost,first.host);
    assert.equal(m.setRepeater(second.host,'Second again').id,second.id);assert.equal(m.state.targets.filter(t=>t.host===second.host).length,1);
    assert.throws(()=>m.selectRepeater('192.168.1.99'));assert.throws(()=>m.selectRepeater(undefined));
    m.removeTarget(second.id);assert.equal(m.state.repeaterHost,first.host);
    m.toggleTarget(first.id,false);assert.equal(m.state.repeaterHost,first.host);
    m.removeTarget(first.id);assert.equal(m.state.repeaterHost,null);
  }finally{await m.close();}
});

test('repeater settings restore multiple marks, paused state and explicit or legacy PC connection',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'network-repeaters-test-'));let m;
  const start=async()=>{m=new Monitor(fake,{dataDir});m.schedule=()=>{};await m.start();return m;};
  try {
    await start();const first=m.setRepeater('192.168.1.3','One');m.setRepeater('192.168.1.4','Two');m.selectRepeater(first.host);m.toggleTarget(first.id,false);await m.close();
    await start();assert.equal(m.state.targets.filter(t=>t.kind==='repeater').length,2);assert.equal(m.state.repeaterHost,first.host);assert.equal(m.state.targets.find(t=>t.host===first.host).enabled,false);
    m.selectRepeater(null);await m.close();await start();assert.equal(m.state.repeaterHost,null);await m.close();
    await writeFile(path.join(dataDir,'settings.json'),JSON.stringify({targets:[{host:first.host,kind:'repeater'}]}));
    await start();assert.equal(m.state.repeaterHost,first.host);await m.close();
    await writeFile(path.join(dataDir,'settings.json'),JSON.stringify({targets:[{host:first.host,kind:'repeater'},{host:'192.168.1.4',kind:'repeater'}]}));
    await start();assert.equal(m.state.repeaterHost,null);assert.equal(m.state.targets.filter(t=>t.kind==='repeater').length,2);await m.close();
    await writeFile(path.join(dataDir,'settings.json'),JSON.stringify({repeaterHost:'192.168.1.99',targets:[{host:first.host,kind:'repeater'}]}));
    await start();assert.equal(m.state.repeaterHost,null);
  }finally{await m?.close();if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('network-repeaters-test-'))throw new Error('Unsicherer Testpfad');await rm(dataDir,{recursive:true,force:true});}
});

test('an in-flight ping cannot repopulate a removed or paused repeater',async()=>{
  const gate=deferred();const m=new Monitor({...fake,pingMany:()=>gate.promise});m.maintenance=async()=>{};await m.refresh();
  const first=m.setRepeater('192.168.1.3');const second=m.setRepeater('192.168.1.4');m.selectRepeater(first.host);
  const pending=m.tick();m.toggleTarget(first.id,false);m.removeTarget(second.id);gate.resolve([first,second].map(t=>({host:t.host,ok:true,ms:2})));await pending;
  assert.equal(first.samples.length,0);assert.equal(second.samples.length,0);assert.equal(m.history.snapshot(1).records.find(r=>r.type==='ping').results.length,0);await m.close();
});

test('a newly selected gateway reuses its target without duplicate repeater role',async()=>{
  const m=new Monitor(fake);await m.refresh();const target=m.setRepeater('192.168.2.1');m.selectRepeater(target.host);m.selectInterface('2');
  assert.equal(m.state.targets.filter(t=>t.host===target.host).length,1);assert.equal(m.state.targets.find(t=>t.kind==='gateway'),target);assert.equal(m.state.repeaterHost,null);await m.close();
});

test('FRITZ login accepts an omitted or blank username and keeps destination validation',async()=>{
  const m=new Monitor(fake);
  try {
    for(const extra of [{},{username:''},{username:'   '}]) {
      await assert.rejects(m.connectFritz({host:'8.8.8.8',password:'synthetic-only',...extra}),/private IPv4-Routeradressen/);
      assert.equal(m.state.fritzbox.connected,false);
    }
    await assert.rejects(m.connectFritz({host:'fritz.box',username:[],password:'synthetic-only'}),/optionalen Benutzernamen/);
  }finally{await m.close();}
});

test('FRITZ history separates link capacity and throughput and rejects gaps and counter resets',async()=>{
  const m=new Monitor(fake);
  const data={host:'fritz.box',device:{uptimeSeconds:100},wan:{status:'Connected',downstreamMbps:100,totalBytesReceived:1000000,totalBytesSent:500000},hosts:[],mesh:{nodes:[]}};
  m.applyFritz(data);
  assert.equal(m.state.fritzbox.wan.downloadMbps,null);
  assert.equal(m.state.fritzbox.wan.downstreamMbps,100);
  m.fritzPrevious.time-=1000;
  m.applyFritz({...data,wan:{...data.wan,totalBytesReceived:2000000,totalBytesSent:1000000}});
  assert.ok(m.state.fritzbox.wan.downloadMbps>0);
  assert.ok(m.history.snapshot(1).records.every(r=>r.sessionId));
  m.fritzPrevious.time-=91000;m.applyFritz(data);
  assert.equal(m.state.fritzbox.wan.downloadMbps,null);
  m.fritzPrevious.time-=1000;m.applyFritz({...data,wan:{...data.wan,totalBytesReceived:1,totalBytesSent:1}});
  assert.equal(m.state.fritzbox.wan.downloadMbps,null);
  m.applyFritz({...data,wan:{...data.wan,totalBytesReceived:null}});
  assert.equal(m.fritzPrevious,null);
  m.disconnectFritz(false);
  assert.equal(m.state.fritzbox.connected,false);
  assert.equal(m.fritzPrevious,null);
  assert.ok(m.history.snapshot(1).records.length>=5);
  await m.close();
});

test('disconnect discards an in-flight FRITZ poll without repopulating the state',async()=>{
  const m=new Monitor(fake);let finish;
  m.fritzClient={connected:true,poll:()=>new Promise(resolve=>{finish=resolve;}),disconnect(){this.connected=false;}};
  const pending=m.refreshFritz();m.disconnectFritz(false);
  finish({host:'old.box',wan:{},hosts:[],mesh:{nodes:[]}});await pending;
  assert.equal(m.state.fritzbox.connected,false);assert.equal(m.state.fritzbox.host,null);
  assert.equal(m.history.snapshot(1).records.length,0);await m.close();
});

test('custom targets deduplicate and standard targets cannot be removed',async()=>{
  const m=new Monitor(fake);await m.refresh();
  const first=m.addTarget('192.168.1.4','Repeater');
  assert.equal(m.addTarget('192.168.1.4','Duplikat'),first);
  assert.equal(m.state.targets.length,4);
  assert.throws(()=>m.removeTarget(m.state.targets[0].id));
  m.removeTarget(first.id);assert.equal(m.state.targets.length,3);
  await m.close();
});

test('late ping response after adapter change cannot enter a new measurement window',async()=>{
  let resolvePing;
  const m=new Monitor({...fake,pingMany:hosts=>new Promise(resolve=>{resolvePing=()=>resolve(hosts.map(host=>({host,ok:true,ms:999,status:'Success'})));})});
  await m.refresh();m.lastCounters=Date.now();m.lastDns=Date.now();m.lastRefresh=Date.now();
  const tick=m.tick();m.selectInterface('2');resolvePing();await tick;
  assert.ok(m.state.targets.every(t=>t.samples.length===0));
  assert.equal(m.state.targets.find(t=>t.kind==='gateway').host,'192.168.2.1');
  await m.close();
});

test('cached neighbors do not imply a live device; failed rescan clears old Ping status',async()=>{
  const m=new Monitor({...fake,pingMany:async hosts=>hosts.map(host=>({host,ok:false,ms:null,status:'TimedOut'}))});
  await m.refresh();
  m.mergeNeighbors([{ip:'192.168.1.1',mac:'12-34-56-78-90-AB',state:'Stale',interfaceId:'1'}]);
  assert.equal(m.state.devices[0].respondsToPing,null);
  m.state.devices[0].respondsToPing=true;
  m.startScan('1');await Promise.all([...m.pending]);
  assert.equal(m.state.devices[0].respondsToPing,false);assert.equal(m.state.scan.running,false);assert.equal(m.state.scan.done,1);
  await m.close();
});

test('scan and target counts are bounded and local-only',async()=>{
  const m=new Monitor(fake);await m.refresh();
  for(let i=1;i<=21;i++)m.addTarget(`10.0.0.${i}`,'Gerät');
  assert.throws(()=>m.addTarget('10.0.0.100','Zu viel'));
  assert.throws(()=>m.startScan('unknown'));
  m.state.network.interfaces.push({id:'public',ipv4:[{address:'8.8.8.9',prefixLength:24}]});
  assert.throws(()=>m.startScan('public'));
  await m.close();
});

test('scan measurement errors remain unknown, never negative Ping results',async()=>{
  const m=new Monitor({...fake,pingMany:async hosts=>hosts.map(host=>({host,ok:false,ms:null,status:'measurement_error',error:'Access denied'}))});
  await m.refresh();m.mergeNeighbors([{ip:'192.168.1.1',mac:'12-34-56-78-90-AB',state:'Stale',interfaceId:'1'}]);
  m.state.devices[0].respondsToPing=true;m.startScan('1');await Promise.all([...m.pending]);
  assert.equal(m.state.devices[0].respondsToPing,null);assert.match(m.state.scan.error,/Messfehler/);
  await m.close();
});

test('same adapter joining another subnet rejects old delayed pings and clears histories',async()=>{
  let resolvePing;let discovered=structuredClone(network);
  const m=new Monitor({...fake,discoverNetwork:async()=>structuredClone(discovered),pingMany:hosts=>new Promise(resolve=>{resolvePing=()=>resolve(hosts.map(host=>({host,ok:true,ms:999,status:'Success'})));})});
  await m.refresh();m.lastCounters=Date.now();m.lastDns=Date.now();m.lastRefresh=Date.now();
  m.lookupDns=async()=>({address:'1.1.1.1'});
  const tick=m.tick();
  discovered.interfaces[0].gateway='192.168.3.1';discovered.interfaces[0].ipv4=[{address:'192.168.3.2',prefixLength:24}];
  await m.refresh();resolvePing();await tick;
  assert.ok(m.state.targets.every(t=>t.samples.length===0));assert.equal(m.state.targets[0].host,'192.168.3.1');
  await m.close();
});

test('old DNS response does not overwrite state after switching adapter',async()=>{
  let rejectDns;let started;
  const began=new Promise(resolve=>{started=resolve;});
  const m=new Monitor(fake);await m.refresh();m.lastCounters=Date.now();
  m.lookupDns=()=>new Promise((resolve,reject)=>{rejectDns=reject;started();});
  const tick=m.tick();await began;m.selectInterface('2');rejectDns(new Error('Old adapter DNS failed'));await tick;
  assert.equal(m.state.dns,null);assert.equal(m.lastDns,0);
  await m.close();
});

test('concurrent refreshes share the same discovery and do not fail the scan',async()=>{
  let count=0;let finish;
  const m=new Monitor({...fake,discoverNetwork:async()=>{count++;if(count===1)return structuredClone(network);return new Promise(resolve=>{finish=()=>resolve(structuredClone(network));});},pingMany:async hosts=>hosts.map(host=>({host,ok:false,ms:null,status:'TimedOut'}))});
  await m.refresh();const refresh=m.refresh();m.startScan('1');
  await Promise.resolve();finish();await refresh;await Promise.all([...m.pending]);
  assert.equal(m.state.scan.error,null);assert.equal(count,2);
  await m.close();
});

test('corrupt settings use defaults and preserve a warning, without breaking startup',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'network-settings-test-'));
  const m=new Monitor(fake,{dataDir});
  try {
    await writeFile(path.join(dataDir,'settings.json'),'null');await m.start();
    assert.equal(m.state.targets.length,3);
    assert.ok(m.state.events.some(e=>e.title.includes('Einstellungen')));
  }finally{await m.close();if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('network-settings-test-'))throw new Error('Unsicherer Testpfad');await rm(dataDir,{recursive:true,force:true});}
});

test('slow adapter readings never block parallel gaming Ping rounds',async()=>{
  let finishCounters;
  const m=new Monitor({...fake,getTrafficCounters:()=>new Promise(resolve=>{finishCounters=()=>resolve([]);})});
  await m.refresh();m.lastDns=Date.now();
  await m.tick({background:true});
  assert.equal(m.state.targets[0].stats.sent,1);assert.ok(m.maintenancePromise);
  await m.tick({background:true});assert.equal(m.state.targets[0].stats.sent,2);
  finishCounters();await m.maintenancePromise;await m.close();
});

test('optional repeater and lag markers preserve contemporaneous measurements in history',async()=>{
  const m=new Monitor(fake);await m.refresh();m.lastCounters=Date.now();m.lastDns=Date.now();
  const repeater=m.setRepeater('192.168.1.3','Mesh-Repeater');
  assert.equal(repeater.kind,'repeater');assert.throws(()=>m.setRepeater('192.168.1.1'));
  await m.tick();const event=m.markLag('Spiel stockt');
  assert.equal(event.title,'Spiellag markiert');assert.equal(event.measurements.find(t=>t.kind==='repeater').received,1);
  assert.ok(m.history.snapshot(1).records.some(r=>r.title==='Spiellag markiert'));
  m.removeTarget(repeater.id);assert.equal(m.state.repeaterHost,null);
  await m.close();
});

test('reset clears live measurements and restarts monitoring while retaining configuration and raw history',async()=>{
  const m=new Monitor(fake);await m.refresh();m.selectInterface('2');const repeater=m.setRepeater('192.168.2.3','Mein Repeater');m.selectRepeater(repeater.host);const custom=m.addTarget('example.com','Spielserver');m.toggleTarget(custom.id,false);
  m.maintenance=async()=>{};await m.tick();m.markLag('Alte Markierung');m.state.monitoring=false;
  m.state.traffic={interfaceId:'2',downloadMbps:50,uploadMbps:4,at:new Date().toISOString(),history:[{downloadMbps:50}]};m.previousCounter={id:'2',receivedBytes:100,sentBytes:50,time:Date.now()};
  m.state.scan={running:false,done:42,total:42,message:'Alt',error:'Alt',limited:true};m.state.speedTest={running:false,phase:'done',downloadMbps:100,uploadMbps:40,at:new Date().toISOString()};m.state.devices=[{ip:'192.168.2.8',respondsToPing:true}];m.state.dns={ok:false,error:'Alt'};m.state.lastError='Alt';
  m.state.network.wifi={connected:true,ssid:'Alt',signalPercent:90,networks:[{}]};const targetIds=m.state.targets.map(t=>t.id);const count=m.history.snapshot(1).total;
  const result=await m.reset();assert.equal(result.ok,true);assert.equal(result.measurementStartedAt,m.state.measurementStartedAt);assert.equal(m.state.monitoring,true);assert.equal(m.state.selectedInterfaceId,'2');assert.equal(m.state.repeaterHost,repeater.host);assert.deepEqual(m.state.targets.map(t=>t.id),targetIds);assert.equal(custom.enabled,false);
  assert.ok(m.state.targets.every(t=>t.samples.length===0&&t.stats.status==='pending'&&!t.lastError&&!t.spiking));assert.equal(m.state.traffic.downloadMbps,null);assert.deepEqual(m.state.traffic.history,[]);assert.equal(m.previousCounter,null);assert.equal(m.state.dns,null);assert.deepEqual(m.state.devices,[]);assert.equal(m.state.scan.done,0);assert.equal(m.state.speedTest.phase,'idle');assert.equal(m.state.speedTest.downloadMbps,null);assert.equal(m.state.lastError,null);assert.equal(m.state.network.wifi.signalPercent,null);
  assert.deepEqual(m.state.events.map(event=>event.title),['Messung zurückgesetzt']);assert.ok(m.history.snapshot(1).total>count);assert.ok(m.history.snapshot(1).records.some(record=>record.title==='Spiellag markiert'));assert.ok(!m.historySnapshot(1).records.some(record=>record.title==='Spiellag markiert'));
  // An untagged old record at precisely the reset millisecond must stay excluded.
  m.history.record({type:'event',at:result.measurementStartedAt,title:'Old same-millisecond event'});assert.ok(!m.historySnapshot(1).records.some(record=>record.title==='Old same-millisecond event'));await m.close();
});

test('reset refuses active scans, speedtests and FRITZ login without changing state',async()=>{
  const m=new Monitor(fake);for(const key of ['scan','speedTest','fritzbox']){
    const property=key==='fritzbox'?'connecting':'running';m.state[key][property]=true;
    await assert.rejects(m.reset(),{code:'MONITOR_BUSY'});assert.equal(m.state.measurementStartedAt,null);assert.equal(m.measureEpoch,0);m.state[key][property]=false;
  }
  m.fritzConnecting=true;await assert.rejects(m.reset(),{code:'MONITOR_BUSY'});m.fritzConnecting=false;m.starting=true;await assert.rejects(m.reset(),{code:'MONITOR_BUSY'});m.starting=false;await m.close();
});

test('speedtest validates before mutation, refuses parallel stress work, and records selected sizes on success or failure',async()=>{
  const requested={downloadBytes:100_000_000,uploadBytes:20_000_000};
  let runnerOptions;
  const success=new Monitor(fake,{speedTestRunner:async(update,options)=>{runnerOptions=options;update({phase:'download',progress:100});return {...requested,downloadMbps:123,uploadMbps:45};}});
  success.measureInternetPing=async()=>({ms:12,target:'Internet (1.1.1.1)'});
  const original=success.state.speedTest,eventCount=success.state.events.length;
  assert.throws(()=>success.startSpeedTest({downloadBytes:101_000_000}),/angebotene Download/);
  assert.equal(success.state.speedTest,original);assert.equal(success.state.events.length,eventCount);
  success.state.stressTest={running:true};
  assert.throws(()=>success.startSpeedTest(requested),{code:'MONITOR_BUSY'});
  assert.equal(success.state.speedTest,original);
  success.state.stressTest.running=false;
  success.startSpeedTest(requested);assert.equal(success.state.speedTest.downloadBytes,requested.downloadBytes);assert.equal(success.state.speedTest.uploadBytes,requested.uploadBytes);
  await Promise.all([...success.pending]);
  assert.deepEqual({downloadBytes:runnerOptions.downloadBytes,uploadBytes:runnerOptions.uploadBytes},requested);
  const successRecord=success.history.snapshot(1).records.find(record=>record.type==='speedtest'&&!record.error);
  assert.deepEqual({downloadBytes:successRecord.downloadBytes,uploadBytes:successRecord.uploadBytes},requested);
  await success.close();

  const failure=new Monitor(fake,{speedTestRunner:async()=>{throw new Error('Fake stream failed');}});
  failure.measureInternetPing=async()=>({ms:12,target:'Internet (1.1.1.1)'});
  failure.startSpeedTest(requested);await Promise.all([...failure.pending]);
  const failureRecord=failure.history.snapshot(1).records.find(record=>record.type==='speedtest'&&record.error);
  assert.deepEqual({downloadBytes:failureRecord.downloadBytes,uploadBytes:failureRecord.uploadBytes},requested);
  await failure.close();
});

test('reset discards delayed ping successes and failures without reintroducing old errors or samples',async()=>{
  for(const failure of [false,true]){
    const gate=deferred();let hosts;const m=new Monitor({...fake,pingMany:values=>{hosts=values;return gate.promise;}});await m.refresh();m.maintenance=async()=>{};
    const tick=m.tick();await m.reset();if(failure)gate.reject(new Error('Old Ping failure'));else gate.resolve(hosts.map(host=>({host,ok:true,ms:999,status:'Success'})));await tick;
    assert.ok(m.state.targets.every(target=>target.samples.length===0));assert.equal(m.state.lastError,null);assert.deepEqual(m.state.events.map(event=>event.title),['Messung zurückgesetzt']);assert.ok(!m.historySnapshot(1).records.some(record=>record.type==='ping'));await m.close();
  }
});

test('reset rejects delayed counter successes and failures before creating a new baseline',async()=>{
  for(const failure of [false,true]){
    const gate=deferred();const m=new Monitor({...fake,getTrafficCounters:()=>gate.promise});await m.refresh();m.lastDns=Date.now();m.previousCounter={id:'1',receivedBytes:1,sentBytes:1,time:Date.now()-1000};
    const pending=m.maintenance();await m.reset();if(failure)gate.reject(new Error('Old counters failure'));else gate.resolve([{id:'1',receivedBytes:999999,sentBytes:999999}]);await pending;
    assert.equal(m.previousCounter,null);assert.equal(m.state.traffic.at,null);assert.equal(m.state.traffic.downloadMbps,null);assert.equal(m.state.lastError,null);assert.ok(!m.historySnapshot(1).records.some(record=>record.type==='traffic'));
    m.probes={...fake,getTrafficCounters:async()=>[{id:'1',receivedBytes:100,sentBytes:50}]};m.lastDns=Date.now();m.lastRefresh=Date.now();await m.maintenance();assert.equal(m.previousCounter.receivedBytes,100);assert.equal(m.state.traffic.downloadMbps,null);await m.close();
  }
});

test('reset ignores late DNS success and failure from the prior measurement period',async()=>{
  for(const failure of [false,true]){
    const gate=deferred();const m=new Monitor(fake);await m.refresh();m.lastCounters=Date.now();m.lookupDns=()=>gate.promise;
    const pending=m.maintenance();await m.reset();if(failure)gate.reject(new Error('Old DNS failure'));else gate.resolve({address:'1.1.1.1'});await pending;
    assert.equal(m.state.dns,null);assert.equal(m.lastDns,0);assert.ok(!m.historySnapshot(1).records.some(record=>record.type==='dns'));await m.close();
  }
});

test('reset rejects old discovery and WLAN results and errors then allows a fresh refresh',async()=>{
  for(const failure of [false,true]){
    const gate=deferred();const m=new Monitor(fake);await m.refresh();m.probes={...fake,discoverNetwork:()=>gate.promise};const pending=m.refresh();await m.reset();
    const old=structuredClone(network);old.interfaces[0].gateway='192.168.99.1';old.wifi={connected:true,signalPercent:99,ssid:'Old WLAN'};
    if(failure)gate.reject(new Error('Old network error'));else gate.resolve(old);await pending;
    assert.equal(m.state.network.interfaces[0].gateway,'192.168.1.1');assert.equal(m.state.network.wifi.signalPercent,null);assert.equal(m.state.lastError,null);assert.deepEqual(m.state.events.map(event=>event.title),['Messung zurückgesetzt']);assert.ok(!m.historySnapshot(1).records.some(record=>record.type==='network'||record.type==='wifi'));
    m.probes=fake;await m.refresh();assert.equal(m.state.network.wifi.connected,false);assert.ok(m.historySnapshot(1).records.some(record=>record.type==='network'));await m.close();
  }
});

test('reset retains the authenticated FRITZ client, discards its old poll and starts a fresh counter baseline',async()=>{
  const gate=deferred();let polls=0,disconnects=0;
  const data={host:'fritz.box',device:{model:'6690',firmware:'8.20',uptimeSeconds:100},wan:{status:'Connected',totalBytesReceived:100,totalBytesSent:50,downstreamMbps:100},hosts:[],mesh:{nodes:[]}};
  const m=new Monitor(fake);m.fritzClient={connected:true,poll:()=>++polls===1?gate.promise:Promise.resolve({...data,wan:{...data.wan,totalBytesReceived:200,totalBytesSent:100}}),disconnect(){disconnects++;this.connected=false;}};m.applyFritz(data);const client=m.fritzClient;const oldSession=m.state.fritzbox.history[0].sessionId;
  const pending=m.refreshFritz();await m.reset();assert.equal(m.fritzClient,client);assert.equal(disconnects,0);assert.equal(m.state.fritzbox.connected,true);assert.equal(m.state.fritzbox.busy,true);assert.equal(m.state.fritzbox.wan.totalBytesReceived,null);assert.equal(m.state.fritzbox.wan.status,null);assert.deepEqual(m.state.fritzbox.history,[]);assert.equal(m.fritzPrevious,null);
  gate.resolve({...data,wan:{...data.wan,totalBytesReceived:99999999}});await pending;assert.equal(m.state.fritzbox.busy,false);assert.equal(m.state.fritzbox.wan.totalBytesReceived,null);assert.deepEqual(m.state.fritzbox.history,[]);assert.equal(m.lastFritz,0);assert.ok(!m.historySnapshot(1).records.some(record=>record.type==='fritzbox'));
  await m.refreshFritz();assert.equal(m.state.fritzbox.history.length,1);assert.equal(m.state.fritzbox.wan.totalBytesReceived,200);assert.equal(m.state.fritzbox.wan.downloadMbps,null);assert.notEqual(m.state.fritzbox.history[0].sessionId,oldSession);await m.close();
});

test('measurement cutoff persists through settings saves and restart while old raw logs survive',async()=>{
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'network-settings-test-'));let first,second;
  try{
    first=new Monitor(fake,{dataDir});first.schedule=()=>{};await first.start();first.selectInterface('2');first.setRepeater('192.168.2.3','Repeater');first.selectRepeater('192.168.2.3');first.log({type:'event',at:new Date(Date.now()-1000).toISOString(),title:'Before reset'});
    const reset=await first.reset();first.addTarget('example.com','Server');first.log({type:'ping',at:reset.measurementStartedAt,results:[{host:'example.com',ok:true,ms:4}]});await first.close();
    const saved=JSON.parse(await readFile(path.join(dataDir,'settings.json'),'utf8'));assert.equal(saved.measurementStartedAt,reset.measurementStartedAt);
    const raw=await readFile(path.join(dataDir,`messungen-${reset.measurementStartedAt.slice(0,10)}.jsonl`),'utf8');assert.ok(raw.includes('Before reset'));
    second=new Monitor(fake,{dataDir});second.schedule=()=>{};await second.start();assert.equal(second.state.measurementStartedAt,reset.measurementStartedAt);assert.equal(second.state.selectedInterfaceId,'2');assert.equal(second.state.repeaterHost,'192.168.2.3');assert.ok(second.state.targets.some(target=>target.host==='example.com'));
    assert.ok(second.history.snapshot(168).records.some(record=>record.title==='Before reset'));assert.ok(!second.historySnapshot(168).records.some(record=>record.title==='Before reset'));assert.ok(second.historySnapshot(168).records.some(record=>record.type==='ping'));assert.equal(second.historySnapshot(168).from,reset.measurementStartedAt);
  }finally{await first?.close();await second?.close();if(path.dirname(path.resolve(dataDir))!==path.resolve(os.tmpdir())||!path.basename(dataDir).startsWith('network-settings-test-'))throw new Error('Unsicherer Testpfad');await rm(dataDir,{recursive:true,force:true});}
});
