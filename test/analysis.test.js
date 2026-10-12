import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, PING_WARNING_MS, summarize, subnetHosts, trafficRate, validateHost } from '../lib/analysis.js';

test('PC diagnosis uses only the selected repeater, and has no implicit fallback',()=>{
  const target=(host,kind,status)=>({host,label:host,kind,enabled:true,stats:{sent:10,status}});
  const first=target('192.168.1.3','repeater','ok'),second=target('192.168.1.4','repeater','down');
  const state={monitoring:true,repeaterHost:second.host,targets:[target('192.168.1.1','gateway','down'),first,second],network:{wifi:{}},speedTest:{running:false}};
  const has=title=>diagnose(state).some(d=>d.title===title);
  assert.equal(has('Schon Repeater und Router gleichzeitig auffällig'),true);assert.equal(has('Repeater antwortet, Weg zur FRITZ!Box auffällig'),false);
  state.repeaterHost=first.host;assert.equal(has('Repeater antwortet, Weg zur FRITZ!Box auffällig'),true);
  first.enabled=false;assert.equal(has('PC-Repeater noch nicht auswertbar'),true);assert.equal(has('Schon Repeater und Router gleichzeitig auffällig'),false);
  state.targets=state.targets.filter(t=>t!==first);assert.equal(has('PC-Repeater noch nicht auswertbar'),true);
  state.repeaterHost=null;assert.equal(has('Repeater am PC nicht zugeordnet'),true);assert.equal(has('Schon Repeater und Router gleichzeitig auffällig'),false);
  state.repeaterHost=second.host;second.stats.sent=2;assert.equal(has('PC-Repeater noch nicht auswertbar'),true);
});

test('subnets exclude network, broadcast and own address, limit large networks',()=>{
  const subnet=subnetHosts('192.168.178.12',24);
  assert.equal(subnet.hosts.length,253);
  assert.ok(subnet.hosts.includes('192.168.178.1'));
  for(const ip of ['192.168.178.0','192.168.178.255','192.168.178.12'])assert.ok(!subnet.hosts.includes(ip));
  const large=subnetHosts('10.20.30.42',8);
  assert.equal(large.limited,true);assert.equal(large.cidr,'10.20.30.0/24');
  assert.equal(subnetHosts('172.31.3.1',22).hosts.length,1021);
  assert.deepEqual(subnetHosts('192.168.1.1',32).hosts,[]);
  assert.deepEqual(subnetHosts('192.168.1.1',31).hosts,['192.168.1.0']);
  assert.throws(()=>subnetHosts('8.8.8.8',24));
  assert.throws(()=>subnetHosts('192.168.1.1',0));
});

test('host validation rejects commands, URLs and malformed addresses',()=>{
  assert.equal(validateHost(' FRITZ.BOX '),'fritz.box');
  assert.equal(validateHost('192.168.178.1'),'192.168.178.1');
  for(const bad of ['https://fritz.box','127.0.0.1 & echo pwn','-t','1.2.3.999','example.com:80','::1','a..b','a'.repeat(64),null])assert.throws(()=>validateHost(bad));
});

test('loss, jitter and recovery use measured values without treating failures as zero latency',()=>{
  const samples=[{ok:true,ms:10,status:'Success'},{ok:true,ms:20,status:'Success'},{ok:false,ms:null,status:'TimedOut'},{ok:true,ms:40,status:'Success'}];
  const s=summarize(samples,'internet');
  assert.equal(s.sent,4);assert.equal(s.received,3);assert.equal(s.lossPercent,25);assert.equal(s.avgMs,70/3);assert.equal(s.jitterMs,10);assert.equal(s.lastMs,40);
  const down=summarize([...samples,...Array(3).fill({ok:false,ms:null,status:'TimedOut'})]);
  assert.equal(down.status,'down');assert.equal(down.lastMs,null);
  assert.equal(summarize([{ok:true,ms:0,status:'Success'}]).minMs,0);
});

