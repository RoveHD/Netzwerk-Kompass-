import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Monitor } from '../lib/monitor.js';
import { AnalysisController } from '../lib/ai-analysis.js';
import { SessionStore, atomicWrite, durableAppend } from '../lib/session-store.js';

const fake={discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false,networks:[]}})};
const ready={available:true,authenticated:true};
async function directory(t) {
  const base=path.resolve(os.tmpdir()),dataDir=await mkdtemp(path.join(base,'netzwerk-durability-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dataDir)),base);assert.ok(path.basename(dataDir).startsWith('netzwerk-durability-'));await rm(dataDir,{recursive:true,force:true});});
  return dataDir;
}

test('archived diagnosis pages skip corrupt files and read known filenames without repeated lookups',async t=>{
  const dataDir=await directory(t),store=new SessionStore({dataDir});await store.beginSession();
  for(let i=0;i<23;i++)await store.saveAnalysis({id:randomUUID(),startedAt:new Date(Date.now()+i).toISOString(),status:'completed',result:`Saved ${i}`});
  const files=(await readdir(path.join(dataDir,'diagnoses'))).sort().reverse();
  await writeFile(path.join(dataDir,'diagnoses',files[21]),'{broken');
  store.getAnalysis=()=>{throw new Error('Page already knows the file; must not search the directory again');};
  const page=await store.listAnalyses({offset:20,limit:20});
  assert.equal(page.total,23);assert.equal(page.analyses.length,2);assert.equal(page.analyses[0].hasResult,true);assert.match(store.lastError,/Archivdatei/);
  assert.ok(await store.readAnalysis(files[22],files[22].slice(14,-5)));
  await assert.rejects(store.readAnalysis('../settings.json',randomUUID()),/ID/);await store.close();
});

test('diagnosis size validation matches the actual pretty-printed archive representation',async t=>{
  const dataDir=await directory(t),store=new SessionStore({dataDir});await store.beginSession();
  const large={id:randomUUID(),startedAt:new Date().toISOString(),status:'completed',report:{values:Array(260000).fill(0)}};
  assert.ok(Buffer.byteLength(JSON.stringify(large))<2*1024*1024);
  assert.ok(Buffer.byteLength(JSON.stringify(large,null,2))>2*1024*1024);
  assert.throws(()=>store.saveAnalysis(large),/zu groß/);
  assert.equal((await readdir(path.join(dataDir,'diagnoses'))).length,0);await store.close();
});

test('hard process termination preserves flushed measurements and AI results and detects unfinished work',async t=>{
  const dataDir=await directory(t);
  const monitorURL=new URL('../lib/monitor.js',import.meta.url).href,analysisURL=new URL('../lib/ai-analysis.js',import.meta.url).href;
  const script=`
    import {Monitor} from ${JSON.stringify(monitorURL)};
    import {AnalysisController} from ${JSON.stringify(analysisURL)};
    import {randomUUID} from 'node:crypto';
    const m=new Monitor({discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false,networks:[]}})},{dataDir:process.argv[1]});m.schedule=()=>{};await m.start();
    m.log({type:'ping',at:new Date().toISOString(),results:[{host:'192.168.1.1',kind:'gateway',ok:true,ms:4}]});
    const ai=new AnalysisController(m,{client:{check:async()=>({available:true,authenticated:true}),analyze:async()=> 'Router und Internet aktuell unauffällig.'}});
    ai.start(1);await ai.job;await m.logQueue;if(m.history.flushPromise)await m.history.flushPromise;
    const pendingId=randomUUID();await m.persistence.saveAnalysis({id:pendingId,sessionId:m.persistence.currentSession.id,startedAt:new Date().toISOString(),status:'running',finishedAt:null,report:{version:1},result:null,measurementStartedAt:null});
    console.log(JSON.stringify({session:m.persistence.currentSession.id,analysis:ai.state.analysisId,pendingId}));setInterval(()=>{},1000);
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,dataDir],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let stderr='',output='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const ids=await new Promise((resolve,reject)=>{
    child.on('error',reject);child.on('exit',code=>reject(new Error(`Child exited ${code}: ${stderr}`)));
    child.stdout.on('data',chunk=>{output+=chunk;const end=output.indexOf('\n');if(end>=0){try{resolve(JSON.parse(output.slice(0,end)));}catch(error){reject(error);}}});
  });
  const stopped=once(child,'close');child.kill('SIGKILL');await stopped;
  const monitor=new Monitor(fake,{dataDir});monitor.schedule=()=>{};
  t.after(()=>monitor.close());await monitor.start();
  const previous=monitor.snapshot().persistence.sessions.find(item=>item.id===ids.session);
  assert.equal(previous.status,'interrupted');assert.equal(previous.reason,'unexpected_interruption');assert.equal(previous.endedAt,null);assert.ok(previous.detectedAt);assert.ok(previous.lastPersistedAt);
  assert.ok(monitor.historySnapshot(1).records.some(record=>record.type==='ping'&&record.results[0].ms===4));
  const ai=new AnalysisController(monitor,{client:{close(){}}});await ai.ready;
  const saved=ai.snapshot().savedAnalyses.find(item=>item.id===ids.analysis);
  assert.equal(saved.status,'completed');assert.match(saved.result,/Router und Internet/);
  const full=await monitor.persistence.getAnalysis(ids.analysis);assert.ok(full.report);assert.ok(full.reportSummary.records>0);assert.ok(full.reportSummary.from);assert.ok(full.reportSummary.to);
  const interrupted=await monitor.persistence.getAnalysis(ids.pendingId);assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.finishedAt,null);assert.equal(interrupted.result,null);
  await ai.close();await monitor.close({reason:'windows_shutdown'});
  assert.equal(monitor.persistence.currentSession.reason,'windows_shutdown');assert.equal(monitor.persistence.currentSession.status,'completed');
});

test('atomic replacement ignores orphan temporary files and preserves the old file when replacement fails',async t=>{
  const dataDir=await directory(t),file=path.join(dataDir,'state.json');
  await atomicWrite(file,'{"old":true}\n');await writeFile(file+'.orphan.tmp','{"unfinished":true}');
  await atomicWrite(file,'{"new":true}\n');assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{new:true});
  const blocked=path.join(dataDir,'blocked');await mkdir(blocked);await writeFile(path.join(blocked,'keep.txt'),'preserve');
  await assert.rejects(atomicWrite(blocked,'replacement'));
  assert.equal(await readFile(path.join(blocked,'keep.txt'),'utf8'),'preserve');
  assert.ok(!(await readdir(dataDir)).some(name=>name.startsWith('blocked.')&&name.endsWith('.tmp')));
});

test('raw archive repairs a stale history cache, separates torn tails and does not duplicate recovered records',async t=>{
  const dataDir=await directory(t),at=new Date().toISOString();
  const raw=path.join(dataDir,`messungen-${at.slice(0,10)}.jsonl`);
  const record={type:'ping',at,recordId:randomUUID(),results:[{host:'192.168.1.1',ok:true,ms:8}]};
  await writeFile(raw,JSON.stringify(record)+'\n{"torn":');
  await durableAppend(raw,JSON.stringify({type:'event',at,title:'After torn line'})+'\n');
  const first=new Monitor(fake,{dataDir});first.schedule=()=>{};await first.start();
  assert.equal(first.historySnapshot(1).records.filter(item=>item.recordId===record.recordId).length,1);
  assert.ok(first.historySnapshot(1).records.some(item=>item.title==='After torn line'));await first.close();
  const second=new Monitor(fake,{dataDir});second.schedule=()=>{};await second.start();
  assert.equal(second.historySnapshot(1).records.filter(item=>item.recordId===record.recordId).length,1);await second.close();
});

test('all AI diagnoses remain archived while the UI index is bounded and paginated; unsafe IDs cannot read files',async t=>{
  const dataDir=await directory(t),store=new SessionStore({dataDir});await store.beginSession();const ids=[];
  for(let i=0;i<25;i++) {
    const id=randomUUID();ids.push(id);
    await store.saveAnalysis({id,startedAt:new Date(Date.now()+i).toISOString(),status:'completed',finishedAt:new Date().toISOString(),report:{safe:true,password:'never-save',nested:{username:'never-save'}},result:`diagnosis ${i} password=never-save`,error:'',reportSummary:{hours:1},measurementStartedAt:null});
  }
  assert.equal(store.snapshot().analyses.length,20);
  const page=await store.listAnalyses({offset:20,limit:20});assert.equal(page.total,25);assert.equal(page.analyses.length,5);
  const oldest=await store.getAnalysis(ids[0]);assert.ok(oldest.report.safe);assert.ok(!JSON.stringify(oldest).includes('never-save'));
  await assert.rejects(store.getAnalysis('../settings.json'),/ID/);await store.close({reason:'normal'});
  const restarted=new SessionStore({dataDir});await restarted.start();assert.equal(restarted.sessions[0].reason,'normal');assert.equal(restarted.sessions[0].status,'completed');assert.equal((await restarted.listAnalyses()).total,25);
});

test('reset clears the visible AI result but preserves the earlier archived diagnosis and safe projected raw data',async t=>{
  const dataDir=await directory(t),monitor=new Monitor(fake,{dataDir});monitor.schedule=()=>{};await monitor.start();
  monitor.log({type:'ping',at:new Date().toISOString(),results:[{host:'192.168.1.1',ok:true,ms:2}],password:'never-save',nested:{username:'never-save'}});
  const ai=new AnalysisController(monitor,{client:{check:async()=>ready,analyze:async()=> 'Saved before reset',cancel(){},close(){}}});ai.start();await ai.job;const id=ai.state.analysisId;
  await monitor.reset();ai.reset();assert.equal(ai.snapshot().result,null);assert.equal((await monitor.persistence.getAnalysis(id)).result,'Saved before reset');
  await ai.close();await monitor.close();
  for(const name of await readdir(dataDir))if(name.endsWith('.jsonl'))assert.ok(!(await readFile(path.join(dataDir,name),'utf8')).includes('never-save'));
  const restarted=new Monitor(fake,{dataDir});restarted.schedule=()=>{};await restarted.start();const restoredAI=new AnalysisController(restarted,{client:{close(){}}});await restoredAI.ready;
  assert.equal(restoredAI.snapshot().result,null);assert.equal(restoredAI.snapshot().savedAnalyses.length,1);await restoredAI.close();await restarted.close();
});

test('closing during startup cannot begin monitoring or leave a live session, and repeated close retains the first reason',async t=>{
  const dataDir=await directory(t);let release;const monitor=new Monitor(fake,{dataDir});let scheduled=0;
  monitor.schedule=()=>{scheduled++;};monitor.history.start=()=>new Promise(resolve=>{release=()=>{monitor.history.started=true;resolve();};});
  const start=monitor.start(),closing=monitor.close({reason:'launcher_lost'});release();await start;await closing;
  assert.equal(scheduled,0);assert.equal(monitor.persistence.currentSession,null);await monitor.close({reason:'normal'});
  const real=new Monitor(fake,{dataDir});real.schedule=()=>{};await real.start();await real.close({reason:'launcher_lost'});await real.close({reason:'normal'});
  assert.equal(real.persistence.currentSession.reason,'launcher_lost');assert.equal(real.persistence.currentSession.status,'interrupted');
});

test('FRITZ per-device rates survive node ID changes, retain stale timestamps and reject gaps, reboots, missing counters and reset',async()=>{
  const monitor=new Monitor(fake),start=Date.now()-20000;
  const row=(time,bytes,nodeId='old')=>({id:'mac:12:34:56:78:90:AB',mac:'12:34:56:78:90:AB',nodeId,name:'Device',available:true,source:'mesh-wan-counters',scope:'internet',lastUpdateMs:time,totalBytesReceived:bytes,totalBytesSent:bytes/2,password:'never-save'});
  const apply=(rows,uptimeSeconds=100)=>monitor.applyFritz({host:'fritz.box',device:{uptimeSeconds},wan:{},hosts:[],mesh:{nodes:[{id:'node',mac:'12:34:56:78:90:AB',password:'never-save'}]},deviceTraffic:rows,deviceTrafficCapability:{available:true,source:'mesh-wan-counters',scope:'internet',reason:null,password:'never-save'}});
  apply([row(start,1000)]);assert.equal(monitor.state.fritzbox.deviceTraffic[0].rateAvailable,false);
  apply([row(start,1000)]);assert.equal(monitor.state.fritzbox.deviceTraffic[0].downloadMbps,null);
  apply([row(start+1000,201000,'new')]);let device=monitor.state.fritzbox.deviceTraffic[0];assert.equal(device.rateAvailable,true);assert.equal(device.downloadDeltaBytes,200000);assert.equal(device.downloadMbps,1.6);
  const persisted=monitor.history.snapshot().records.at(-1);assert.equal(persisted.deviceTraffic[0].downloadMbps,1.6);assert.equal(persisted.mesh.nodes[0].mac,'12:34:56:78:90:AB');assert.ok(!JSON.stringify(persisted).includes('never-save'));
  apply([row(start+100000,301000)]);assert.equal(monitor.state.fritzbox.deviceTraffic[0].rateAvailable,false);
  apply([row(start+101000,401000)],1);assert.equal(monitor.state.fritzbox.deviceTraffic[0].rateAvailable,false);
  apply([{...row(start+102000,501000),available:false}]);apply([row(start+103000,601000)]);assert.equal(monitor.state.fritzbox.deviceTraffic[0].rateAvailable,false);
  await monitor.reset();apply([row(start+104000,701000)]);assert.equal(monitor.state.fritzbox.deviceTraffic[0].rateAvailable,false);await monitor.close();
});

test('closing while the completed AI result is being saved cannot overwrite it with cancellation',async()=>{
  const monitor=new Monitor(fake);monitor.log({type:'ping',at:new Date().toISOString(),results:[{host:'192.168.1.1',ok:true,ms:2}]});
  const ai=new AnalysisController(monitor,{client:{check:async()=>ready,analyze:async()=> 'Keep completed diagnosis',cancel(){},close(){}}});
  let began,release;const started=new Promise(resolve=>{began=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const original=monitor.persistence.saveAnalysis.bind(monitor.persistence);
  monitor.persistence.saveAnalysis=async record=>{await original(record);if(record.status==='completed'){began();await gate;}};
  ai.start();await started;const id=ai.state.analysisId;
  const closing=ai.close();release();await closing;
  const saved=await monitor.persistence.getAnalysis(id);assert.equal(saved.status,'completed');assert.equal(saved.result,'Keep completed diagnosis');await monitor.close();
});

test('shutdown intent survives a hard exit while a slow non-abortable probe blocks final close',async t=>{
  const dataDir=await directory(t),monitorURL=new URL('../lib/monitor.js',import.meta.url).href;
  const script=`
    import {Monitor} from ${JSON.stringify(monitorURL)};
    const m=new Monitor({discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false,networks:[]}})},{dataDir:process.argv[1]});m.schedule=()=>{};await m.start();
    m.track(new Promise(()=>{}));
    await m.prepareClose({reason:'windows_shutdown'});const closing=m.close({reason:'normal'});
    console.log(JSON.stringify({id:m.persistence.currentSession.id,status:m.persistence.currentSession.status}));setInterval(()=>{},1000);
  `;
  const child=spawn(process.execPath,['--input-type=module','-e',script,dataDir],{stdio:['ignore','pipe','pipe'],windowsHide:true});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let output='',stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  const saved=await new Promise((resolve,reject)=>{
    child.on('error',reject);child.on('exit',code=>reject(new Error(`Child exited ${code}: ${stderr}`)));
    child.stdout.on('data',chunk=>{output+=chunk;const end=output.indexOf('\n');if(end>=0){try{resolve(JSON.parse(output.slice(0,end)));}catch(error){reject(error);}}});
  });
  assert.equal(saved.status,'closing');const stopped=once(child,'close');child.kill('SIGKILL');await stopped;
  const restart=new SessionStore({dataDir});await restart.start();const interrupted=restart.sessions.find(item=>item.id===saved.id);
  assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.reason,'shutdown_incomplete');assert.equal(interrupted.shutdownReason,'windows_shutdown');assert.ok(interrupted.shutdownRequestedAt);assert.equal(interrupted.endedAt,null);assert.ok(interrupted.detectedAt);
  const normal=new Monitor(fake,{dataDir});normal.schedule=()=>{};await normal.start();await normal.prepareClose({reason:'windows_shutdown'});
  const lastRecord=new Date().toISOString();await normal.persistence.notePersisted(lastRecord);assert.equal(normal.persistence.currentSession.lastRecordAt,lastRecord);
  await normal.close({reason:'normal'});
  assert.equal(normal.persistence.currentSession.reason,'windows_shutdown');assert.equal(normal.persistence.currentSession.status,'completed');assert.ok(normal.persistence.currentSession.endedAt);
});
