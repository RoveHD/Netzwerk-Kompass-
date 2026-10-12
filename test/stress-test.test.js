import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { normalizeStressOptions,runStressTest } from '../lib/stress-test.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const small={downloadRequestBytes:32,uploadRequestBytes:16};
async function until(predicate){for(let i=0;i<100&&!predicate();i++)await nextTurn();assert.ok(predicate(),'Synthetic transfer did not reach expected state');}
function fakeTime() {
  const tasks=new Map();let id=0;
  const time={value:0,clock:()=>time.value,tasks};
  time.timers={setTimeout:(callback,ms)=>{tasks.set(++id,{callback,ms,interval:false});return id;},clearTimeout:key=>tasks.delete(key),setInterval:(callback,ms)=>{tasks.set(++id,{callback,ms,interval:true});return id;},clearInterval:key=>tasks.delete(key)};
  time.timeout=ms=>{const found=[...tasks].find(([,task])=>!task.interval&&task.ms===ms);assert.ok(found,`Missing timer ${ms}`);tasks.delete(found[0]);found[1].callback();};
  time.progress=()=>{for(const task of [...tasks.values()])if(task.interval)task.callback();};
  return time;
}

test('stress options have explicit modes and bounded durations with manual stop',()=>{
  assert.deepEqual(normalizeStressOptions(),{mode:'both',durationSeconds:300});
  for(const mode of ['download','upload','both'])for(const durationSeconds of [60,300,900,1800,3600,0])assert.deepEqual(normalizeStressOptions({mode,durationSeconds}),{mode,durationSeconds});
  for(const options of [null,[],{mode:'all'},{mode:1},{durationSeconds:'300'},{durationSeconds:1},{durationSeconds:-1},{durationSeconds:Infinity},{durationSeconds:NaN}])assert.throws(()=>normalizeStressOptions(options));
});

test('pre-aborted runs create no traffic, buffers or live timers',async()=>{
  const controller=new AbortController();controller.abort();const time=fakeTime(),updates=[];
  const result=await runStressTest(update=>updates.push(update),{signal:controller.signal,fetchImpl:()=>{throw new Error('Must not fetch');},clock:time.clock,timers:time.timers});
  assert.equal(result.reason,'stopped');assert.equal(result.elapsedSeconds,0);assert.equal(result.downloadBytes,0);assert.equal(result.uploadBytes,0);assert.equal(result.downloadMbps,null);assert.equal(time.tasks.size,0);assert.equal(updates.at(-1).reason,'stopped');
});

test('both directions continuously transfer with at most one request each and reuse the upload buffer',async()=>{
  const controller=new AbortController(),active={download:0,upload:0},maximum={download:0,upload:0},calls={download:0,upload:0},buffers=[],updates=[];
  const fake=async(url,options)=>{
    const direction=options.method==='POST'?'upload':'download';active[direction]++;maximum[direction]=Math.max(maximum[direction],active[direction]);calls[direction]++;
    assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
    if(direction==='upload'){assert.equal(url,'https://speed.cloudflare.com/__up');assert.equal(options.body.length,16);buffers.push(options.body);}
    else assert.equal(url,'https://speed.cloudflare.com/__down?bytes=32');
    await nextTurn();active[direction]--;
    return new Response(direction==='upload'?'ok':new Uint8Array(32));
  };
  const pending=runStressTest(update=>updates.push(update),{...small,signal:controller.signal,durationSeconds:0,fetchImpl:fake});
  await until(()=>calls.download>=4&&calls.upload>=4);controller.abort();const result=await pending;
  assert.deepEqual(maximum,{download:1,upload:1});assert.ok(buffers.every(buffer=>buffer===buffers[0]));
  assert.equal(result.reason,'stopped');assert.ok(result.completedDownloads>=3);assert.ok(result.completedUploads>=3);
  assert.equal(result.downloadBytes,result.completedDownloads*32);assert.equal(result.uploadBytes,result.completedUploads*16);
  assert.ok(result.downloadMbps>0);assert.ok(result.uploadMbps>0);assert.equal(updates.at(-1).reason,'stopped');
  const stoppedCalls={...calls};await nextTurn();assert.deepEqual(calls,stoppedCalls);
});

