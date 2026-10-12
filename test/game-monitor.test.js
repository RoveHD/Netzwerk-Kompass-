import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Monitor } from '../lib/monitor.js';

const fake = {discoverNetwork:async()=>({interfaces:[],neighbors:[],wifi:{connected:false},warnings:[]}),pingMany:async()=>[],getTrafficCounters:async()=>[]};
const marvel = {id:555,name:'Marvel-Win64-Shipping',path:'C:\\SecretUser\\Marvel\\Marvel-Win64-Shipping.exe',startedAt:'2026-10-12T10:00:00.1234567Z'};
const scan = (processes=[marvel]) => ({processes,steamRoots:[],epicRoots:[],partial:false,truncated:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
function monitor(probes={},options={}) {
  const value=new Monitor({...fake,getGameProcesses:async()=>scan(),...probes},options);
  value.schedule=()=>{};value.scheduleGames=()=>{};
  value.gameLibrary.load=async()=>({games:[],partial:false});
  return value;
}

test('game polling is single flight, separate from ping and projections never leak process data',async()=>{
  const gate=deferred();let count=0;
  const m=monitor({getGameProcesses:()=>{count++;return gate.promise;}});
  try {
    await m.start();m.maintenance=async()=>{};
    const first=m.refreshGames(),second=m.refreshGames();assert.equal(first,second);assert.equal(count,1);
    await m.tick();assert.equal(m.state.lastError,null);
    gate.resolve(scan());await first;
    const game=m.state.gameDetection.active[0];assert.equal(game.name,'Marvel Rivals');assert.notEqual(game.startedAt,marvel.startedAt);
    assert.deepEqual(m.gameProcessIds(game.sessionId),[555]);assert.deepEqual(m.gameProcesses(game.sessionId),[{pid:555,startedAt:marvel.startedAt}]);
    const mark=m.markLag('lag fixture');assert.ok(mark.detail.includes('Marvel Rivals'));assert.deepEqual(mark.gameSessionIds,[game.sessionId]);
    for(const type of ['ping','traffic','dns'])m.log({type,at:new Date().toISOString()});
    for(const type of ['ping','traffic','dns'])assert.deepEqual(m.historySnapshot().records.findLast(record=>record.type===type).gameSessionIds,[game.sessionId]);
    const serialized=JSON.stringify({state:m.snapshot(),history:m.historySnapshot()});
    for(const forbidden of ['SecretUser','Marvel-Win64-Shipping','"pid"','"processes"','"path"','1234567'])assert.ok(!serialized.includes(forbidden));
    const visible=m.state.events.find(event=>event.kind==='game');const logged=m.historySnapshot().records.find(event=>event.kind==='game');
    for(const field of ['game','kind','action','at','level','title','detail','gameSessionIds'])assert.deepEqual(visible[field],logged[field]);
    await m.reset();assert.equal(m.state.gameDetection.active[0].sessionId,game.sessionId);
  } finally {await m.close();}
});

test('settings preserve other configuration and restore on restart; invalid settings never execute',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'game-settings-test-'));let first,second;
  try {
    await writeFile(path.join(directory,'settings.json'),JSON.stringify({unrelated:{preserve:true},gameDetection:{enabled:false,customGames:[{name:'My fixture',executable:'Fixture.exe'}]}}));
    first=monitor({}, {dataDir:directory});await first.start();assert.equal(first.state.gameDetection.enabled,false);assert.equal(first.state.gameDetection.status,'disabled');
    await first.setGameDetection({enabled:true,customGames:[{name:'My new fixture',executable:'NewGame.exe'}]});
    first.addTarget('example.com','My target');await first.saveQueue;await first.close();
    const saved=JSON.parse(await readFile(path.join(directory,'settings.json'),'utf8'));assert.deepEqual(saved.unrelated,{preserve:true});assert.equal(saved.gameDetection.enabled,true);assert.equal(saved.gameDetection.customGames[0].executable,'NewGame.exe');
    second=monitor({}, {dataDir:directory});await second.start();assert.deepEqual(second.state.gameDetection.customGames,saved.gameDetection.customGames);
    const before=structuredClone(second.state.gameDetection);await assert.rejects(second.setGameDetection({enabled:true,customGames:[{name:'Unsafe',executable:'C:\\unsafe.exe'}]}));assert.deepEqual(second.state.gameDetection,before);
    await second.setGameDetection({enabled:false,customGames:[]});assert.equal(second.state.gameDetection.status,'disabled');
  } finally {
    await first?.close();await second?.close();
    assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('game-settings-test-'));await rm(directory,{recursive:true,force:true});
  }
});

