import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDeviceTraffic } from '../lib/device-traffic.js';

const previous={id:'mac:02:00:00:00:00:01',nodeId:'old-uid',mac:'02:00:00:00:00:01',available:true,source:'mesh-wan-counters',scope:'internet',totalBytesReceived:1000000,totalBytesSent:500000,lastUpdateMs:1700000000000};
const current={...previous,nodeId:'new-uid',totalBytesReceived:4750000,totalBytesSent:1250000,lastUpdateMs:1700000030000};
const context={previousSessionId:'same',currentSessionId:'same',previousUptimeSeconds:100,currentUptimeSeconds:130};
test('Internet rates and interval volumes use canonical MAC and actual counter time, not changing mesh UID',()=>{
  const result=deriveDeviceTraffic(previous,current,context);assert.equal(result.downloadMbps,1);assert.equal(result.uploadMbps,.2);assert.equal(result.downloadBytes,3750000);assert.equal(result.uploadBytes,750000);assert.equal(result.elapsedMs,30000);assert.equal(result.reason,null);
  const idle=deriveDeviceTraffic(previous,{...previous,lastUpdateMs:current.lastUpdateMs},context);assert.equal(idle.downloadMbps,0);assert.equal(idle.uploadBytes,0);
});
test('Repeated and older counter timestamps never produce false zero rates or peaks',()=>{
  for(const lastUpdateMs of [previous.lastUpdateMs,previous.lastUpdateMs-1,0,null]){const result=deriveDeviceTraffic(previous,{...current,lastUpdateMs},context);assert.equal(result.downloadMbps,null);assert.equal(result.downloadBytes,null);assert.ok(result.reason);}
});
test('Identity/session changes, reboot, gaps and counter resets break the rate interval',()=>{
  const cases=[
    [{...current,mac:'02:00:00:00:00:02'},context],
    [{...current,available:false},context],
    [{...current,source:'local-interface'},context],
    [{...current,scope:'lan'},context],
    [current,{...context,currentSessionId:'new'}],
    [current,{...context,previousSessionId:undefined}],
    [current,{...context,currentUptimeSeconds:99}],
    [current,{...context,currentUptimeSeconds:null}],
    [{...current,lastUpdateMs:previous.lastUpdateMs+90001},context],
    [{...current,totalBytesReceived:previous.totalBytesReceived-1},context],
    [{...current,totalBytesSent:previous.totalBytesSent-1},context],
    [{...current,totalBytesReceived:Number.MAX_SAFE_INTEGER+1},context],
    [{...current,totalBytesSent:'1250000'},context],
    [{...current,totalBytesSent:NaN},context],
    [{...current,totalBytesSent:1.5},context]
  ];
  for(const [entry,options] of cases){const result=deriveDeviceTraffic(previous,entry,options);assert.equal(result.downloadMbps,null);assert.equal(result.uploadMbps,null);assert.equal(result.downloadBytes,null);assert.ok(result.reason);}
  assert.equal(deriveDeviceTraffic(null,current,context).downloadMbps,null);
});
