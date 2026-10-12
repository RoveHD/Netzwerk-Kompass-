import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GamePacketTracker, parsePacketRecord } from '../lib/game-packets.js';

const at='2026-10-12T00:00:00.000Z';
const selection={game:{id:'fixture',sessionId:'session-1',name:'Fixture'},processes:[{pid:1234,startedAt:at}]};
const sample=(changes={})=>({type:'sample',at,sentPackets:2,receivedPackets:1,sentBytes:200,receivedBytes:50,retransmits:0,
  unknownEvents:0,omittedEndpoints:0,losses:{events:0,buffers:0},reason:'duration',
  endpoints:[{protocol:'UDP',address:'203.0.113.8',port:443,sentPackets:2,receivedPackets:1,sentBytes:200,receivedBytes:50}],...changes});
function rig(options={}){
  const children=[],calls=[],finished=[];
  const tracker=new GamePacketTracker({platform:'win32',onFinish:state=>finished.push(state),...options,spawnProcess:(...args)=>{
    calls.push(args);const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    child.kill=()=>{child.killed=true;child.emit('close',0);};children.push(child);return child;
  }});
  const emit=(record,child=children.at(-1))=>child.stdout.write(`${JSON.stringify(record)}\n`);
  const ready=()=>emit({type:'ready',at});
  const end=(changes={})=>{emit(sample({type:'final',...changes}));children.at(-1).emit('close',0);};
  return {tracker,children,calls,finished,emit,ready,end};
}

