import test from 'node:test';
import assert from 'node:assert/strict';
import { trafficSources } from '../public/traffic-history.js';
import { sessionLabel } from '../public/storage.js';
test('traffic keeps PC, WAN and device scopes separate and sums only measured differences',()=>{
  const device={id:'mac:A',name:'PC',available:true,rateAvailable:true,totalBytesReceived:9e12,downloadMbps:8,uploadMbps:1,downloadDeltaBytes:1000000,uploadDeltaBytes:125000,intervalStartedAt:'2026-10-11T10:00:00Z'};
  const sources=trafficSources([{type:'traffic',at:'2026-10-11T10:00:00Z',interfaceId:'LAN',downloadMbps:3,uploadMbps:2,appSessionId:'one'},{type:'fritzbox',at:'2026-10-11T10:00:01Z',wan:{downloadMbps:40,uploadMbps:10},deviceTraffic:[device]}],{connected:true});
  assert.equal(sources.length,3);assert.equal(sources[0].latest.downloadMbps,3);assert.equal(sources[1].latest.downloadMbps,40);
  assert.equal(sources[2].downloadBytes,1000000);assert.equal(sources[2].uploadBytes,125000);assert.equal(sources[0].downloadBytes,null);
});
test('missing counters remain visible and unknown; app restarts split chart epochs',()=>{
  const sources=trafficSources([{type:'traffic',at:'2026-10-11T10:00:00Z',interfaceId:'LAN',downloadMbps:3,appSessionId:'one'},{type:'traffic',at:'2026-10-11T10:00:02Z',interfaceId:'LAN',downloadMbps:4,appSessionId:'two'}],{deviceTraffic:[{id:'mac:A',name:'Tablet',available:false,reason:'Keine Bytezähler'}]});
  assert.notEqual(sources[0].points[0].epoch,sources[0].points[1].epoch);assert.equal(sources[2].measured,0);assert.equal(sources[2].downloadBytes,null);assert.equal(sources[2].reason,'Keine Bytezähler');
  assert.match(sessionLabel({status:'interrupted',reason:'unexpected_interruption'}),/Ursache unbekannt/);assert.match(sessionLabel({reason:'windows_shutdown'}),/Windows/);
});

test('known hosts and mesh-only devices stay selectable without measured traffic',()=>{
  const sources=trafficSources([],{
    connected:true,
    hosts:[{name:'Laptop',ip:'192.168.178.22',mac:'AA:BB:CC:DD:EE:01',active:false}],
    mesh:{nodes:[{id:'node-2',name:'Repeater',ip:'192.168.178.2',mac:'AA:BB:CC:DD:EE:02',role:'SLAVE'}]},
  });
  const devices=sources.filter(source=>source.kind==='device');
  assert.equal(devices.length,2);
  const laptop=devices.find(source=>source.id==='device:mac:AA:BB:CC:DD:EE:01');
  const repeater=devices.find(source=>source.id==='device:mac:AA:BB:CC:DD:EE:02');
  assert.equal(laptop.label,'Laptop');assert.equal(laptop.active,false);assert.equal(laptop.available,false);assert.equal(laptop.measured,0);
  assert.equal(repeater.label,'Repeater');assert.equal(repeater.latest,null);
});

test('duplicate MAC casing merges, same names with different MACs do not, and latest name wins',()=>{
  const sources=trafficSources([
    {type:'fritzbox',at:'2026-10-11T10:00:00Z',deviceTraffic:[{id:'mac:AA:BB:CC:DD:EE:03',mac:'AA:BB:CC:DD:EE:03',name:'Altes Tablet',downloadMbps:1,rateAvailable:true}]},
  ],{connected:true,deviceTraffic:[
    {id:'mac:aa:bb:cc:dd:ee:03',mac:'aa:bb:cc:dd:ee:03',name:'Neues Tablet',ip:'192.168.178.3',available:true},
    {id:'mac:AA:BB:CC:DD:EE:04',mac:'AA:BB:CC:DD:EE:04',name:'Neues Tablet',ip:'192.168.178.4'},
  ]});
  const devices=sources.filter(source=>source.kind==='device');
  assert.equal(devices.length,2);assert.equal(devices[0].label,'Neues Tablet');assert.equal(devices[0].ip,'192.168.178.3');
  assert.equal(devices[0].measured,1);assert.notEqual(devices[0].id,devices[1].id);
});

