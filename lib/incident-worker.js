import { parentPort } from 'node:worker_threads';
import { IncidentEngine } from './incident-analysis.js';
const engine=new IncidentEngine({onUpdate:update=>parentPort.postMessage({type:'update',...update})});
const timer=setInterval(()=>engine.tick(),1000);
parentPort.on('message',message=>{
  if(message.type==='records') { for(const record of message.records)engine.ingest(record);engine.tick();parentPort.postMessage({type:'ack'}); }
  if(message.type==='close') { clearInterval(timer);engine.close();parentPort.postMessage({type:'closed'});parentPort.close(); }
});
