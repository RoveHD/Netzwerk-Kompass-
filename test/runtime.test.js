import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dataDirectory, attachLauncherShutdown } from '../lib/runtime.js';
import { Monitor } from '../lib/monitor.js';

test('portable data stays outside the extracted app and preserves spaces and umlauts',()=>{
  const app=path.resolve('temporary-runtime');
  const portable=path.resolve('Test mit Leerzeichen ä','Netzwerk-Kompass-Daten');
  assert.equal(dataDirectory(app,{}),path.join(app,'data'));
  assert.equal(dataDirectory(app,{NETZWERK_KOMPASS_DATA_DIR:portable}),portable);
  assert.throws(()=>dataDirectory(app,{NETZWERK_KOMPASS_DATA_DIR:'relative-data'}),/absoluter Pfad/);
});

test('launcher shutdown command survives split chunks and closes only once',()=>{
  const input=new PassThrough();const reasons=[];
  attachLauncherShutdown(input,reason=>reasons.push(reason));
  input.write('unknown\nshut');assert.deepEqual(reasons,[]);
  input.write('down\r\n');assert.deepEqual(reasons,['normal']);
  input.end('shutdown:windows_shutdown\n');assert.deepEqual(reasons,['normal']);
});

test('launcher reports confirmed Windows shutdown and distinguishes lost pipe',async()=>{
  const windows=new PassThrough();const reasons=[];
  attachLauncherShutdown(windows,reason=>reasons.push(reason));
  windows.write('shutdown:windows_');windows.write('shutdown\n');
  assert.deepEqual(reasons,['windows_shutdown']);
  const lost=new PassThrough();
  attachLauncherShutdown(lost,reason=>reasons.push(reason));
  lost.end();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(reasons,['windows_shutdown','launcher_lost']);
});

