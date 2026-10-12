const { spawn } = require('node:child_process');
const path = require('node:path');

// Fixed messages only; explicit one-shot recording returns the chosen binding.
function startNativeHotkey({ binding, onMark, onSelected, onFailure, spawnProcess=spawn, platform=process.platform, startupTimeoutMs=15000, outputTimeoutMs=12000 }) {
  if(platform!=='win32')return Promise.reject(new Error('Globale Eingaben benötigen Windows.'));
  return new Promise((resolve,reject)=>{
    let child,closed=false,ready=false,pending='',bytes=0,windowAt=Date.now(),lastOutput=Date.now(),records=0,arm=null;
    const timers=[];
    const write=line=>{if(!closed&&child?.stdin?.writable)child.stdin.write(line+'\n');};
    const close=()=>{
      if(closed)return;try{write('stop');child?.stdin?.end();}catch{}closed=true;
      timers.forEach(timer=>{clearTimeout(timer);clearInterval(timer);});
      arm?.reject(new Error('Aufnahme beendet.'));arm=null;
      const kill=setTimeout(()=>{try{child?.kill();}catch{}},3000);kill.unref?.();child?.once('close',()=>clearTimeout(kill));
    };
    const fail=()=>{if(closed)return;const wasReady=ready;close();const error=new Error('Der Windows-Hotkey-Helfer ist nicht verfügbar. Bitte erneut einstellen.');if(wasReady)onFailure?.(error);else reject(error);};
    const observer={ close,get active(){return !closed;},capture(active){
      if(closed)return Promise.reject(new Error('Hotkey-Helfer beendet.'));
      if(!active){arm?.reject(new Error('Aufnahme beendet.'));arm=null;write('cancel');return Promise.resolve();}
      if(arm)return Promise.reject(new Error('Eine Aufnahme läuft bereits.'));
      return new Promise((resolve,reject)=>{const request={resolve,reject};arm=request;write('capture');const timeout=setTimeout(()=>{if(arm===request){arm.reject(new Error('Aufnahme konnte nicht gestartet werden.'));arm=null;write('cancel');}},3000);timeout.unref?.();timers.push(timeout);});
    }};
    try{
      child=spawnProcess(path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),
        ['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','scripts','lag-hotkey.ps1')],
        {windowsHide:true,stdio:['pipe','pipe','pipe']});
      child.on('error',fail);child.on('close',()=>{if(!closed)fail();});child.stdin.on('error',fail);
      child.stderr.on('data',chunk=>{if(chunk.length)fail();});
      child.stdout.on('data',chunk=>{
        if(closed)return;
        const current=Date.now();if(current-windowAt>=10000){windowAt=current;bytes=0;records=0;}bytes+=chunk.length;pending+=chunk.toString('utf8');
        if(bytes>65536||Buffer.byteLength(pending)>8192){fail();return;}
        let index;
        while((index=pending.indexOf('\n'))!==-1){
          const line=pending.slice(0,index).trim();pending=pending.slice(index+1);if(!line)continue;
          if(++records>64||Buffer.byteLength(line)>4096){fail();return;}
          let record;try{record=JSON.parse(line);}catch{fail();return;}
          if(!record||typeof record!=='object'||Array.isArray(record)){fail();return;}
          lastOutput=current;
          if(record.type==='ready'&&!ready){ready=true;resolve(observer);}
          else if(!ready){fail();return;}
          else if(record.type==='pulse'){}
          else if(record.type==='mark')onMark?.();
          else if(record.type==='armed'){if(arm){arm.resolve();arm=null;}}
          else if(record.type==='selected'&&typeof record.accelerator==='string'&&record.accelerator.length<=80)onSelected?.(record.accelerator);
          else {fail();return;}
          if(closed)return;
        }
      });
      write(JSON.stringify({binding}));
      const heartbeat=setInterval(()=>{try{write('ping');}catch{fail();}},2000);heartbeat.unref?.();timers.push(heartbeat);
      const startup=setTimeout(()=>{if(!ready)fail();},startupTimeoutMs);startup.unref?.();timers.push(startup);
      const watchdog=setInterval(()=>{if(ready&&Date.now()-lastOutput>outputTimeoutMs)fail();},Math.min(1000,outputTimeoutMs));watchdog.unref?.();timers.push(watchdog);
    }catch{fail();}
  });
}
module.exports={startNativeHotkey};
