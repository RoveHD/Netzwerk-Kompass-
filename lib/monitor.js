import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lookup, reverse } from 'node:dns/promises';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { diagnose, isLatencySpike, privateIPv4, subnetHosts, summarize, trafficRate, validateHost } from './analysis.js';
import { runSpeedTest } from './speedtest.js';
import { normalizeStressOptions, runStressTest } from './stress-test.js';
import { normalizeSpeedTestOptions } from '../public/speedtest-options.js';
import { HistoryStore } from './history.js';
import { SessionStore, atomicWrite, durableAppend, safeStoredData } from './session-store.js';
import { deriveDeviceTraffic, deriveWanTraffic } from './device-traffic.js';
import { adapterHealth } from './adapter-health.js';
import { createGameLibrary, GameDetector, initialGameDetection, validateGameSettings } from './game-detection.js';
import { measurementSettings, targetInterval, evaluateMeasurementQuality } from './measurement-quality.js';
import { buildMeshEvidence, compareMeshSnapshots } from './mesh-evidence.js';
import { createIncidentService } from './incident-service.js';
import { createHistoryPolicy, RollupStore, pruneArchives } from './history-policy.js';
import { createSecretStore } from './secret-store.js';

const iso = () => new Date().toISOString();
const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const bounded = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('Zeitüberschreitung')), ms); })]).finally(() => clearTimeout(timer));
};

// Keep graph snapshots well below HistoryStore's 64 KiB record limit. Persist
// only projected router fields; never raw responses, paths, login data or keys.
function fritzHistoryDetails(data) {
  const list=value=>Array.isArray(value)?value:[];
  const string=(value,max=200)=>typeof value==='string'?value.slice(0,max):null;
  const numeric=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
  const boolean=value=>typeof value==='boolean'?value:null;
  const budgeted=(values,project,budget,limit)=>{
    const result=[];let bytes=2;
    for(const value of values.slice(0,limit)){const item=project(value);if(!item)continue;const size=Buffer.byteLength(JSON.stringify(item))+1;if(bytes+size>budget)break;result.push(item);bytes+=size;}
    return result;
  };
  const sourceNodes=list(data.mesh?.nodes),sourceLinks=list(data.mesh?.links);
  const nodes=budgeted(sourceNodes,item=>item&&typeof item.id==='string'&&item.id.length<=200?{id:item.id,name:string(item.name,80),model:string(item.model,80),ip:string(item.ip,45),mac:string(item.mac,17),role:string(item.role,30),interfaces:list(item.interfaces).slice(0,32).map(i=>({id:string(i.id),mac:string(i.mac,17),type:string(i.type,20),isUpstream:boolean(i.isUpstream)})),latency:item.latency?{status:string(item.latency.status,40),roundTripMs:numeric(item.latency.roundTripMs),measuredAtMs:numeric(item.latency.measuredAtMs)}:null}:null,9000,128);
  const links=budgeted(sourceLinks,item=>item&&typeof item.from==='string'&&item.from.length<=200&&typeof item.to==='string'&&item.to.length<=200?{id:string(item.id),from:item.from,to:item.to,fromInterface:string(item.fromInterface),toInterface:string(item.toInterface),type:string(item.type,30),state:string(item.state,30),receiveRateMbps:numeric(item.receiveRateMbps??item.rateMbps),transmitRateMbps:numeric(item.transmitRateMbps),signalPercent:numeric(item.signalPercent)}:null,12000,256);
  const wlan=budgeted(list(data.wlan),item=>item?{id:string(item.id,80),ssid:string(item.ssid,128),enabled:boolean(item.enabled),status:string(item.status,50),channel:numeric(item.channel),frequencyBand:string(item.frequencyBand,40),standard:string(item.standard,40),associatedDevices:numeric(item.associatedDevices),beaconType:string(item.beaconType,50),basicEncryptionModes:string(item.basicEncryptionModes,50),macFilterEnabled:boolean(item.macFilterEnabled),bssid:string(item.bssid,17),packetStats:item.packetStats?{available:item.packetStats.available===true,reason:string(item.packetStats.reason,160),totalPacketsReceived:numeric(item.packetStats.totalPacketsReceived),totalPacketsSent:numeric(item.packetStats.totalPacketsSent)}:null}:null,5000,8);
  const capabilities=budgeted(list(data.capabilities),item=>item?{service:string(item.service,50),instance:string(item.instance,80),action:string(item.action,80),available:item.available===true,reason:string(item.reason,160)}:null,6000,128);
  const deviceTraffic=budgeted(list(data.deviceTraffic),item=>item?{id:string(item.id,80),nodeId:string(item.nodeId,200),name:string(item.name,80),ip:string(item.ip,45),mac:string(item.mac,17),source:string(item.source,40),scope:string(item.scope,20),available:item.available===true,reason:string(item.reason,160),totalBytesReceived:numeric(item.totalBytesReceived),totalBytesSent:numeric(item.totalBytesSent),lastUpdateMs:numeric(item.lastUpdateMs),observedAt:string(item.observedAt,30),counterAgeBasis:string(item.counterAgeBasis,60),counterTimingAvailable:item.counterTimingAvailable===true,counterTimingReason:string(item.counterTimingReason,160),downloadMbps:numeric(item.downloadMbps),uploadMbps:numeric(item.uploadMbps),downloadDeltaBytes:numeric(item.downloadDeltaBytes),uploadDeltaBytes:numeric(item.uploadDeltaBytes),rateAvailable:item.rateAvailable===true,measurementReason:string(item.measurementReason,160),intervalStartedAt:string(item.intervalStartedAt,30),at:string(item.at,30)}:null,10000,128);
  const capability=data.deviceTrafficCapability;
  const hosts=budgeted(list(data.hosts),item=>item?{name:string(item.name,80),ip:string(item.ip,45),mac:string(item.mac,17),active:boolean(item.active),interfaceType:string(item.interfaceType,30),guest:boolean(item.guest),wanAccess:string(item.wanAccess,20),priority:boolean(item.priority),filterProfileId:string(item.filterProfileId,40),model:string(item.model,80),linkRateMbps:numeric(item.linkRateMbps),lanPort:numeric(item.lanPort),vpn:boolean(item.vpn),updateAvailable:boolean(item.updateAvailable),addressSource:string(item.addressSource,30),leaseTimeRemainingSeconds:numeric(item.leaseTimeRemainingSeconds),deviceClass:string(item.deviceClass,40)}:null,8000,128);
  const project=(item,strings,numbers,booleans)=>item?Object.fromEntries([...strings.map(key=>[key,string(item[key],100)]),...numbers.map(key=>[key,numeric(item[key])]),...booleans.map(key=>[key,boolean(item[key])])]):null;
  const addressList=value=>Array.isArray(value)?value.slice(0,8).map(value=>string(value,45)).filter(Boolean):null;
  const raw=data.diagnostics;
  const diagnostics=raw?{ethernet:budgeted(list(raw.ethernet),item=>project(item,['id','reason','status','mac','duplexMode'],['maxBitRateMbps','totalBytesReceived','totalBytesSent','totalPacketsReceived','totalPacketsSent'],['available','enabled']),3500,16),lan:raw.lan?{...project(raw.lan,['reason','minAddress','maxAddress','subnetMask','domainName'],[],['available','dhcpEnabled','dhcpConfigurable','dhcpRelay']),dnsServers:addressList(raw.lan.dnsServers),routers:addressList(raw.lan.routers)}:null,internet:raw.internet?{...project(raw.internet,['reason','service','status','connectionType','externalIp','lastConnectionError','ipv6Status'],['portMappingCount','ipv6UptimeSeconds'],['available','enabled','natEnabled','rsipAvailable']),dnsServers:addressList(raw.internet.dnsServers)}:null}:null;
  return {mesh:{available:data.mesh?.available!==false,nodes,links,schemaVersion:string(data.mesh?.schemaVersion,20),totalNodes:sourceNodes.length,totalLinks:sourceLinks.length,truncated:data.mesh?.truncated===true||nodes.length<sourceNodes.length||links.length<sourceLinks.length},hosts,hostsTruncated:hosts.length<list(data.hosts).length,diagnostics,wlan,capabilities,deviceTraffic,deviceTrafficTruncated:deviceTraffic.length<list(data.deviceTraffic).length,deviceTrafficCapability:capability?{available:capability.available===true,source:string(capability.source,40),scope:string(capability.scope,20),reason:string(capability.reason,320)}:null};
}

export class Monitor {
  constructor(probes, { dataDir, intervalMs = 1000, speedTestRunner = runSpeedTest, stressTestRunner = runStressTest } = {}) {
    this.probes = probes;
    this.pingProbe = probes.createPingMonitor ? probes.createPingMonitor() : probes;
    this.trafficProbe = probes.createTrafficMonitor ? probes.createTrafficMonitor() : null;
    this.trafficIntervalMs=1000;this.fritzTrafficIntervalMs=2000;this.fritzDeviceIntervalMs=5000;
    this.dataDir = dataDir;
    this.history = new HistoryStore({dataDir});
    this.persistence = new SessionStore({dataDir});
    this.intervalMs = intervalMs;
    this.speedTestRunner = speedTestRunner;
    this.stressTestRunner = stressTestRunner;
    this.closed = false;
    this.measureEpoch = 0;
    this.monitoringEpoch = 0;
    this.targetEpochs = new WeakMap();
    this.pending = new Set();
    this.abort = new AbortController();
    this.logQueue = Promise.resolve();
    this.saveQueue = Promise.resolve();
    this.state = {
      version:appVersion, startedAt:iso(), measurementStartedAt:null, monitoring:true,
      network:{ interfaces:[], defaultInterfaceId:null, neighbors:[], wifi:{connected:false,networks:[]}, warnings:[] },
      selectedInterfaceId:null, targets:[], devices:[], repeaterHost:null,
      traffic:{interfaceId:null,downloadMbps:null,uploadMbps:null,intervalStartedAt:null,at:null,history:[]},
      scan:{running:false,done:0,total:0,message:'Noch kein Gerätescan gestartet.',error:null,limited:false},
      speedTest:{running:false,phase:'idle',progress:0,downloadMbps:null,uploadMbps:null,downloadBytes:null,uploadBytes:null,pingBeforeMs:null,pingDuringDownloadMs:null,pingDuringDownloadCount:0,pingDuringUploadMs:null,pingDuringUploadCount:0,pingAfterMs:null,error:null,at:null},
      events:[], diagnosis:[], dns:null, lastError:null,
      stressTest:{running:false,stopping:false,mode:'both',durationSeconds:300,startedAt:null,elapsedSeconds:0,downloadBytes:0,uploadBytes:0,downloadMbps:null,uploadMbps:null,error:null,reason:null},
    };
    this.settings = { targets:[], selectedInterfaceId:null };
    this.state.gameDetection = initialGameDetection();
    this.gameDetector = new GameDetector(this.state.gameDetection, event => {
      this.state.events.unshift(event); this.state.events.length = Math.min(300, this.state.events.length);
      this.log(event);
    });
    this.gameLibrary = createGameLibrary();
    this.gameEpoch = 0;
    this.state.fritzbox={connected:false,connecting:false,busy:false,host:null,error:null,history:[]};
    this.fritzEpoch=0;this.credentialEpoch=0;this.credentialQueue=Promise.resolve();
    this.pendingFritzLag=null;
    this.recordListeners=new Set();this.incidentListeners=new Set();this.nextPing=new Map();this.lastPingAt=new Map();
    this.state.measurement={...measurementSettings(),quality:null};
    this.state.incidents=[];this.state.analysisStatus={running:false,error:null};
    this.state.routerCredentialStorage={enabled:false,error:null};
    this.rawBatch=null;
    this.rawQueuedBytes=0;this.rawDropped=null;
    this.state.rawPersistence={droppedRecords:0,pendingDroppedRecords:0,lastGapAt:null};
    this.secretStore=dataDir?createSecretStore({dataDir:path.resolve(dataDir)}):null;
    this.historyPolicy=createHistoryPolicy();
    this.rollups=new RollupStore({dataDir});
  }

