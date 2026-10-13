import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp, attachPeerMonitoring } from '../server.js';
import { createPeerMonitor } from '../lib/peer-monitor.js';
import { pinnedRequest } from '../lib/peer-tls.js';
import { Monitor } from '../lib/monitor.js';

function secrets() { const values=new Map();return {async read(name){return structuredClone(values.get(name)||null);},async write(name,value){values.set(name,structuredClone(value));}}; }
function tracker() {
  let state={status:'idle',game:null};const calls=[];
  return {calls,onFinish:()=>{},snapshot:()=>structuredClone(state),setStatus(status){state.status=status;},
    async start(options){calls.push(options);state={status:'starting',game:options.game};return this.snapshot();},
    finish(status='stopped'){state={...state,status,endedAt:new Date().toISOString(),reason:'Test beendet',sentPackets:3,receivedPackets:4};this.onFinish(this.snapshot());},
    async stop(){if(['starting','recording','stopping'].includes(state.status))this.finish();return this.snapshot();},
    async reset(){state={status:'idle',game:null};},async close(){await this.stop();}};
}
async function fixture(t,{withPeers=false}={}) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'kompass-api-peer-'));
  const monitor=new Monitor({}),manual=tracker(),automatic=tracker();
  const peers=withPeers?createPeerMonitor({dataDir:dir,secretStore:secrets(),autoFlush:false}):null;
  if(peers)await peers.initialize();
  let clock=Date.now();
  const server=createApp(monitor,{token:'integration-token',peers,packetTracker:manual,incidentPacketTracker:automatic,now:()=>clock});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await Promise.all([server.closeGameCapture(),server.closePeers()]);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();await rm(dir,{recursive:true,force:true});});
  return {monitor,manual,automatic,peers,server,base,advance(ms){clock+=ms;},
    get:async route=>(await fetch(base+route)).json(),
    post:(route,body={},headers={})=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json','x-api-token':'integration-token',...headers},body:JSON.stringify(body)}),
    incident(id='incident-1'){monitor.applyIncident({kind:'started',incident:{id,startedAt:new Date().toISOString()}});}};
}
function activeGame(f) {
  f.monitor.state.gameDetection.active=[{id:'test-game',sessionId:'game-session',name:'Testspiel'}];
  f.monitor.gameProcesses=()=>[{pid:4242,startedAt:new Date().toISOString()}];
}

test('all new mutation routes retain token, origin and body bounds; peer snapshots exclude records and secrets',async t=>{
  const f=await fixture(t,{withPeers:true});
  const routes=['/api/peers/configure','/api/peers/pairing','/api/peers/pair','/api/peers/revoke','/api/measurement','/api/history-policy','/api/fritzbox/forget','/api/incident-capture'];
  for(const route of routes)assert.equal((await f.post(route,{}, {'x-api-token':'wrong'})).status,403,route);
  assert.equal((await f.post('/api/peers/configure',{}, {origin:'https://foreign.example'})).status,403);
  assert.equal((await f.post('/api/peers/configure',{padding:'x'.repeat(9000)})).status,413);
  assert.equal((await f.post('/api/peers/configure',{enabled:true,role:'central',listenHost:'127.0.0.1',port:0})).status,200);
  const invitation=await(await f.post('/api/peers/pairing')).json();
  assert.equal(invitation.secret.length,43);
  const state=await f.get('/api/state'),peerState=await f.get('/api/peers');
  assert.equal(state.peers.records,undefined);assert.equal(peerState.records,undefined);
  assert.ok(!JSON.stringify(state).includes(invitation.secret));assert.ok(!JSON.stringify(peerState).includes('PRIVATE KEY'));
  await assert.rejects(pinnedRequest({address:'127.0.0.1',port:invitation.port,pin:invitation.pin},'/api/measurement',{mode:'precision'}),/Messendpunkt/);
  await f.server.closePeers();assert.equal(f.peers.snapshot().listening,false);
});

test('measurement, policy, incident archive, rollup and forget routes invoke monitor contracts',async t=>{
  const f=await fixture(t);let forgotten=false;
  f.monitor.forgetRouter=async()=>{forgotten=true;return {enabled:false};};
  f.monitor.listIncidents=()=>[{id:'archived-incident'}];
  f.monitor.state.incidents=Array.from({length:10},(_,index)=>({id:`incident-${index}`}));
  assert.equal((await f.post('/api/measurement',{mode:'precision'})).status,200);
  assert.equal(f.monitor.state.measurement.mode,'precision');
  assert.equal((await f.post('/api/measurement',{mode:'unbounded'})).status,400);
  assert.equal((await f.post('/api/history-policy',{pingHours:0})).status,400);
  assert.equal((await f.post('/api/history-policy',{pingHours:48})).status,200);
  assert.equal((await f.post('/api/fritzbox/forget')).status,200);assert.equal(forgotten,true);
  assert.deepEqual((await f.get('/api/incidents')).incidents,[{id:'archived-incident'}]);
  assert.equal((await f.get('/api/state')).incidents.length,5);assert.equal((await f.get('/api/export')).incidents.length,10);
  assert.ok(Array.isArray(await f.get('/api/rollups')));
  for(const asset of ['incident-view.js','incident-view.css','diagnostic-settings.js','diagnostic-settings.css','peer-monitor.js','peer-monitor.css','background-monitor.js']){
    const response=await fetch(`${f.base}/${asset}`);assert.equal(response.status,200,asset);assert.ok((await response.text()).length>0);
  }
});