test('parser keeps only bounded metadata, strips paths, payloads, PIDs and arbitrary native reasons',()=>{
  const raw=sample({path:'C:\\private\\secret',payload:'secret',pid:1234,reason:'arbitrary private text'});
  raw.endpoints[0].payload='secret';
  const parsed=parsePacketRecord(JSON.stringify(raw));
  assert.equal(parsed.reason,'consumer-failed');assert.equal(parsed.endpoints[0].address,'203.0.113.8');
  assert.doesNotMatch(JSON.stringify(parsed),/secret|1234|private/);
  assert.deepEqual(parsePacketRecord('{"type":"error","code":"secret"}'),{type:'error',code:'helper_failed'});
});
test('parser rejects malformed schemas, unbounded endpoints, bad IPs and impossible counters',()=>{
  for(const raw of [sample({sentPackets:-1}),sample({losses:{events:0}}),sample({at:'invalid'}),sample({sentBytes:1}),sample({endpoints:Array(65).fill({})})])
    assert.throws(()=>parsePacketRecord(JSON.stringify(raw)));
  const duplicate=sample();duplicate.endpoints.push(duplicate.endpoints[0]);assert.throws(()=>parsePacketRecord(JSON.stringify(duplicate)));
  const invalid=sample();invalid.endpoints[0].address='malicious host';assert.throws(()=>parsePacketRecord(JSON.stringify(invalid)));
  assert.throws(()=>parsePacketRecord('x'.repeat(65537)));
});
test('start is asynchronous, allows only selected identities, and explicitly opts into helper UAC',async()=>{
  const r=rig();const state=await r.tracker.start({...selection,elevate:true});assert.equal(state.status,'starting');assert.equal(state.sentBytes,null);
  assert.equal(r.calls[0][1].at(-1),'-Elevate');assert.equal(r.calls[0][2].windowsHide,true);
  const config=JSON.parse(r.children[0].stdin.read().toString());assert.deepEqual(config,{durationMs:0,processes:selection.processes});
  assert.ok(!JSON.stringify(config).includes('Fixture'));r.ready();r.emit(sample());assert.equal(r.tracker.snapshot().quality,'observed');
  r.end();assert.equal(r.finished.length,1);await r.tracker.close();
});
test('process IDs need exact lifetime identity and duplicate IDs or overlapping captures are rejected',async()=>{
  const r=rig();
  for(const processes of [[],[{pid:1234}], [{pid:4,startedAt:at}], [{pid:1234,startedAt:at},{pid:1234,startedAt:at}]])
    await assert.rejects(r.tracker.start({...selection,processes}));
  await r.tracker.start(selection);await assert.rejects(r.tracker.start(selection));
  r.emit({type:'error',code:'process-changed'});assert.equal(r.tracker.snapshot().status,'error');assert.equal(r.tracker.snapshot().sentPackets,null);
  r.children[0].emit('close',0);await r.tracker.close();
});
test('unknown schema and ETW losses stay distinct from network packet loss',async()=>{
  const r=rig();await r.tracker.start(selection);r.ready();r.emit(sample({losses:{events:4,buffers:1}}));
  assert.equal(r.tracker.snapshot().quality,'incomplete');assert.equal(r.tracker.snapshot().deliveryBeyondRouter,'unknown');
  r.emit(sample({unknownEvents:1}));assert.equal(r.tracker.snapshot().quality,'unknown');
  r.end({unknownEvents:1});await r.tracker.close();
});
test('zero observed traffic never claims confirmed healthy packet capture or delivery',async()=>{
  const r=rig();await r.tracker.start(selection);r.ready();
  r.end({sentPackets:0,receivedPackets:0,sentBytes:0,receivedBytes:0,endpoints:[]});
  assert.equal(r.tracker.snapshot().quality,'unknown');assert.equal(r.tracker.snapshot().sentPackets,0);await r.tracker.close();
});
test('stop waits for native final and ignores stale output after restart',async()=>{
  const r=rig();await r.tracker.start(selection);r.ready();const old=r.children[0];
  const stopping=r.tracker.stop();assert.equal(r.tracker.snapshot().status,'stopping');r.end({reason:'user'});await stopping;
  await r.tracker.start({...selection,game:{...selection.game,sessionId:'session-2'}});r.ready();
  r.emit(sample({type:'final',sentBytes:9999}),old);assert.equal(r.tracker.snapshot().status,'recording');assert.equal(r.tracker.snapshot().sentBytes,0);
  r.end();assert.equal(r.finished.length,2);await r.tracker.close();
});
test('counter reset, unexpected exit and malformed late output fail closed',async()=>{
  const r=rig();await r.tracker.start(selection);r.ready();r.emit(sample());r.emit(sample({sentBytes:199,endpoints:[]}));
  assert.equal(r.tracker.snapshot().status,'error');assert.equal(r.tracker.snapshot().quality,'incomplete');
  r.children[0].emit('close',1);await r.tracker.start(selection);r.ready();r.children[1].emit('close',1);
  assert.equal(r.tracker.snapshot().status,'error');assert.equal(r.finished.length,2);await r.tracker.close();
});
test('UAC cancellation is needs-admin and carries no fabricated packet counts',async()=>{
  const r=rig();await r.tracker.start({...selection,elevate:true});r.emit({type:'error',code:'uac-cancelled'});
  assert.equal(r.tracker.snapshot().status,'needs-admin');assert.equal(r.tracker.snapshot().sentBytes,null);
  r.children[0].emit('close',0);await r.tracker.close();
});
test('sample history is bounded, snapshots are isolated, reset clears and close is idempotent',async()=>{
  let clock=Date.parse(at);const r=rig({now:()=>clock});await r.tracker.start(selection);r.ready();for(let index=0;index<2000;index++){clock+=1000;r.emit(sample({at:new Date(clock).toISOString()}));}
  assert.ok(r.tracker.snapshot().samples.length<=1800);assert.equal(r.tracker.snapshot().sampleIntervalMs,2000);const copy=r.tracker.snapshot();copy.endpoints[0].address='mutated';
  assert.equal(r.tracker.snapshot().endpoints[0].address,'203.0.113.8');
  const reset=r.tracker.reset();await assert.rejects(r.tracker.start(selection));r.end({reason:'user',at:new Date(clock).toISOString()});await reset;
  assert.equal(r.tracker.snapshot().status,'idle');assert.equal(r.tracker.snapshot().sentPackets,null);
  await Promise.all([r.tracker.close(),r.tracker.close()]);await assert.rejects(r.tracker.start(selection));
});