test('corrupt persisted game settings recover safely with default enabled configuration',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'game-settings-test-'));let m;
  try {
    await writeFile(path.join(directory,'settings.json'),JSON.stringify({gameDetection:{enabled:false,customGames:[{name:'Bad',executable:'C:\\bad.exe'}]}}));
    m=monitor({}, {dataDir:directory});await m.start();assert.equal(m.state.gameDetection.enabled,true);assert.deepEqual(m.state.gameDetection.customGames,[]);assert.match(m.state.gameDetection.warning,/ungültig/);
  } finally {await m?.close();assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('game-settings-test-'));await rm(directory,{recursive:true,force:true});}
});

test('probe errors keep observed sessions, sanitize error text and allow recovery; missing start time is unusable for capture',async()=>{
  let result=scan(),failure=false;const m=monitor({getGameProcesses:async()=>{if(failure)throw new Error('C:\\PRIVATE\\process.exe secret');return result;}});
  try {
    await m.refreshGames();const game=m.state.gameDetection.active[0],checked=m.state.gameDetection.checkedAt;
    failure=true;await m.refreshGames();assert.equal(m.state.gameDetection.status,'error');assert.equal(m.state.gameDetection.active[0].sessionId,game.sessionId);assert.equal(m.state.gameDetection.checkedAt,checked);assert.ok(!JSON.stringify(m.snapshot()).includes('PRIVATE'));assert.deepEqual(m.gameProcesses(game.sessionId),[]);
    failure=false;await m.refreshGames();assert.equal(m.state.gameDetection.active[0].sessionId,game.sessionId);assert.deepEqual(m.gameProcesses(game.sessionId),[{pid:555,startedAt:marvel.startedAt}]);
    result=scan([{...marvel,startedAt:null}]);await m.refreshGames();assert.equal(m.state.gameDetection.status,'partial');assert.deepEqual(m.gameProcesses(m.state.gameDetection.active[0].sessionId),[]);
    m.state.gameDetection.checkedAt=new Date(Date.now()-16000).toISOString();assert.deepEqual(m.gameProcessIds(m.state.gameDetection.active[0].sessionId),[]);
  } finally {await m.close();}
});

test('configuration and shutdown invalidate delayed collector successes and failures without hanging',async()=>{
  for(const close of [false,true])for(const failure of [false,true]){
    const gate=deferred();let signal;const m=monitor();await m.refreshGames();const game=m.state.gameDetection.active[0];
    m.probes={...fake,getGameProcesses:options=>{signal=options.signal;return gate.promise;}};
    const pending=m.refreshGames();
    if(close)await m.close();else await m.setGameDetection({enabled:false,customGames:[]});
    assert.equal(signal.aborted,true);assert.equal(m.state.gameDetection.active.length,0);assert.deepEqual(m.gameProcessIds(game.sessionId),[]);
    if(failure)gate.reject(new Error('C:\\private'));else gate.resolve(scan());await pending;
    assert.equal(m.state.gameDetection.status,'disabled');assert.equal(m.state.gameDetection.error,null);
    assert.equal(m.state.gameDetection.recent[0].reason,close?'app-closed':'disabled');assert.equal(m.state.events.find(event=>event.kind==='game').action,'observation-ended');
    await m.close();
  }
});

test('configuration change during library read cannot apply an old scan, and replacement scan can recover',async()=>{
  const m=monitor();const gate=deferred();m.gameLibrary.load=()=>gate.promise;
  try {
    const pending=m.refreshGames();await Promise.resolve();
    await m.setGameDetection({enabled:true,customGames:[{name:'Other fixture',executable:'OtherGame.exe'}]});await pending;
    gate.resolve({games:[],partial:false});await Promise.resolve();assert.equal(m.state.gameDetection.active.length,0);
    m.gameLibrary.load=async()=>({games:[],partial:false});await m.refreshGames();assert.equal(m.state.gameDetection.active[0].name,'Marvel Rivals');
    await m.setGameDetection({enabled:true,customGames:[]});assert.equal(m.state.gameDetection.recent[0].reason,'configuration-changed');
    await m.refreshGames();assert.equal(m.state.gameDetection.active[0].name,'Marvel Rivals');
  } finally {await m.close();}
});

test('unsupported environments and manual disabled state never start collectors',async()=>{
  const m=monitor({getGameProcesses:undefined});try{await m.refreshGames();assert.equal(m.state.gameDetection.status,'unsupported');await m.setGameDetection({enabled:false,customGames:[]});await m.refreshGames();assert.equal(m.state.gameDetection.status,'disabled');}finally{await m.close();}
});