test('local monitor records reach TLS peer while received records replay once and stay out of local charts',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'kompass-peer-monitor-integration-'));
  const central=createPeerMonitor({dataDir:path.join(dir,'central'),secretStore:secrets(),autoFlush:false});
  const agent=createPeerMonitor({dataDir:path.join(dir,'agent'),secretStore:secrets(),autoFlush:false});
  const local=new Monitor({}),remote=new Monitor({});let detachLocal=()=>{},detachRemote=()=>{};
  t.after(async()=>{detachLocal();detachRemote();await agent.close();await central.close();await local.close();await remote.close();await rm(dir,{recursive:true,force:true});});
  await central.initialize();await agent.initialize();
  await central.configure({enabled:true,role:'central',listenHost:'127.0.0.1',port:0});
  await agent.configure({enabled:true,role:'agent'});
  await agent.pair({...await central.createPairing(),address:'127.0.0.1'});
  detachLocal=await attachPeerMonitoring(local,agent);detachRemote=await attachPeerMonitoring(remote,central);
  local.log({type:'ping',at:new Date().toISOString(),results:[{host:'192.168.1.1',kind:'gateway',ok:true,ms:5}]});
  await agent.queue;await agent.flush();
  const peerRecords=remote.history.entries.map(entry=>JSON.parse(entry.json)).filter(record=>record.remote);
  assert.equal(peerRecords.length,1);assert.equal(peerRecords[0].sourceDeviceId,agent.snapshot().deviceId);
  assert.ok(!remote.historySnapshot(1).records.some(record=>record.remote));
  detachRemote();detachRemote=await attachPeerMonitoring(remote,central);
  assert.equal(remote.history.entries.map(entry=>JSON.parse(entry.json)).filter(record=>record.remote).length,1);
  local.ingestPeer(peerRecords[0]);await agent.queue;assert.equal(agent.snapshot().outboxCount,0);
  const app=createApp(remote,{peers:central});app.listen(0,'127.0.0.1');await once(app,'listening');
  try {const exported=await(await fetch(`http://127.0.0.1:${app.address().port}/api/export`)).json();assert.equal(exported.peerMeasurements.length,1);assert.equal(exported.history.records.filter(record=>record.remote).length,0);}
  finally{app.closeAllConnections();await new Promise(resolve=>app.close(resolve));await app.closeGameCapture();}
});

test('automatic metadata capture is opt-in, one-shot, persisted and mutually exclusive with manual capture',async t=>{
  const f=await fixture(t);activeGame(f);
  assert.equal((await f.get('/api/state')).incidentCapture.enabled,false);
  f.incident();assert.equal(f.automatic.calls.length,0);
  assert.equal((await f.post('/api/incident-capture',{enabled:true,sessionId:'game-session'})).status,200);
  f.manual.setStatus('recording');f.incident('manual-busy');assert.equal(f.automatic.calls.length,0);
  f.manual.setStatus('idle');f.incident('automatic-1');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.automatic.calls.length,1);assert.equal(f.automatic.calls[0].elevate,true);assert.equal(f.automatic.calls[0].processes[0].pid,4242);
  const state=await f.get('/api/state');assert.equal(state.incidentCapture.enabled,false);assert.equal(state.incidentCapture.durationMs,15000);
  assert.equal((await f.post('/api/games/capture/start',{sessionId:'game-session'})).status,409);
  f.automatic.finish();f.incident('automatic-2');assert.equal(f.automatic.calls.length,1);
  assert.equal(f.monitor.state.events.filter(event=>event.kind==='incident-packets').length,1);
  assert.equal(f.monitor.state.events[0].capture.deliveryBeyondRouter,'unknown');
  assert.equal((await f.post('/api/incident-capture',{enabled:true})).status,400);
  f.advance(600001);assert.equal((await f.post('/api/incident-capture',{enabled:true})).status,200);
  await f.post('/api/games/capture/stop');f.incident('after-stop');assert.equal(f.automatic.calls.length,1);
});

test('capture reports missing or ambiguous games and never retries an admin failure unattended',async t=>{
  const f=await fixture(t);
  await f.post('/api/incident-capture',{enabled:true});f.incident();
  assert.equal((await f.get('/api/state')).incidentCapture.status,'waiting-game');assert.equal(f.automatic.calls.length,0);
  activeGame(f);f.monitor.state.gameDetection.active.push({id:'other',sessionId:'other-session',name:'Other'});f.incident();
  assert.equal((await f.get('/api/state')).incidentCapture.status,'selection-required');assert.equal(f.automatic.calls.length,0);
  await f.post('/api/incident-capture',{enabled:true,sessionId:'game-session'});f.incident();await new Promise(resolve=>setImmediate(resolve));
  f.automatic.finish('needs-admin');f.advance(600001);f.incident('later');
  assert.equal(f.automatic.calls.length,1);assert.equal((await f.get('/api/state')).incidentCapture.enabled,false);
  await f.server.closeGameCapture();f.incident('after-close');assert.equal(f.automatic.calls.length,1);
});

test('packaging includes private-store helper, background dependencies and every new public module',async()=>{
  const portable=await readFile(new URL('../scripts/build-portable.ps1',import.meta.url),'utf8');
  const builder=JSON.parse(await readFile(new URL('../electron-builder.json',import.meta.url),'utf8'));
  assert.ok(builder.files.includes('scripts/secret-store.ps1'));assert.ok(builder.files.includes('desktop/*.cjs'));assert.ok(builder.files.includes('public/*.js'));
  for(const file of ['secret-store.ps1','background.cjs','background-server.cjs','server-lifecycle.cjs','incident-view.js','incident-view.css','diagnostic-settings.js','diagnostic-settings.css','peer-monitor.js','peer-monitor.css','background-monitor.js'])assert.ok(portable.includes(`'${file}'`),file);
});
