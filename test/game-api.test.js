import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../server.js';
import {Monitor} from '../lib/monitor.js';

async function fixture() {
  const monitor=new Monitor({});
  const calls=[];
  const tracker={snapshot:()=>({status:'idle'}),start:async value=>{calls.push(value);return {status:'starting'};},stop:async()=>({status:'stopped'}),reset:async()=>({status:'idle'}),close:async()=>{}};
  const server=createApp(monitor,{token:'game-test',packetTracker:tracker});server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  return {monitor,tracker,calls,base,post:(endpoint,body,headers={})=>fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'game-test',...headers},body:JSON.stringify(body)}),close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();}};
}

test('capture API uses only a verified active game and rejects untrusted process IDs and cross-origin actions',async()=>{
  const f=await fixture();
  try {
    f.monitor.state.gameDetection.active=[{id:'marvel',name:'Marvel Rivals',sessionId:'game-1'}];
    const processes=[{pid:4242,startedAt:'2026-10-12T00:00:00Z'}];f.monitor.gameProcesses=()=>processes;
    assert.equal((await f.post('/api/games/capture/start',{sessionId:'game-1'},{'X-Api-Token':'bad'})).status,403);
    assert.equal((await f.post('/api/games/capture/start',{sessionId:'game-1'},{Origin:'https://example.org'})).status,403);
    assert.equal((await f.post('/api/games/capture/start',{sessionId:'missing'})).status,400);
    const start=await f.post('/api/games/capture/start',{sessionId:'game-1',processes:[{pid:999}],game:{name:'injected'}});
    assert.equal(start.status,202);assert.deepEqual(f.calls,[{game:{id:'marvel',name:'Marvel Rivals',sessionId:'game-1'},processes,elevate:true}]);
    f.monitor.gameProcesses=()=>[];
    assert.equal((await f.post('/api/games/capture/start',{sessionId:'game-1'})).status,400);
    assert.equal((await(await fetch(f.base+'/api/state')).json()).gamePackets.status,'idle');
    const state=await(await fetch(f.base+'/api/export')).json();assert.equal(state.gamePackets.status,'idle');
  }finally{await f.close();}
});

test('invalid rules do not stop a capture; valid game settings and stop are serialized',async()=>{
  const f=await fixture();let stopped=0;f.tracker.stop=async()=>{stopped++;return {status:'stopped'};};
  try {
    assert.equal((await f.post('/api/games/settings',{enabled:true,customGames:[{name:'bad',executable:'../bad.exe'}]})).status,400);assert.equal(stopped,0);
    assert.equal((await f.post('/api/games/settings',{enabled:false,customGames:[{name:'Testspiel',executable:'Testspiel.exe'}]})).status,200);assert.equal(stopped,1);assert.equal(f.monitor.state.gameDetection.enabled,false);
    let release,entered;const waiting=new Promise(resolve=>{entered=resolve;});f.tracker.stop=()=>new Promise(resolve=>{release=resolve;entered();});
    const first=f.post('/api/games/capture/stop',{});await waiting;
    assert.equal((await f.post('/api/games/capture/stop',{})).status,409);
    release({status:'stopped'});assert.equal((await first).status,200);
  }finally{await f.close();}
});
