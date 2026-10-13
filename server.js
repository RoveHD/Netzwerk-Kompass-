import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { Monitor } from './lib/monitor.js';
import { validateHost } from './lib/analysis.js';
import * as probes from './lib/probes.js';
import { AnalysisController } from './lib/ai-analysis.js';
import { dataDirectory, attachLauncherShutdown } from './lib/runtime.js';
import { createStartupManager } from './lib/startup.js';
import { GamePacketTracker } from './lib/game-packets.js';
import { validateGameSettings } from './lib/game-detection.js';
import { createPeerMonitor } from './lib/peer-monitor.js';

const directory=path.dirname(fileURLToPath(import.meta.url));

export async function attachPeerMonitoring(monitor, peers) {
  const detachPeer = peers.onRecord(record => monitor.ingestPeer(record));
  try {
    await peers.initialize();
    for (const record of peers.snapshot().records || []) await monitor.ingestPeer(record);
    const detachLocal = monitor.onRecord(record => {
      if (record.remote || record.sourceDeviceId && record.sourceDeviceId !== 'local') return;
      peers.enqueue(record).catch(error => { peers.lastError = error.message; });
    });
    return () => { detachLocal(); detachPeer(); };
  } catch (error) { detachPeer(); await peers.close(); throw error; }
}

