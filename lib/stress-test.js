import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

const MODES=new Set(['download','upload','both']);
const DURATIONS=new Set([60,300,900,1800,3600,0]);
const DEFAULT_TIMERS={setTimeout,clearTimeout,setInterval,clearInterval};

export function normalizeStressOptions(options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options))throw new TypeError('Ungültige Belastungstest-Einstellungen.');
  const {mode='both',durationSeconds=300}=options;
  if(!MODES.has(mode))throw new TypeError('Belastungstest: Richtung muss download, upload oder both sein.');
  if(!DURATIONS.has(durationSeconds))throw new TypeError('Belastungstest: Dauer muss 60, 300, 900, 1800, 3600 oder 0 Sekunden sein.');
  return {mode,durationSeconds};
}

function abortable(promise,signal) {
  if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise((resolve,reject)=>{
    const onAbort=()=>{cleanup();reject(signal.reason);};
    const cleanup=()=>signal.removeEventListener('abort',onAbort);
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}

// Rates are averages over the complete run. Download includes observed partial
// responses; upload counts only complete POSTs acknowledged by an HTTP success.
export async function runStressTest(update,options={}) {
  const {mode,durationSeconds}=normalizeStressOptions(options);
  const {signal,fetchImpl=fetch,downloadRequestBytes=5_000_000,uploadRequestBytes=2_000_000,requestTimeoutMs=60_000,clock=()=>performance.now(),timers=DEFAULT_TIMERS}=options;
  if(typeof update!=='function'||typeof fetchImpl!=='function'||typeof clock!=='function')throw new TypeError('Ungültige Belastungstest-Funktionen.');
  for(const [bytes,max] of [[downloadRequestBytes,5_000_000],[uploadRequestBytes,2_000_000]])if(!Number.isSafeInteger(bytes)||bytes<1||bytes>max)throw new TypeError('Ungültige Belastungstest-Transfergröße.');
  if(!Number.isSafeInteger(requestTimeoutMs)||requestTimeoutMs<1||requestTimeoutMs>360_000)throw new TypeError('Ungültige Belastungstest-Zeitgrenze.');
  if(signal&&!(signal instanceof AbortSignal))throw new TypeError('Ungültiges Belastungstest-Abbruchsignal.');
  for(const name of Object.keys(DEFAULT_TIMERS))if(typeof timers?.[name]!=='function')throw new TypeError('Ungültige Belastungstest-Zeitgeber.');

  const controller=new AbortController(),runSignal=controller.signal,started=clock();
  const counters={downloadBytes:0,uploadBytes:0,completedDownloads:0,completedUploads:0};
  let reason=null,failure=null,lastUpdate=-Infinity,durationTimer,progressTimer;
  const summary=()=>{
    const elapsedSeconds=Math.max(0,(clock()-started)/1000);
    return {mode,durationSeconds,elapsedSeconds,...counters,
      downloadMbps:mode==='upload'||!counters.downloadBytes||!elapsedSeconds?null:counters.downloadBytes*8/elapsedSeconds/1_000_000,
      uploadMbps:mode==='download'||!counters.uploadBytes||!elapsedSeconds?null:counters.uploadBytes*8/elapsedSeconds/1_000_000};
  };
  const publish=(force=false)=>{
    const now=clock();if(!force&&now-lastUpdate<250)return;
    lastUpdate=now;update(summary());
  };
  const stop=value=>{if(!runSignal.aborted){reason=value;controller.abort(new DOMException('Belastungstest beendet.','AbortError'));}};
  const fail=error=>{if(!runSignal.aborted){failure=error instanceof Error?error:new Error(String(error));controller.abort(failure);}};
  const onStop=()=>stop('stopped');
  const add=(key,amount)=>{
    const total=counters[key]+amount;
    if(!Number.isSafeInteger(total)||total<0)throw new Error('Belastungstest-Zähler überschreitet den sicheren Zahlenbereich.');
    counters[key]=total;
  };

  // One fixed upload buffer is reused by sequential requests, never queued.
  let uploadData;
  const transfer=async direction=>{
    const timeoutController=new AbortController();
    const transferSignal=AbortSignal.any([runSignal,timeoutController.signal]);
    const timeout=timers.setTimeout(()=>timeoutController.abort(new Error(`${direction==='download'?'Download':'Upload'}: Zeitüberschreitung beim Belastungstest.`)),requestTimeoutMs);
    let response,reader,cancelled;
    const cancelReader=()=>{if(reader&&!cancelled)cancelled=reader.cancel().catch(()=>{});};
    transferSignal.addEventListener('abort',cancelReader,{once:true});
    try {
      transferSignal.throwIfAborted();
      const pending=Promise.resolve(fetchImpl(direction==='download'?`https://speed.cloudflare.com/__down?bytes=${downloadRequestBytes}`:'https://speed.cloudflare.com/__up',{
        ...(direction==='upload'?{method:'POST',body:uploadData,headers:{'Content-Type':'application/octet-stream'}}:{}),
        signal:transferSignal,cache:'no-store',redirect:'error',
      }));
      // A synthetic/custom fetch may ignore AbortSignal and resolve late.
      pending.then(value=>{if(transferSignal.aborted)value?.body?.cancel().catch(()=>{});},()=>{});
      response=await abortable(pending,transferSignal);
      transferSignal.throwIfAborted();
      if(!response.ok)throw new Error(`${direction==='download'?'Download':'Upload'}: HTTP ${response.status}`);
      if(direction==='upload') {
        response.body?.cancel().catch(()=>{});
        transferSignal.throwIfAborted();
        add('uploadBytes',uploadData.length);add('completedUploads',1);publish();
        return;
      }
      if(!response.body?.getReader)throw new Error('Download: Antwort enthält keinen Datenstrom.');
      reader=response.body.getReader();let received=0;
      while(true) {
        const chunk=await abortable(reader.read(),transferSignal);
        transferSignal.throwIfAborted();
        if(chunk.done)break;
        const bytes=chunk.value?.byteLength;
        if(!Number.isSafeInteger(bytes)||bytes<0||received+bytes>downloadRequestBytes)throw new Error('Unerwartete Download-Antwort beim Belastungstest.');
        received+=bytes;add('downloadBytes',bytes);publish();
      }
      if(received!==downloadRequestBytes)throw new Error('Download wurde nicht vollständig übertragen.');
      add('completedDownloads',1);publish();
    } finally {
      timers.clearTimeout(timeout);transferSignal.removeEventListener('abort',cancelReader);
      if(reader){cancelReader();reader.releaseLock();}
      else response?.body?.cancel().catch(()=>{});
    }
  };
  const loop=async direction=>{
    try {while(!runSignal.aborted){await transfer(direction);await yieldToEventLoop();}}
    catch(error){fail(error);}
  };

  try {
    signal?.addEventListener('abort',onStop,{once:true});
    if(signal?.aborted)stop('stopped');
    publish(true);
    if(!runSignal.aborted) {
      if(mode!=='download')uploadData=randomBytes(uploadRequestBytes);
      if(durationSeconds)durationTimer=timers.setTimeout(()=>stop('completed'),durationSeconds*1000);
      progressTimer=timers.setInterval(()=>{try{publish();}catch(error){fail(error);}},250);
      await Promise.all([...(mode!=='upload'?[loop('download')]:[]),...(mode!=='download'?[loop('upload')]:[])]);
    }
  } catch(error) {fail(error);}
  finally {
    signal?.removeEventListener('abort',onStop);
    if(durationTimer!==undefined)timers.clearTimeout(durationTimer);
    if(progressTimer!==undefined)timers.clearInterval(progressTimer);
  }
  const result={...summary(),reason:reason||'stopped'};
  if(failure){failure.partial={...result,reason:'error'};throw failure;}
  update(result);
  return result;
}
