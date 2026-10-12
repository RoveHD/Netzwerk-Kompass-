import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPingSelection, resolvePingSelection, togglePingSelection, selectPingTarget, pingTargetColor, pingTargetDash, createHistoryRequestGate } from '../public/history-selection.js';

const targets = [
  {host:'192.168.1.1',kind:'gateway'},
  {host:'1.1.1.1',kind:'internet'},
  {host:'9.9.9.9',kind:'internet'},
  {host:'192.168.1.3',kind:'repeater'},
];

test('initial comparison selects the router and one internet target, then remains stable as data changes',()=>{
  const selected=initialPingSelection(targets);assert.deepEqual([...selected],['192.168.1.1','1.1.1.1']);
  assert.equal(resolvePingSelection(selected,[...targets].reverse()),selected);
  assert.equal(resolvePingSelection(selected,[...targets,{host:'192.168.1.4',kind:'repeater'}]),selected);
  assert.equal(resolvePingSelection(selected,[]),selected);
  assert.equal(resolvePingSelection(null,[]),null);assert.deepEqual([...resolvePingSelection(null,targets)],[...selected]);
});

test('checkbox changes preserve independent choices and an explicit empty selection has no fallback',()=>{
  const original=initialPingSelection(targets);let selected=togglePingSelection(original,'192.168.1.3',true);
  assert.deepEqual([...original],['192.168.1.1','1.1.1.1']);assert.deepEqual([...selected],['192.168.1.1','1.1.1.1','192.168.1.3']);
  for(const host of [...selected])selected=togglePingSelection(selected,host,false);
  assert.equal(selected.size,0);assert.equal(resolvePingSelection(selected,targets),selected);
  selected=togglePingSelection(selected,'9.9.9.9',true);assert.deepEqual([...selected],['9.9.9.9']);
});

test('opening one target history replaces the comparison with exactly that host',()=>{
  const selected=selectPingTarget('192.168.1.3');assert.deepEqual([...selected],['192.168.1.3']);
  assert.equal(resolvePingSelection(selected,targets),selected);assert.equal(resolvePingSelection(selected,[]),selected);
  assert.equal(selectPingTarget('').size,0);
});

test('the primary series uses turquoise and additional targets use stable neutral colors',()=>{
  const before=targets.map((target,index)=>pingTargetColor(target.host,index));
  assert.equal(before[0], 'var(--turquoise, var(--accent, #3FC1B0))');
  assert.ok(before.slice(1).every(color => ['#8A9096','#B8BDC2','#676D73'].includes(color)));
  assert.deepEqual([...targets].reverse().map((target,index)=>pingTargetColor(target.host,targets.length-index-1)).reverse(),before);
  assert.notEqual(pingTargetColor(targets[0].host), pingTargetColor(targets[1].host,1));
  assert.deepEqual([...targets].reverse().map(target=>pingTargetDash(target.host)).reverse(), targets.map(target=>pingTargetDash(target.host)));
  assert.ok(targets.every(target => ['none','6 4','2 3','9 3 2 3'].includes(pingTargetDash(target.host))));
});

test('a changed period supersedes an in-flight history request and manual refresh supersedes the same period',()=>{
  const gate=createHistoryRequestGate();
  const first=gate.begin(1);assert.ok(first);assert.equal(gate.begin(1),null);
  const changed=gate.begin(24);assert.ok(changed);assert.equal(gate.isCurrent(first),false);assert.equal(gate.isCurrent(changed),true);
  gate.finish(first);assert.equal(gate.isCurrent(changed),true);assert.equal(gate.pending,true);
  const refreshed=gate.begin(24,true);assert.ok(refreshed);assert.equal(gate.isCurrent(changed),false);
  gate.finish(changed);assert.equal(gate.pending,true);gate.finish(refreshed);assert.equal(gate.pending,false);
});
