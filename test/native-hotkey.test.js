import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import native from '../desktop/native-hotkey.cjs';
function fixture(options={}){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;child.emit('close',0);};
  const marks=[],selections=[],failures=[],calls=[];
  const started=native.startNativeHotkey({binding:'MouseBack',platform:'win32',onMark:()=>marks.push('mark'),onSelected:value=>selections.push(value),onFailure:error=>failures.push(error.message),...options,spawnProcess:(...args)=>{calls.push(args);return child;}});
  const emit=value=>child.stdout.write(JSON.stringify(value)+'\n');return{child,started,emit,marks,selections,failures,calls};
}
test('helper launch is hidden, fixed and never elevated; one-shot selection forwards only the chosen binding',async()=>{
  const f=fixture();assert.equal(f.calls[0][2].windowsHide,true);assert.ok(!f.calls[0][1].includes('-Elevate'));
  assert.deepEqual(JSON.parse(f.child.stdin.read().toString()),{binding:'MouseBack'});f.emit({type:'ready'});const observer=await f.started;
  const capture=observer.capture(true);assert.equal(f.child.stdin.read().toString(),'capture\n');f.emit({type:'armed'});await capture;
  f.emit({type:'selected',accelerator:'MouseForward',rawKeys:['private'],pid:5});assert.deepEqual(f.selections,['MouseForward']);
  f.emit({type:'mark',secret:'not forwarded'});assert.deepEqual(f.marks,['mark']);observer.close();assert.equal(observer.active,false);assert.match(f.child.stdin.read().toString(),/stop/);f.child.emit('close',0);
});
test('cancel resolves without another input and stale output never triggers marks',async()=>{
  const f=fixture();f.emit({type:'ready'});const observer=await f.started;const recording=observer.capture(true);const rejected=assert.rejects(recording,/beendet/);
  await observer.capture(false);await rejected;observer.close();f.emit({type:'mark'});assert.equal(f.marks.length,0);f.child.emit('close',0);
});
test('unexpected output and helper exit fail closed; lifecycle failure signals no input data',async()=>{
  const f=fixture();f.emit({type:'ready'});const observer=await f.started;f.emit({type:'keydown',secret:'private'});assert.equal(observer.active,false);assert.equal(f.failures.length,1);assert.doesNotMatch(f.failures[0],/private/);f.child.emit('close',0);
  const g=fixture();g.emit({type:'ready'});await g.started;g.child.emit('close',1);assert.equal(g.failures.length,1);
});
test('unbounded output and absent helper readiness have bounded termination',async()=>{
  const f=fixture();const rejected=assert.rejects(f.started,/Helfer/);f.child.stdout.write('x'.repeat(9000));await rejected;f.child.emit('close',0);
  const g=fixture({startupTimeoutMs:5});const timeout=assert.rejects(g.started,/Helfer/);await new Promise(resolve=>setTimeout(resolve,15));await timeout;g.child.emit('close',0);
});
test('a helper that stays alive without its pulses is stopped by the watchdog',async()=>{
  const f=fixture({outputTimeoutMs:5});f.emit({type:'ready'});const observer=await f.started;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(observer.active,false);assert.equal(f.failures.length,1);f.child.emit('close',0);
});
