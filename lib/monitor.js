import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { lookup, reverse } from 'node:dns/promises';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { diagnose, PING_WARNING_MS, privateIPv4, subnetHosts, summarize, trafficRate, validateHost } from './analysis.js';
import { runSpeedTest } from './speedtest.js';
import { normalizeStressOptions, runStressTest } from './stress-test.js';
import { normalizeSpeedTestOptions } from '../public/speedtest-options.js';
import { HistoryStore } from './history.js';
import { SessionStore, atomicWrite, durableAppend, safeStoredData } from './session-store.js';
import { deriveDeviceTraffic } from './device-traffic.js';
import { adapterHealth } from './adapter-health.js';
import { createGameLibrary, GameDetector, initialGameDetection, validateGameSettings } from './game-detection.js';

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
  const nodes=budgeted(sourceNodes,item=>item&&typeof item.id==='string'&&item.id.length<=200?{id:item.id,name:string(item.name,80),model:string(item.model,80),ip:string(item.ip,45),mac:string(item.mac,17),role:string(item.role,30),latency:item.latency?{status:string(item.latency.status,40),roundTripMs:numeric(item.latency.roundTripMs),measuredAtMs:numeric(item.latency.measuredAtMs)}:null}:null,9000,128);
  const links=budgeted(sourceLinks,item=>item&&typeof item.from==='string'&&item.from.length<=200&&typeof item.to==='string'&&item.to.length<=200?{id:string(item.id),from:item.from,to:item.to,type:string(item.type,30),state:string(item.state,30),receiveRateMbps:numeric(item.receiveRateMbps??item.rateMbps),transmitRateMbps:numeric(item.transmitRateMbps),signalPercent:numeric(item.signalPercent)}:null,12000,256);
  const wlan=budgeted(list(data.wlan),item=>item?{id:string(item.id,80),ssid:string(item.ssid,128),enabled:boolean(item.enabled),status:string(item.status,50),channel:numeric(item.channel),frequencyBand:string(item.frequencyBand,40),standard:string(item.standard,40),associatedDevices:numeric(item.associatedDevices),beaconType:string(item.beaconType,50),basicEncryptionModes:string(item.basicEncryptionModes,50),macFilterEnabled:boolean(item.macFilterEnabled),bssid:string(item.bssid,17),packetStats:item.packetStats?{available:item.packetStats.available===true,reason:string(item.packetStats.reason,160),totalPacketsReceived:numeric(item.packetStats.totalPacketsReceived),totalPacketsSent:numeric(item.packetStats.totalPacketsSent)}:null}:null,5000,8);
  const capabilities=budgeted(list(data.capabilities),item=>item?{service:string(item.service,50),instance:string(item.instance,80),action:string(item.action,80),available:item.available===true,reason:string(item.reason,160)}:null,6000,128);
  const deviceTraffic=budgeted(list(data.deviceTraffic),item=>item?{id:string(item.id,80),nodeId:string(item.nodeId,200),name:string(item.name,80),ip:string(item.ip,45),mac:string(item.mac,17),source:string(item.source,40),scope:string(item.scope,20),available:item.available===true,reason:string(item.reason,160),totalBytesReceived:numeric(item.totalBytesReceived),totalBytesSent:numeric(item.totalBytesSent),lastUpdateMs:numeric(item.lastUpdateMs),downloadMbps:numeric(item.downloadMbps),uploadMbps:numeric(item.uploadMbps),downloadDeltaBytes:numeric(item.downloadDeltaBytes),uploadDeltaBytes:numeric(item.uploadDeltaBytes),rateAvailable:item.rateAvailable===true,measurementReason:string(item.measurementReason,160),intervalStartedAt:string(item.intervalStartedAt,30),at:string(item.at,30)}:null,10000,128);
  const capability=data.deviceTrafficCapability;
  const hosts=budgeted(list(data.hosts),item=>item?{name:string(item.name,80),ip:string(item.ip,45),mac:string(item.mac,17),active:boolean(item.active),interfaceType:string(item.interfaceType,30),guest:boolean(item.guest),wanAccess:string(item.wanAccess,20),priority:boolean(item.priority),filterProfileId:string(item.filterProfileId,40),model:string(item.model,80),linkRateMbps:numeric(item.linkRateMbps),lanPort:numeric(item.lanPort),vpn:boolean(item.vpn),updateAvailable:boolean(item.updateAvailable),addressSource:string(item.addressSource,30),leaseTimeRemainingSeconds:numeric(item.leaseTimeRemainingSeconds),deviceClass:string(item.deviceClass,40)}:null,8000,128);
  const project=(item,strings,numbers,booleans)=>item?Object.fromEntries([...strings.map(key=>[key,string(item[key],100)]),...numbers.map(key=>[key,numeric(item[key])]),...booleans.map(key=>[key,boolean(item[key])])]):null;
  const addressList=value=>Array.isArray(value)?value.slice(0,8).map(value=>string(value,45)).filter(Boolean):null;
  const raw=data.diagnostics;
  const diagnostics=raw?{ethernet:budgeted(list(raw.ethernet),item=>project(item,['id','reason','status','mac','duplexMode'],['maxBitRateMbps','totalBytesReceived','totalBytesSent','totalPacketsReceived','totalPacketsSent'],['available','enabled']),3500,16),lan:raw.lan?{...project(raw.lan,['reason','minAddress','maxAddress','subnetMask','domainName'],[],['available','dhcpEnabled','dhcpConfigurable','dhcpRelay']),dnsServers:addressList(raw.lan.dnsServers),routers:addressList(raw.lan.routers)}:null,internet:raw.internet?{...project(raw.internet,['reason','service','status','connectionType','externalIp','lastConnectionError','ipv6Status'],['portMappingCount','ipv6UptimeSeconds'],['available','enabled','natEnabled','rsipAvailable']),dnsServers:addressList(raw.internet.dnsServers)}:null}:null;
  return {mesh:{nodes,links,schemaVersion:string(data.mesh?.schemaVersion,20),totalNodes:sourceNodes.length,totalLinks:sourceLinks.length,truncated:nodes.length<sourceNodes.length||links.length<sourceLinks.length},hosts,hostsTruncated:hosts.length<list(data.hosts).length,diagnostics,wlan,capabilities,deviceTraffic,deviceTrafficTruncated:deviceTraffic.length<list(data.deviceTraffic).length,deviceTrafficCapability:capability?{available:capability.available===true,source:string(capability.source,40),scope:string(capability.scope,20),reason:string(capability.reason,320)}:null};
}

