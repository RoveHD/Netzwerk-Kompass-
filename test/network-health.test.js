import test from 'node:test';
import assert from 'node:assert/strict';
import {adapterHealth} from '../lib/adapter-health.js';
import {healthSummary,networkChanges,renderAdapterHealth} from '../public/network-health.js';
const start=Date.parse('2026-10-12T00:00:00Z');
const counters={id:'1',time:start,receivedErrors:20,sentErrors:4,receivedDiscards:7,sentDiscards:3};

function healthDom(t) {
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.open=false;this.hidden=false;this.scrollTop=0;this.textContent='';}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    get lastElementChild(){return this.children.at(-1);}
  }
  const previous=globalThis.document;
  globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{globalThis.document=previous;});
  return new Element('div');
}

test('live counter disclosure keeps its open and closed state while measurements change',t=>{
  const parent=healthDom(t);
  const render=(count,time)=>renderAdapterHealth(parent,{interfaceId:'1',adapterHealth:adapterHealth(counters,{...counters,receivedErrors:count},time)});
  render(21,start+5000);
  assert.equal(parent.children.find(child=>child.className==='network-health-note').textContent,'Neue Fehler seit der letzten Abfrage.');
  assert.match(parent.children.find(child=>child.className==='network-health-note').dataset.help,/Zeitraum:/);
  const detail=parent.children.find(child=>child.tagName==='details');
  const summary=detail.children[0];
  assert.equal(detail.open,false);
  detail.open=true;detail.scrollTop=35;
  for(let sample=0;sample<60;sample++){
    render(22+sample,start+5000+sample);
    assert.equal(parent.children.find(child=>child.tagName==='details'),detail);
    assert.equal(detail.children[0],summary);
    assert.equal(detail.open,true);assert.equal(detail.scrollTop,35);
    assert.equal(detail.children[1].children[0].lastElementChild.textContent,String(22+sample));
  }
  detail.open=false;render(90,start+10000);assert.equal(detail.open,false);
});

test('temporary missing counters and adapter changes retain the disclosure preference without stale totals',t=>{
  const parent=healthDom(t);
  renderAdapterHealth(parent,{interfaceId:'1',adapterHealth:adapterHealth(null,counters,start)});
  const detail=parent.children.find(child=>child.tagName==='details');detail.open=true;
  renderAdapterHealth(parent,null);
  assert.equal(detail.hidden,true);assert.equal(detail.open,true);
  assert.equal(detail.children[1].children[0].lastElementChild.textContent,'–');
  renderAdapterHealth(parent,{interfaceId:'2',adapterHealth:adapterHealth(null,{...counters,id:'2',receivedErrors:7},start+10000)});
  assert.equal(parent.children.find(child=>child.tagName==='details'),detail);
  assert.equal(detail.hidden,false);assert.equal(detail.open,true);
  assert.equal(detail.children[1].children[0].lastElementChild.textContent,'7');
});
test('adapter errors are deltas, not pre-existing driver totals',()=>{
  const health=adapterHealth(counters,{...counters,receivedErrors:22},start+5000);
  assert.deepEqual(health.delta,{receivedErrors:2,sentErrors:0,receivedDiscards:0,sentDiscards:0});
  assert.equal(health.intervalMs,5000);assert.equal(health.counters.receivedErrors,22);
  assert.equal(adapterHealth(null,counters,start).delta.receivedErrors,null);
  assert.equal(adapterHealth(counters,{...counters,id:'2'},start+5000).delta.receivedErrors,null);
});
test('resets, missing counters and measurement gaps never manufacture zero errors',()=>{
  const reset=adapterHealth(counters,{...counters,receivedErrors:0},start+5000);
  assert.equal(reset.reset,true);assert.equal(reset.delta.sentErrors,null);
  assert.equal(adapterHealth(counters,counters,start+16000).delta.receivedErrors,null);
  assert.equal(adapterHealth(counters,{id:'1'},start+5000).available,false);
  assert.equal(adapterHealth(counters,{...counters,sentErrors:NaN},start+5000).delta.sentErrors,null);
});
test('history totals count valid intervals once, and preserve unknown old records',()=>{
  const health=adapterHealth(counters,{...counters,receivedErrors:22},start+5000);
  const row={type:'traffic',interfaceId:'1',at:health.at,adapterHealth:health};
  const summary=healthSummary([row,row,{type:'traffic',at:new Date(start+10000).toISOString()}]);
  assert.equal(summary.totals.receivedErrors,2);assert.equal(summary.durationMs,5000);assert.equal(summary.missing,1);
  assert.equal(healthSummary([{type:'traffic',at:row.at}]).totals.receivedErrors,null);
});
test('network chronology detects observed changes but does not bridge sessions or query failures',()=>{
  const at=second=>new Date(start+second*1000).toISOString();
  const net={type:'network',at:at(0),appSessionId:'a',interfaceId:'1',gateway:'192.168.1.1',dns:['1.1.1.1'],ipv4:[{address:'192.168.1.2',prefixLength:24}],linkSpeedMbps:1000,status:'Up'};
  let changes=networkChanges([net,{...net,at:at(60),linkSpeedMbps:100,dns:['9.9.9.9']}]);
  assert.ok(changes.some(row=>row.title==='Linkrate geändert'));assert.ok(changes.some(row=>row.title==='DNS-Server geändert'));
  changes=networkChanges([net,{...net,at:at(60),appSessionId:'b',gateway:'10.0.0.1'}]);
  assert.ok(!changes.some(row=>row.title==='Gateway geändert'));
  const wifi={type:'wifi',at:at(0),connected:true,bssid:'a',ssid:'Netz'};
  changes=networkChanges([wifi,{...wifi,at:at(60),connected:false,error:'query failed'},{...wifi,at:at(120),bssid:'b'}]);
  assert.ok(!changes.some(row=>row.title==='WLAN-Verbindung geändert'));assert.ok(!changes.some(row=>row.title==='Access Point geändert'));
  assert.ok(changes.some(row=>row.title==='WLAN-Abfrage fehlgeschlagen'));
});
