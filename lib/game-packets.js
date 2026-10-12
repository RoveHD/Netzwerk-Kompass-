import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../scripts/game-packets.ps1', import.meta.url));
const COUNTERS = ['sentPackets','receivedPackets','sentBytes','receivedBytes','retransmits'];
const MAX_DURATION_MS = 86400000;
const MAX_SAMPLES = 1800;
const OUTPUT_WINDOW_MS = 10000;
const count = value => Number.isSafeInteger(value) && value >= 0;
const errors = {
  'needs-admin':'Windows hat die Administratorfreigabe für den Erfassungshelfer nicht erteilt.',
  'uac-cancelled':'Die Windows-Administratorfreigabe wurde abgebrochen.',
  'uac-timeout':'Die Windows-Administratorfreigabe oder der Helfer hat nicht rechtzeitig geantwortet.',
  'process-changed':'Der ausgewählte Spielprozess wurde beendet oder seine Identität hat sich geändert.',
  'provider-unavailable':'Der Windows-Netzwerkereignisprovider ist nicht verfügbar.',
  'session-start-failed':'Die eigene Windows-Ereigniserfassung konnte nicht gestartet werden.',
  'consumer-start-failed':'Die Windows-Ereignisse konnten nicht gelesen werden.',
  'guard-unavailable':'Der sichere Aufräumhelfer konnte nicht gestartet werden. Es wurden keine Ereignisse erfasst.',
  helper_failed:'Der Windows-Erfassungshelfer ist fehlgeschlagen.',
  'helper-lost':'Die Verbindung zum Erfassungshelfer ist abgebrochen.',
  'invalid-output':'Der Erfassungshelfer hat ungültige oder zu viele Daten geliefert.',
  'unsupported-platform':'Die Ereigniserfassung benötigt Windows (64 Bit).',
};
const ends = {
  user:'Die Erfassung wurde angehalten.', duration:'Die begrenzte Erfassung ist abgeschlossen.',
  'process-ended':'Die ausgewählten Spielprozesse wurden beendet.',
  'event-limit':'Die sichere Obergrenze für die Windows-Ereignisrate wurde erreicht.',
  'controller-lost':'Die Verbindung zur Anwendung ist abgebrochen.',
  'consumer-ended':'Windows hat den Ereignisstrom beendet.',
  'consumer-failed':'Der Windows-Ereignisstrom ist fehlgeschlagen.',
  'cleanup-failed':'Windows konnte das Ende der Erfassung nicht bestätigen.',
};
const initial = () => ({ status:'idle',game:null,startedAt:null,endedAt:null,durationMs:0,sampleIntervalMs:1000,
  sentPackets:null,receivedPackets:null,sentBytes:null,receivedBytes:null,retransmits:null,
  endpoints:[],samples:[],losses:{events:null,buffers:null},unknownEvents:0,omittedEndpoints:0,
  quality:'unknown',reason:null,scope:'local-stack-events',
  packetCountMeaning:'ETW-Netzwerkereignisse, keine einzelnen Drahtpakete',deliveryBeyondRouter:'unknown',
  failureEvents:'unavailable-with-process-attribution' });
const validTime = value => typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

