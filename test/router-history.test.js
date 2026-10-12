import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';

test('router history preserves diagnostic facts as independent whitelisted snapshots',async()=>{
  const monitor=new Monitor({});
  try{
    const data={host:'fritz.box',device:{model:'FRITZ!Box 6690 Cable'},wan:{},hosts:[{name:'Tablet',mac:'02:00:00:00:00:01',active:null,guest:true,wanAccess:'denied',priority:false,filterProfileId:'profile-1',linkRateMbps:1000,lanPort:1,vpn:false,password:'never-store'}],mesh:{nodes:[{id:'tablet',latency:{status:'SUCCESS',roundTripMs:2.5,measuredAtMs:1700000000000,secret:'never-store'}}],links:[]},wlan:[{id:'wifi',bssid:'02:00:00:00:00:02',beaconType:'WPA3',packetStats:{available:false,reason:'Counters unsupported',totalPacketsReceived:null,totalPacketsSent:null,password:'never-store'},key:'never-store'}],diagnostics:{lan:{available:true,dhcpEnabled:true,dnsServers:['192.168.1.1'],password:'never-store'},internet:{available:true,natEnabled:true,portMappingCount:3,ipv6Status:'Connected',username:'never-store'},ethernet:[{id:'lan1',available:true,status:'Up',maxBitRateMbps:1000,totalBytesReceived:123,secret:'never-store'}]}};
    monitor.applyFritz(data);
    const record=monitor.history.snapshot().records.at(-1);
    assert.equal(record.hosts[0].active,null);assert.equal(record.hosts[0].guest,true);assert.equal(record.hosts[0].wanAccess,'denied');
    assert.equal(record.diagnostics.internet.portMappingCount,3);assert.equal(record.diagnostics.ethernet[0].maxBitRateMbps,1000);
    assert.equal(record.mesh.nodes[0].latency.roundTripMs,2.5);assert.equal(record.wlan[0].packetStats.available,false);
    assert.ok(!JSON.stringify(record).includes('never-store'));
    data.hosts[0].name='Renamed';data.diagnostics.lan.dnsServers.push('192.168.1.2');
    assert.equal(record.hosts[0].name,'Tablet');assert.deepEqual(record.diagnostics.lan.dnsServers,['192.168.1.1']);
    assert.equal(record.hostsTruncated,false);assert.equal(record.deviceTrafficTruncated,false);
  }finally{await monitor.close();}
});

test('large combined router snapshots stay persistable and disclose truncated device lists',async()=>{
  const monitor=new Monitor({});const long='😀'.repeat(250);
  try{
    const data={host:'fritz.box',device:{model:'FRITZ!Box'},wan:{},hosts:Array.from({length:128},(_,i)=>({name:long,ip:'192.168.1.'+i,mac:'02:00:00:00:00:01',model:long,deviceClass:long})),mesh:{nodes:Array.from({length:256},(_,i)=>({id:'n'+i,name:long,model:long,latency:{status:'SUCCESS',roundTripMs:1,measuredAtMs:1700000000000}})),links:Array.from({length:1024},(_,i)=>({id:'l'+i,from:'n'+i%256,to:'n'+(i+1)%256,type:'WLAN',state:'CONNECTED'}))},deviceTraffic:Array.from({length:128},(_,i)=>({id:'d'+i,name:long,nodeId:'n'+i,reason:long,available:false})),capabilities:Array.from({length:128},()=>({service:long,instance:long,action:long,reason:long})),wlan:Array.from({length:8},()=>({id:long,ssid:long,beaconType:long,packetStats:{reason:long}})),diagnostics:{ethernet:Array.from({length:16},()=>({id:long,reason:long,duplexMode:long})),lan:{reason:long,domainName:long,dnsServers:Array(8).fill('1'.repeat(45))},internet:{reason:long,service:long,status:long,connectionType:long,lastConnectionError:long,ipv6Status:long,dnsServers:Array(8).fill('1'.repeat(45))}},warnings:Array(40).fill('Warning: '+long.slice(0,80))};
    monitor.applyFritz(data);
    const records=monitor.history.snapshot().records;assert.equal(records.length,1);
    assert.ok(Buffer.byteLength(JSON.stringify(records[0]))<65536);
    assert.equal(records[0].hostsTruncated,true);assert.equal(records[0].deviceTrafficTruncated,true);assert.equal(records[0].mesh.truncated,true);
  }finally{await monitor.close();}
});
