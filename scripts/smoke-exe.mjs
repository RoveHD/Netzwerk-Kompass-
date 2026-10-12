import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const sourceExecutable=process.argv[2]?path.resolve(process.argv[2]):path.join(root,'release',`Netzwerk-Kompass-Portable-${version}-x64.exe`);
await (await import('node:fs/promises')).mkdir(path.join(root,'test-artifacts'),{recursive:true});
const location=await mkdtemp(path.join(root,'test-artifacts','EXE Test ä '));
const executable=path.join(location,'Netzwerk-Kompass.exe');
await copyFile(sourceExecutable,executable);
const dataDir=path.join(location,'Netzwerk-Kompass-Daten');

async function start() {
  const child=spawn(executable,['--hidden-window','--diagnostics'],{cwd:location,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:'--this-must-be-removed-by-the-launcher',NODE_PATH:'Z:\\unavailable-node-modules',ELECTRON_RUN_AS_NODE:'1'}});
  let output='',errors='';
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  const url=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('EXE start timed out:\nSTDOUT:\n'+output+'\nSTDERR:\n'+errors)),70000);
    child.stderr.on('data',chunk=>{errors+=chunk;});
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/^http:\/\/127\.0\.0\.1:\d+$/m);if(match){clearTimeout(timer);resolve(match[0]);}});
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('EXE exited before readiness: '+code+' '+errors+' '+output));});
  }).catch(error=>{child.kill();throw error;});
  try {
  // Use this launcher's own trace; other app launches may create temp folders concurrently.
  const tempPaths=[...output.matchAll(/^LAUNCHER payload-extracted ([^\r\n]+)$/gm)].map(match=>path.resolve(match[1]));
  assert.equal(tempPaths.length,1,'one isolated runtime directory reported by this launcher');
  const temp=tempPaths[0];
  assert.equal(path.dirname(temp).toLowerCase(),path.resolve(os.tmpdir()).toLowerCase());
  assert.match(path.basename(temp),/^Netzwerk-Kompass-[a-f0-9]{32}$/i);
  assert.ok((await stat(temp)).isDirectory());
  for (const file of ['scripts/lag-hotkey.cs', 'scripts/lag-hotkey.ps1', 'scripts/game-packets.cs', 'desktop/native-hotkey.cjs']) {
    assert.ok((await stat(path.join(temp,file))).size>100, 'packaged native helper: '+file);
  }
  const html=await(await fetch(url)).text();
  const token=html.match(/name="api-token" content="([^"]+)/)?.[1];assert.ok(token);
  return {child,url,temp,exited,post:async(endpoint,body={})=>{
    const response=await fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':token},body:JSON.stringify(body)});
    assert.ok(response.ok,endpoint+' '+response.status);return response.json();
  }};
  } catch(error) { if(child.exitCode===null)child.kill();throw error; }
}

async function stop(app) {
  await app.post('/api/shutdown');
  let timer;
  try {
    const result=await Promise.race([app.exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('EXE did not exit')),15000);})]);
    assert.equal(result.code,0);assert.equal(result.signal,null);
    await assert.rejects(stat(app.temp),{code:'ENOENT'});
    await assert.rejects(fetch(app.url));
  } finally { clearTimeout(timer);if(app.child.exitCode===null)app.child.kill(); }
}

let app;
try {
  app=await start();
  const firstState=await(await fetch(app.url+'/api/state')).json();
  assert.equal(firstState.version,version);
  assert.equal(firstState.persistence.enabled,true);
  assert.equal(firstState.gamePackets.durationMs,0,'game tracking has no default time limit');
  const startup=await(await fetch(app.url+'/api/startup')).json();
  assert.equal(startup.enabled,true,'autostart is the default preference');
  assert.equal(startup.available,false,'hidden test must not modify Windows autostart');
  const firstSessionId=firstState.persistence.currentSession.id;
  assert.ok(firstState.network.interfaces.length>0,'real Windows adapters discovered');
  await app.post('/api/targets',{host:'127.0.0.1',label:'Portable persistence smoke'});
  const reset=await app.post('/api/reset');
  assert.ok(reset.measurementStartedAt);
  await stop(app);app=null;
  const settings=JSON.parse(await readFile(path.join(dataDir,'settings.json'),'utf8'));
  assert.ok(settings.targets.some(target=>target.host==='127.0.0.1'));
  assert.equal(settings.measurementStartedAt,reset.measurementStartedAt);
  const initialHistory=await readFile(path.join(dataDir,'history.jsonl'),'utf8');assert.ok(initialHistory.length>0);
  app=await start();
  const restarted=await(await fetch(app.url+'/api/state')).json();
  assert.ok(restarted.targets.some(target=>target.host==='127.0.0.1'&&target.label==='Portable persistence smoke'));
  assert.equal(restarted.measurementStartedAt,reset.measurementStartedAt);
  assert.notEqual(restarted.persistence.currentSession.id,firstSessionId);
  const previousSession=restarted.persistence.sessions.find(session=>session.id===firstSessionId);
  assert.equal(previousSession.status,'completed');assert.equal(previousSession.reason,'normal');
  assert.ok(previousSession.lastPersistedAt);assert.ok(previousSession.endedAt);
  for (const asset of ['overview-details.js','dashboard.css','live-signal.js','live-signal.css','ui-presentation.js','ui-help.js','graphite.css','workspace.css','workspace-panels.css','ai.js','storage.js','traffic-history.js','network-health.js','network-health.css','game-comparison.js','game-comparison.css','lag-incidents.js','lag-incidents.css','ping-chart.js','ping-chart.css','lag-hotkey.js']) {
    assert.equal((await fetch(app.url+'/'+asset)).status,200,'packaged UI asset: '+asset);
  }
  assert.equal((await fetch(app.url+'/api/analysis/archive')).status,200);
  for (const name of ['geist-variable.woff2','geist-mono-variable.woff2']) {
    const font = await fetch(app.url+'/fonts/'+name);
    assert.equal(font.status,200,'packaged font: '+name);
    assert.ok(font.headers.get('content-type').startsWith('font/woff2'));
  }
  assert.equal((await fetch(app.url+'/api/analysis/report?hours=1')).status,200);
  await stop(app);app=null;
  const result={version,portableSingleFile:true,desktopWindowLoaded:true,spacesAndUmlauts:true,nodeEnvironmentCleared:true,windowsAdapters:firstState.network.interfaces.length,persistence:true,resetPreserved:true,sessionRestart:true,autostartDefault:true,realAutostartUntouched:true,cleanShutdown:true,tempCleanup:true,lagFeatureAssets:true,nativeHelpersPackaged:true,location};
  await writeFile(path.join(location,'verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally { if(app&&app.child.exitCode===null)app.child.kill(); }