// Only allowlisted cumulative metadata survives the native boundary. No PIDs,
// paths, raw event data, commands or packet contents enter the public snapshot.
export function parsePacketRecord(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line) > 65536) throw new Error('invalid-output');
  let raw; try { raw = JSON.parse(line); } catch { throw new Error('invalid-output'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-output');
  if (raw.type === 'error') return {type:'error',code:Object.hasOwn(errors,raw.code)?raw.code:'helper_failed'};
  if (raw.type === 'ready' && validTime(raw.at)) return {type:'ready',at:raw.at};
  if (!['sample','final'].includes(raw.type) || !validTime(raw.at) || !COUNTERS.every(key=>count(raw[key])) ||
      !count(raw.unknownEvents) || !count(raw.omittedEndpoints) || !Array.isArray(raw.endpoints) || raw.endpoints.length > 64 ||
      !raw.losses || !['events','buffers'].every(key=>raw.losses[key] === null || count(raw.losses[key]))) throw new Error('invalid-output');
  const result = {type:raw.type,at:raw.at,unknownEvents:raw.unknownEvents,omittedEndpoints:raw.omittedEndpoints,
    losses:{events:raw.losses.events,buffers:raw.losses.buffers},reason:Object.hasOwn(ends,raw.reason)?raw.reason:'consumer-failed',endpoints:[]};
  for (const key of COUNTERS) result[key] = raw[key];
  const keys = new Set();
  for (const endpoint of raw.endpoints) {
    if (!endpoint || !['TCP','UDP'].includes(endpoint.protocol) || typeof endpoint.address !== 'string' || !isIP(endpoint.address) ||
        !Number.isInteger(endpoint.port) || endpoint.port < 0 || endpoint.port > 65535 || !COUNTERS.slice(0,4).every(key=>count(endpoint[key]))) throw new Error('invalid-output');
    const key = `${endpoint.protocol}/${endpoint.address}/${endpoint.port}`;
    if(keys.has(key))throw new Error('invalid-output'); keys.add(key);
    result.endpoints.push(Object.fromEntries(['protocol','address','port',...COUNTERS.slice(0,4)].map(key=>[key,endpoint[key]])));
  }
  for (const key of COUNTERS.slice(0,4)) if(result.endpoints.reduce((sum,endpoint)=>sum+endpoint[key],0)>result[key])throw new Error('invalid-output');
  return result;
}

export class GamePacketTracker {
  constructor({durationMs=0,onFinish=()=>{},spawnProcess=spawn,platform=process.platform,now=()=>Date.now(),startupTimeoutMs=60000,stopTimeoutMs=6000,outputTimeoutMs=15000}={}) {
    if(!Number.isInteger(durationMs)||(durationMs!==0&&(durationMs<1000||durationMs>MAX_DURATION_MS)))throw new Error('Ungültige Erfassungsdauer.');
    this.durationMs = durationMs;
    this.onFinish=onFinish; this.spawnProcess=spawnProcess; this.platform=platform; this.now=now;
    this.startupTimeoutMs=startupTimeoutMs; this.stopTimeoutMs=stopTimeoutMs;this.outputTimeoutMs=outputTimeoutMs;
    this.state=initial(); this.run=null; this.closed=false; this.resetting=false;
  }
  snapshot() { return structuredClone(this.state); }
  async start({game,processes,elevate=false}={}) {
    if(this.closed)throw new Error('Die Paketerfassung ist geschlossen.');
    if(this.resetting)throw new Error('Die Paketerfassung wird gerade zurückgesetzt.');
    if(this.run)throw new Error('Eine Paketerfassung läuft bereits oder wird noch beendet.');
    if(!game || !['id','sessionId','name'].every(key=>typeof game[key]==='string'&&game[key].length>0&&game[key].length<=160) ||
       !Array.isArray(processes)||processes.length===0||processes.length>32||processes.some(p=>!p||!Number.isInteger(p.pid)||p.pid<=4||p.pid>0xffffffff||!validTime(p.startedAt))||new Set(processes.map(p=>p.pid)).size!==processes.length)
      throw new Error('Für die Erfassung fehlen gültige laufende Spielprozesse.');
    this.state={...initial(),status:'starting',game:{id:game.id,sessionId:game.sessionId,name:game.name},durationMs:this.durationMs};
    if(this.platform!=='win32') { this.state.status='error';this.state.reason=errors['unsupported-platform'];return this.snapshot(); }
    const run={child:null,pending:'',bytes:0,records:0,windowAt:this.now(),lastOutputAt:this.now(),lastRecordAt:null,nextSampleAt:0,finished:false,ready:false,stopRequested:false,timers:[],resolve:null};
    run.done=new Promise(resolve=>{run.resolve=resolve;}); this.run=run;
    const fail=code=>this._fail(run,code);
    const executable=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    try {
      run.child=this.spawnProcess(executable,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,...(elevate?['-Elevate']:[])],{windowsHide:true,stdio:['pipe','pipe','pipe']});
      run.child.on('error',()=>fail('helper_failed'));
      run.child.stdin.on('error',()=>{if(!run.finished&&!run.stopRequested)fail('helper-lost');});
      run.child.stdout.on('data',chunk=>{
        if(this.run!==run||run.finished)return;
        if(this.now()-run.windowAt>=OUTPUT_WINDOW_MS){run.windowAt=this.now();run.bytes=0;run.records=0;}
        run.bytes+=Buffer.byteLength(chunk); run.pending+=chunk.toString('utf8');
        if(run.bytes>2000000||Buffer.byteLength(run.pending)>131072){fail('invalid-output');return;}
        let index;
        while((index=run.pending.indexOf('\n'))!==-1){
          const line=run.pending.slice(0,index).trim();run.pending=run.pending.slice(index+1);
          if(!line)continue;
          if(++run.records>64){fail('invalid-output');return;}
          try{this._record(run,parsePacketRecord(line));}catch{fail('invalid-output');return;}
          if(run.finished)return;
        }
      });
      let stderrBytes=0,stderrWindowAt=this.now();
      run.child.stderr.on('data',chunk=>{if(this.now()-stderrWindowAt>=OUTPUT_WINDOW_MS){stderrWindowAt=this.now();stderrBytes=0;}stderrBytes+=chunk.length;if(stderrBytes>65536)fail('invalid-output');});
      run.child.on('close',()=>{
        if(run.finished)return;
        if(this.run===run&&run.stopRequested&&!run.ready){this.state.status='stopped';this.state.reason=ends.user;this._finish(run);}
        else fail('helper-lost');
      });
      this._write(run,JSON.stringify({durationMs:this.durationMs,processes:processes.map(({pid,startedAt})=>({pid,startedAt}))}));
      const heartbeat=setInterval(()=>this._write(run,'ping'),2000);heartbeat.unref?.();run.timers.push(heartbeat);
      const timeout=setTimeout(()=>{if(!run.ready)fail('uac-timeout');},this.startupTimeoutMs);timeout.unref?.();run.timers.push(timeout);
    }catch{fail('helper_failed');}
    return this.snapshot();
  }
  _write(run,line) { if(!run.finished&&run.child?.stdin?.writable)try{run.child.stdin.write(`${line}\n`);}catch{this._fail(run,'helper-lost');} }
  _record(run,record) {
    if(this.run!==run||run.finished)return;
    run.lastOutputAt=this.now();
    if(record.type==='error'){this._fail(run,record.code);return;}
    if(record.type==='ready'){
      if(run.ready)throw new Error('duplicate-ready');
      run.ready=true;this.state.startedAt=record.at;
      if(!run.stopRequested)this.state.status='recording';
      for(const key of COUNTERS)this.state[key]=0;
      // Unbounded matches still fail closed if the helper stops producing its
      // once-per-second metadata. A healthy stream has no lifetime deadline.
      const watchdog=setInterval(()=>{if(this.now()-run.lastOutputAt>this.outputTimeoutMs)this._fail(run,'helper-lost');},Math.min(1000,this.outputTimeoutMs));watchdog.unref?.();run.timers.push(watchdog);
      if(this.durationMs>0){const deadline=setTimeout(()=>{this._fail(run,'helper-lost');},this.durationMs+15000);deadline.unref?.();run.timers.push(deadline);}
      return;
    }
    if(!run.ready)throw new Error('missing-ready');
    if(COUNTERS.some(key=>record[key]<this.state[key]) || record.unknownEvents<this.state.unknownEvents ||
       (run.lastRecordAt!==null&&Date.parse(record.at)<run.lastRecordAt))throw new Error('counter-reset');
    run.lastRecordAt=Date.parse(record.at);
    for(const key of [...COUNTERS,'unknownEvents','omittedEndpoints','endpoints','losses'])this.state[key]=record[key];
    this.state.quality=record.unknownEvents>0||record.sentPackets+record.receivedPackets+record.retransmits===0?'unknown':record.losses.events===null||record.losses.buffers===null?'unknown':
      record.losses.events>0||record.losses.buffers>0||['event-limit','controller-lost','consumer-failed','consumer-ended','cleanup-failed'].includes(record.reason)?'incomplete':'observed';
    // Keep the full match span while bounding RAM. Longer matches gradually
    // reduce time-series resolution; all cumulative totals remain exact.
    if(!this.state.samples.length||run.lastRecordAt>=run.nextSampleAt||record.type==='final'){
      this.state.samples.push(Object.fromEntries(['at',...COUNTERS].map(key=>[key,record[key]])));
      if(this.state.samples.length>MAX_SAMPLES){
        const last=this.state.samples.at(-1);
        this.state.samples=this.state.samples.filter((_,index)=>index%2===0);
        if(this.state.samples.at(-1)!==last)this.state.samples.push(last);
        this.state.sampleIntervalMs*=2;
      }
      run.nextSampleAt=run.lastRecordAt+this.state.sampleIntervalMs;
    }
    if(record.type==='final'){
      this.state.status=['consumer-failed','consumer-ended','controller-lost','cleanup-failed'].includes(record.reason)?'error':'stopped';
      this.state.reason=record.reason==='user'&&run.stopReason==='reset'?'Die Erfassung wurde zurückgesetzt.':
        record.reason==='user'&&run.stopReason==='shutdown'?'Die Anwendung wurde geschlossen.':ends[record.reason];this._finish(run);
    }
  }
  _fail(run,code){
    if(this.run!==run||run.finished)return;
    this._writeStop(run);
    this.state.status=['needs-admin','uac-cancelled','uac-timeout'].includes(code)?'needs-admin':'error';
    this.state.reason=errors[code]||errors.helper_failed;
    if(run.ready)this.state.quality='incomplete';
    this._finish(run);
  }
  _writeStop(run){try{if(run.child?.stdin?.writable){run.child.stdin.write('stop\n');run.child.stdin.end();}}catch{}}
  _finish(run){
    if(run.finished)return;
    run.finished=true;for(const timer of run.timers){clearTimeout(timer);clearInterval(timer);}
    this.state.endedAt=new Date(this.now()).toISOString();
    // A normal final is followed by process exit. On errors close the control
    // pipe; the elevated helper independently stops on EOF or its 8s watchdog.
    try{run.child?.stdin?.end();}catch{}
    const kill=setTimeout(()=>{try{run.child?.kill();}catch{}},4000);kill.unref?.();
    run.child?.once('close',()=>clearTimeout(kill));
    this.run=null;run.resolve(this.snapshot());
    try{Promise.resolve(this.onFinish(this.snapshot())).catch(()=>{});}catch{}
  }
  async stop(reason='user'){
    const run=this.run;if(!run)return this.snapshot();
    if(!run.stopRequested){run.stopRequested=true;run.stopReason=['reset','shutdown'].includes(reason)?reason:'user';this.state.status='stopping';this._writeStop(run);
      const deadline=setTimeout(()=>{
        if(run.finished)return;
        if(!run.ready){this.state.status='stopped';this.state.reason=ends.user;this._finish(run);}
        else this._fail(run,'helper-lost');
      },this.stopTimeoutMs);deadline.unref?.();run.timers.push(deadline);
    }
    return run.done;
  }
  async reset(){this.resetting=true;try{await this.stop('reset');this.state=initial();return this.snapshot();}finally{this.resetting=false;}}
  async close(){this.closed=true;return this.stop('shutdown');}
}