export function createApp(monitor,{token=randomBytes(32).toString('hex'),publicDir=path.join(directory,'public'),onShutdown=()=>{},analysis=new AnalysisController(monitor),startup=null,packetTracker=null,incidentPacketTracker=null,peers=null,now=Date.now}={}) {
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.ttf':'font/ttf','.woff2':'font/woff2'};
  const recordCapture=(capture,incidentId=null)=>{
    if(!capture.game||monitor.history.closed)return;
    const event={type:'event',kind:'game-packets',at:capture.endedAt||new Date().toISOString(),level:['error','needs-admin'].includes(capture.status)?'warning':'info',title:`Paket-Tracking: ${capture.game.name}`,detail:capture.reason||'Lokale Erfassung beendet. Keine Bestätigung einer Zustellung hinter dem Router.',game:{id:capture.game.id,name:capture.game.name,sessionId:capture.game.sessionId},gameSessionIds:[capture.game.sessionId].filter(Boolean),capture:Object.fromEntries(['startedAt','endedAt','status','quality','sampleIntervalMs','sentPackets','receivedPackets','sentBytes','receivedBytes','retransmits','losses'].map(key=>[key,capture[key]]))};
    if(incidentId){event.incidentId=incidentId;event.kind='incident-packets';event.capture.durationMs=15000;event.capture.scope='local-stack-events';event.capture.deliveryBeyondRouter='unknown';}
    monitor.state.events.unshift(event);monitor.state.events.length=Math.min(300,monitor.state.events.length);monitor.log(event);
  };
  const packets=packetTracker||new GamePacketTracker({onFinish:recordCapture});
  const incidentPackets=incidentPacketTracker||new GamePacketTracker({durationMs:15000});
  const incidentCapture={enabled:false,status:'disabled',durationMs:15000,cooldownMs:600000,nextAllowedAt:null,sessionId:null,incidentId:null,error:null,detail:'Optionale Ereignisaufzeichnung ist ausgeschaltet.'};
  let incidentFinished=false,closing=false;
  const previousIncidentFinish=incidentPackets.onFinish;
  const finishIncident=capture=>{
    if(incidentFinished)return;incidentFinished=true;
    incidentCapture.enabled=false;incidentCapture.status=capture.status;
    incidentCapture.error=['error','needs-admin'].includes(capture.status)?capture.reason:null;
    incidentCapture.detail=capture.reason||'Begrenzte lokale Metadatenaufzeichnung beendet.';
    recordCapture(capture,incidentCapture.incidentId);
  };
  incidentPackets.onFinish=capture=>{try{previousIncidentFinish?.(capture);}finally{finishIncident(capture);}};
  const captureBusy=tracker=>['starting','recording','stopping'].includes(tracker.snapshot().status);
  const peerSnapshot=()=>peers?.snapshot({includeRecords:false})||{available:false,peers:[],outboxCount:0,lastError:null};
  const captureSnapshot=()=>{const capture=incidentPackets.snapshot();return {...incidentCapture,...(['starting','recording','stopping'].includes(capture.status)?{status:capture.status}:{}),capture};};
  const snapshot=({forExport=false}={})=>{const state=monitor.snapshot();return {...state,...(!forExport?{incidents:(state.incidents||[]).slice(0,5),fritzbox:{...state.fritzbox,history:[]}}:{}),gamePackets:packets.snapshot(),peers:peerSnapshot(),incidentCapture:captureSnapshot()};};
  let gameActionBusy=false;
  const gameAction=async action=>{if(gameActionBusy)throw Object.assign(new Error('Eine Spiel-Aktion läuft bereits.'),{code:'MONITOR_BUSY'});gameActionBusy=true;try{return await action();}finally{gameActionBusy=false;}};
  const stopCaptures=async()=>{incidentCapture.enabled=false;const [manual]=await Promise.all([packets.stop(),incidentPackets.stop()]);if(!captureBusy(incidentPackets)){incidentCapture.status='disabled';incidentCapture.detail='Ereignisaufzeichnung angehalten.';}return manual;};
  const captureIncident=async incident=>{
    if(!incidentCapture.enabled||closing)return;
    if(gameActionBusy||captureBusy(packets)||captureBusy(incidentPackets)){incidentCapture.status='busy';incidentCapture.detail='Eine manuelle oder automatische Erfassung läuft bereits.';return;}
    if(incidentCapture.nextAllowedAt&&now()<Date.parse(incidentCapture.nextAllowedAt)){incidentCapture.status='cooldown';incidentCapture.detail='Der nächste automatische Versuch ist erst nach zehn Minuten möglich.';return;}
    const active=monitor.state.gameDetection?.active||[];
    const game=incidentCapture.sessionId?active.find(item=>item.sessionId===incidentCapture.sessionId):active.length===1?active[0]:null;
    const processes=game?monitor.gameProcesses(game.sessionId):[];
    if(!game||!processes.length){incidentCapture.status=active.length>1?'selection-required':'waiting-game';incidentCapture.detail=active.length>1?'Mehrere Spiele erkannt; ein Spiel ausdrücklich auswählen.':'Kein eindeutig erkanntes laufendes Spiel für die Aufzeichnung.';return;}
    // One explicit opt-in grants one automatic elevation attempt. Later events
    // never repeat UAC unattended, even after a denial or helper failure.
    incidentCapture.enabled=false;incidentCapture.status='starting';incidentCapture.error=null;incidentCapture.incidentId=incident?.id||null;
    incidentCapture.nextAllowedAt=new Date(now()+600000).toISOString();incidentCapture.sessionId=game.sessionId;incidentFinished=false;
    incidentCapture.detail=`Einmaliger 15-Sekunden-Versuch für ${game.name}; Windows kann Administratorfreigabe anfordern.`;
    try {
      const result=await gameAction(()=>incidentPackets.start({game:{id:game.id,sessionId:game.sessionId,name:game.name},processes,elevate:true}));
      if(['error','needs-admin'].includes(result.status))finishIncident(result);
    } catch(error) {incidentCapture.status='error';incidentCapture.error=error.message;incidentCapture.detail='Ereignisaufzeichnung konnte nicht gestartet werden.';}
  };
  const detachIncident=monitor.onIncident?.(incident=>{captureIncident(incident).catch(error=>{incidentCapture.error=error.message;});})||(()=>{});
  let tracing=false;
  const server=http.createServer(async (req,res)=>{
    const port=server.address()?.port;
    const expectedHost=`127.0.0.1:${port}`;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
    if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return json(403,{error:'Verwaltung ist nur auf diesem PC erreichbar.'});
    if(req.headers.host!==expectedHost) return json(403,{error:'Ungültiger Host.'});
    if(req.headers.origin && req.headers.origin!==`http://${expectedHost}`) return json(403,{error:'Zugriff nur aus der lokalen App.'});
    if(req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return json(403,{error:'Fremder Webseitenzugriff abgewiesen.'});
    let url;
    try{url=new URL(req.url,`http://${expectedHost}`);}catch{return json(400,{error:'Ungültige Adresse.'});}
    try {
      if(req.method==='GET' && url.pathname==='/api/startup')return json(200,startup?.snapshot()||{available:false,enabled:true,registered:null,error:null});
      if(req.method==='GET' && url.pathname==='/api/peers')return json(200,peerSnapshot());
      if(req.method==='GET' && url.pathname==='/api/incidents')return json(200,{incidents:await monitor.listIncidents()});
      if(req.method==='GET' && url.pathname==='/api/rollups')return json(200,monitor.rollups.snapshot());
      if(req.method==='GET' && url.pathname==='/api/analysis/archive') {
        await monitor.persistence.start();
        const id=url.searchParams.get('id');
        if(id){const item=await monitor.persistence.getAnalysis(id);return json(item?200:404,item||{error:'Gespeicherte Diagnose nicht gefunden.'});}
        const offset=Number(url.searchParams.get('offset')||0);
        if(!Number.isSafeInteger(offset)||offset<0)return json(400,{error:'Ungültige Archivseite.'});
        return json(200,await monitor.persistence.listAnalyses({offset,limit:20}));
      }
      if(req.method==='GET' && url.pathname==='/api/state') return json(200,snapshot());
      if(req.method==='GET' && url.pathname==='/api/analysis') {analysis.ensureChecked();return json(200,analysis.snapshot());}
      if(req.method==='GET' && url.pathname==='/api/analysis/report') return json(200,analysis.preview(Number(url.searchParams.get('hours')||1)));
      if(req.method==='GET' && url.pathname==='/api/history') return json(200,monitor.historySnapshot(Number(url.searchParams.get('hours')||1),url.searchParams.get('cursor')));
      if(req.method==='GET' && url.pathname==='/api/export') {
        const cutoff=Date.parse(monitor.state.measurementStartedAt)||0;
        const peerMeasurements=monitor.history.entries.map(entry=>JSON.parse(entry.json)).filter(record=>record.remote===true&&Date.parse(record.at)>=cutoff);
        res.setHeader('Content-Disposition',`attachment; filename="netzwerk-bericht-${new Date().toISOString().slice(0,10)}.json"`);
        return json(200,{...snapshot({forExport:true}),history:monitor.historySnapshot(168),peerMeasurements,exportedAt:new Date().toISOString(),notes:['Ping-Ausfall ist kein sicherer Offline-Nachweis.','PC-Adapterverkehr, FRITZ!Box-Gesamtverkehr und Geräte-Internetverkehr sind getrennte, sich überschneidende Quellen; nicht addieren.','Messwerte: letzte 600 Pings pro Ziel; gespeicherter Verlauf ist mengenbegrenzt, vollständige Messungen in data/messungen-*.jsonl.','Gerätenamen, lokale IP- und MAC-Adressen sind private Informationen.']});
      }
      if(req.method==='POST' && url.pathname.startsWith('/api/')) {
        if(req.headers['x-api-token']!==token) return json(403,{error:'Die Sitzung ist abgelaufen. Bitte die Seite neu laden.'});
        if(!req.headers['content-type']?.startsWith('application/json')) return json(415,{error:'JSON erwartet.'});
        if(Number(req.headers['content-length'])>8192)return json(413,{error:'Anfrage zu groß.'});
        let content='';
        for await(const chunk of req) {content+=chunk; if(Buffer.byteLength(content)>8192){json(413,{error:'Anfrage zu groß.'});req.destroy();return;}}
        let body;
        try{body=JSON.parse(content||'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();}catch{return json(400,{error:'Ungültiges JSON.'});}
        if(monitor.starting && url.pathname!=='/api/shutdown')return json(409,{error:'Die gespeicherten Einstellungen werden noch geladen. Bitte den Start abwarten.'});
        switch(url.pathname) {
          case '/api/peers/configure':
          case '/api/peers/pairing':
          case '/api/peers/pair':
          case '/api/peers/revoke': {
            if(!peers)throw new Error('PC-Kopplung ist in dieser Instanz nicht verfügbar.');
            if(url.pathname==='/api/peers/pairing')return json(200,await peers.createPairing());
            if(url.pathname==='/api/peers/configure')await peers.configure(body);
            else if(url.pathname==='/api/peers/pair')await peers.pair(body);
            else await peers.revoke(body);
            return json(200,peerSnapshot());
          }
          case '/api/measurement':return json(200,await monitor.setMeasurement(body));
          case '/api/history-policy':return json(200,await monitor.setHistoryPolicy(body));
          case '/api/fritzbox/forget':return json(200,await monitor.forgetRouter());
          case '/api/incident-capture':return json(200,await gameAction(async()=>{
            if(typeof body.enabled!=='boolean'||body.sessionId!==undefined&&(typeof body.sessionId!=='string'||body.sessionId.length>120))throw new Error('Ungültige Ereignisaufzeichnung.');
            if(body.enabled&&captureBusy(incidentPackets))throw new Error('Die Ereignisaufzeichnung läuft noch.');
            if(body.enabled&&incidentCapture.nextAllowedAt&&now()<Date.parse(incidentCapture.nextAllowedAt))throw new Error('Vor dem nächsten automatischen Versuch zehn Minuten abwarten.');
            incidentCapture.enabled=body.enabled;incidentCapture.sessionId=body.sessionId||null;incidentCapture.error=null;
            if(!body.enabled)await incidentPackets.stop();
            incidentCapture.status=body.enabled?'armed':'disabled';
            incidentCapture.detail=body.enabled?'Ein automatischer 15-Sekunden-Versuch beim nächsten Ereignis; Windows kann Administratorfreigabe anfordern.':'Optionale Ereignisaufzeichnung ist ausgeschaltet.';
            return captureSnapshot();
          }));
          case '/api/startup':
            if(!startup)return json(400,{error:'Autostart ist in dieser Instanz nicht verfügbar.'});
            return json(200,await startup.setEnabled(body.enabled));
          case '/api/reset': {const result=await gameAction(async()=>{await stopCaptures();const result=await monitor.reset();await packets.reset();await incidentPackets.reset();analysis.reset();return result;});return json(200,result);}
          case '/api/games/settings': return json(200,await gameAction(async()=>{const settings=validateGameSettings(body);await stopCaptures();return monitor.setGameDetection(settings);}));
          case '/api/games/capture/start': return json(202,await gameAction(async()=>{
            if(captureBusy(incidentPackets))throw Object.assign(new Error('Die begrenzte Ereignisaufzeichnung läuft bereits.'),{code:'MONITOR_BUSY'});
            if(typeof body.sessionId!=='string'||body.sessionId.length>120)throw new Error('Wähle eine laufende Spielsitzung.');
            const selected=monitor.state.gameDetection?.active.find(game=>game.sessionId===body.sessionId);
            const processes=selected?monitor.gameProcesses(body.sessionId):[];
            if(!selected||!processes.length)throw new Error('Das Spiel ist nicht mehr sicher erkennbar. Warte auf die nächste Prüfung oder starte das Spiel neu.');
            return packets.start({game:{id:selected.id,sessionId:selected.sessionId,name:selected.name},processes,elevate:true});
          }));
          case '/api/games/capture/stop': return json(200,await gameAction(stopCaptures));
          case '/api/analysis/check': return json(200,await analysis.check());
          case '/api/analysis/login': return json(202,analysis.login());
          case '/api/analysis/start': return json(202,analysis.start(body.hours ?? 1));
          case '/api/analysis/cancel': return json(200,analysis.cancel());
          case '/api/monitor':
            if(typeof body.enabled!=='boolean') throw new Error('Ungültiger Überwachungsstatus.');
            monitor.setMonitoring(body.enabled);
            monitor.event('info',body.enabled?'Überwachung fortgesetzt':'Überwachung pausiert','Ping- und DNS-Messungen wurden '+(body.enabled?'aktiviert.':'pausiert. Adapterdaten bleiben sichtbar.'));
            return json(200,{ok:true});
          case '/api/refresh': await monitor.refresh(); return json(200,{ok:true});
          case '/api/interface': monitor.selectInterface(body.interfaceId); return json(200,{ok:true});
          case '/api/targets': return json(200,monitor.addTarget(body.host,body.label));
          case '/api/repeater': return json(200,monitor.setRepeater(body.host,body.label));
          case '/api/repeater/primary': return json(200,monitor.selectRepeater(body.host));
          case '/api/mark': return json(200,{ok:true,event:monitor.markLag(body.note)});
          case '/api/fritzbox/connect': await monitor.connectFritz(body);return json(200,{ok:true});
          case '/api/fritzbox/refresh': await monitor.refreshFritz();return json(200,{ok:true});
          case '/api/fritzbox/disconnect': monitor.disconnectFritz();return json(200,{ok:true});
          case '/api/targets/toggle': monitor.toggleTarget(body.id,body.enabled); return json(200,{ok:true});
          case '/api/targets/remove': monitor.removeTarget(body.id); return json(200,{ok:true});
          case '/api/scan': monitor.startScan(body.interfaceId||monitor.state.selectedInterfaceId); return json(202,{ok:true});
          case '/api/stress/start': monitor.startStressTest(body); return json(202,{ok:true});
          case '/api/stress/stop': await monitor.stopStressTest(); return json(200,{ok:true});
          case '/api/speedtest': monitor.startSpeedTest(body); return json(202,{ok:true});
          case '/api/trace': {
            if(tracing) return json(409,{error:'Eine Routenprüfung läuft bereits.'});
            const host=validateHost(body.host);
            tracing=true;
            try{return json(200,await monitor.probes.traceRoute(host,{signal:monitor.abort.signal}));}finally{tracing=false;}
          }
          case '/api/shutdown':
            // Half-close after writing the acknowledgement, then wait for the
            // client to close its side before terminating Node. Connection:close
            // uses HTTP's destroySoon(), which can reset unread replies on Windows.
            req.socket.once('close',()=>onShutdown('normal'));
            res.once('finish',()=>req.socket.end());
            json(200,{ok:true}); return;
          default: return json(404,{error:'Unbekannte Aktion.'});
        }
      }
      if(req.method!=='GET') return json(405,{error:'Methode nicht unterstützt.'});
      const filename={'/incident-view.js':'incident-view.js','/incident-view.css':'incident-view.css','/diagnostic-settings.js':'diagnostic-settings.js','/diagnostic-settings.css':'diagnostic-settings.css','/peer-monitor.js':'peer-monitor.js','/peer-monitor.css':'peer-monitor.css','/background-monitor.js':'background-monitor.js','/overview-details.js':'overview-details.js','/dashboard.css':'dashboard.css','/ui-help.js':'ui-help.js','/fonts/geist-variable.woff2':'fonts/geist-variable.woff2','/fonts/geist-mono-variable.woff2':'fonts/geist-mono-variable.woff2','/live-signal.js':'live-signal.js','/live-signal.css':'live-signal.css','/ui-presentation.js':'ui-presentation.js','/graphite.css':'graphite.css','/workspace.css':'workspace.css','/workspace-panels.css':'workspace-panels.css','/lag-incidents.css':'lag-incidents.css','/lag-incidents.js':'lag-incidents.js','/game-comparison.css':'game-comparison.css','/game-comparison.js':'game-comparison.js','/network-health.js':'network-health.js','/network-health.css':'network-health.css','/':'index.html','/index.html':'index.html','/app.js':'app.js','/games.js':'games.js','/games.css':'games.css','/overview.js':'overview.js','/overview.css':'overview.css','/fritzbox.js':'fritzbox.js','/topology.js':'topology.js','/navigation.js':'navigation.js','/lag-hotkey.js':'lag-hotkey.js','/history-selection.js':'history-selection.js','/ping-chart.js':'ping-chart.js','/ping-chart.css':'ping-chart.css','/ping-statistics.js':'ping-statistics.js','/traffic-history.js':'traffic-history.js','/storage.js':'storage.js','/scroll-state.js':'scroll-state.js','/speedtest-ui.js':'speedtest-ui.js','/speed-history.js':'speed-history.js','/speedtest-options.js':'speedtest-options.js','/stress-test-ui.js':'stress-test-ui.js','/speedtest.css':'speedtest.css','/ai.js':'ai.js','/diagnosis-result.js':'diagnosis-result.js','/diagnosis-result.css':'diagnosis-result.css','/style.css':'style.css','/topology.css':'topology.css','/favicon.ico':'brand/compass.ico','/brand/compass.ico':'brand/compass.ico','/brand/compass.png':'brand/compass.png','/brand/compass-256.png':'brand/compass-256.png','/brand/compass-64.png':'brand/compass-64.png'}[url.pathname];
      if(!filename) return json(404,{error:'Nicht gefunden.'});
      let data=await readFile(path.join(publicDir,filename));
      if(filename==='index.html') data=data.toString('utf8').replaceAll('__API_TOKEN__',token);
      res.writeHead(200,{'Content-Type':types[path.extname(filename)]});res.end(data);
    } catch(error) {if(!res.headersSent)json(['MONITOR_BUSY','ANALYSIS_BUSY'].includes(error.code)?409:400,{error:error.message||'Aktion fehlgeschlagen.'});else res.end();}
  });
  server.requestTimeout=15000;
  server.headersTimeout=10000;
  server.once('close',()=>{Promise.resolve().then(()=>analysis.close()).catch(()=>{});});
  let closeCapturesPromise,closePeersPromise;
  server.closeGameCapture=()=>{closing=true;detachIncident();return closeCapturesPromise??=(Promise.allSettled([packets.close(),incidentPackets.close()]).then(results=>{const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);if(errors.length)throw new AggregateError(errors,'Paketaufzeichnung konnte nicht vollständig beendet werden.');}));};
  server.closePeers=()=>closePeersPromise??=Promise.resolve(peers?.close());
  server.once('close',()=>{server.closeGameCapture().catch(()=>{});server.closePeers().catch(()=>{});});
  return server;
}

export async function main() {
  const dataDir=dataDirectory(directory);
  const launcher=process.argv.includes('--launcher');
  const monitor=new Monitor(probes,{dataDir});
  const peers=createPeerMonitor({dataDir});
  const startup=createStartupManager({dataDir});
  const analysis=new AnalysisController(monitor);
  let stopping=false;
  let detachLauncher=()=>{};
  let detachPeers=()=>{};
  const cleanup=async(reason,{forceConnections=false}={})=>{
    const errors=[];
    const finish=async action=>{try{await action();}catch(error){errors.push(error);}};
    detachLauncher();detachPeers();
    const closed=new Promise(resolve=>server.close(error=>{if(error&&error.code!=='ERR_SERVER_NOT_RUNNING')errors.push(error);resolve();}));
    server.closeIdleConnections();
    if(forceConnections)server.closeAllConnections();
    await finish(()=>server.closeGameCapture());
    await finish(()=>server.closePeers());
    await finish(()=>monitor.prepareClose({reason}));
    await finish(()=>analysis.close());
    await finish(()=>monitor.close({reason}));
    await closed;
    if(errors.length===1)throw errors[0];
    if(errors.length)throw new AggregateError(errors,'Programm konnte nicht vollständig beendet werden.');
  };
  const shutdown=async(reason='normal')=>{
    if(stopping)return;stopping=true;
    const hard=setTimeout(()=>process.exit(1),12000);hard.unref();
    try{await cleanup(reason);process.exitCode=0;}
    catch(error){console.error('Beenden fehlgeschlagen:',error.message);process.exitCode=1;}
    finally{clearTimeout(hard);}
  };
  const server=createApp(monitor,{analysis,onShutdown:shutdown,startup,peers});
  let url;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    url=`http://127.0.0.1:${server.address().port}`;
    process.once('SIGINT',()=>shutdown('signal'));process.once('SIGTERM',()=>shutdown('signal'));
    if(launcher)detachLauncher=attachLauncherShutdown(process.stdin,shutdown);
    await monitor.start();
    if(!stopping){
      try {detachPeers=await attachPeerMonitoring(monitor,peers);}
      catch(error){peers.lastError=`PC-Kopplung konnte nicht gestartet werden: ${error.message}`;}
      if(stopping){detachPeers();await peers.close();}else await startup.init();
    }
  } catch(error) {
    stopping=true;
    try{await cleanup('startup_error',{forceConnections:true});}
    catch(cleanupError){console.error('Startbereinigung fehlgeschlagen:',cleanupError.message);}
    throw error;
  }
  if(stopping)return {server,monitor};
  console.log(`\nNetzwerk-Kompass ${monitor.state.version}\n${url}\n\n${launcher?'Beenden in der App oder über das Symbol im Infobereich.':'Dieses Fenster offen lassen. Beenden mit Strg+C oder in der App.'}\nMessprotokolle: ${dataDir}\n`);
  if(process.platform==='win32'&&!process.argv.includes('--no-browser')) {
    const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
  }
  return {server,monitor};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error('Start fehlgeschlagen:',error.message);process.exitCode=1;});