test('local measurement failures are not network loss and missing values are null',()=>{
  const s=summarize([{ok:false,ms:null,status:'measurement_error'}]);
  assert.equal(s.sent,0);assert.equal(s.lossPercent,null);assert.equal(s.status,'pending');
  assert.equal(summarize([]).avgMs,null);
});

test('critical latency has separate local and internet thresholds',()=>{
  const samples=ms=>Array.from({length:30},()=>({ok:true,ms,status:'Success'}));
  for(const kind of ['gateway','device','repeater']) {
    assert.equal(summarize(samples(30),kind).status,'ok');
    assert.equal(summarize(samples(31),kind).status,'warning');
    assert.equal(summarize(samples(99),kind).status,'warning');
    assert.equal(summarize(samples(100),kind).status,'critical');
  }
  for(const kind of ['internet','custom']) {
    assert.equal(summarize(samples(PING_WARNING_MS),kind).status,'ok');
    assert.equal(summarize(samples(PING_WARNING_MS+1),kind).status,'warning');
    assert.equal(summarize(samples(299),kind).status,'warning');
    assert.equal(summarize(samples(300),kind).status,'critical');
  }
});

test('up to 30 ms is normal for every target, while packet loss still warns',()=>{
  const samples=ms=>Array.from({length:30},()=>({ok:true,ms,status:'Success'}));
  assert.equal(PING_WARNING_MS,30);
  for(const kind of ['gateway','device','repeater','internet','custom']) {
    assert.equal(summarize(samples(30),kind).status,'ok');
    assert.equal(summarize(samples(31),kind).status,'warning');
  }
  const withLoss=samples(20);withLoss[0]={ok:false,ms:null,status:'TimedOut'};
  assert.equal(summarize(withLoss,'internet').recentAvgMs,20);
  assert.equal(summarize(withLoss,'internet').status,'warning');
});

test('critical loss uses the recent window, recovers and preserves down and measurement errors',()=>{
  const ok={ok:true,ms:10,status:'Success'},lost={ok:false,ms:null,status:'TimedOut'};
  const samples=Array.from({length:30},(_,i)=>[2,12].includes(i)?lost:ok);
  assert.equal(summarize(samples).status,'warning');
  samples[22]=lost;
  assert.equal(summarize(samples).recentLossPercent,10);
  assert.equal(summarize(samples).status,'critical');
  assert.notEqual(summarize([lost,ok,ok,ok]).status,'critical');
  assert.equal(summarize([lost,ok,ok,ok,ok]).status,'critical');
  assert.equal(summarize([...samples,lost,lost,lost]).status,'down');
  const error={ok:false,ms:null,status:'measurement_error'};
  assert.equal(summarize([...samples,error]).status,'pending');
  const withErrors=summarize([...samples.slice(0,29),...Array(10).fill(error),ok]);
  assert.equal(withErrors.status,'critical');assert.equal(withErrors.recentLossPercent,10);
  assert.equal(summarize([...samples,...Array(30).fill(ok)]).status,'ok');
  assert.equal(summarize([...Array(30).fill({ok:true,ms:400}),...Array(30).fill(ok)]).status,'ok');
});

test('critical targets remain affected in router, repeater and internet diagnosis',()=>{
  const target=(host,kind,status)=>({host,kind,enabled:true,stats:{sent:30,status}});
  const router=target('192.168.1.1','gateway','ok'),repeater=target('192.168.1.2','repeater','critical');
  const internet=target('1.1.1.1','internet','critical'),other=target('9.9.9.9','internet','ok');
  const state={monitoring:true,repeaterHost:repeater.host,targets:[router,repeater,internet,other],network:{wifi:{}},speedTest:{running:false}};
  const has=title=>diagnose(state).some(item=>item.title===title);
  assert.equal(has('Einzelnes Internetziel auffällig'),true);
  other.stats.status='critical';
  assert.equal(has('Internetweg auffällig, Router erreichbar'),true);
  assert.equal(has('Einzelnes Internetziel auffällig'),false);
  router.stats.status='critical';
  assert.equal(has('Weg zum Router auffällig'),true);
  assert.equal(has('Schon Repeater und Router gleichzeitig auffällig'),true);
});