test('lost launcher pipe stops the app and listener disposal does not',async()=>{
  const input=new PassThrough();let calls=0;
  attachLauncherShutdown(input,()=>calls++);
  input.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  const another=new PassThrough();const dispose=attachLauncherShutdown(another,()=>calls++);
  dispose();another.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('startup failure exits even when the launcher still holds stdin open',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'network-startup-test-'));
  const blocked=path.join(folder,'not-a-directory');await writeFile(blocked,'isolated fixture');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.js',import.meta.url)),'--launcher','--no-browser'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,NETZWERK_KOMPASS_DATA_DIR:blocked}});
  let stderr='',timer;child.stderr.on('data',chunk=>{stderr+=chunk;});
  try {
    const code=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Failed startup kept waiting on launcher stdin: ${stderr}`)),5000);
      child.once('error',reject);child.once('exit',resolve);
    });
    assert.equal(code,1);assert.match(stderr,/Start fehlgeschlagen/);
    assert.match(stderr,/EEXIST|ENOTDIR/);
    assert.doesNotMatch(stderr,/UnhandledPromiseRejection/);
  }finally{clearTimeout(timer);child.kill();child.stdin.destroy();await rm(folder,{recursive:true,force:true});}
});

test('failed rollup flush still closes incident analysis and history, draining session storage',async()=>{
  const calls=[],failure=new Error('isolated rollup write failure');
  const monitor=new Monitor({close(){calls.push('probe');}});
  monitor.persistence={requestClose:async()=>calls.push('intent'),get queue(){calls.push('session-queue');return Promise.resolve();},close:async()=>calls.push('session')};
  monitor.incidentService={close:async()=>calls.push('incident')};
  monitor.rollups.flush=async()=>{calls.push('rollup');throw failure;};
  monitor.history.close=async()=>calls.push('history');
  const closing=monitor.close({reason:'startup_error'});
  assert.equal(monitor.close(),closing);
  await assert.rejects(closing,error=>error===failure);
  assert.deepEqual(calls,['probe','intent','incident','rollup','history','session-queue']);
  assert.equal(monitor.closed,true);assert.equal(monitor.abort.signal.aborted,true);
});

test('failed immediate stop and shutdown intent do not prevent remaining resource cleanup',async()=>{
  const calls=[],failure=new Error('isolated probe stop failure');
  const monitor=new Monitor({close(){calls.push('probe');throw failure;}});
  monitor.persistence={requestClose:async()=>{calls.push('intent');throw new Error('isolated intent write failure');},get queue(){calls.push('session-queue');return Promise.resolve();},close:async()=>calls.push('session')};
  monitor.incidentService={close:async()=>calls.push('incident')};
  monitor.rollups.flush=async()=>calls.push('rollup');
  monitor.history.close=async()=>calls.push('history');
  const closing=monitor.close();
  await assert.rejects(closing,error=>error instanceof AggregateError&&error.errors.includes(failure));
  assert.deepEqual(calls,['probe','intent','incident','rollup','history','session-queue']);
  assert.equal(monitor.closed,true);assert.equal(monitor.abort.signal.aborted,true);
  assert.equal(monitor.state.fritzbox.connected,false);
});

test('failed durable close retains shutdown intent and restart records shutdown_incomplete',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'network-close-durability-'));
  const fake={discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false,networks:[]}})};
  const monitor=new Monitor(fake,{dataDir:folder}),restarted=new Monitor(fake,{dataDir:folder});
  for(const item of [monitor,restarted]){item.schedule=()=>{};item.scheduleGames=()=>{};}
  const failure=new Error('isolated rollup durability failure');
  try {
    await monitor.start();const id=monitor.persistence.currentSession.id;
    monitor.rollups.flush=async()=>{throw failure;};
    await assert.rejects(monitor.close({reason:'windows_shutdown'}),error=>error===failure);
    const saved=JSON.parse(await readFile(path.join(folder,'sessions',monitor.persistence.filename(monitor.persistence.currentSession)),'utf8'));
    assert.equal(saved.status,'closing');assert.equal(saved.shutdownReason,'windows_shutdown');assert.equal(saved.endedAt,null);
    await restarted.start();
    const recovered=restarted.persistence.sessions.find(session=>session.id===id);
    assert.equal(recovered.status,'interrupted');assert.equal(recovered.reason,'shutdown_incomplete');assert.equal(recovered.endedAt,null);
  } finally {
    await monitor.close().catch(error=>assert.equal(error,failure));await restarted.close();
    assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
    await rm(folder,{recursive:true,force:true});
  }
});

for(const storage of ['raw','history'])test(`caught ${storage} write failure cannot mark a session completed`,async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'network-caught-write-'));
  let probeClosed=false;
  const monitor=new Monitor({close(){probeClosed=true;},discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false,networks:[]}})},{dataDir:folder});
  monitor.schedule=()=>{};monitor.scheduleGames=()=>{};
  t.after(async()=>{
    await monitor.close().catch(()=>{});
    assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
    await rm(folder,{recursive:true,force:true});
  });
  await monitor.start();await monitor.flushRaw();
  if(monitor.history.flushPromise)await monitor.history.flushPromise;
  if(storage==='raw') {
    const file=path.join(folder,`messungen-${new Date().toISOString().slice(0,10)}.jsonl`);
    await rm(file,{force:true});await mkdir(file);
  } else {
    monitor.history.file=path.join(folder,'blocked-history');await mkdir(monitor.history.file);
  }
  monitor.log({type:'event',at:new Date().toISOString(),title:'Isolated failed write fixture'});
  await monitor.flushRaw();if(monitor.history.flushPromise)await monitor.history.flushPromise;
  const message=storage==='raw'?monitor.logError:monitor.history.lastError;
  assert.match(message,/konnte nicht gespeichert werden/);
  await assert.rejects(monitor.close({reason:'windows_shutdown'}),error=>error.message.includes(storage==='raw'?monitor.logError:monitor.history.lastError));
  assert.equal(probeClosed,true);assert.equal(monitor.history.closed,true);assert.equal(monitor.incidentService.status().running,false);
  const session=JSON.parse(await readFile(path.join(folder,'sessions',monitor.persistence.filename(monitor.persistence.currentSession)),'utf8'));
  assert.equal(session.status,'closing');assert.equal(session.shutdownReason,'windows_shutdown');assert.equal(session.endedAt,null);
});

test('successful final history retry clears the write error and permits completed session',async t=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'network-recovered-write-'));
  const monitor=new Monitor({discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false,networks:[]}})},{dataDir:folder});
  monitor.schedule=()=>{};monitor.scheduleGames=()=>{};
  t.after(async()=>{
    await monitor.close();
    assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));
    await rm(folder,{recursive:true,force:true});
  });
  await monitor.start();await monitor.flushRaw();if(monitor.history.flushPromise)await monitor.history.flushPromise;
  const file=monitor.history.file;
  monitor.history.file=path.join(folder,'blocked-history');await mkdir(monitor.history.file);
  monitor.log({type:'event',at:new Date().toISOString(),title:'Isolated recoverable write fixture'});
  await monitor.history.flushPromise;
  assert.match(monitor.history.lastError,/konnte nicht gespeichert werden/);
  monitor.history.file=file;
  await monitor.close();
  assert.equal(monitor.history.lastError,null);assert.equal(monitor.persistence.currentSession.status,'completed');
});
