import { Worker } from 'node:worker_threads';

export function createIncidentService({onUpdate=()=>{},onError=()=>{}}={}) {
  let queue=[],busy=false,closed=false,stopping=false,dropped=0,closeResolve,closePromise;
  const worker=new Worker(new URL('./incident-worker.js',import.meta.url));
  const flush=()=>{if(closed||busy)return;if(queue.length){busy=true;worker.postMessage({type:'records',records:queue.splice(0,500)});}else if(stopping){busy=true;worker.postMessage({type:'close'});}};
  const timer=setInterval(flush,500);timer.unref();
  const fail=error=>{if(!closed){closed=true;clearInterval(timer);onError(error);closeResolve?.();}};
  worker.on('error',fail);
  worker.on('exit',code=>{if(!closed&&code!==0)fail(new Error('Lokale Ursachenanalyse wurde unerwartet beendet.'));closed=true;clearInterval(timer);closeResolve?.();});
  worker.on('message',message=>{
    if(message.type==='ack'){busy=false;flush();}
    else if(message.type==='update')onUpdate(message);
    else if(message.type==='closed'){closed=true;clearInterval(timer);closeResolve?.();}
  });
  return {
    ingest(record){if(closed||stopping)return;queue.push(record);if(queue.length>2000){queue.shift();dropped++;}},
    status(){return {running:!closed,queued:queue.length,dropped};},
    close(){if(closePromise)return closePromise;closePromise=(async()=>{if(closed)return;stopping=true;let timeout;try{await Promise.race([new Promise(resolve=>{closeResolve=resolve;flush();}),new Promise(resolve=>{timeout=setTimeout(()=>{onError(new Error('Vorfallsanalyse konnte vor dem Beenden nicht fertig gespeichert werden; letzter Zwischenstand bleibt erhalten.'));resolve();},5000);})]);}finally{clearTimeout(timeout);closed=true;clearInterval(timer);await worker.terminate();}})();return closePromise;}
  };
}