test('an hour-long match exceeds old duration, record and byte caps while retaining full totals and full-span bounded history',async()=>{
  let clock=Date.parse(at),outputBytes=0;const r=rig({now:()=>clock});await r.tracker.start(selection);r.ready();
  let record;
  for(let second=1;second<=3600;second++){
    clock=Date.parse(at)+second*1000;
    record=sample({at:new Date(clock).toISOString(),sentPackets:second*64,receivedPackets:second*64,sentBytes:second*6400,receivedBytes:second*3200,
      endpoints:Array.from({length:64},(_,index)=>({protocol:'UDP',address:`203.0.113.${index+1}`,port:443,sentPackets:second,receivedPackets:second,sentBytes:second*100,receivedBytes:second*50}))});
    outputBytes+=Buffer.byteLength(JSON.stringify(record))+1;r.emit(record);
    assert.equal(r.tracker.state.status,'recording');assert.ok(r.tracker.state.samples.length<=1800);
  }
  assert.ok(outputBytes>20000000);assert.equal(r.tracker.snapshot().sentBytes,3600*6400);assert.equal(r.tracker.snapshot().durationMs,0);
  assert.equal(r.tracker.snapshot().samples[0].at,'2026-10-12T00:00:01.000Z');
  const stop=r.tracker.stop();r.end({...record,type:'final',reason:'user'});await stop;
  assert.equal(r.tracker.snapshot().samples.at(-1).at,'2026-10-12T01:00:00.000Z');
  assert.equal(r.tracker.snapshot().quality,'observed');assert.equal(r.finished.length,1);await r.tracker.close();
});

test('duration accepts unlimited or explicit bounded finite matches, without clamping 20 minutes to two',async()=>{
  for(const durationMs of [-1,1,999,86400001,NaN,Infinity,1.5,'120000'])assert.throws(()=>rig({durationMs}));
  const r=rig({durationMs:1200000});await r.tracker.start(selection);
  assert.equal(JSON.parse(r.children[0].stdin.read().toString()).durationMs,1200000);
  r.ready();r.end({reason:'duration'});assert.equal(r.tracker.snapshot().status,'stopped');await r.tracker.close();
});

test('flooded output is bounded by its rate while normal output can continue across windows',async()=>{
  let clock=Date.parse(at);const r=rig({now:()=>clock});await r.tracker.start(selection);r.ready();
  for(let index=0;index<63;index++)r.emit(sample());assert.equal(r.tracker.snapshot().status,'recording');
  clock+=10000;r.emit(sample());assert.equal(r.tracker.snapshot().status,'recording');
  for(let index=0;index<64;index++)r.emit(sample());assert.equal(r.tracker.snapshot().status,'error');
  assert.equal(r.tracker.snapshot().quality,'incomplete');r.children[0].emit('close',0);await r.tracker.close();
});

test('unlimited capture still stops when helper stops emitting, game ends, or the app closes',async()=>{
  let clock=Date.parse(at);const r=rig({now:()=>clock,outputTimeoutMs:5});await r.tracker.start(selection);r.ready();clock+=20;
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(r.tracker.snapshot().status,'error');r.children[0].emit('close',0);
  await r.tracker.start(selection);r.ready();r.end({reason:'process-ended'});assert.equal(r.tracker.snapshot().status,'stopped');assert.match(r.tracker.snapshot().reason,/Spielprozesse/);
  await r.tracker.start(selection);r.ready();const closed=r.tracker.close();r.end({reason:'user'});await closed;
  assert.match(r.tracker.snapshot().reason,/Anwendung wurde geschlossen/);assert.equal(r.finished.length,3);
});
test('stop during pending UAC has a bounded completion and late ready cannot revive it',async()=>{
  const r=rig({stopTimeoutMs:5});await r.tracker.start({...selection,elevate:true});const stop=r.tracker.stop();
  await new Promise(resolve=>setTimeout(resolve,15));await stop;assert.equal(r.tracker.snapshot().status,'stopped');
  r.ready();assert.equal(r.tracker.snapshot().status,'stopped');assert.equal(r.tracker.snapshot().sentBytes,null);
  r.children[0].emit('close',0);await r.tracker.close();
});
test('startup timeout and stdout limits terminate unknown capture honestly',async()=>{
  const r=rig({startupTimeoutMs:5});await r.tracker.start(selection);await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(r.tracker.snapshot().status,'needs-admin');r.children[0].emit('close',0);
  await r.tracker.start(selection);r.children[1].stdout.write('x'.repeat(140000));assert.equal(r.tracker.snapshot().status,'error');
  r.children[1].emit('close',0);await r.tracker.close();
});
