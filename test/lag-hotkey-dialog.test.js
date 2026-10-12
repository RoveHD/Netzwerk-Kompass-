import test from 'node:test';
import assert from 'node:assert/strict';
import {initLagHotkey} from '../public/lag-hotkey.js';
function fixture(t,overrides={}){
  class Element {
    constructor(){this.listeners=new Map();this.attributes=new Map();this.dataset={};this.open=false;this.value='';this.textContent='';this.disabled=false;this.classList={toggle(){}};}
    addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn);}
    trigger(name,event={}){return Promise.all((this.listeners.get(name)||[]).map(fn=>fn(event)));}
    focus(){this.focused=true;}
    showModal(){this.open=true;}
    close(){this.open=false;this.trigger('close');}
    setAttribute(name,value){this.attributes.set(name,value);}
    removeAttribute(name){this.attributes.delete(name);}
  }
  const elements=new Map(['lag-hotkey-edit','lag-hotkey-status','lag-hotkey-dialog','lag-hotkey-input','lag-hotkey-save','lag-hotkey-remove','lag-hotkey-cancel','lag-hotkey-error','lag-hotkey-record','lag-hotkey-record-status','lag-hotkey-help','history-mark'].map(id=>[id,new Element()]));
  const calls=[],listeners={},marks=[],toasts=[];
  const bridge={get:async()=>({accelerator:'',registered:false,error:''}),set:async value=>{calls.push(['set',value]);return {accelerator:value,registered:!!value,error:''};},capture:async active=>{calls.push(['capture',active]);return {capturing:active,error:''};},onMark:callback=>{listeners.mark=callback;},onSelected:callback=>{listeners.selected=callback;},onStatus:callback=>{listeners.status=callback;},...overrides};
  const oldWindow=globalThis.window,oldDocument=globalThis.document;globalThis.window={desktopLagHotkey:bridge};globalThis.document={querySelector:selector=>elements.get(selector.slice(1))};
  t.after(()=>{globalThis.window=oldWindow;globalThis.document=oldDocument;});
  initLagHotkey({markLag:()=>marks.push('mark'),showToast:value=>toasts.push(value)});
  return {get:id=>elements.get(id),calls,listeners,marks,toasts};
}
test('opening does not record the opening click; one-shot recording accepts Escape and needs explicit Save',async t=>{
  const f=fixture(t);await Promise.resolve();await f.get('lag-hotkey-edit').trigger('click');assert.equal(f.get('lag-hotkey-dialog').open,true);assert.deepEqual(f.calls,[]);
  assert.equal(f.get('lag-hotkey-help').textContent,'Wähle eine Taste oder Kombination zum Markieren.');
  assert.match(f.get('lag-hotkey-help').dataset.help,/Strg\+Alt\+Entf/);
  f.listeners.selected('MouseLeft');assert.equal(f.get('lag-hotkey-input').value,'');
  await f.get('lag-hotkey-record').trigger('click');assert.deepEqual(f.calls,[['capture',true]]);assert.equal(f.get('lag-hotkey-save').disabled,true);
  let prevented=false;await f.get('lag-hotkey-dialog').trigger('keydown',{key:'Escape',preventDefault(){prevented=true;},stopPropagation(){}});assert.equal(prevented,true);
  f.listeners.selected('Escape');assert.equal(f.get('lag-hotkey-input').value,'Escape');assert.equal(f.get('lag-hotkey-save').disabled,false);assert.ok(!f.calls.some(call=>call[0]==='set'));
  await f.get('lag-hotkey-save').trigger('click');assert.ok(f.calls.some(call=>call[0]==='set'&&call[1]==='Escape'));assert.equal(f.get('lag-hotkey-dialog').open,false);
});
test('Tab, single keyboard letters and mouse side buttons are displayed as chosen without modifiers',async t=>{
  const f=fixture(t);await Promise.resolve();await f.get('lag-hotkey-edit').trigger('click');
  for(const [binding,label] of [['Tab','Tab'],['A','A'],['MouseBack','Seitentaste zurück (X1)'],['ControlRight','Strg rechts']]){
    await f.get('lag-hotkey-record').trigger('click');f.listeners.selected(binding);assert.equal(f.get('lag-hotkey-input').value,label);assert.equal(f.get('lag-hotkey-save').disabled,false);
  }
  await f.get('lag-hotkey-cancel').trigger('click');assert.ok(!f.calls.some(call=>call[0]==='set'));
});
test('Cancel works during pending startup and cannot be undone by late arm/selection responses',async t=>{
  let resolve;const f=fixture(t,{capture:active=>active?new Promise(done=>{resolve=done;}):Promise.resolve({capturing:false,error:''})});await Promise.resolve();await f.get('lag-hotkey-edit').trigger('click');
  const recording=f.get('lag-hotkey-record').trigger('click');assert.equal(f.get('lag-hotkey-cancel').disabled,false);await f.get('lag-hotkey-cancel').trigger('click');resolve({capturing:true,error:''});await recording;
  f.listeners.selected('MouseLeft');assert.equal(f.get('lag-hotkey-dialog').open,false);assert.equal(f.get('lag-hotkey-input').value,'');assert.ok(!f.calls.some(call=>call[0]==='set'));
});
test('failed save keeps the modal open and helper status is reported while marking is suppressed in the modal',async t=>{
  const f=fixture(t,{set:async()=>({accelerator:'F8',registered:true,error:'Speichern fehlgeschlagen'})});await Promise.resolve();f.listeners.mark();assert.equal(f.marks.length,1);
  await f.get('lag-hotkey-edit').trigger('click');f.listeners.mark();assert.equal(f.marks.length,1);await f.get('lag-hotkey-record').trigger('click');f.listeners.selected('MouseRight');await f.get('lag-hotkey-save').trigger('click');
  assert.equal(f.get('lag-hotkey-dialog').open,true);assert.match(f.get('lag-hotkey-error').textContent,/fehlgeschlagen/);
  f.listeners.status({accelerator:'F8',registered:false,error:'Helfer nicht verfügbar'});assert.match(f.get('lag-hotkey-status').textContent,/Helfer/);await f.get('lag-hotkey-cancel').trigger('click');
});
test('helper loss during recording re-enables controls and ignores a stale selection',async t=>{
  const f=fixture(t);await Promise.resolve();await f.get('lag-hotkey-edit').trigger('click');await f.get('lag-hotkey-record').trigger('click');assert.equal(f.get('lag-hotkey-record').disabled,true);
  f.listeners.status({accelerator:'',registered:false,error:'Helfer nicht verfügbar'});assert.equal(f.get('lag-hotkey-record').disabled,false);assert.equal(f.get('lag-hotkey-cancel').disabled,false);assert.match(f.get('lag-hotkey-error').textContent,/Helfer/);
  f.listeners.selected('MouseLeft');assert.equal(f.get('lag-hotkey-input').value,'');assert.equal(f.get('lag-hotkey-save').disabled,true);await f.get('lag-hotkey-cancel').trigger('click');
});
