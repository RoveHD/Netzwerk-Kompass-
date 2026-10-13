import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDeviceTraffic, deriveWanTraffic } from '../lib/device-traffic.js';

const previous={id:'mac:02:00:00:00:00:01',nodeId:'old-uid',mac:'02:00:00:00:00:01',available:true,source:'mesh-wan-counters',scope:'internet',totalBytesReceived:1000000,totalBytesSent:500000,lastUpdateMs:1700000000000};
const current={...previous,nodeId:'new-uid',totalBytesReceived:4750000,totalBytesSent:1250000,lastUpdateMs:1700000030000};
const context={previousSessionId:'same',currentSessionId:'same',previousUptimeSeconds:100,currentUptimeSeconds:130};
test('Internet rates and interval volumes use canonical MAC and actual counter time, not changing mesh UID',()=>{
  const result=deriveDeviceTraffic(previous,current,context);assert.equal(result.downloadMbps,1);assert.equal(result.uploadMbps,.2);assert.equal(result.downloadBytes,3750000);assert.equal(result.uploadBytes,750000);assert.equal(result.elapsedMs,30000);assert.equal(result.reason,null);
  assert.equal(result.intervalStartedAt,new Date(previous.lastUpdateMs).toISOString());assert.equal(result.intervalEndedAt,new Date(current.lastUpdateMs).toISOString());assert.equal(result.measurementBasis,'router-counter-timestamp');
  const idle=deriveDeviceTraffic(previous,{...previous,lastUpdateMs:current.lastUpdateMs},context);assert.equal(idle.downloadMbps,0);assert.equal(idle.uploadBytes,0);
});

const wanSample=(from,to,rx=1000000,tx=500000)=>({source:'tr064-wan-byte-counters',scope:'internet',totalBytesReceived:rx,totalBytesSent:tx,sampling:{from:new Date(from).toISOString(),to:new Date(to).toISOString(),counterUpdatedAtAvailable:false}});
const wanPrevious=wanSample(1700000000000,1700000000200),wanCurrent=wanSample(1700000002000,1700000002200,1250000,625000);

test('WAN rates use bounded observation windows and disclose unknown router counter timing',()=>{
  const result=deriveWanTraffic(wanPrevious,wanCurrent,context);
  assert.equal(result.downloadMbps,1);assert.equal(result.uploadMbps,.5);assert.equal(result.elapsedMs,2000);assert.equal(result.downloadBytes,250000);assert.equal(result.timingUncertaintyMs,200);
  assert.equal(result.intervalStartedAt,'2023-11-14T22:13:20.100Z');assert.equal(result.intervalEndedAt,'2023-11-14T22:13:22.100Z');
  assert.deepEqual(result.observationWindow,{from:wanPrevious.sampling.from,to:wanCurrent.sampling.to});
  assert.equal(result.counterUpdatedAtAvailable,false);assert.equal(result.counterUpdateFrequencyKnown,false);assert.equal(result.measurementBasis,'request-observation-window');
  const zero=deriveWanTraffic(wanPrevious,{...wanCurrent,totalBytesReceived:1000000,totalBytesSent:500000},context);assert.equal(zero.downloadMbps,0);assert.equal(zero.counterUpdateFrequencyKnown,false);
});

test('WAN reboot, missing data and overlapping or reversed request windows do not generate rates',()=>{
  const cases=[
    [null,wanCurrent,context],
    [wanPrevious,{...wanCurrent,source:'mesh-wan-counters'},context],
    [wanPrevious,{...wanCurrent,scope:'local'},context],
    [wanPrevious,wanCurrent,{...context,currentSessionId:'new'}],
    [wanPrevious,wanCurrent,{...context,currentUptimeSeconds:99}],
    [wanPrevious,wanCurrent,{...context,previousUptimeSeconds:null}],
    [wanPrevious,{...wanCurrent,sampling:undefined},context],
    [wanPrevious,wanSample(1700000000199,1700000002200),context],
    [wanPrevious,wanSample(1700000002100,1700000002000),context],
    [wanPrevious,wanSample(1700000100000,1700000100200),context],
    [wanPrevious,{...wanCurrent,totalBytesSent:100},context],
    [wanPrevious,{...wanCurrent,totalBytesReceived:null},context],
    [wanPrevious,{...wanCurrent,totalBytesSent:Number.MAX_SAFE_INTEGER+1},context],
    [wanPrevious,wanCurrent,{...context,maxGapMs:0}]
  ];
  for(const [before,after,options] of cases){const result=deriveWanTraffic(before,after,options);assert.equal(result.downloadMbps,null);assert.equal(result.downloadBytes,null);assert.ok(result.reason);}
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