  start() {
    if(this.startPromise)return this.startPromise;
    if(this.closed)return Promise.resolve();
    this.startPromise=this.performStart();
    return this.startPromise;
  }

  async performStart() {
    this.starting=true;
    try {
    if (this.dataDir) {
      try {
        const settings = JSON.parse(readFileSync(path.join(this.dataDir,'settings.json'),'utf8'));
        if (!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('Ungültiges Einstellungsformat. Standardwerte werden verwendet.');
        this.settings = settings;
        if(typeof settings.measurementStartedAt==='string'&&Number.isFinite(Date.parse(settings.measurementStartedAt)))this.state.measurementStartedAt=new Date(settings.measurementStartedAt).toISOString();
      }
      catch (error) { if (error.code !== 'ENOENT') this.event('warning','Einstellungen konnten nicht gelesen werden',error.message); }
    }
    try {this.historyPolicy=createHistoryPolicy(this.settings.historyPolicy);}catch{}
    this.history.setPolicy(this.historyPolicy);
    await this.history.start();
    if(this.closed)return;
    // An invalid storage location is a startup failure, before starting probes.
    // History may continue in memory after I/O failure; the app cannot silently
    // use that fallback for a data directory which is actually a file.
    if(this.dataDir)await mkdir(this.dataDir,{recursive:true});
    if(this.closed)return;
    await this.persistence.beginSession();
    if(this.closed)return;
    await this.history.recoverArchives();
    if(this.closed)return;
    if (this.settings.gameDetection !== undefined) {
      try { Object.assign(this.state.gameDetection, validateGameSettings(this.settings.gameDetection)); }
      catch { this.state.gameDetection.warning = 'Gespeicherte Spieleinstellungen sind ungültig; Standardwerte werden verwendet.'; }
    }
    try { this.state.measurement={...measurementSettings(this.settings.measurement),quality:null};this.historyPolicy=createHistoryPolicy(this.settings.historyPolicy); }
    catch(error){this.event('warning','Messeinstellungen ungültig',error.message);}
    this.history.setPolicy(this.historyPolicy);this.rollups.retentionDays=this.historyPolicy.rollupDays;
    await this.rollups.start().catch(error=>this.event('warning','Langzeitstatistik eingeschränkt',error.message));
    const retainedPings=this.history.entries.filter(entry=>entry.type==='ping').map(entry=>JSON.parse(entry.json));
    const localPings=retainedPings.filter(record=>record.remote!==true);
    const peerPings=retainedPings.filter(record=>record.remote===true).sort((a,b)=>String(a.sourceDeviceId).localeCompare(String(b.sourceDeviceId))||(a.sequence||0)-(b.sequence||0));
    for(const record of [...localPings,...peerPings])this.rollups.recordPing({record});
    this.incidentService=createIncidentService({onUpdate:update=>this.applyIncident(update),onError:error=>{this.state.analysisStatus={running:false,error:error.message};this.event('error','Vorfallsanalyse unterbrochen',error.message);}});
    this.state.analysisStatus={running:true,error:null};
    for(const row of this.history.entries.filter(entry=>entry.type==='incident').slice(-100)) {
      let incident=JSON.parse(row.json).incident;if(!incident?.id)continue;
      if(incident.status!=='complete') {
        incident={...incident,status:'complete',endedAt:incident.endedAt||incident.lastSeenAt||incident.updatedAt||incident.startedAt,endReason:'process_interrupted',limitations:[...(incident.limitations||[]),'Messprozess wurde beendet oder neu gestartet; eine Erholung und der vollständige Nachlauf sind nicht belegt.']};
        if(incident.windows?.after)incident.windows.after.complete=false;
        this.log({type:'incident',at:iso(),incident});
      }
      this.state.incidents.unshift(incident);
    }
    this.peerRecords=new Set(this.history.entries.filter(entry=>entry.json.includes('"remote":true')).map(entry=>{const r=JSON.parse(entry.json);return `${r.sourceDeviceId}:${r.sequence}`;}));
    this.state.gameDetection.status = this.state.gameDetection.enabled ? 'checking' : 'disabled';
    await this.refresh();
    if(this.closed)return;
    const savedSettings=this.settings;
    for (const item of (Array.isArray(this.settings.targets) ? this.settings.targets : []).slice(0,24)) {
      try {
        const target=item.kind==='repeater'?this.setRepeater(item.host,item.label,false):this.addTarget(item.host,item.label,false);
        if(typeof item.enabled==='boolean')target.enabled=item.enabled;
      } catch { /* Invalid saved entries are ignored, never executed. */ }
    }
    const repeaters=this.state.targets.filter(t=>t.kind==='repeater');
    // Older versions stored only one repeater and implicitly used it as the PC connection.
    const primary=Object.hasOwn(savedSettings,'repeaterHost')?savedSettings.repeaterHost:(repeaters.length===1?repeaters[0].host:null);
    this.state.repeaterHost=repeaters.some(t=>t.host===primary)?primary:null;
    if(this.settings.rememberRouter===true && this.secretStore) {
      this.state.routerCredentialStorage.enabled=true;
      try {const credentials=await this.secretStore.read('router-credentials');if(credentials)await this.connectFritz({...credentials,remember:true});else this.state.routerCredentialStorage.error='Gespeicherte Anmeldung fehlt; bitte neu verbinden.';}
      catch {this.state.routerCredentialStorage.error='Gespeicherte FRITZ!Box-Anmeldung konnte nicht verwendet werden. Bitte erneut anmelden.';}
    }
    this.event('info','Überwachung gestartet','Etwa jede Sekunde: Router, alle markierten Repeater und zwei unabhängige Internetziele. Daten bleiben lokal; externe Ziele erhalten Ping-Anfragen.');
    this.schedule(0);
    this.scheduleTraffic(0);
    this.scheduleGames(0);
    }finally{this.starting=false;}
  }

  snapshot() {
    this.state.diagnosis = diagnose(this.state);
    if(this.incidentService)this.state.analysisStatus={...this.state.analysisStatus,...this.incidentService.status()};
    this.state.persistence = this.persistence.snapshot();
    this.state.persistence.lastError=this.state.persistence.lastError||this.logError||this.history.lastError;
    this.state.historyPolicy=this.historyPolicy;
    return this.state;
  }

  historySnapshot(hours=1,cursor) {
    return this.history.snapshot(hours,{cursor,measurementStartedAt:this.state.measurementStartedAt,localOnly:true});
  }

  listIncidents() {
    const records=this.history.entries.filter(entry=>entry.type==='incident').map(entry=>JSON.parse(entry.json).incident).filter(Boolean);
    const byId=new Map(records.map(incident=>[incident.id,incident]));
    for(const incident of this.state.incidents)byId.set(incident.id,incident);
    return [...byId.values()].sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)).slice(0,500);
  }

  event(level,title,detail,at=iso()) {
    const event = {at,level,title,detail};
    this.state.events.unshift(event);
    this.state.events.length = Math.min(this.state.events.length,300);
    this.log({type:'event',...event});
  }

  log(value) {
    value={...value,recordId:randomUUID()};
    const adapter=this.state.network.interfaces.find(item=>item.id===this.state.selectedInterfaceId);
    if(['ping','traffic','network','wifi','dns','event'].includes(value.type))value={...value,sourceDeviceId:'local',epoch:this.measureEpoch,interfaceId:this.state.selectedInterfaceId,pcMac:adapter?.mac||null,ipv4:(adapter?.ipv4||[]).map(ip=>ip.address),routingConfirmed:value.type==='ping'?Boolean(adapter&&value.results?.length&&value.results.every(result=>result.routeInterfaceId===adapter.id)):false};
    if (['ping','traffic','dns','event'].includes(value.type) && !value.gameSessionIds) value.gameSessionIds=this.state.gameDetection.active.map(game=>game.sessionId);
    if(['traffic','dns','fritzbox'].includes(value.type)||value.type==='ping'&&this.state.measurement.mode!=='precision')value={...value,diagnosis:diagnose(this.state)};
    if(this.persistence.currentSession)value={...value,appSessionId:this.persistence.currentSession.id};
    if(this.state.measurementStartedAt)value={...value,measurementStartedAt:this.state.measurementStartedAt};
    try {value=safeStoredData(value);this.history.record(value);} catch(error) {this.state.lastError=`Verlauf konnte nicht übernommen werden: ${error.message}`;return;}
    if(value.type==='ping')this.rollups.recordPing({record:value});
    if(['ping','traffic','dns','network','wifi','fritzbox','mesh_change','router_event','event'].includes(value.type))this.incidentService?.ingest(value);
    for(const listener of this.recordListeners){try{listener(value);}catch{}}
    this.appendRaw(value);
  }

  appendRaw(value) {
    if(!this.dataDir)return false;
    const text=JSON.stringify(value)+'\n',bytes=Buffer.byteLength(text);
    // Reserve room for the bounded loss notice; count sealed and in-flight
    // batches too, not merely the batch currently collecting records.
    if(this.rawQueuedBytes+bytes>4*1024*1024-4096) {
      const at=iso();this.rawDropped??={count:0,from:at,to:at};
      this.rawDropped.count++;this.rawDropped.to=at;
      this.state.rawPersistence.droppedRecords++;this.state.rawPersistence.pendingDroppedRecords++;
      this.state.lastError=`Messlücke im Roharchiv: ${this.state.rawPersistence.pendingDroppedRecords} Datensätze wegen überlasteter Schreibwarteschlange verworfen.`;
      // A single oversized entry can be dropped with no ordinary batch queued.
      // Queue one empty carrier so its notice still has a durable destination.
      if(this.rawBatch)this.flushRaw();
      if(this.rawQueuedBytes)return false;
    }
    const accepted=this.rawQueuedBytes+bytes<=4*1024*1024-4096;
    if(!this.rawBatch) {
      const batch={entries:[],bytes:0,release:null};
      const ready=new Promise(resolve=>{batch.release=resolve;});this.rawBatch=batch;
      this.logQueue=this.logQueue.then(async()=>{
        await ready;
        const file=path.join(this.dataDir,`messungen-${new Date().toISOString().slice(0,10)}.jsonl`);
        try {
          if(batch.entries.length) {
            await durableAppend(file,batch.entries.map(item=>item.text).join(''));
            await this.persistence.notePersisted(batch.entries.at(-1).at);
          }
        } finally {this.rawQueuedBytes-=batch.bytes;}
        // Each pass writes only newly reported drops. Disk failures stop this
        // task immediately; they are not retried automatically.
        while(this.rawDropped) {
          const dropped=this.rawDropped;this.rawDropped=null;
          const gap={type:'event',kind:'measurement-gap',level:'warning',at:iso(),recordId:randomUUID(),sourceDeviceId:'local',
            title:'Messlücke im Roharchiv',detail:`${dropped.count} Datensätze wurden wegen überlasteter Schreibwarteschlange nicht im Roharchiv gespeichert. Dies ist kein Nachweis eines Netzwerkausfalls.`,
            droppedRecords:dropped.count,interval:{from:dropped.from,to:dropped.to},quality:{gap:true}};
          const gapText=JSON.stringify(gap)+'\n',gapBytes=Buffer.byteLength(gapText);
          this.rawQueuedBytes+=gapBytes;
          try {
            await durableAppend(file,gapText);
            await this.persistence.notePersisted(gap.at);
          } catch(error) {
            this.rawDropped={count:dropped.count+(this.rawDropped?.count||0),from:dropped.from,to:this.rawDropped?.to||dropped.to};
            throw error;
          } finally {this.rawQueuedBytes-=gapBytes;}
          this.state.rawPersistence.pendingDroppedRecords-=dropped.count;this.state.rawPersistence.lastGapAt=gap.at;
          this.state.events.unshift(gap);this.state.events.length=Math.min(300,this.state.events.length);
          this.history.record(gap);
        }
        this.logError=null;
      }).catch(error=>{this.logError=this.state.lastError=`Protokoll konnte nicht gespeichert werden: ${error.message}`;});
      this.rawTimer=setTimeout(()=>this.flushRaw(),500);
    }
    if(!accepted){this.flushRaw();return false;}
    this.rawBatch.entries.push({text,at:value.at});this.rawBatch.bytes+=bytes;this.rawQueuedBytes+=bytes;
    if(this.rawBatch.bytes>=256*1024)this.flushRaw();
    return true;
  }

  flushRaw() {
    clearTimeout(this.rawTimer);this.rawTimer=null;
    const batch=this.rawBatch;this.rawBatch=null;batch?.release();return this.logQueue;
  }

  onRecord(callback){this.recordListeners.add(callback);return()=>this.recordListeners.delete(callback);}
  onIncident(callback){this.incidentListeners.add(callback);return()=>this.incidentListeners.delete(callback);}
  applyIncident({kind,incident,persist}) {
    if(kind==='started'){if(this.closed)return;this.requestFritzLag(incident.startedAt);if(Date.now()-(this.lastIncidentProbes||0)>=30000){this.lastIncidentProbes=Date.now();this.nextPing.clear();}for(const callback of this.incidentListeners){try{callback(incident);}catch{}}return;}
    this.state.incidents=[incident,...this.state.incidents.filter(item=>item.id!==incident.id)].sort((a,b)=>Date.parse(b.startedAt)-Date.parse(a.startedAt)).slice(0,100);
    if(persist)this.log({type:'incident',at:incident.updatedAt,incident});
  }
  ingestPeer(record) {
    this.peerRecords??=new Set();const key=`${record.sourceDeviceId}:${record.sequence}`;
    if(this.peerRecords.has(key))return;
    const value={...record,type:record.type==='topology'?'scan':record.type,remote:true};
    if(this.rollups.hasPeerPing(value))return;
    const retained=this.history.record(value);
    if(retained!==false)this.incidentService?.ingest(value);
    this.peerRecords.add(key);if(this.peerRecords.size>12000)this.peerRecords.delete(this.peerRecords.values().next().value);
    this.appendRaw(value);
    if(value.type==='ping')this.rollups.recordPing({record:value});
  }
  async setMeasurement(value) {
    const settings=measurementSettings(value);this.settings.measurement=settings;this.state.measurement={...settings,quality:null};this.nextPing.clear();
    await this.saveSettings({throwOnError:true});return this.state.measurement;
  }
  async setHistoryPolicy(value) {
    const policy=createHistoryPolicy(value);this.historyPolicy=policy;this.settings.historyPolicy=policy;this.history.setPolicy(policy);this.rollups.retentionDays=policy.rollupDays;
    await this.archiveMaintenance();await this.saveSettings({throwOnError:true});return policy;
  }
  async archiveMaintenance() {
    if(this.archiveTask)return this.archiveTask;
    this.flushRaw();
    this.logQueue=this.logQueue.then(()=>pruneArchives({dataDir:this.dataDir,policy:this.historyPolicy})).catch(error=>{this.logError=error.message;});
    this.archiveTask=Promise.all([this.logQueue,this.rollups.flush()]).finally(()=>{this.archiveTask=null;});
    return this.archiveTask;
  }
  async forgetRouter() {
    this.credentialEpoch++;
    const task=this.credentialQueue.catch(()=>{}).then(async()=>{await this.secretStore?.remove('router-credentials');this.settings.rememberRouter=false;this.state.routerCredentialStorage={enabled:false,error:null};await this.saveSettings({throwOnError:true});});
    this.credentialQueue=task;return task;
  }

  saveSettings({throwOnError=false}={}) {
    this.settings = {...this.settings,selectedInterfaceId:this.state.selectedInterfaceId,repeaterHost:this.state.repeaterHost,targets:this.state.targets.filter(t=>!t.meshAutomatic&&['custom','device','repeater'].includes(t.kind)).map(t=>({host:t.host,label:t.label,kind:t.kind,enabled:t.enabled})),gameDetection:{enabled:this.state.gameDetection.enabled,customGames:this.state.gameDetection.customGames.map(game=>({...game}))},...(this.state.measurementStartedAt?{measurementStartedAt:this.state.measurementStartedAt}:{})};
    if (!this.dataDir) return;
    const text = JSON.stringify(this.settings,null,2);
    const file = path.join(this.dataDir,'settings.json');
    const saving=this.saveQueue.then(() => atomicWrite(file,text));
    this.saveQueue=saving.catch(error=>this.event('warning','Einstellungen nicht gespeichert',error.message));
    return throwOnError?saving:this.saveQueue;
  }

  makeTarget(host,label,kind) {
    return {id:randomUUID(),host,label,kind,enabled:true,samples:[],stats:summarize([],kind)};
  }

  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise=this.performRefresh();
    try {await this.refreshPromise;} finally {this.refreshPromise=null;}
  }

  async performRefresh() {
    let epoch=this.measureEpoch;
    this.refreshing = true;
    try {
      const oldBssid = this.state.network.wifi?.bssid;
      const network = await this.probes.discoverNetwork();
      if(this.closed||epoch!==this.measureEpoch)return;
      const selected = this.state.selectedInterfaceId || this.settings.selectedInterfaceId;
      const previousAdapter=this.state.network.interfaces.find(i=>i.id===this.state.selectedInterfaceId);
      const signature=i=>i?JSON.stringify([i.id,i.ipv4,i.gateway,i.dns]):null;
      this.state.network = network;
      this.state.selectedInterfaceId = network.interfaces.some(i=>i.id===selected) ? selected : network.defaultInterfaceId || network.interfaces[0]?.id || null;
      const nextAdapter=network.interfaces.find(i=>i.id===this.state.selectedInterfaceId);
      if (previousAdapter && signature(previousAdapter)!==signature(nextAdapter)) {
        this.resetMeasurements();
        epoch=this.measureEpoch;
        this.event('info','Netzwerkverbindung geändert','Adapter, Adresse, Gateway oder DNS-Konfiguration haben sich geändert. Sichtbare Messfenster wurden zurückgesetzt.');
      }
      this.syncGateway();
      this.mergeNeighbors(network.neighbors);
      this.log({type:'network',at:iso(),interfaceId:this.state.selectedInterfaceId,name:nextAdapter?.name,ipv4:nextAdapter?.ipv4||[],gateway:nextAdapter?.gateway||null,dns:nextAdapter?.dns||[],status:nextAdapter?'Up':'Disconnected',linkSpeedMbps:nextAdapter?.linkSpeedMbps??null});
      this.log({type:'wifi',at:iso(),...network.wifi,networks:undefined});
      if (oldBssid && network.wifi?.bssid && oldBssid !== network.wifi.bssid) this.event('info','WLAN-Access-Point gewechselt',`BSSID wechselte von ${oldBssid} zu ${network.wifi.bssid}. Das kann ein Mesh-Roaming sein.`);
      if (this.state.lastError?.startsWith('Netzwerkerkennung:')) this.state.lastError = null;
    } catch(error) {
      if(this.closed||epoch!==this.measureEpoch)return;
      this.state.lastError = `Netzwerkerkennung: ${error.message}`;
      this.event('warning','Netzwerkinformationen unvollständig',error.message);
    } finally { this.refreshing = false; if(epoch===this.measureEpoch)this.lastRefresh=Date.now(); }
  }

  syncGateway() {
    const selected = this.state.network.interfaces.find(i=>i.id===this.state.selectedInterfaceId);
    const existing = this.state.targets.find(t=>t.kind==='gateway');
    if (existing?.host !== selected?.gateway) {
      this.state.targets = this.state.targets.filter(t=>t.kind!=='gateway');
      if (selected?.gateway) {
        const target=this.state.targets.find(t=>t.host===selected.gateway)||this.makeTarget(selected.gateway,'Router / Gateway','gateway');
        this.state.targets=this.state.targets.filter(t=>t!==target);
        target.kind='gateway';target.label='Router / Gateway';target.stats=summarize(target.samples,'gateway');
        this.state.targets.unshift(target);
        if(this.state.repeaterHost===target.host)this.state.repeaterHost=null;
      }
    }
    if (!this.state.targets.some(t=>t.kind==='internet')) {
      this.state.targets.push(this.makeTarget('1.1.1.1','Internet · Cloudflare','internet'),this.makeTarget('9.9.9.9','Internet · Quad9','internet'));
    }
  }

  selectInterface(id) {
    if (this.state.scan.running) throw new Error('Bitte den laufenden Scan abwarten.');
    if (!this.state.network.interfaces.some(i=>i.id===id)) throw new Error('Netzwerkadapter nicht gefunden.');
    if (id === this.state.selectedInterfaceId) return;
    this.state.selectedInterfaceId = id;
    this.resetMeasurements();
    this.state.traffic = {interfaceId:id,downloadMbps:null,uploadMbps:null,intervalStartedAt:null,at:null,history:[]};
    this.previousCounter = null;
    this.syncGateway();
    this.event('info','Netzwerkadapter gewechselt','Scan und Datenverkehr beziehen sich auf den ausgewählten Adapter. Windows bestimmt den tatsächlichen Routingweg der Ping- und Speedtest-Anfragen.');
    this.saveSettings();
  }

  resetMeasurements() {
    this.measureEpoch++;
    this.nextPing.clear();this.lastPingAt.clear();
    this.pendingFritzLag=null;
    this.fritzPrevious=null;
    this.deviceTrafficPrevious=null;
    this.previousCounter=null;
    this.lastCounters=0;
    this.lastFritzTraffic=0;this.lastFritzDevices=0;
    this.trafficIntervalMs=1000;this.fritzTrafficIntervalMs=2000;this.fritzDeviceIntervalMs=5000;
    this.state.dns=null;
    this.lastDns=0;
    this.state.traffic={interfaceId:this.state.selectedInterfaceId,downloadMbps:null,uploadMbps:null,intervalStartedAt:null,at:null,history:[]};
    for (const target of this.state.targets) {target.samples=[];target.lastError=null;target.spiking=false;target.stats=summarize([],target.kind);}
  }

  async reset() {
    if(this.closed)throw new Error('Das Programm wird beendet.');
    if(this.starting||this.state.scan.running||this.state.speedTest.running||this.state.stressTest.running||this.state.fritzbox.connecting||this.fritzConnecting){const error=new Error('Bitte den Programmstart, laufenden Gerätescan, Speedtest, Dauerbelastungstest oder die FRITZ!Box-Anmeldung vor dem Reset abwarten.');error.code='MONITOR_BUSY';throw error;}
    const cutoff=new Date(Math.max(Date.now(),(Date.parse(this.state.measurementStartedAt)||0)+1)).toISOString();
    this.state.measurementStartedAt=cutoff;
    this.resetMeasurements();
    this.setMonitoring(true);
    this.state.devices=[];
    this.state.scan={running:false,done:0,total:0,message:'Noch kein Gerätescan in dieser Messperiode gestartet.',error:null,limited:false};
    this.state.stressTest={running:false,stopping:false,mode:'both',durationSeconds:300,startedAt:null,elapsedSeconds:0,downloadBytes:0,uploadBytes:0,downloadMbps:null,uploadMbps:null,error:null,reason:null};
    this.state.speedTest={running:false,phase:'idle',progress:0,downloadMbps:null,uploadMbps:null,downloadBytes:null,uploadBytes:null,pingBeforeMs:null,pingDuringDownloadMs:null,pingDuringDownloadCount:0,pingDuringUploadMs:null,pingDuringUploadCount:0,pingAfterMs:null,error:null,at:null};
    this.state.events=[];this.state.diagnosis=[];this.state.lastError=null;
    this.state.network={...this.state.network,neighbors:[],warnings:[],wifi:{connected:null,ssid:null,bssid:null,signalPercent:null,channel:null,radio:null,receiveRateMbps:null,transmitRateMbps:null,networks:[],error:'Seit dem Reset noch keine WLAN-Messung.'}};
    this.lastRefresh=0;this.lastFritz=0;
    this.fritzEpoch++;this.fritzPrevious=null;this.deviceTrafficPrevious=null;
    const old=this.state.fritzbox;
    this.state.fritzbox={connected:Boolean(this.fritzClient?.connected),connecting:false,busy:Boolean(this.fritzPoll),host:old.host,error:null,history:[],device:old.device?{model:old.device.model,firmware:old.device.firmware,uptimeSeconds:null}:undefined,wan:{status:null,uptimeSeconds:null,downstreamMbps:null,upstreamMbps:null,totalBytesReceived:null,totalBytesSent:null,downloadMbps:null,uploadMbps:null},dsl:null,hosts:[],mesh:{nodes:[],links:[]},log:'',warnings:[]};
    this.event('info','Messung zurückgesetzt','Neue Messperiode gestartet. Einstellungen und FRITZ!Box-Anmeldung bleiben erhalten; frühere Rohprotokolle bleiben gespeichert.',cutoff);
    await this.saveSettings({throwOnError:true});
    return {ok:true,measurementStartedAt:cutoff};
  }

  addTarget(host,label,save=true) {
    host = validateHost(host);
    const existing = this.state.targets.find(t=>t.host===host);
    if (existing) { this.toggleTarget(existing.id,true,false); if(save)this.saveSettings(); return existing; }
    if (this.state.targets.length >= 24) throw new Error('Maximal 24 Ziele gleichzeitig. Bitte zuerst ein eigenes Ziel entfernen.');
    const cleanLabel = typeof label === 'string' ? label.trim().slice(0,80) : '';
    const target = this.makeTarget(host,cleanLabel || host,privateIPv4(host) ? 'device' : 'custom');
    this.state.targets.push(target);
    if (save) this.saveSettings();
    return target;
  }

  setMonitoring(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('Ungültiger Überwachungsstatus.');
    if (enabled === this.state.monitoring) return;
    this.monitoringEpoch++;
    this.state.monitoring=enabled;
    this.pendingFritzLag=null;
    this.fritzPrevious=null;
    this.deviceTrafficPrevious=null;
    this.previousCounter=null;this.lastCounters=0;this.lastFritzTraffic=0;this.lastFritzDevices=0;
    this.trafficIntervalMs=1000;this.fritzTrafficIntervalMs=2000;this.fritzDeviceIntervalMs=5000;
    if(enabled)this.lastDns=0;
  }

  toggleTarget(id,enabled,save=true) {
    const target = this.state.targets.find(t=>t.id===id);
    if (!target || typeof enabled !== 'boolean') throw new Error('Ungültiges Ziel.');
    if(target.enabled!==enabled)this.targetEpochs.set(target,(this.targetEpochs.get(target)||0)+1);
    target.enabled=enabled;
    if(save)this.saveSettings();
  }

  setRepeater(host,label='Mesh-Repeater',save=true) {
    host=validateHost(host);
    if(this.state.targets.some(t=>t.host===host&&['gateway','internet'].includes(t.kind)))throw new Error('Der Repeater muss ein anderes Ziel als Router oder Internet sein.');
    const target=this.addTarget(host,label,false);
    target.kind='repeater';target.label=typeof label==='string'&&label.trim()?label.trim().slice(0,80):'Mesh-Repeater';
    target.stats=summarize(target.samples,'repeater');
    if(save)this.saveSettings();
    return target;
  }

  selectRepeater(host) {
    if(host!==null) {
      host=validateHost(host);
      if(!this.state.targets.some(t=>t.host===host&&t.kind==='repeater'))throw new Error('Bitte zuerst ein Ziel als Repeater markieren.');
    }
    if(this.state.repeaterHost===host)return {repeaterHost:host};
    this.state.repeaterHost=host;
    this.event('info','PC-Anschluss geändert',host?`Ausgewählter Repeater am PC: ${host}. Andere Repeater bleiben unabhängige Messziele; ihre Verbindung untereinander ist unbekannt.`:'Repeater am PC ist nicht zugeordnet. Aus den Ping-Zielen wird kein Mesh-Pfad abgeleitet.');
    this.saveSettings();
    return {repeaterHost:host};
  }

  markLag(note) {
    const since=Date.now()-30000;
    const summaries=this.state.targets.filter(t=>t.enabled).map(t=>({label:t.label,host:t.host,kind:t.kind,...summarize(t.samples.filter(s=>Date.parse(s.at)>=since),t.kind)}));
    const text=summaries.map(s=>`${s.label}: ${s.sent?s.received+'/'+s.sent+' Antworten, Spitze '+(s.maxMs??'–')+' ms':'keine Messung'}`).join(' · ');
    const games=this.state.gameDetection.active;
    const gameContext=games.length?`Beobachtete Spiele: ${games.map(game=>game.name).join(', ')}${this.state.gameDetection.status==='error'?' (letzter Scan fehlgeschlagen; aktueller Zustand unbestätigt)':''}. `:'';
    const detail=`Letzte 30 Sekunden: ${text}. ${this.state.speedTest.running?'Speedtest war aktiv. ':''}${gameContext}Markierung hält den Zeitpunkt fest; sie beweist keine Ursache.`;
    const event={type:'event',at:iso(),level:'warning',title:'Spiellag markiert',detail,note:typeof note==='string'?note.slice(0,300):'',measurements:summaries,gameSessionIds:games.map(game=>game.sessionId)};
    this.state.events.unshift(event);this.state.events.length=Math.min(this.state.events.length,300);this.log(event);
    this.requestFritzLag(event.at);
    return event;
  }

  requestFritzLag(triggeredAt) {
    if(this.closed||!this.state.monitoring||!this.fritzClient?.connected)return;
    // Coalesce a burst until the next eligible maintenance poll. A trigger
    // arriving after that poll starts creates a separate pending capture.
    this.pendingFritzLag??={reason:'lag',triggeredAt};
  }

  async connectFritz(credentials) {
    if(this.state.fritzbox.connecting)throw new Error('Die FRITZ!Box-Anmeldung läuft bereits.');
    const username=credentials?.username===undefined?'':credentials.username;
    if(typeof credentials?.host!=='string'||typeof username!=='string'||typeof credentials?.password!=='string'||username.length>128||!credentials.password||credentials.password.length>512)throw new Error('Bitte FRITZ!Box-Adresse, Kennwort und gegebenenfalls den optionalen Benutzernamen prüfen.');
    const host=validateHost(credentials.host);
    if(this.fritzConnecting)throw new Error('Die FRITZ!Box-Anmeldung läuft bereits.');
    this.fritzConnecting=true;
    try {
    const {FritzBoxClient}=await import('./fritzbox.js');
    if(this.closed)throw new Error('Das Programm wird beendet.');
    if(this.state.fritzbox.connecting)throw new Error('Die FRITZ!Box-Anmeldung läuft bereits.');
    this.disconnectFritz(false);
    const epoch=this.fritzEpoch,credentialEpoch=this.credentialEpoch;
    const client=new FritzBoxClient();this.fritzClient=client;
    this.state.fritzbox={connected:false,connecting:true,busy:true,host,error:null,history:[]};
    try {
      const data=await client.connect({...credentials,host,username:username.trim()});
      if(epoch!==this.fritzEpoch||this.closed)return;
      this.applyFritz(data);
      if(credentials.remember===true) {
        if(!this.secretStore)throw new Error('Geschützte Speicherung ist in dieser Instanz nicht verfügbar.');
        const task=this.credentialQueue.catch(()=>{}).then(async()=>{
          if(credentialEpoch!==this.credentialEpoch||epoch!==this.fritzEpoch||this.closed)return;
          await this.secretStore.write('router-credentials',{host,username:username.trim(),password:credentials.password});
          if(credentialEpoch!==this.credentialEpoch||epoch!==this.fritzEpoch||this.closed){await this.secretStore.remove('router-credentials');return;}
          this.settings.rememberRouter=true;this.state.routerCredentialStorage={enabled:true,error:null};await this.saveSettings({throwOnError:true});
        });this.credentialQueue=task;await task;
      } else if(credentials.remember===false) await this.forgetRouter();
      if(epoch!==this.fritzEpoch||this.closed)return;
      this.event('info','FRITZ!Box verbunden',this.settings.rememberRouter?'Routerdaten werden nur gelesen. Anmeldung ist für dieses Windows-Benutzerkonto verschlüsselt gespeichert.':'Routerdaten werden nur gelesen. Zugangsdaten bleiben in dieser Sitzung.');
    }catch(error){
      if(epoch===this.fritzEpoch){client.disconnect();this.fritzClient=null;this.state.fritzbox={connected:false,connecting:false,busy:false,host,error:error.message,history:[]};}
      throw error;
    }finally{if(epoch===this.fritzEpoch){this.state.fritzbox.connecting=false;this.state.fritzbox.busy=false;}}
    }finally{this.fritzConnecting=false;}
  }

  measureFritzTraffic(data,now=Date.now()) {
    const sessionId=`${this.state.startedAt}:${this.fritzEpoch}:${this.measureEpoch}`;
    const previousDevices=this.deviceTrafficPrevious||new Map(),nextDevices=new Map();
    const deviceTraffic=Array.isArray(data.deviceTraffic)?data.deviceTraffic.slice(0,128).map(item=>{
      const identity=typeof item.mac==='string'?item.mac.toUpperCase():null;
      const previous=previousDevices.get(identity);
      const measured=deriveDeviceTraffic(previous?.row,item,{previousSessionId:previous?.sessionId,currentSessionId:sessionId,previousUptimeSeconds:previous?.uptimeSeconds,currentUptimeSeconds:data.device?.uptimeSeconds});
      const fresh=item.available===true&&Number.isSafeInteger(item.lastUpdateMs)&&item.lastUpdateMs>0&&item.lastUpdateMs<=8640000000000000;
      // Delayed router snapshots must not rewind a healthy counter baseline.
      // Missing rows/counters, changed counters at the same timestamp and reboots
      // break it; an unchanged timestamp retains the original interval start.
      const continuous=previous&&previous.sessionId===sessionId&&Number.isSafeInteger(previous.uptimeSeconds)&&Number.isSafeInteger(data.device?.uptimeSeconds)&&previous.uptimeSeconds<=data.device.uptimeSeconds;
      const unchanged=previous&&item.lastUpdateMs===previous.row.lastUpdateMs&&item.totalBytesReceived===previous.row.totalBytesReceived&&item.totalBytesSent===previous.row.totalBytesSent&&item.source===previous.row.source&&item.scope===previous.row.scope;
      if(fresh)nextDevices.set(identity,continuous&&(item.lastUpdateMs<previous.row.lastUpdateMs||unchanged)?previous:{row:item,sessionId,uptimeSeconds:data.device?.uptimeSeconds});
      const observedAt=Number.isFinite(Date.parse(item.observedAt))?item.observedAt:new Date(now).toISOString();
      const counterTimingAvailable=fresh&&item.lastUpdateMs<=Date.parse(observedAt)+2000;
      return {...item,observedAt,counterAgeBasis:item.counterAgeBasis||'router-vs-pc-clock-unverified',counterTimingAvailable,counterTimingReason:counterTimingAvailable?null:fresh?'Routerzeitpunkt liegt nach der Beobachtung; Zuordnung zum PC-Lag unbekannt.':'Keine gültige Routerzeit für die Zuordnung zum Lag.',downloadMbps:measured.downloadMbps,uploadMbps:measured.uploadMbps,downloadDeltaBytes:measured.downloadBytes,uploadDeltaBytes:measured.uploadBytes,rateAvailable:measured.reason===null,measurementReason:measured.reason,intervalStartedAt:measured.intervalStartedAt??null,intervalEndedAt:measured.intervalEndedAt??null,measurementBasis:measured.measurementBasis??'router-counter-timestamp',at:fresh?new Date(item.lastUpdateMs).toISOString():null};
    }):undefined;
    if(deviceTraffic!==undefined)this.deviceTrafficPrevious=nextDevices;
    const counters=data.wan;
    let measured=null;
    const validCounter=value=>Number.isSafeInteger(value)&&value>=0;
    const from=Date.parse(counters?.sampling?.from),to=Date.parse(counters?.sampling?.to);
    const explicit=Number.isFinite(from)&&Number.isFinite(to)&&to>=from&&to<=now+2000;
    const sampling=explicit?counters.sampling:null;
    const wan={...counters,source:'tr064-wan-byte-counters',scope:'internet',sampling};
    if(explicit&&counters&&validCounter(counters.totalBytesReceived)&&validCounter(counters.totalBytesSent)) {
      const previous=this.fritzPrevious;
      measured=deriveWanTraffic(previous?.wan,wan,{previousSessionId:previous?.sessionId,currentSessionId:sessionId,previousUptimeSeconds:previous?.uptimeSeconds,currentUptimeSeconds:data.device?.uptimeSeconds});
      this.fritzPrevious={receivedBytes:counters.totalBytesReceived,sentBytes:counters.totalBytesSent,uptimeSeconds:data.device?.uptimeSeconds,wan,time:(Date.parse(sampling.from)+Date.parse(sampling.to))/2,observationTimed:explicit,sessionId};
    } else this.fritzPrevious=null;
    return {...data,...(deviceTraffic===undefined?{}:{deviceTraffic,deviceTrafficCount:data.deviceTraffic.length,deviceTrafficTruncated:data.deviceTraffic.length>deviceTraffic.length}),wan:{...wan,downloadMbps:measured?.downloadMbps??null,uploadMbps:measured?.uploadMbps??null,intervalStartedAt:measured?.intervalStartedAt??null,intervalEndedAt:measured?.intervalEndedAt??null,downloadDeltaBytes:measured?.downloadBytes??null,uploadDeltaBytes:measured?.uploadBytes??null,measurementBasis:'request-observation-window',timingUncertaintyMs:measured?.timingUncertaintyMs??null,observationWindow:measured?.observationWindow??null,counterUpdatedAtAvailable:false,counterUpdateFrequencyKnown:false,measurementReason:measured?.reason??(explicit?'Keine zwei WAN-Bytezähler vorhanden.':'WAN-Beobachtungsfenster fehlt oder ist ungültig; zeitliche Rate unbekannt.')}};
  }

  applyFritz(data, capture) {
    const now=Date.now();
    data=this.measureFritzTraffic(data,now);
    const sessionId=`${this.state.startedAt}:${this.fritzEpoch}:${this.measureEpoch}`;
    const previousHistory=this.state.fritzbox.history||[];
    const previousSnapshot=previousHistory.at(-1);
    const historyEntry={type:'fritzbox',at:new Date(now).toISOString(),host:data.host,sessionId,device:data.device,wan:data.wan,...(capture?{capture}:{}),dsl:data.dsl,hostCount:data.hosts?.length||0,activeHostCount:data.hosts?.filter(h=>h.active).length||0,meshNodes:data.mesh?.nodes?.length||0,warnings:data.warnings||[],...fritzHistoryDetails(data)};
    previousHistory.push(historyEntry);if(previousHistory.length>240)previousHistory.shift();
    this.state.fritzbox={...data,connected:true,connecting:false,busy:false,error:null,wan:historyEntry.wan,history:previousHistory};
    const adapter=this.state.network.interfaces.find(item=>item.id===this.state.selectedInterfaceId);
    const evidence=buildMeshEvidence(historyEntry,{pcMac:adapter?.id===this.state.network.defaultInterfaceId?adapter.mac:null,now});
    const comparison=compareMeshSnapshots(previousSnapshot,historyEntry);
    this.state.fritzbox.mesh={...data.mesh,evidence,comparison};
    this.log(historyEntry);
    for(const change of comparison.changes||[])this.log({type:'mesh_change',at:historyEntry.at,sessionId,interval:comparison.interval,changes:[change]});
    if(previousSnapshot&&previousSnapshot.sessionId===sessionId&&now-Date.parse(previousSnapshot.at)<=120000) {
      const oldLines=new Set((this.previousRouterLog||'').split(/\r?\n/));
      for(const message of String(data.log||'').split(/\r?\n/).filter(line=>line.trim()&&!oldLines.has(line)).slice(0,30)) {
        this.log({type:'router_event',at:historyEntry.at,sessionId,interval:{from:previousSnapshot.at,to:historyEntry.at},category:/WLAN|DFS|Radar|Kanal/i.test(message)?'wlan':'router',message:message.slice(0,600),timing:'Zwischen zwei Abfragen neu beobachtet; Ereigniszeit nicht verifiziert.'});
      }
      for(const radio of historyEntry.wlan||[]) {
        const old=previousSnapshot.wlan?.find(item=>item.id===radio.id);
        if(old&&((old.channel!=null&&radio.channel!=null&&old.channel!==radio.channel)||(old.frequencyBand&&radio.frequencyBand&&old.frequencyBand!==radio.frequencyBand)))this.log({type:'router_event',at:historyEntry.at,sessionId,interval:{from:previousSnapshot.at,to:historyEntry.at},category:'wlan',message:`Gemeldetes Router-Funkmodul ${radio.id}: Kanal ${old.channel??'?'} → ${radio.channel??'?'}, Band ${old.frequencyBand??'?'} → ${radio.frequencyBand??'?'}. Kein direkter Backhaul-Interferenznachweis.`});
      }
    }
    this.previousRouterLog=String(data.log||'').slice(0,20000);
    this.syncMeshTargets(evidence);
    this.lastFritz=now;
  }

  applyFritzTraffic(data) {
    const now=Date.now(),measured=this.measureFritzTraffic(data,now),sessionId=`${this.state.startedAt}:${this.fritzEpoch}:${this.measureEpoch}`;
    const at=data.updatedAt||new Date(now).toISOString();
    const record={type:'fritzbox',kind:'traffic',at,host:data.host,sessionId,collection:data.collection,device:{uptimeSeconds:data.device?.uptimeSeconds??null},wan:measured.wan,warnings:data.warnings||[]};
    if(measured.deviceTraffic!==undefined) {
      const rows=[];let bytes=2;
      for(const row of measured.deviceTraffic) {
        const clean={id:row.id,mac:row.mac,name:typeof row.name==='string'?row.name.slice(0,80):null,ip:row.ip,source:row.source,scope:row.scope,lastUpdateMs:row.lastUpdateMs,counterAgeBasis:row.counterAgeBasis,counterTimingAvailable:row.counterTimingAvailable,counterTimingReason:row.counterTimingReason,available:row.available===true,rateAvailable:row.rateAvailable===true,downloadMbps:row.downloadMbps,uploadMbps:row.uploadMbps,downloadDeltaBytes:row.downloadDeltaBytes,uploadDeltaBytes:row.uploadDeltaBytes,intervalStartedAt:row.intervalStartedAt,intervalEndedAt:row.intervalEndedAt,at:row.at,observedAt:row.observedAt||at,measurementBasis:row.measurementBasis,freshness:row.freshness||'router-timestamp-reported',measurementReason:typeof row.measurementReason==='string'?row.measurementReason.slice(0,180):null,reason:typeof row.reason==='string'?row.reason.slice(0,180):null};
        const size=Buffer.byteLength(JSON.stringify(clean))+1;if(bytes+size>44000)break;rows.push(clean);bytes+=size;
      }
      record.deviceTraffic=rows;record.deviceTrafficCapability=measured.deviceTrafficCapability;record.deviceTrafficCount=measured.deviceTrafficCount;record.deviceTrafficTruncated=measured.deviceTrafficTruncated||rows.length<measured.deviceTrafficCount;
    }
    this.state.fritzbox={...this.state.fritzbox,connected:true,busy:false,error:null,trafficUpdatedAt:at,trafficCollection:data.collection,wan:{...this.state.fritzbox.wan,...measured.wan},...(measured.deviceTraffic===undefined?{}:{deviceTraffic:measured.deviceTraffic,deviceTrafficCapability:measured.deviceTrafficCapability,deviceTrafficCount:record.deviceTrafficCount,deviceTrafficTruncated:record.deviceTrafficTruncated,deviceTrafficUpdatedAt:at})};
    this.log(record);
  }

  syncMeshTargets(evidence) {
    // Only uniquely reported paths; never derive an order from an IP or label.
    const hosts=evidence.path.status==='confirmed'?evidence.path.nodeIds.slice(1).map(id=>evidence.nodes.find(node=>node.id===id)).filter(node=>node&&privateIPv4(node.ip)).slice(0,6):[];
    const wanted=new Set(hosts.map(node=>node.ip));
    this.state.targets=this.state.targets.filter(target=>!target.meshAutomatic||wanted.has(target.host));
    for(const node of hosts) {
      if(this.state.targets.some(target=>target.host===node.ip)||this.state.targets.length>=24)continue;
      const target=this.makeTarget(node.ip,node.name||'Mesh-Pfad',node.role?.toUpperCase()==='MASTER'?'gateway':'repeater');
      target.meshAutomatic=true;this.state.targets.push(target);
    }
  }

  async refreshFritz({automatic=false}={}) {
    const client=this.fritzClient;
    if(!client?.connected)throw new Error('Bitte zuerst an der FRITZ!Box anmelden.');
    if(this.fritzPoll)return this.fritzPoll;
    if(this.fritzTrafficPoll){const waitEpoch=this.measureEpoch,waitMonitoring=this.monitoringEpoch;await this.fritzTrafficPoll;if(client!==this.fritzClient||this.closed||waitEpoch!==this.measureEpoch||waitMonitoring!==this.monitoringEpoch||automatic&&!this.state.monitoring)return;if(this.fritzPoll)return this.fritzPoll;}
    const epoch=this.fritzEpoch,measureEpoch=this.measureEpoch,monitoringEpoch=this.monitoringEpoch;
    const current=()=>epoch===this.fritzEpoch&&measureEpoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&!this.closed&&(!automatic||this.state.monitoring);
    const capture=this.pendingFritzLag;
    this.pendingFritzLag=null;
    const started=Date.now();this.lastFritz=started;this.state.fritzbox.busy=true;
    this.fritzPoll=(async()=>{
      try{const data=await client.poll();if(current())this.applyFritz(data,capture);}
      catch(error){if(current()){this.state.fritzbox.error=error.message;this.state.fritzbox.connected=client.connected;this.lastFritz=Date.now();this.pendingFritzLag??=capture;}}
      finally{if(client===this.fritzClient&&!this.state.fritzbox.connecting){this.state.fritzbox.busy=false;this.state.fritzbox.connected=client.connected;}}
    })();
    const pending=this.fritzPoll;
    this.track(pending);
    try{await pending;}finally{if(this.fritzPoll===pending)this.fritzPoll=null;}
  }

  async refreshFritzTraffic() {
    const client=this.fritzClient,now=Date.now();
    if(this.closed||!this.state.monitoring||!client?.connected||typeof client.pollTraffic!=='function'||this.state.fritzbox.connecting||this.fritzPoll||this.fritzTrafficPoll)return;
    const fullInterval=this.pendingFritzLag?30000:60000;
    if(now-(this.lastFritz||0)>=fullInterval){await this.refreshFritz({automatic:true});return;}
    if(now-(this.lastFritzTraffic||0)<this.fritzTrafficIntervalMs)return;
    const epoch=this.fritzEpoch,measureEpoch=this.measureEpoch,monitoringEpoch=this.monitoringEpoch;
    const current=()=>client===this.fritzClient&&epoch===this.fritzEpoch&&measureEpoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&!this.closed&&this.state.monitoring;
    const includeDevices=now-(this.lastFritzDevices||0)>=this.fritzDeviceIntervalMs;
    this.lastFritzTraffic=now;if(includeDevices)this.lastFritzDevices=now;this.state.fritzbox.busy=true;
    const pending=(async()=>{
      try {
        const data=await client.pollTraffic({includeDevices});
        if(!current())return;
        const duration=Math.max(0,Date.now()-now),payload=data.collection?.responseBytes||0;
        this.fritzTrafficIntervalMs=duration>1500?Math.min(15000,Math.max(2000,duration*2)):Math.max(2000,this.fritzTrafficIntervalMs-1000);
        if(includeDevices)this.fritzDeviceIntervalMs=payload>100000||duration>1500?Math.min(60000,Math.max(5000,duration*3,Math.ceil(payload/20000)*1000)):Math.max(5000,this.fritzDeviceIntervalMs-1000);
        this.applyFritzTraffic(data);
        this.state.fritzbox.trafficMeasurement={wanIntervalMs:this.fritzTrafficIntervalMs,deviceIntervalMs:this.fritzDeviceIntervalMs,durationMs:duration,responseBytes:payload,error:null};
      }catch(error){if(current()){this.fritzTrafficIntervalMs=Math.min(15000,Math.max(4000,this.fritzTrafficIntervalMs*2));this.state.fritzbox.trafficMeasurement={wanIntervalMs:this.fritzTrafficIntervalMs,deviceIntervalMs:this.fritzDeviceIntervalMs,error:error.message};this.state.fritzbox.error=`Datenverkehr: ${error.message}`;this.state.fritzbox.connected=client.connected;}}
      finally{if(client===this.fritzClient&&!this.state.fritzbox.connecting){this.state.fritzbox.busy=false;this.state.fritzbox.connected=client.connected;}}
    })();
    this.fritzTrafficPoll=pending;this.track(pending);
    try{await pending;}finally{if(this.fritzTrafficPoll===pending)this.fritzTrafficPoll=null;}
  }

  disconnectFritz(log=true) {
    this.fritzEpoch++;this.credentialEpoch++;this.pendingFritzLag=null;this.fritzClient?.disconnect();this.fritzClient=null;this.fritzPrevious=null;this.fritzPoll=null;this.deviceTrafficPrevious=null;
    this.state.fritzbox={connected:false,connecting:false,busy:false,host:null,error:null,history:[]};
    this.lastFritzTraffic=0;this.lastFritzDevices=0;this.fritzTrafficIntervalMs=2000;this.fritzDeviceIntervalMs=5000;
    if(log)this.event('info','FRITZ!Box getrennt','Die Zugangsdaten dieser Verbindung wurden aus der laufenden App-Sitzung entfernt. Bereits gespeicherte Messwerte bleiben erhalten.');
  }

  removeTarget(id) {
    const target = this.state.targets.find(t=>t.id===id);
    if (!target || ['gateway','internet'].includes(target.kind)) throw new Error('Standardziele können pausiert, aber nicht entfernt werden.');
    this.state.targets = this.state.targets.filter(t=>t.id!==id);
    if(target.host===this.state.repeaterHost)this.state.repeaterHost=null;
    this.saveSettings();
  }

  mergeNeighbors(neighbors = []) {
    for (const n of neighbors || []) {
      if (!privateIPv4(n.ip) || !n.mac || /^00[:-]00[:-]00|^ff[:-]ff[:-]ff/i.test(n.mac)) continue;
      const known = this.state.devices.find(d=>d.ip===n.ip&&d.interfaceId===n.interfaceId);
      const data = {ip:n.ip,mac:n.mac,interfaceId:n.interfaceId,neighborState:n.state};
      if (known) Object.assign(known,data);
      else this.state.devices.push({...data,name:'',respondsToPing:null,lastSeen:null,source:'Nachbartabelle (kann veraltet sein)'});
    }
  }

  schedule(delay=this.intervalMs) {
    if (this.closed) return;
    this.timer = setTimeout(async () => {
      const started=Date.now();
      this.tickPromise = this.tick({background:true});
      try { await this.tickPromise; } catch(error) { this.state.lastError=error.message; }
      this.schedule(Math.max(0,(this.state.measurement.mode==='precision'?250:this.intervalMs)-(Date.now()-started)));
    },delay);
  }

  scheduleTraffic(delay=1000) {
    clearTimeout(this.trafficTimer);
    if(this.closed)return;
    this.trafficTimer=setTimeout(async()=>{
      const started=Date.now();
      await Promise.allSettled([this.refreshTrafficCounters(),this.refreshFritzTraffic()]);
      this.scheduleTraffic(Math.max(250,1000-(Date.now()-started)));
    },delay);
  }

  async refreshTrafficCounters() {
    const now=Date.now();
    if(this.closed||!this.state.monitoring||now-(this.lastCounters||0)<this.trafficIntervalMs)return;
    if(this.counterPoll)return this.counterPoll;
    const epoch=this.measureEpoch,monitoringEpoch=this.monitoringEpoch,interfaceId=this.state.selectedInterfaceId;
    const currentRound=()=>!this.closed&&this.state.monitoring&&epoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&interfaceId===this.state.selectedInterfaceId;
    this.lastCounters=now;
    const pending=(async()=>{
      try {
        const counters=await (this.trafficProbe||this.probes).getTrafficCounters({signal:this.abort.signal,timeoutMs:4000});
        if(!currentRound())return;
        const time=Date.now(),duration=Math.max(0,time-now),current=counters.find(c=>c.id===interfaceId);
        this.trafficIntervalMs=duration>500?Math.min(10000,Math.max(1000,duration*2)):Math.max(1000,this.trafficIntervalMs-1000);
        const quality={source:'windows-adapter-counters',durationMs:duration,scheduledIntervalMs:this.trafficIntervalMs,actualIntervalMs:this.previousCounter?time-this.previousCounter.time:null,limited:duration>500||this.trafficIntervalMs>1000};
        if(!current){Object.assign(this.state.traffic,{downloadMbps:null,uploadMbps:null,intervalStartedAt:null,adapterHealth:null,quality});this.previousCounter=null;return;}
        if(this.state.lastError?.startsWith('Datenverkehr:'))this.state.lastError=null;
        const previous=this.previousCounter?.id===current.id?this.previousCounter:null;
        const elapsed=time-(previous?.time||time);
        const rate=elapsed<=10000?trafficRate(previous,current,elapsed):null;
        const intervalStartedAt=rate&&Number.isFinite(rate.downloadMbps)&&Number.isFinite(rate.uploadMbps)?new Date(previous.time).toISOString():null;
        const health=adapterHealth(previous,current,time),at=new Date(time).toISOString();
        this.previousCounter={...current,time};
        Object.assign(this.state.traffic,{interfaceId:current.id,at,intervalStartedAt,downloadMbps:rate?.downloadMbps??null,uploadMbps:rate?.uploadMbps??null,adapterHealth:health,quality});
        if(rate){this.state.traffic.history.push({at,intervalStartedAt,...rate});if(this.state.traffic.history.length>180)this.state.traffic.history.shift();}
        this.log({type:'traffic',at,intervalStartedAt,interfaceId:current.id,epoch,downloadMbps:rate?.downloadMbps??null,uploadMbps:rate?.uploadMbps??null,downloadDeltaBytes:rate?current.receivedBytes-previous.receivedBytes:null,uploadDeltaBytes:rate?current.sentBytes-previous.sentBytes:null,measurementBasis:'windows-counter-observation',quality,adapterHealth:health});
        if(Object.values(health.delta).some(value=>value>0)&&time-(this.lastAdapterWarning||0)>30000){this.lastAdapterWarning=time;this.event('warning','PC-Netzwerkkarte meldet Fehler oder verworfene Pakete','Neue Windows-Zähler im letzten Messintervall. Unter Geräte & Repeater und im Datenverkehr-Verlauf ansehen; daraus allein folgt kein Kabeldefekt.');}
      }catch(error){if(!currentRound())return;this.trafficIntervalMs=Math.min(10000,Math.max(2000,this.trafficIntervalMs*2));Object.assign(this.state.traffic,{downloadMbps:null,uploadMbps:null,intervalStartedAt:null,adapterHealth:null,quality:{source:'windows-adapter-counters',limited:true,scheduledIntervalMs:this.trafficIntervalMs,error:error.message}});this.previousCounter=null;this.state.lastError=`Datenverkehr: ${error.message}`;}
    })();
    this.counterPoll=pending;this.track(pending);
    try{await pending;}finally{if(this.counterPoll===pending)this.counterPoll=null;}
  }

  gameProcessIds(sessionId) { return this.closed ? [] : this.gameDetector.processIds(sessionId); }

  // Internal API for PID-reuse-safe capture; no paths/names enter public data.
  gameProcesses(sessionId) {
    const ids = new Set(this.gameProcessIds(sessionId));
    return [...(this.gameDetector.sessions.get(sessionId)?.processes.values() || [])]
      .filter(process => ids.has(process.id) && typeof process.startedAt === 'string' && Number.isFinite(Date.parse(process.startedAt)))
      .map(process => ({ pid: process.id, startedAt: process.startedAt }));
  }

  async setGameDetection(value) {
    const settings = validateGameSettings(value);
    if (this.closed) throw new Error('Das Programm wird beendet.');
    const epoch = ++this.gameEpoch;
    clearTimeout(this.gameTimer); this.gameAbort?.abort();
    const unchanged = JSON.stringify(settings) === JSON.stringify({enabled:this.state.gameDetection.enabled,customGames:this.state.gameDetection.customGames});
    if (!unchanged) this.gameDetector.stop(settings.enabled ? 'configuration-changed' : 'disabled');
    Object.assign(this.state.gameDetection, settings, { status: settings.enabled ? 'checking' : 'disabled', error: null });
    this.gameDetector.fresh = false;
    try { await this.saveSettings({throwOnError:true}); }
    finally { if (!this.closed && epoch === this.gameEpoch) this.scheduleGames(0); }
    return this.state.gameDetection;
  }

  scheduleGames(delay=5000) {
    clearTimeout(this.gameTimer);
    if (this.closed || !this.state.gameDetection.enabled) return;
    this.gameTimer = setTimeout(async () => {
      const epoch = this.gameEpoch;
      await this.refreshGames();
      if (epoch === this.gameEpoch) this.scheduleGames();
    }, delay);
    this.gameTimer.unref?.();
  }

  refreshGames() {
    if (this.gamePoll) return this.gamePoll;
    if (this.closed || !this.state.gameDetection.enabled) return Promise.resolve();
    if (!this.probes.getGameProcesses) { this.state.gameDetection.status='unsupported'; this.state.gameDetection.warning='Prozessbeobachtung ist in dieser Umgebung nicht verfügbar.'; return Promise.resolve(); }
    const epoch = this.gameEpoch, controller = new AbortController(); this.gameAbort = controller;
    const current = () => !this.closed && epoch === this.gameEpoch && this.state.gameDetection.enabled;
    const task = (async () => {
      let timer, cancel;
      try {
        const cancellation = new Promise((_, reject) => {
          cancel = () => reject(Object.assign(new Error('Abgebrochen'), {name:'AbortError'}));
          controller.signal.addEventListener('abort', cancel, {once:true});
          timer = setTimeout(() => { controller.abort(); }, 18000);
        });
        const work = (async () => {
          const snapshot = await this.probes.getGameProcesses({signal:controller.signal});
          if (!current() || controller.signal.aborted) return null;
          const library = await this.gameLibrary.load(snapshot);
          return {snapshot,library};
        })();
        const result = await Promise.race([work,cancellation]);
        if (current() && result && !controller.signal.aborted) this.gameDetector.apply(result.snapshot,result.library);
      } catch (error) {
        if (!current()) return;
        if (error.code === 'GAMES_UNSUPPORTED') { this.gameDetector.fresh=false; this.state.gameDetection.status='unsupported'; this.state.gameDetection.warning='Spieleerkennung benötigt Windows.'; }
        else this.gameDetector.fail();
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort',cancel); }
    })();
    this.gamePoll = task;
    task.finally(() => { if (this.gamePoll === task) this.gamePoll=null; });
    return task;
  }

  async tick({background=false}={}) {
    const at = iso();
    const started=Date.now(),cpuStart=process.cpuUsage();
    if (this.state.monitoring) {
      const epoch=this.measureEpoch;
      const speedTest=this.state.speedTest;
      const speedPhase=speedTest.running?speedTest.phase:null;
      const loadType=this.state.stressTest.running?'stress':speedTest.running?'speedtest':null;
      const precision=background&&this.state.measurement.mode==='precision';
      const targets = this.state.targets.filter(t=>t.enabled&&(!precision||started>=(this.nextPing.get(t.host)||0)));
      const intervals=new Map(targets.map(t=>[t.host,targetInterval(t,{...this.state.measurement,repeaterHost:this.state.repeaterHost,backoffMs:this.state.measurement.quality?.backoffMs})]));
      for(const target of targets)this.nextPing.set(target.host,started+(precision?intervals.get(target.host):this.intervalMs));
      const monitoringEpoch=this.monitoringEpoch;
      const targetEpochs=new Map(targets.map(target=>[target,this.targetEpochs.get(target)||0]));
      const currentRound=()=>!this.closed&&epoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&this.state.monitoring;
      const currentTarget=target=>target.enabled&&this.state.targets.includes(target)&&targetEpochs.get(target)===(this.targetEpochs.get(target)||0);
      const repeaterHost=this.state.repeaterHost;
      try {
        const results = targets.length?await this.pingProbe.pingMany(targets.map(t=>t.host),{timeoutMs:800,signal:this.abort.signal}):[];
        const durationMs=Date.now()-started,cpu=process.cpuUsage(cpuStart);
        const qualities=new Map(targets.map(target=>{
          const previous=this.lastPingAt.get(target.host),scheduledIntervalMs=precision?intervals.get(target.host):this.intervalMs;
          const quality=evaluateMeasurementQuality({durationMs,scheduledIntervalMs,actualIntervalMs:previous===undefined?null:started-previous,cpuFraction:(cpu.user+cpu.system)/1000/Math.max(durationMs,scheduledIntervalMs),schedulerDelayMs:previous===undefined?0:Math.max(0,started-previous-scheduledIntervalMs),previousBackoffMs:this.state.measurement.quality?.backoffMs});
          if(currentRound()&&currentTarget(target))this.lastPingAt.set(target.host,started);
          return [target.host,quality];
        }));
        if(currentRound()&&targets.length)this.state.measurement.quality=[...qualities.values()].sort((a,b)=>b.backoffMs-a.backoffMs)[0];
        for (const target of targets) {
          if (!currentRound() || !currentTarget(target)) continue;
          const result = results.find(r=>r.host===target.host);
          if (!result) continue;
          if(target.kind==='internet'&&target.host===this.speedTestPingTarget&&(speedPhase==='download'||speedPhase==='upload')&&this.state.speedTest===speedTest&&speedTest.running&&speedTest.phase===speedPhase) {
            const field=speedPhase==='download'?'pingDuringDownload':'pingDuringUpload';
            const samples=this.speedTestPingSamples;
            if(samples) {
              if(result.ok&&Number.isFinite(result.ms))samples[speedPhase].push(result.ms);
              const valid=samples[speedPhase];
              speedTest[`${field}Count`]=valid.length;
              speedTest[`${field}Ms`]=valid.length?valid.reduce((sum,value)=>sum+value,0)/valid.length:null;
            }
          }
          const oldStatus = target.stats.status;
          target.samples.push({at,ok:result.ok,ms:result.ms,status:result.status,quality:qualities.get(target.host),...(result.error?{error:result.error}:{})});
          target.lastError=result.status==='measurement_error'?(result.error||'Windows konnte die Messung nicht ausführen.'):null;
          if (target.samples.length>600) target.samples.splice(0,target.samples.length-600);
          target.stats = summarize(target.samples,target.kind);
          const spike=isLatencySpike(result);
          if(result.status!=='measurement_error'&&(spike||result.ok===false))this.requestFritzLag(at);
          if(spike&&!target.spiking)this.event('warning',`${target.label}: Ping-Spitze`,`${result.ms} ms zu ${target.host}${loadType==='speedtest'?' während des Speedtests':loadType==='stress'?' während der Dauerbelastung':''}. Verlauf mit Repeater, Router und Internet vergleichen.`);
          target.spiking=spike;
          if (result.status==='measurement_error' && oldStatus!=='pending') this.event('warning',`${target.label}: Messfehler`,result.error || 'Windows konnte die Ping-Messung nicht ausführen.');
          if (target.stats.status !== oldStatus && oldStatus !== 'pending' && target.stats.status!=='pending') {
            const status = target.stats.status;
            this.event(status==='ok'?'info':status==='critical'?'error':'warning',`${target.label}: ${status==='down'?'keine Ping-Antwort':status==='critical'?'Messwerte kritisch':status==='warning'?'Messwerte auffällig':'wieder unauffällig'}`,`${target.host} · ${target.stats.consecutiveLoss} unbeantwortete Pings in Folge. Fehlende ICMP-Antworten sind kein sicherer Offline-Nachweis.`);
          }
        }
        if(currentRound()&&targets.length)this.log({type:'ping',at,quality:this.state.measurement.quality,results:results.filter(r=>targets.some(t=>t.host===r.host&&currentTarget(t))).map(r=>({...r,quality:qualities.get(r.host),label:targets.find(t=>t.host===r.host)?.label||r.host,kind:targets.find(t=>t.host===r.host)?.kind||'custom'})),repeaterHost,underLoad:loadType!==null,loadType,interfaceId:this.state.selectedInterfaceId,epoch});
        if (currentRound()&&this.state.lastError?.startsWith('Ping-Messung:')) this.state.lastError=null;
      } catch(error) {
        if (currentRound()&&targets.some(currentTarget)) {
          this.state.lastError=`Ping-Messung: ${error.message}`;
          for (const target of targets) {
            if (!currentTarget(target)) continue;
            target.samples.push({at,ok:false,ms:null,status:'measurement_error'});
            if (target.samples.length>600) target.samples.shift();
            target.stats=summarize(target.samples,target.kind);
          }
          this.log({type:'ping',at,epoch,interfaceId:this.state.selectedInterfaceId,repeaterHost,results:targets.filter(currentTarget).map(t=>({host:t.host,label:t.label,kind:t.kind,ok:false,ms:null,status:'measurement_error'}))});
        }
      }
    }
    if(background) {
      if(!this.maintenancePromise&&!this.closed) {
        this.maintenancePromise=this.maintenance().catch(error=>{this.state.lastError=error.message;}).finally(()=>{this.maintenancePromise=null;});
        this.track(this.maintenancePromise);
      }
    } else await this.maintenance();
  }

  async maintenance() {
    const epoch=this.measureEpoch;
    const monitoringEpoch=this.monitoringEpoch;
    const now = Date.now();
    if(!this.closed&&now-(this.lastArchiveMaintenance||0)>=60000){this.lastArchiveMaintenance=now;this.track(this.archiveMaintenance().catch(error=>{this.state.lastError=`Archiv: ${error.message}`;}));}
    const fritzInterval=this.pendingFritzLag?30000:60000;
    if(!this.closed&&this.state.monitoring&&this.fritzClient?.connected&&now-(this.lastFritz||0)>=fritzInterval&&!this.fritzPoll)this.track(this.refreshFritz({automatic:true}));
    if(!this.closed&&this.state.monitoring&&now-(this.lastCounters||0)>=this.trafficIntervalMs)await this.refreshTrafficCounters();
    if(this.closed||epoch!==this.measureEpoch||monitoringEpoch!==this.monitoringEpoch)return;
    if (!this.closed && now-(this.lastDns || 0)>=60000 && this.state.monitoring) {
      this.lastDns=now;
      const start=Date.now();
      try { await bounded(this.lookupDns('example.com'),2500); if(epoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&this.state.monitoring&&!this.closed){this.state.dns={ok:true,ms:Date.now()-start,at:iso()};this.log({type:'dns',...this.state.dns,interfaceId:this.state.selectedInterfaceId});} }
      catch(error) { if(epoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&this.state.monitoring&&!this.closed){this.state.dns={ok:false,error:error.message,at:iso()};this.log({type:'dns',...this.state.dns,interfaceId:this.state.selectedInterfaceId});} }
    }
    if(this.closed||epoch!==this.measureEpoch)return;
    if (!this.closed && now-(this.lastRefresh || 0)>=60000 && !this.refreshing && !this.state.scan.running) { this.lastRefresh=now; await this.refresh(); }
  }

  lookupDns(host) {return lookup(host,{family:4});}

  startScan(interfaceId) {
    if (this.state.scan.running) throw new Error('Ein Gerätescan läuft bereits.');
    const adapter = this.state.network.interfaces.find(i=>i.id===interfaceId);
    if (!adapter) throw new Error('Bitte einen verfügbaren Netzwerkadapter auswählen.');
    const address = adapter.ipv4.find(a=>privateIPv4(a.address));
    if (!address) throw new Error('Dieser Adapter hat kein unterstütztes privates IPv4-Netz.');
    const subnet = subnetHosts(address.address,address.prefixLength);
    const hosts = [...new Set([...subnet.hosts,...this.state.devices.filter(d=>d.interfaceId===interfaceId).map(d=>d.ip),...(privateIPv4(adapter.gateway)?[adapter.gateway]:[])])];
    this.state.scan={running:true,done:0,total:hosts.length,message:`Prüfe ${subnet.cidr}${subnet.limited?' (Ausschnitt des größeren Netzes)':''}`,error:null,limited:subnet.limited};
    const task = this.performScan(hosts,interfaceId,subnet);
    this.track(task);
  }

  track(promise) { this.pending.add(promise); promise.finally(()=>this.pending.delete(promise)).catch(()=>{}); }

  async performScan(hosts,interfaceId,subnet) {
    let found=0,failedMeasurements=0;
    try {
      for (let index=0;index<hosts.length&&!this.closed;index+=64) {
        const results = await this.probes.pingMany(hosts.slice(index,index+64),{timeoutMs:650,signal:this.abort.signal});
        for (const r of results) {
          let device=this.state.devices.find(d=>d.ip===r.host&&d.interfaceId===interfaceId);
          if(r.status==='measurement_error') {
            failedMeasurements++;
            if(device){device.respondsToPing=null;device.measurementError=r.error||'Messfehler';}
            continue;
          }
          if(device)device.measurementError=null;
          if (device) device.respondsToPing=r.ok;
          if (!r.ok) continue;
          found++;
          if (!device) { device={ip:r.host,mac:'',name:'',interfaceId,source:'Ping'}; this.state.devices.push(device); }
          Object.assign(device,{respondsToPing:true,lastSeen:iso()});
        }
        this.state.scan.done=Math.min(index+64,hosts.length);
      }
      if (this.closed) return;
      await this.refresh();
      // Name lookups are bounded and run in small batches; absent names remain absent.
      const unnamed=this.state.devices.filter(d=>d.interfaceId===interfaceId&&d.respondsToPing&&!d.name);
      for (let i=0;i<unnamed.length&&!this.closed;i+=8) await Promise.all(unnamed.slice(i,i+8).map(async device=>{try {device.name=(await bounded(reverse(device.ip),700))[0] || '';}catch{}}));
      this.state.scan.message=`Scan abgeschlossen: ${found} Ping-Antworten in ${subnet.cidr}.${subnet.limited?' Das größere Netz wurde nur ausschnittweise geprüft; bekannte Nachbarn wurden zusätzlich geprüft.':''}`;
      if(failedMeasurements){this.state.scan.error=`${failedMeasurements} Adressen konnten wegen lokaler Messfehler nicht geprüft werden. ${found} Ping-Antworten wurden empfangen.`;this.state.scan.message='Scan nur teilweise messbar.';}
      this.event(failedMeasurements?'warning':'info','Gerätescan abgeschlossen',this.state.scan.error||this.state.scan.message);
    } catch(error) { this.state.scan.error=error.message; this.state.scan.message='Scan konnte nicht abgeschlossen werden.'; }
    finally { this.state.scan.running=false;this.log({type:'scan',at:iso(),...this.state.scan,interfaceId,devices:this.state.devices.filter(d=>d.interfaceId===interfaceId).map(d=>({...d}))}); }
  }

  startSpeedTest(options = {}) {
    const limits=normalizeSpeedTestOptions(options);
    if(this.closed)throw new Error('Das Programm wird beendet.');
    if (this.state.speedTest.running) throw new Error('Ein Speedtest läuft bereits.');
    if (this.state.stressTest?.running) { const error=new Error('Der Belastungstest läuft bereits.');error.code='MONITOR_BUSY';throw error; }
    this.state.speedTest={running:true,phase:'ping-before',progress:0,downloadMbps:null,uploadMbps:null,...limits,pingBeforeMs:null,pingDuringDownloadMs:null,pingDuringDownloadCount:0,pingDuringUploadMs:null,pingDuringUploadCount:0,pingAfterMs:null,pingTarget:null,error:null,at:iso()};
    this.speedTestPingSamples={download:[],upload:[]};
    const pingTarget=this.state.targets.find(target=>target.kind==='internet'&&target.host==='1.1.1.1'&&target.enabled)
      ||this.state.targets.find(target=>target.kind==='internet'&&target.enabled);
    this.speedTestPingTarget=pingTarget?.host||null;
    this.state.speedTest.pingTarget=pingTarget?`${pingTarget.label} (${pingTarget.host})`:null;
    const speedTest=this.state.speedTest;
    this.event('info','Speedtest gestartet',`${limits.downloadBytes/1_000_000} MB Download und ${limits.uploadBytes/1_000_000} MB Upload über Cloudflare; Testlast kann Ping erhöhen.`);
    const measureInternetPing=()=>this.measureInternetPing(pingTarget);
    const task=(async()=>{
      const before=await measureInternetPing();
      if(this.state.speedTest!==speedTest)return;
      Object.assign(this.state.speedTest,{pingBeforeMs:before.ms,pingTarget:before.target,phase:'download'});
      const result=await this.speedTestRunner(update=>{if(this.state.speedTest===speedTest)Object.assign(speedTest,update);},{...limits,signal:this.abort.signal});
      if(this.state.speedTest!==speedTest)return;
      Object.assign(this.state.speedTest,{...result,phase:'ping-after',progress:0});
      const after=await measureInternetPing();
      if(this.state.speedTest!==speedTest)return;
      Object.assign(this.state.speedTest,{pingAfterMs:after.ms,pingTarget:before.target||after.target,phase:'done',progress:100});
      const completed={downloadMbps:result.downloadMbps,uploadMbps:result.uploadMbps,downloadBytes:limits.downloadBytes,uploadBytes:limits.uploadBytes,pingBeforeMs:before.ms,pingDuringDownloadMs:this.state.speedTest.pingDuringDownloadMs,pingDuringDownloadCount:this.state.speedTest.pingDuringDownloadCount,pingDuringUploadMs:this.state.speedTest.pingDuringUploadMs,pingDuringUploadCount:this.state.speedTest.pingDuringUploadCount,pingAfterMs:after.ms,pingTarget:before.target||after.target};
      this.log({type:'speedtest',at:iso(),...completed,error:null});
      this.event('info','Speedtest abgeschlossen',`Download ${result.downloadMbps.toFixed(1)} Mbit/s, Upload ${result.uploadMbps.toFixed(1)} Mbit/s. Internet-Ping zu ${pingTarget?.host||'unbekannt'} vor/während/nach Testlast: ${before.ms==null?'unbekannt':before.ms+' ms'} / ${this.state.speedTest.pingDuringDownloadMs==null?'unbekannt':this.state.speedTest.pingDuringDownloadMs.toFixed(1)+' ms Download, '+this.state.speedTest.pingDuringDownloadCount+' Antworten'} / ${this.state.speedTest.pingDuringUploadMs==null?'unbekannt':this.state.speedTest.pingDuringUploadMs.toFixed(1)+' ms Upload, '+this.state.speedTest.pingDuringUploadCount+' Antworten'} / ${after.ms==null?'unbekannt':after.ms+' ms'}. Kurzer Einzelverbindungstest; kein Tarifnachweis.`);
    })()
      .catch(error=>{if(this.state.speedTest!==speedTest)return;speedTest.error=error.message;speedTest.phase='error';this.log({type:'speedtest',at:iso(),downloadMbps:speedTest.downloadMbps,uploadMbps:speedTest.uploadMbps,downloadBytes:limits.downloadBytes,uploadBytes:limits.uploadBytes,pingBeforeMs:speedTest.pingBeforeMs,pingAfterMs:speedTest.pingAfterMs,pingDuringDownloadMs:speedTest.pingDuringDownloadMs,pingDuringDownloadCount:speedTest.pingDuringDownloadCount,pingDuringUploadMs:speedTest.pingDuringUploadMs,pingDuringUploadCount:speedTest.pingDuringUploadCount,pingTarget:speedTest.pingTarget,error:error.message});this.event('warning','Speedtest fehlgeschlagen',error.message);})
      .finally(()=>{if(this.state.speedTest===speedTest){speedTest.running=false;speedTest.at=iso();}});
    this.track(task);
  }

  startStressTest(options = {}) {
    const settings=normalizeStressOptions(options);
    if(this.closed)throw new Error('Das Programm wird beendet.');
    if(this.state.speedTest.running||this.state.stressTest.running){const error=new Error('Bitte den laufenden Speedtest oder Dauerbelastungstest zuerst beenden.');error.code='MONITOR_BUSY';throw error;}
    const current={...settings,running:true,stopping:false,startedAt:iso(),elapsedSeconds:0,downloadBytes:0,uploadBytes:0,downloadMbps:null,uploadMbps:null,completedDownloads:0,completedUploads:0,error:null,reason:null};
    this.state.stressTest=current;
    this.stressAbort=new AbortController();
    const signal=AbortSignal.any([this.abort.signal,this.stressAbort.signal]);
    const label={both:'Download und Upload',download:'Download',upload:'Upload'}[settings.mode];
    this.event('info','Dauerbelastung gestartet',`${label} über Cloudflare · ${settings.durationSeconds?settings.durationSeconds/60+' Minuten':'bis zum Stoppen'}. Ping-Werte können durch die Testlast steigen.`);
    const task=Promise.resolve().then(()=>this.stressTestRunner(update=>{
      if(this.state.stressTest===current)Object.assign(current,update);
    },{...settings,signal})).then(result=>{Object.assign(current,result);}).catch(error=>{
      if(error.partial)Object.assign(current,error.partial);
      current.error=error.message||'Dauerbelastung fehlgeschlagen.';current.reason='error';
    }).finally(()=>{
      current.running=false;current.stopping=false;current.at=iso();
      this.log({type:'stress',...current});
      this.event(current.error?'warning':'info',current.error?'Dauerbelastung fehlgeschlagen':current.reason==='completed'?'Dauerbelastung abgeschlossen':'Dauerbelastung gestoppt',current.error||`${Math.round(current.elapsedSeconds)} Sekunden · ${(current.downloadBytes/1_000_000).toFixed(1)} MB empfangen · ${(current.uploadBytes/1_000_000).toFixed(1)} MB Upload bestätigt. Werte ohne Testlast zum Vergleich weiter beobachten.`);
    });
    this.stressTask=task;
    this.track(task);
    return current;
  }

  async stopStressTest() {
    if(this.state.stressTest.running){this.state.stressTest.stopping=true;this.stressAbort?.abort();}
    await this.stressTask;
    return this.state.stressTest;
  }

  async measureInternetPing(target) {
    if(!target)return {ms:null,target:null};
    try {
      // This uses the one-off PowerShell probe, separate from the monitor's single-flight worker.
      const results=await this.probes.pingMany([target.host],{timeoutMs:2000,signal:this.abort.signal});
      const result=results.find(item=>item.host===target.host);
      return {ms:result?.ok&&Number.isFinite(result.ms)?result.ms:null,target:`${target.label} (${target.host})`};
    } catch { return {ms:null,target:`${target.label} (${target.host})`}; }
  }

  close({reason='normal'}={}) {
    if(this.closePromise)return this.closePromise;
    this.closePromise=this.performClose({reason});
    return this.closePromise;
  }

  prepareClose({reason='normal'}={}) {
    if(this.shutdownPromise)return this.shutdownPromise;
    this.shutdownReason=reason;
    this.closed=true;
    const errors=[];
    const stop=action=>{try{action();}catch(error){errors.push(error);}};
    this.gameEpoch++; clearTimeout(this.gameTimer); this.gameAbort?.abort();
    stop(()=>this.gameDetector.stop('app-closed'));
    this.state.gameDetection.status='disabled';
    clearTimeout(this.timer);
    clearTimeout(this.trafficTimer);
    this.abort.abort();
    stop(()=>this.pingProbe.close?.());
    stop(()=>this.trafficProbe?.close?.());
    stop(()=>this.disconnectFritz(false));
    this.shutdownPromise=(async()=>{
      try{await this.persistence.requestClose({reason});}catch(error){errors.push(error);}
      if(errors.length===1)throw errors[0];
      if(errors.length)throw new AggregateError(errors,'Überwachung konnte nicht vollständig gestoppt werden.');
    })();
    return this.shutdownPromise;
  }

  async performClose({reason}) {
    const errors=[];
    const finish=async action=>{try{await action();}catch(error){errors.push(error);}};
    await finish(()=>this.prepareClose({reason}));
    await this.startPromise?.catch(()=>{});
    await Promise.allSettled([...this.pending,this.tickPromise,this.gamePoll]);
    await finish(()=>this.incidentService?.close());
    await finish(()=>this.flushRaw());
    await finish(()=>this.archiveTask);
    await finish(()=>this.rollups.flush());
    await Promise.allSettled([this.logQueue,this.saveQueue,this.archiveTask,this.credentialQueue]);
    await finish(()=>this.history.close());
    // These writers report I/O failures through state while resolving their
    // queues. Check after their final flush, when a successful retry may have
    // cleared the error, before recording a successful session completion.
    for(const message of [this.logError,this.history.lastError])if(message)errors.push(new Error(message));
    // A failed durable close must not claim a completed session. SessionStore
    // owns no runtime handles; drain its queue and retain the closing marker,
    // which the next start recovers as shutdown_incomplete.
    if(errors.length)await finish(()=>this.persistence.queue);
    else await finish(()=>this.persistence.close({reason:this.shutdownReason}));
    if(errors.length===1)throw errors[0];
    if(errors.length)throw new AggregateError(errors,'Überwachung konnte nicht vollständig gespeichert werden.');
  }
}