test('manual stop cancels a partial response and pending upload without inventing uploaded bytes',async()=>{
  const controller=new AbortController(),upload=deferred(),signals=[];let cancelled=0,pulls=0;
  const fake=async(url,options)=>{
    signals.push(options.signal);
    if(options.method==='POST')return upload.promise;
    return new Response(new ReadableStream({start(stream){stream.enqueue(new Uint8Array(7));},pull(){pulls++;},cancel(){cancelled++;}}));
  };
  const pending=runStressTest(()=>{},{...small,durationSeconds:0,signal:controller.signal,fetchImpl:fake});
  await until(()=>pulls>=2&&signals.length===2);controller.abort();const result=await pending;
  assert.equal(result.downloadBytes,7);assert.equal(result.completedDownloads,0);assert.equal(result.uploadBytes,0);assert.equal(result.completedUploads,0);assert.equal(cancelled,1);assert.ok(signals.every(signal=>signal.aborted));
  // Even a custom fetch that ignores the signal cannot publish or start new work.
  let lateCancelled=0;upload.resolve(new Response(new ReadableStream({cancel(){lateCancelled++;}})));await nextTurn();assert.equal(lateCancelled,1);
});

test('configured duration aborts both in-flight requests, returns completed and removes timers',async()=>{
  const time=fakeTime(),signals=[],updates=[];
  const pending=runStressTest(update=>updates.push(update),{...small,durationSeconds:60,clock:time.clock,timers:time.timers,fetchImpl:async(url,options)=>{signals.push(options.signal);return new Promise(()=>{});}});
  assert.equal(signals.length,2);time.value=60_000;time.timeout(60_000);
  const result=await pending;assert.equal(result.reason,'completed');assert.equal(result.elapsedSeconds,60);assert.ok(signals.every(signal=>signal.aborted));assert.equal(time.tasks.size,0);assert.equal(updates.at(-1).reason,'completed');
});

test('progress is throttled to four updates per second plus initial and final summaries',async()=>{
  const controller=new AbortController(),time=fakeTime(),updates=[];
  const pending=runStressTest(update=>updates.push({at:time.value,...update}),{...small,mode:'download',durationSeconds:0,signal:controller.signal,clock:time.clock,timers:time.timers,fetchImpl:()=>new Promise(()=>{})});
  for(const value of [1,100,249,250,251,499,500,501]){time.value=value;time.progress();}
  assert.deepEqual(updates.map(update=>update.at),[0,250,500]);controller.abort();const result=await pending;
  assert.equal(result.elapsedSeconds,.501);assert.equal(result.uploadMbps,null);assert.deepEqual(updates.map(update=>update.at),[0,250,500,501]);assert.equal(time.tasks.size,0);
});

test('HTTP failures abort the other direction and never retry silently',async()=>{
  for(const failedDirection of ['download','upload']) {
  const signals=[],calls=[],time=fakeTime();
  await assert.rejects(runStressTest(()=>{},{...small,clock:time.clock,timers:time.timers,fetchImpl:async(url,options)=>{
    signals.push(options.signal);calls.push(url);
    const direction=options.method==='POST'?'upload':'download';
    return direction!==failedDirection?new Promise(()=>{}):new Response('busy',{status:503});
  }}),error=>{assert.match(error.message,/503/);assert.equal(error.partial.reason,'error');assert.equal(error.partial.downloadBytes,0);assert.equal(error.partial.uploadBytes,0);return true;});
  assert.equal(calls.length,2);assert.ok(signals.every(signal=>signal.aborted));assert.equal(time.tasks.size,0);
  }
});

test('short, oversized and absent download streams fail with bounded partial counters',async()=>{
  for(const [response,pattern,observed] of [[()=>new Response(new Uint8Array(3)),/vollständig/,3],[()=>new Response(new Uint8Array(33)),/Unerwartete/,0],[()=>new Response(null),/Datenstrom/,0]]) {
    let calls=0;
    await assert.rejects(runStressTest(()=>{},{...small,mode:'download',fetchImpl:async()=>{calls++;return response();}}),error=>{assert.match(error.message,pattern);assert.equal(error.partial.downloadBytes,observed);assert.equal(error.partial.completedDownloads,0);assert.equal(error.partial.uploadBytes,0);assert.ok(Number.isSafeInteger(error.partial.downloadBytes));return true;});
    assert.equal(calls,1);
  }
});

