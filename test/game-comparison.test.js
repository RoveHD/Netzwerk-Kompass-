import test from 'node:test';
import assert from 'node:assert/strict';
import { collectGameSessions, compareGameSessions } from '../public/game-comparison.js';

const at = minute => new Date(Date.UTC(2026,0,1,0,minute)).toISOString();
const session = (sessionId, startedAt, endedAt=null, name='Spiel') => ({sessionId,startedAt,endedAt,name});
const marker = (game, action, minute) => ({type:'event',kind:'game',action,at:at(minute),game:{...game,...(action==='ended'?{endedAt:at(minute)}:{})}});
const ping = (minute, results) => ({type:'ping',at:at(minute),results});
const result = (host, ok, ms, status='Success') => ({host,label:host,kind:'gateway',ok,ms,status});
const recordsFor = (sid, offset, host='192.0.2.1') => Array.from({length:6},(_,index)=>ping(offset+index,[result(host,true,[10,20,30,40,50,60][index]) ]));

test('builds distinct sessions from start/end history and merges live sessions without losing an end marker',()=>{
  const first=session('same-game-a',at(1),at(15),'Testspiel'),second=session('same-game-b',at(20),null,'Testspiel');
  const records=[marker(first,'started',1),marker(first,'ended',15),marker(second,'started',20)];
  const sessions=collectGameSessions(records,{active:[{...second,lastSeenAt:at(25)}]},{from:at(0),to:at(30),now:Date.UTC(2026,0,1,0,30)});
  assert.equal(sessions.length,2);
  assert.equal(sessions.find(item=>item.sessionId===first.sessionId).endedAt,at(15));
  assert.equal(sessions.find(item=>item.sessionId===second.sessionId).startedAt,at(20));
});

test('uses valid attempts only, separates losses from measurement errors, and does not invent samples across gaps',()=>{
  const a=session('a',at(0),at(20)),b=session('b',at(30),at(50));
  const left=[...recordsFor('a',1),ping(8,[result('192.0.2.1',false,null,'TimedOut')]),ping(9,[result('192.0.2.1',false,null,'measurement_error')]),ping(10,[result('192.0.2.1',null,null,'Success')])];
  const right=[...recordsFor('b',31),ping(38,[result('192.0.2.1',false,null,'TimedOut')]),ping(39,[result('192.0.2.1',false,null,'measurement_error')])];
  const comparison=compareGameSessions([...left,...right],a,b,{from:at(0),to:at(60),truncated:false});
  assert.equal(comparison.comparable,true);
  const target=comparison.targets[0];
  assert.equal(target.a.replies,6);assert.equal(target.a.losses,1);assert.equal(target.a.errors,1);assert.equal(target.a.attempts,7);
  assert.equal(target.a.average,35);assert.equal(target.a.p95,60);assert.equal(target.a.max,60);
  assert.equal(target.b.losses,1);assert.equal(target.b.errors,1);assert.equal(target.b.attempts,7);
});

test('does not compare different targets or fewer than the minimum valid attempts',()=>{
  const a=session('a',at(0),at(20)),b=session('b',at(30),at(50));
  const different=compareGameSessions([...recordsFor('a',1,'192.0.2.1'),...recordsFor('b',31,'192.0.2.2')],a,b,{from:at(0),to:at(60)});
  assert.equal(different.comparable,false);assert.match(different.reason,/keine gemeinsamen Ping-Ziele/);
  const short=compareGameSessions([ping(1,[result('192.0.2.1',true,20)]),ping(31,[result('192.0.2.1',true,30)])],a,b,{from:at(0),to:at(60)});
  assert.equal(short.comparable,false);assert.match(short.reason,/mindestens 5/);
});

test('surfaces truncated and out-of-window history and rejects invalid session selection',()=>{
  const a=session('a',at(-30),at(20)),b=session('b',at(30),at(50));
  const comparison=compareGameSessions([...recordsFor('a',1),...recordsFor('b',31)],a,b,{from:at(0),to:at(60),truncated:true});
  assert.equal(comparison.comparable,true);assert.equal(comparison.missingHistory,true);
  assert.equal(compareGameSessions([],a,a,{}).comparable,false);
  assert.equal(compareGameSessions([],session('missing','bad'),b,{}).comparable,false);
});

test('collects session events only inside the selected window and handles a measurement reset with new IDs',()=>{
  const old=session('old-id',at(-60),at(-45)),fresh=session('new-id',at(5),at(20));
  const sessions=collectGameSessions([marker(old,'started',-60),marker(old,'ended',-45),marker(fresh,'started',5),marker(fresh,'ended',20)],{}, {from:at(0),to:at(30),now:Date.UTC(2026,0,1,0,30)});
  assert.deepEqual(sessions.map(item=>item.sessionId),['new-id']);
});

test('deduplicates ping records and reports long gaps plus epoch, adapter, app-session and reset boundaries',()=>{
  const a=session('a',at(0),at(20)),b=session('b',at(30),at(50));
  const left=Array.from({length:6},(_,index)=>({type:'ping',recordId:`left-${index}`,at:at(index+1),epoch:index<3?1:2,interfaceId:index<4?'wifi':'ethernet',appSessionId:index<5?'app-1':'app-2',measurementStartedAt:index<5?'period-1':'period-2',results:[result('192.0.2.1',true,20+index)]}));
  const right=Array.from({length:6},(_,index)=>({type:'ping',recordId:`right-${index}`,at:at(index+31),epoch:1,interfaceId:'wifi',appSessionId:'app-2',measurementStartedAt:'period-2',results:[result('192.0.2.1',true,30+index)]}));
  const comparison=compareGameSessions([...left,left[0],...right],a,b,{from:at(0),to:at(60)});
  assert.equal(comparison.targets[0].a.attempts,6);
  assert.equal(comparison.targets[0].a.coverage.points,6);
  assert.equal(comparison.targets[0].a.coverage.gaps,2);
  assert.equal(comparison.targets[0].a.coverage.breaks,3);
  assert.equal(comparison.targets[0].b.coverage.gaps,5);
});

test('bounds an unconfirmed running detection to its last observed time',()=>{
  const game=session('active',at(1));game.lastSeenAt=at(3);
  const sessions=collectGameSessions([],{status:'error',active:[game]},{from:at(0),to:at(60),now:Date.UTC(2026,0,1,1,0)});
  assert.equal(sessions[0].observationState,'unconfirmed');
  const other=session('other',at(30),at(50));
  const comparison=compareGameSessions([ping(2,[result('192.0.2.1',true,10)]),ping(4,[result('192.0.2.1',true,15)]),...recordsFor('other',31)],sessions[0],other,{from:at(0),to:at(60),truncated:false},{now:Date.UTC(2026,0,1,1,0)});
  assert.equal(comparison.targets[0].a.replies,1);
});
