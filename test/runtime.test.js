import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { dataDirectory, attachLauncherShutdown } from '../lib/runtime.js';

test('portable data stays outside the extracted app and preserves spaces and umlauts',()=>{
  const app=path.resolve('temporary-runtime');
  const portable=path.resolve('Test mit Leerzeichen ä','Netzwerk-Kompass-Daten');
  assert.equal(dataDirectory(app,{}),path.join(app,'data'));
  assert.equal(dataDirectory(app,{NETZWERK_KOMPASS_DATA_DIR:portable}),portable);
  assert.throws(()=>dataDirectory(app,{NETZWERK_KOMPASS_DATA_DIR:'relative-data'}),/absoluter Pfad/);
});

test('launcher shutdown command survives split chunks and closes only once',()=>{
  const input=new PassThrough();const reasons=[];
  attachLauncherShutdown(input,reason=>reasons.push(reason));
  input.write('unknown\nshut');assert.deepEqual(reasons,[]);
  input.write('down\r\n');assert.deepEqual(reasons,['normal']);
  input.end('shutdown:windows_shutdown\n');assert.deepEqual(reasons,['normal']);
});

test('launcher reports confirmed Windows shutdown and distinguishes lost pipe',async()=>{
  const windows=new PassThrough();const reasons=[];
  attachLauncherShutdown(windows,reason=>reasons.push(reason));
  windows.write('shutdown:windows_');windows.write('shutdown\n');
  assert.deepEqual(reasons,['windows_shutdown']);
  const lost=new PassThrough();
  attachLauncherShutdown(lost,reason=>reasons.push(reason));
  lost.end();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(reasons,['windows_shutdown','launcher_lost']);
});

test('lost launcher pipe stops the app and listener disposal does not',async()=>{
  const input=new PassThrough();let calls=0;
  attachLauncherShutdown(input,()=>calls++);
  input.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
  const another=new PassThrough();const dispose=attachLauncherShutdown(another,()=>calls++);
  dispose();another.end();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
});

test('startup failure exits even when the launcher still holds stdin open',async()=>{
  const folder=await mkdtemp(path.join(os.tmpdir(),'network-startup-test-'));
  const blocked=path.join(folder,'not-a-directory');await writeFile(blocked,'isolated fixture');
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server.js',import.meta.url)),'--launcher','--no-browser'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,NETZWERK_KOMPASS_DATA_DIR:blocked}});
  let stderr='',timer;child.stderr.on('data',chunk=>{stderr+=chunk;});
  try {
    const code=await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Failed startup kept waiting on launcher stdin')),5000);
      child.once('error',reject);child.once('exit',resolve);
    });
    assert.equal(code,1);assert.match(stderr,/Start fehlgeschlagen/);
  }finally{clearTimeout(timer);child.kill();child.stdin.destroy();await rm(folder,{recursive:true,force:true});}
});
