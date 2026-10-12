import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import hotkey from '../desktop/lag-hotkey.cjs';
function fixture(options={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'netzwerk-hotkey-')),filePath=path.join(directory,'lag-hotkey.json');
  const observers=[],rejected=new Set(),marked=[],selected=[],statuses=[];let time=2000;
  const startObserver=async config=>{
    if(rejected.has(config.binding))throw new Error('Unavailable');
    const observer={config,active:true,armed:false,close(){this.active=false;this.armed=false;},async capture(active){this.armed=active;}};observers.push(observer);return observer;
  };
  const create=extra=>hotkey.createLagHotkey({filePath,startObserver,onMark:()=>marked.push('mark'),onSelected:value=>selected.push(value),onStatus:value=>statuses.push(value),now:()=>time,...options,...extra});
  return {directory,filePath,observers,rejected,marked,selected,statuses,create,setTime:value=>{time=value;},cleanup(){observers.forEach(observer=>observer.close());fs.rmSync(directory,{recursive:true,force:true});}};
}
test('accepts single keyboard keys, modifiers, all mouse/wheel inputs, and legacy combinations',async()=>{
  const f=fixture();try{const controller=f.create();assert.deepEqual(await controller.initialize(),{accelerator:'',registered:false,error:''});
    for(const value of ['A','1','Escape','Tab','Backspace','ControlLeft','AltRight','Shift','Super','NumpadEnter','VK_BA','VK_60','MouseLeft','MouseRight','MouseMiddle','MouseBack','MouseForward','WheelUp','WheelDown','WheelLeft','WheelRight','Control+A','Alt+Shift+F24','Super+PageDown','F1'])assert.equal(hotkey.validateAccelerator(value),'',value);
    for(let vk=8;vk<=254;vk++)assert.equal(hotkey.validateAccelerator('VK_'+vk.toString(16).toUpperCase().padStart(2,'0')),'');
    for(const value of [null,undefined,{},'F25','VK_00','VK_FF','VK_ba','Control+Control+A','MouseSide99','Fn','A\nB'])assert.match(hotkey.validateAccelerator(value),/Ungültig/);
    controller.close();
  }finally{f.cleanup();}
});
test('legacy saved binding reloads and replacement is committed before the old observer closes',async()=>{
  const f=fixture();try{const first=f.create();await first.initialize();assert.deepEqual(await first.set('Control+Alt+L'),{accelerator:'Control+Alt+L',registered:true,error:''});first.close();
    const second=f.create();assert.deepEqual(await second.initialize(),{accelerator:'Control+Alt+L',registered:true,error:''});const old=f.observers.at(-1);
    assert.deepEqual(await second.set('MouseBack'),{accelerator:'MouseBack',registered:true,error:''});assert.equal(old.active,false);assert.equal(f.observers.at(-1).active,true);
    assert.deepEqual(await second.set(''),{accelerator:'',registered:false,error:''});assert.ok(f.observers.every(observer=>!observer.active));assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath,'utf8')),{accelerator:''});second.close();
  }finally{f.cleanup();}
});
test('startup/helper failures and invalid values retain the prior saved binding',async()=>{
  const f=fixture();try{const controller=f.create();await controller.initialize();await controller.set('A');const old=f.observers.at(-1);
    f.rejected.add('MouseLeft');const rejected=await controller.set('MouseLeft');assert.equal(rejected.accelerator,'A');assert.equal(rejected.registered,true);assert.match(rejected.error,/bisherige Bindung/);assert.equal(old.active,true);
    assert.match((await controller.set('Control+Alt+Nope')).error,/Ungültig/);assert.equal(JSON.parse(fs.readFileSync(f.filePath,'utf8')).accelerator,'A');controller.close();
    f.rejected.add('A');const startup=f.create();assert.equal((await startup.initialize()).registered,false);assert.equal(startup.get().accelerator,'A');startup.close();
  }finally{f.cleanup();}
});
test('one-second marking debounce ignores stale helpers and suppresses marks while explicitly recording',async()=>{
  const f=fixture();try{const controller=f.create();await controller.initialize();await controller.set('A');const first=f.observers.at(-1);
    first.config.onMark();first.config.onMark();assert.equal(f.marked.length,1);f.setTime(3000);first.config.onMark();assert.equal(f.marked.length,2);
    assert.deepEqual(await controller.capture(true),{capturing:true,error:''});assert.equal(first.armed,true);first.config.onMark();assert.equal(f.marked.length,2);
    first.config.onSelected('MouseForward');first.config.onSelected('B');assert.deepEqual(f.selected,['MouseForward']);
    await controller.set('MouseForward');first.config.onMark();assert.equal(f.marked.length,2);f.observers.at(-1).config.onMark();assert.equal(f.marked.length,3);
    controller.close();f.observers.at(-1).config.onMark();assert.equal(f.marked.length,3);
  }finally{f.cleanup();}
});
test('failed atomic persistence closes candidate and retains previous observer',async()=>{
  const f=fixture();try{const controller=f.create();await controller.initialize();await controller.set('F8');const old=f.observers.at(-1);
    fs.rmSync(f.filePath);fs.mkdirSync(f.filePath);const result=await controller.set('MouseMiddle');assert.equal(result.accelerator,'F8');assert.equal(result.registered,true);assert.match(result.error,/gespeichert/);assert.equal(old.active,true);assert.equal(f.observers.at(-1).active,false);
    assert.ok(!fs.readdirSync(f.directory).some(name=>name.endsWith('.tmp')));controller.close();
  }finally{f.cleanup();}
});
test('observer loss reports inactive status without deleting the setting and can be retried',async()=>{
  const f=fixture();try{const controller=f.create();await controller.initialize();await controller.set('F8');f.observers.at(-1).config.onFailure();assert.equal(controller.get().registered,false);assert.match(f.statuses.at(-1).error,/Helfer/);
    assert.equal(JSON.parse(fs.readFileSync(f.filePath,'utf8')).accelerator,'F8');assert.equal((await controller.set('F8')).registered,true);controller.close();
  }finally{f.cleanup();}
});
test('cancelling during helper startup never arms recording and unbound cancellation closes hooks',async()=>{
  let release;const f=fixture({startObserver:config=>new Promise(resolve=>{release=()=>{const observer={config,active:true,armed:false,close(){this.active=false;},async capture(active){this.armed=active;}};f.observers.push(observer);resolve(observer);};})});
  try{const controller=f.create();await controller.initialize();const recording=controller.capture(true);await Promise.resolve();await controller.capture(false);release();assert.equal((await recording).capturing,false);assert.equal(f.observers[0].armed,false);assert.equal(f.observers[0].active,false);controller.close();}
  finally{f.cleanup();}
});
test('concurrent changes serialize and shutdown cannot commit a late helper',async()=>{
  const f=fixture();try{const controller=f.create();await controller.initialize();await Promise.all([controller.set('A'),controller.set('B')]);assert.equal(controller.get().accelerator,'B');assert.equal(f.observers.filter(observer=>observer.active).length,1);controller.close();
    let release;const late=f.create({startObserver:()=>new Promise(resolve=>{release=()=>{const observer={active:true,close(){this.active=false;}};f.observers.push(observer);resolve(observer);};})});
    const change=late.set('C');await Promise.resolve();late.close();release();await change;assert.equal(f.observers.at(-1).active,false);assert.equal(JSON.parse(fs.readFileSync(f.filePath,'utf8')).accelerator,'B');
  }finally{f.cleanup();}
});
test('a helper that dies immediately after ready cannot become a registered binding',async()=>{
  const f=fixture();try{let closed=false;const controller=f.create({startObserver:async()=>({active:false,close(){closed=true;}})});await controller.initialize();const state=await controller.set('A');assert.equal(state.registered,false);assert.equal(state.accelerator,'');assert.equal(closed,true);assert.equal(fs.existsSync(f.filePath),false);controller.close();}finally{f.cleanup();}
});
