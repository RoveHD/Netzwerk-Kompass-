import test from 'node:test';
import assert from 'node:assert/strict';
import {gameNetworkSummary,packetView} from '../public/games.js';
import {gameReport} from '../lib/game-report.js';

test('packet UI keeps unverified capture counters unknown and marks in-progress states busy',()=>{
  const unverified=packetView({status:'error',quality:'unknown',startedAt:'2026-10-12T00:00:00Z',sentPackets:0,receivedPackets:0});
  assert.deepEqual(unverified.counts,[null,null,null,null]);assert.equal(unverified.measured,false);
  const valid=packetView({status:'recording',quality:'observed',startedAt:'2026-10-12T00:00:00Z',sentPackets:0,receivedPackets:4,sentBytes:0,receivedBytes:800});
  assert.deepEqual(valid.counts,[0,4,0,800]);assert.equal(valid.busy,true);
  assert.equal(packetView({status:'starting'}).busy,true);assert.equal(packetView({status:'stopped'}).busy,false);
});

test('game comparison excludes earlier pings and separates measurement errors from missed replies',()=>{
  const summary=gameNetworkSummary([{enabled:true,label:'Router',kind:'gateway',samples:[{at:'2026-10-12T00:00:00Z',ok:true,ms:800},{at:'2026-10-12T00:01:01Z',ok:true,ms:5},{at:'2026-10-12T00:01:02Z',ok:false,status:'TimedOut'},{at:'2026-10-12T00:01:03Z',ok:false,status:'measurement_error'}]},{enabled:false,kind:'internet',samples:[]}],'2026-10-12T00:01:00Z');
  assert.deepEqual(summary,[{label:'Router',kind:'gateway',replies:1,missing:1,errors:1,mean:5,from:'2026-10-12T00:01:01Z',to:'2026-10-12T00:01:03Z'}]);
  assert.equal(gameNetworkSummary([{enabled:true,kind:'internet',samples:[{at:'2026-10-12T00:00:00Z',ok:true,ms:8}]}],null)[0].mean,null);
});

test('game report projects bounded metadata and never sends process, path or endpoint details',()=>{
  const sensitive={name:'Marvel Rivals',source:'known',id:'private-id',sessionId:'session-private',pid:123,executable:'private.exe',path:'C:\\Users\\Private\\game.exe',startedAt:'2026-10-12T00:00:00Z'};
  const capture={startedAt:sensitive.startedAt,endedAt:'2026-10-12T00:01:00Z',quality:'observed',status:'stopped',sampleIntervalMs:2000,sentPackets:4,receivedPackets:2,sentBytes:400,receivedBytes:200,retransmits:0,losses:{events:0,buffers:0},endpoints:[{address:'198.51.100.14',port:1234}],payload:'SECRET'};
  const records=Array.from({length:30},()=>({type:'event',kind:'game',action:'started',at:sensitive.startedAt,game:sensitive}));
  records.push({type:'event',kind:'game-packets',game:sensitive,capture});
  const report=gameReport({gameDetection:{status:'ready',active:[sensitive]}},records,value=>typeof value==='string'?value:null);
  assert.equal(report.observations.length,20);assert.equal(report.packetCaptures[0].sentPackets,4);assert.equal(report.packetCaptures[0].sampleIntervalMs,2000);assert.equal(report.packetCaptures[0].deliveryBeyondRouter,'unknown');
  const json=JSON.stringify(report);for(const secret of ['private-id','session-private','private.exe','Private','198.51.100.14','SECRET','"pid"'])assert.ok(!json.includes(secret),secret);
});