export class Monitor {
  constructor(probes, { dataDir, intervalMs = 1000, speedTestRunner = runSpeedTest, stressTestRunner = runStressTest } = {}) {
    this.probes = probes;
    this.pingProbe = probes.createPingMonitor ? probes.createPingMonitor() : probes;
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
      traffic:{interfaceId:null,downloadMbps:null,uploadMbps:null,at:null,history:[]},
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
    this.fritzEpoch=0;
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
    await this.history.start();
    if(this.closed)return;
    await this.persistence.beginSession();
    if(this.closed)return;
    await this.history.recoverArchives();
    if(this.closed)return;
    if (this.dataDir) {
      await mkdir(this.dataDir,{recursive:true});
      try {
        const settings = JSON.parse(await readFile(path.join(this.dataDir,'settings.json'),'utf8'));
        if (!settings || typeof settings!=='object' || Array.isArray(settings)) throw new Error('Ungültiges Einstellungsformat. Standardwerte werden verwendet.');
        this.settings = settings;
        if(typeof settings.measurementStartedAt==='string'&&Number.isFinite(Date.parse(settings.measurementStartedAt)))this.state.measurementStartedAt=new Date(settings.measurementStartedAt).toISOString();
      }
      catch (error) { if (error.code !== 'ENOENT') this.event('warning','Einstellungen konnten nicht gelesen werden',error.message); }
    }
    if(this.closed)return;
    if (this.settings.gameDetection !== undefined) {
      try { Object.assign(this.state.gameDetection, validateGameSettings(this.settings.gameDetection)); }
      catch { this.state.gameDetection.warning = 'Gespeicherte Spieleinstellungen sind ungültig; Standardwerte werden verwendet.'; }
    }
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
    this.event('info','Überwachung gestartet','Etwa jede Sekunde: Router, alle markierten Repeater und zwei unabhängige Internetziele. Daten bleiben lokal; externe Ziele erhalten Ping-Anfragen.');
    this.schedule(0);
    this.scheduleGames(0);
    }finally{this.starting=false;}
  }

  snapshot() {
    this.state.diagnosis = diagnose(this.state);
    this.state.persistence = this.persistence.snapshot();
    this.state.persistence.lastError=this.state.persistence.lastError||this.logError||this.history.lastError;
    return this.state;
  }

  historySnapshot(hours=1,cursor) {
    return this.history.snapshot(hours,{cursor,measurementStartedAt:this.state.measurementStartedAt});
  }

  event(level,title,detail,at=iso()) {
    const event = {at,level,title,detail};
    this.state.events.unshift(event);
    this.state.events.length = Math.min(this.state.events.length,300);
    this.log({type:'event',...event});
  }

  log(value) {
    value={...value,recordId:randomUUID()};
    if (['ping','traffic','dns','event'].includes(value.type) && !value.gameSessionIds) value.gameSessionIds=this.state.gameDetection.active.map(game=>game.sessionId);
    if(['ping','traffic','dns','fritzbox'].includes(value.type))value={...value,diagnosis:diagnose(this.state)};
    if(this.persistence.currentSession)value={...value,appSessionId:this.persistence.currentSession.id};
    if(this.state.measurementStartedAt)value={...value,measurementStartedAt:this.state.measurementStartedAt};
    try {value=safeStoredData(value);this.history.record(value);} catch(error) {this.state.lastError=`Verlauf konnte nicht übernommen werden: ${error.message}`;return;}
    if (!this.dataDir) return;
    const file = path.join(this.dataDir,`messungen-${new Date().toISOString().slice(0,10)}.jsonl`);
    this.logQueue = this.logQueue.then(async () => {
      await durableAppend(file,JSON.stringify(value)+'\n');
      await this.persistence.notePersisted(value.at);
      this.logError=null;
    }).catch(error => {
      this.logError=this.state.lastError = `Protokoll konnte nicht gespeichert werden: ${error.message}`;
    });
  }

  saveSettings({throwOnError=false}={}) {
    this.settings = {...this.settings,selectedInterfaceId:this.state.selectedInterfaceId,repeaterHost:this.state.repeaterHost,targets:this.state.targets.filter(t=>['custom','device','repeater'].includes(t.kind)).map(t=>({host:t.host,label:t.label,kind:t.kind,enabled:t.enabled})),gameDetection:{enabled:this.state.gameDetection.enabled,customGames:this.state.gameDetection.customGames.map(game=>({...game}))},...(this.state.measurementStartedAt?{measurementStartedAt:this.state.measurementStartedAt}:{})};
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
    this.state.traffic = {interfaceId:id,downloadMbps:null,uploadMbps:null,at:null,history:[]};
    this.previousCounter = null;
    this.syncGateway();
    this.event('info','Netzwerkadapter gewechselt','Scan und Datenverkehr beziehen sich auf den ausgewählten Adapter. Windows bestimmt den tatsächlichen Routingweg der Ping- und Speedtest-Anfragen.');
    this.saveSettings();
  }

  resetMeasurements() {
    this.measureEpoch++;
    this.previousCounter=null;
    this.lastCounters=0;
    this.state.dns=null;
    this.lastDns=0;
    this.state.traffic={interfaceId:this.state.selectedInterfaceId,downloadMbps:null,uploadMbps:null,at:null,history:[]};
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
    this.state.events.unshift(event);this.state.events.length=Math.min(this.state.events.length,300);this.log(event);return event;
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
    const epoch=this.fritzEpoch;
    const client=new FritzBoxClient();this.fritzClient=client;
    this.state.fritzbox={connected:false,connecting:true,busy:true,host,error:null,history:[]};
    try {
      const data=await client.connect({...credentials,host,username:username.trim()});
      if(epoch!==this.fritzEpoch||this.closed)return;
      this.applyFritz(data);
      this.event('info','FRITZ!Box verbunden','Routerdaten werden nur gelesen. Zugangsdaten werden nicht gespeichert.');
    }catch(error){
      if(epoch===this.fritzEpoch){client.disconnect();this.fritzClient=null;this.state.fritzbox={connected:false,connecting:false,busy:false,host,error:error.message,history:[]};}
      throw error;
    }finally{if(epoch===this.fritzEpoch){this.state.fritzbox.connecting=false;this.state.fritzbox.busy=false;}}
    }finally{this.fritzConnecting=false;}
  }

  applyFritz(data) {
    const now=Date.now();
    const sessionId=`${this.state.startedAt}:${this.fritzEpoch}`;
    const previousDevices=this.deviceTrafficPrevious||new Map(),nextDevices=new Map();
    const deviceTraffic=(Array.isArray(data.deviceTraffic)?data.deviceTraffic:[]).map(item=>{
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
      return {...item,downloadMbps:measured.downloadMbps,uploadMbps:measured.uploadMbps,downloadDeltaBytes:measured.downloadBytes,uploadDeltaBytes:measured.uploadBytes,rateAvailable:measured.reason===null,measurementReason:measured.reason,intervalStartedAt:measured.reason===null?new Date(previous.row.lastUpdateMs).toISOString():null,at:fresh?new Date(item.lastUpdateMs).toISOString():null};
    });
    this.deviceTrafficPrevious=nextDevices;
    data={...data,deviceTraffic};
    const counters=data.wan;
    let rate=null;
    if(counters&&Number.isFinite(counters.totalBytesReceived)&&Number.isFinite(counters.totalBytesSent)) {
      const current={receivedBytes:counters.totalBytesReceived,sentBytes:counters.totalBytesSent,uptimeSeconds:data.device?.uptimeSeconds};
      const rebooted=Number.isFinite(current.uptimeSeconds)&&Number.isFinite(this.fritzPrevious?.uptimeSeconds)&&current.uptimeSeconds<this.fritzPrevious.uptimeSeconds;
      if(this.fritzPrevious&&!rebooted&&now-this.fritzPrevious.time<=90000)rate=trafficRate(this.fritzPrevious,current,now-this.fritzPrevious.time);
      this.fritzPrevious={...current,time:now};
    } else this.fritzPrevious=null;
    const previousHistory=this.state.fritzbox.history||[];
    const historyEntry={type:'fritzbox',at:iso(),host:data.host,sessionId,device:data.device,wan:{...data.wan,downloadMbps:rate?.downloadMbps??null,uploadMbps:rate?.uploadMbps??null},dsl:data.dsl,hostCount:data.hosts?.length||0,activeHostCount:data.hosts?.filter(h=>h.active).length||0,meshNodes:data.mesh?.nodes?.length||0,warnings:data.warnings||[],...fritzHistoryDetails(data)};
    previousHistory.push(historyEntry);if(previousHistory.length>240)previousHistory.shift();
    this.state.fritzbox={...data,connected:true,connecting:false,busy:false,error:null,wan:historyEntry.wan,history:previousHistory};
    this.log(historyEntry);this.lastFritz=now;
  }

  async refreshFritz() {
    const client=this.fritzClient;
    if(!client?.connected)throw new Error('Bitte zuerst an der FRITZ!Box anmelden.');
    if(this.fritzPoll)return this.fritzPoll;
    const epoch=this.fritzEpoch;this.state.fritzbox.busy=true;
    this.fritzPoll=(async()=>{
      try{const data=await client.poll();if(epoch===this.fritzEpoch&&!this.closed)this.applyFritz(data);}
      catch(error){if(epoch===this.fritzEpoch){this.state.fritzbox.error=error.message;this.state.fritzbox.connected=client.connected;this.lastFritz=Date.now();}}
      finally{if(client===this.fritzClient&&!this.state.fritzbox.connecting){this.state.fritzbox.busy=false;this.state.fritzbox.connected=client.connected;}}
    })();
    const pending=this.fritzPoll;
    this.track(pending);
    try{await pending;}finally{if(this.fritzPoll===pending)this.fritzPoll=null;}
  }

  disconnectFritz(log=true) {
    this.fritzEpoch++;this.fritzClient?.disconnect();this.fritzClient=null;this.fritzPrevious=null;this.fritzPoll=null;this.deviceTrafficPrevious=null;
    this.state.fritzbox={connected:false,connecting:false,busy:false,host:null,error:null,history:[]};
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
      this.schedule(Math.max(0,this.intervalMs-(Date.now()-started)));
    },delay);
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
    if (this.state.monitoring) {
      const epoch=this.measureEpoch;
      const speedTest=this.state.speedTest;
      const speedPhase=speedTest.running?speedTest.phase:null;
      const loadType=this.state.stressTest.running?'stress':speedTest.running?'speedtest':null;
      const targets = this.state.targets.filter(t=>t.enabled);
      const monitoringEpoch=this.monitoringEpoch;
      const targetEpochs=new Map(targets.map(target=>[target,this.targetEpochs.get(target)||0]));
      const currentRound=()=>!this.closed&&epoch===this.measureEpoch&&monitoringEpoch===this.monitoringEpoch&&this.state.monitoring;
      const currentTarget=target=>target.enabled&&this.state.targets.includes(target)&&targetEpochs.get(target)===(this.targetEpochs.get(target)||0);
      const repeaterHost=this.state.repeaterHost;
      try {
        const results = await this.pingProbe.pingMany(targets.map(t=>t.host),{timeoutMs:800,signal:this.abort.signal});
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
          target.samples.push({at,ok:result.ok,ms:result.ms,status:result.status,...(result.error?{error:result.error}:{})});
          target.lastError=result.status==='measurement_error'?(result.error||'Windows konnte die Messung nicht ausführen.'):null;
          if (target.samples.length>600) target.samples.splice(0,target.samples.length-600);
          target.stats = summarize(target.samples,target.kind);
          const spike=result.ok&&result.ms>PING_WARNING_MS;
          if(spike&&!target.spiking)this.event('warning',`${target.label}: Ping-Spitze`,`${result.ms} ms zu ${target.host}${loadType==='speedtest'?' während des Speedtests':loadType==='stress'?' während der Dauerbelastung':''}. Verlauf mit Repeater, Router und Internet vergleichen.`);
          target.spiking=spike;
          if (result.status==='measurement_error' && oldStatus!=='pending') this.event('warning',`${target.label}: Messfehler`,result.error || 'Windows konnte die Ping-Messung nicht ausführen.');
          if (target.stats.status !== oldStatus && oldStatus !== 'pending' && target.stats.status!=='pending') {
            const status = target.stats.status;
            this.event(status==='ok'?'info':status==='critical'?'error':'warning',`${target.label}: ${status==='down'?'keine Ping-Antwort':status==='critical'?'Messwerte kritisch':status==='warning'?'Messwerte auffällig':'wieder unauffällig'}`,`${target.host} · ${target.stats.consecutiveLoss} unbeantwortete Pings in Folge. Fehlende ICMP-Antworten sind kein sicherer Offline-Nachweis.`);
          }
        }
        if(currentRound())this.log({type:'ping',at,results:results.filter(r=>targets.some(t=>t.host===r.host&&currentTarget(t))).map(r=>({...r,label:targets.find(t=>t.host===r.host)?.label||r.host,kind:targets.find(t=>t.host===r.host)?.kind||'custom'})),repeaterHost,underLoad:loadType!==null,loadType,interfaceId:this.state.selectedInterfaceId,epoch});
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
    const now = Date.now();
    if(!this.closed&&this.fritzClient?.connected&&now-(this.lastFritz||0)>=30000&&!this.fritzPoll)this.track(this.refreshFritz());
    if (!this.closed && now-(this.lastCounters || 0)>=4500) {
      this.lastCounters=now;
      try {
        const counters = await this.probes.getTrafficCounters();
        if(this.closed||epoch!==this.measureEpoch)return;
        const current = counters.find(c=>c.id===this.state.selectedInterfaceId);
        const time = Date.now();
        if (current) {
          if(this.state.lastError?.startsWith('Datenverkehr:'))this.state.lastError=null;
          const previous = this.previousCounter?.id===current.id ? this.previousCounter : null;
          const rate = trafficRate(previous,current,time-(previous?.time || time));
          const health = adapterHealth(previous,current,time);
          this.previousCounter={...current,time};
          this.state.traffic.interfaceId=current.id;
          this.state.traffic.at=iso();
          this.state.traffic.downloadMbps=rate?.downloadMbps ?? null;
          this.state.traffic.uploadMbps=rate?.uploadMbps ?? null;
          this.state.traffic.adapterHealth=health;
          if (rate) {
            this.state.traffic.history.push({at:this.state.traffic.at,...rate});
            if (this.state.traffic.history.length>180) this.state.traffic.history.shift();
          }
          this.log({type:'traffic',at:this.state.traffic.at,interfaceId:current.id,epoch,downloadMbps:rate?.downloadMbps??null,uploadMbps:rate?.uploadMbps??null,adapterHealth:health});
          if(Object.values(health.delta).some(value=>value>0)&&time-(this.lastAdapterWarning||0)>30000){this.lastAdapterWarning=time;this.event('warning','PC-Netzwerkkarte meldet Fehler oder verworfene Pakete','Neue Windows-Zähler im letzten Messintervall. Unter Geräte & Repeater und im Datenverkehr-Verlauf ansehen; daraus allein folgt kein Kabeldefekt.');}
        } else { this.state.traffic.downloadMbps=null; this.state.traffic.uploadMbps=null;this.state.traffic.adapterHealth=null; this.previousCounter=null; }
      } catch(error) { if(this.closed||epoch!==this.measureEpoch)return;this.state.traffic.downloadMbps=null; this.state.traffic.uploadMbps=null;this.state.traffic.adapterHealth=null; this.previousCounter=null; this.state.lastError=`Datenverkehr: ${error.message}`; }
    }
    if (!this.closed && now-(this.lastDns || 0)>=30000 && this.state.monitoring) {
      const monitoringEpoch=this.monitoringEpoch;
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
    this.gameEpoch++; clearTimeout(this.gameTimer); this.gameAbort?.abort();
    this.gameDetector.stop('app-closed');
    this.state.gameDetection.status='disabled';
    clearTimeout(this.timer);
    this.abort.abort();
    this.pingProbe.close?.();
    this.disconnectFritz(false);
    this.shutdownPromise=this.persistence.requestClose({reason});
    return this.shutdownPromise;
  }

  async performClose({reason}) {
    await this.prepareClose({reason});
    await this.startPromise?.catch(()=>{});
    await Promise.allSettled([...this.pending,this.tickPromise,this.gamePoll]);
    await Promise.allSettled([this.logQueue,this.saveQueue]);
    await this.history.close();
    await this.persistence.close({reason:this.shutdownReason});
  }
}