test('mesh MASTER is represented only by FRITZ!Box total and current device metadata refreshes',()=>{
  const sources=trafficSources([],{
    connected:true,
    mesh:{nodes:[{id:'master-1',name:'Router',mac:'AA:BB:CC:DD:EE:05',role:'MASTER'},{id:'mesh-1',name:'Knoten',mac:'AA:BB:CC:DD:EE:06',role:'SLAVE'}]},
    deviceTraffic:[{id:'mac:AA:BB:CC:DD:EE:05',name:'Router Verkehr',available:true}],
  });
  const devices=sources.filter(source=>source.kind==='device');
  assert.equal(devices.length,1);assert.equal(devices[0].label,'Knoten');assert.equal(devices[0].id,'device:mac:AA:BB:CC:DD:EE:06');
  assert.equal(sources.find(source=>source.id==='wan').id,'wan');
});

test('device source ids remain stable across polling so a chosen source stays chosen',()=>{
  const first=trafficSources([],{hosts:[{id:'stable-host',name:'Vorher',mac:'AA:BB:CC:DD:EE:07'}]}).find(source=>source.kind==='device');
  const next=trafficSources([],{hosts:[{id:'stable-host',name:'Nachher',mac:'aa:bb:cc:dd:ee:07'}]}).find(source=>source.kind==='device');
  assert.equal(next.id,first.id);assert.equal(next.label,'Nachher');
});

test('unknown active state stays unknown and a newly valid counter clears an older reason',()=>{
  const sources=trafficSources([
    {type:'fritzbox',at:'2026-10-11T10:00:00Z',deviceTraffic:[{id:'mac:AA:BB:CC:DD:EE:08',name:'NAS',active:null,available:false,reason:'Zähler fehlt'}]},
    {type:'fritzbox',at:'2026-10-11T10:00:02Z',deviceTraffic:[{id:'mac:aa:bb:cc:dd:ee:08',name:'NAS',active:null,available:true,reason:null}]},
  ]);
  const device=sources.find(source=>source.kind==='device');
  assert.equal(device.active,null);assert.equal(device.available,true);assert.equal(device.reason,null);
});

test('mesh id and traffic nodeId link a device without MAC',()=>{
  const sources=trafficSources([{type:'fritzbox',at:'2026-10-11T10:00:00Z',mesh:{nodes:[{id:'node-no-mac',name:'Knoten'}]},deviceTraffic:[{nodeId:'node-no-mac',name:'Knoten Zähler',rateAvailable:true,downloadMbps:2}]}]);
  const devices=sources.filter(source=>source.kind==='device');
  assert.equal(devices.length,1);assert.equal(devices[0].id,'device:node:node-no-mac');assert.equal(devices[0].measured,1);
});

test('same-snapshot hosts without MAC dedupe by an otherwise unique IP',()=>{
  const sources=trafficSources([],{hosts:[{name:'Gerät A',ip:'192.168.178.40'},{name:'Gerät A',ip:'192.168.178.40'}]});
  assert.equal(sources.filter(source=>source.kind==='device').length,1);
});

test('a historical mesh MASTER is excluded from its device traffic row',()=>{
  const sources=trafficSources([{type:'fritzbox',at:'2026-10-11T10:00:00Z',mesh:{nodes:[{id:'master-historic',mac:'AA:BB:CC:DD:EE:09',role:'MASTER'}]},deviceTraffic:[{id:'mac:AA:BB:CC:DD:EE:09',name:'Router'}]}]);
  assert.equal(sources.filter(source=>source.kind==='device').length,0);
  assert.ok(sources.some(source=>source.id==='wan'));
});

test('same-snapshot IP alias never joins a host without MAC to a MAC-identified device',()=>{
  const sources=trafficSources([],{hosts:[{name:'Identifiziert',ip:'192.168.178.41',mac:'AA:BB:CC:DD:EE:10'},{name:'Unbekannt',ip:'192.168.178.41'}]});
  const devices=sources.filter(source=>source.kind==='device');
  assert.equal(devices.length,2);assert.notEqual(devices[0].id,devices[1].id);
});