test('a download body failure cancels the sibling upload and reports already observed bytes',async()=>{
  let stream,reads=0;const signals=[];
  await assert.rejects(runStressTest(()=>{},{...small,fetchImpl:async(url,options)=>{
    signals.push(options.signal);
    if(options.method==='POST')return new Promise(()=>{});
    return new Response(new ReadableStream({start(controller){stream=controller;stream.enqueue(new Uint8Array(9));},pull(){if(++reads===2)stream.error(new Error('Synthetic stream failure'));}}));
  }}),error=>{assert.match(error.message,/Synthetic stream failure/);assert.equal(error.partial.downloadBytes,9);assert.equal(error.partial.uploadBytes,0);return true;});
  assert.equal(signals.length,2);assert.ok(signals.every(signal=>signal.aborted));
});

test('request timeout is an error that aborts all transfer signals and leaves no timers',async()=>{
  const time=fakeTime(),signals=[];
  const pending=runStressTest(()=>{},{...small,requestTimeoutMs:123,clock:time.clock,timers:time.timers,fetchImpl:async(url,options)=>{signals.push(options.signal);return new Promise(()=>{});}});
  time.value=123;time.timeout(123);
  await assert.rejects(pending,error=>{assert.match(error.message,/Zeitüberschreitung/);assert.equal(error.partial.reason,'error');assert.equal(error.partial.elapsedSeconds,.123);return true;});
  assert.ok(signals.every(signal=>signal.aborted));assert.equal(time.tasks.size,0);
});

test('upload-only mode confirms complete HTTP successes and never requests downloads',async()=>{
  const controller=new AbortController();let calls=0;const first=deferred();
  const pending=runStressTest(()=>{},{...small,mode:'upload',durationSeconds:0,signal:controller.signal,fetchImpl:async(url,options)=>{
    assert.equal(options.method,'POST');assert.equal(url,'https://speed.cloudflare.com/__up');calls++;
    if(calls===1)return first.promise;
    return new Promise(()=>{});
  }});
  first.resolve(new Response('ok'));await until(()=>calls===2);controller.abort();const result=await pending;
  assert.equal(result.uploadBytes,16);assert.equal(result.completedUploads,1);assert.equal(result.downloadBytes,0);assert.equal(result.downloadMbps,null);
});

test('invalid injections and byte limits are rejected before any traffic',async()=>{
  for(const options of [{downloadRequestBytes:5_000_001},{uploadRequestBytes:2_000_001},{downloadRequestBytes:0},{uploadRequestBytes:1.5},{requestTimeoutMs:0},{requestTimeoutMs:Infinity},{signal:{}},{timers:{}},{clock:3}]){
    let calls=0;await assert.rejects(runStressTest(()=>{},{...options,fetchImpl:()=>{calls++;throw new Error('Must not fetch');}}),TypeError);assert.equal(calls,0);
  }
});

test('default download request is exactly five MB and stops even if fetch ignores abort',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=runStressTest(()=>{},{mode:'download',durationSeconds:0,signal:controller.signal,fetchImpl:async(url)=>{assert.equal(url,'https://speed.cloudflare.com/__down?bytes=5000000');calls++;return new Promise(()=>{});}});
  controller.abort();assert.equal((await pending).reason,'stopped');assert.equal(calls,1);
});

test('default upload request uses a bounded two MB buffer and never counts an aborted request',async()=>{
  const controller=new AbortController();let calls=0;
  const pending=runStressTest(()=>{},{mode:'upload',durationSeconds:0,signal:controller.signal,fetchImpl:async(url,options)=>{assert.equal(options.body.length,2_000_000);assert.equal(url,'https://speed.cloudflare.com/__up');calls++;return new Promise(()=>{});}});
  controller.abort();const result=await pending;assert.equal(result.reason,'stopped');assert.equal(result.uploadBytes,0);assert.equal(calls,1);
});