test('low-latency warnings name packet loss without implying an elevated ping',()=>{
  const router={host:'192.168.1.1',label:'Router',kind:'gateway',enabled:true,stats:{sent:30,status:'warning',recentAvgMs:24,recentLossPercent:3.3}};
  const repeater={host:'192.168.1.2',label:'Repeater',kind:'repeater',enabled:true,stats:{sent:30,status:'ok',recentAvgMs:4,recentLossPercent:0}};
  const state={monitoring:true,repeaterHost:repeater.host,targets:[router,repeater],network:{wifi:{}},speedTest:{running:false}};
  const card=diagnose(state).find(item=>item.title==='Weg zum Router auffällig');
  assert.ok(card.detail.startsWith('Router: Antworten fehlen (Ø 24 ms, 3,3 % Verlust).'));
  assert.ok(!card.detail.includes('Ping erhöht'));
  assert.ok(!card.detail.includes('unregelmäßig'));
});

test('combined repeater and router diagnosis labels localized measurements per device',()=>{
  const target=(host,label,kind,stats)=>({host,label,kind,enabled:true,stats});
  const repeater=target('192.168.1.2','Repeater','repeater',{sent:30,status:'warning',recentAvgMs:42,recentLossPercent:0});
  const router=target('192.168.1.1','Router / Gateway','gateway',{sent:30,status:'warning',recentAvgMs:38,recentLossPercent:0});
  const state={monitoring:true,repeaterHost:repeater.host,targets:[router,repeater],network:{wifi:{}},speedTest:{running:false}};
  const card=diagnose(state).find(item=>item.title==='Schon Repeater und Router gleichzeitig auffällig');
  assert.ok(card.detail.startsWith('Repeater: Ping erhöht (Ø 42 ms, 0 % Verlust). Router: Ping erhöht (Ø 38 ms, 0 % Verlust).'));
  assert.ok(!card.detail.includes('bis einschließlich 30 ms'));
});

test('traffic counter reset and interface baseline do not create false peaks',()=>{
  assert.equal(trafficRate(null,{receivedBytes:50,sentBytes:10},1000),null);
  assert.equal(trafficRate({receivedBytes:100,sentBytes:100},{receivedBytes:50,sentBytes:200},1000),null);
  assert.deepEqual(trafficRate({receivedBytes:100,sentBytes:100},{receivedBytes:1_000_100,sentBytes:500_100},1000),{downloadMbps:8,uploadMbps:4});
});

test('Internet diagnosis requires both external targets, and warns about ICMP interpretation',()=>{
  const t=(kind,status)=>({enabled:true,kind,stats:{sent:10,status}});
  const state={monitoring:true,targets:[t('gateway','ok'),t('internet','down'),t('internet','ok')],network:{wifi:{}},speedTest:{running:false}};
  assert.ok(diagnose(state).some(d=>d.title==='Einzelnes Internetziel auffällig'));
  assert.ok(!diagnose(state).some(d=>d.title.includes('Internetweg')));
  state.targets[2].stats.status='down';
  assert.ok(diagnose(state).some(d=>d.title.includes('Internetweg')));
  state.targets[0].stats.status='down';
  assert.ok(diagnose(state).some(d=>d.title.includes('Router auffällig')));
  state.targets[0].stats.status='ok';state.targets[2].stats.status='pending';
  assert.ok(!diagnose(state).some(d=>d.title==='Einzelnes Internetziel auffällig'));
});
test('jitter does not bridge a local measurement error',()=>{
  const summary=summarize([{ok:true,ms:2},{ok:false,ms:null,status:'measurement_error'},{ok:true,ms:80}]);
  assert.equal(summary.jitterMs,null);assert.equal(summary.lossPercent,0);
});
