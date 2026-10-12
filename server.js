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

const directory=path.dirname(fileURLToPath(import.meta.url));

export function createApp(monitor,{token=randomBytes(32).toString('hex'),publicDir=path.join(directory,'public'),onShutdown=()=>{},analysis=new AnalysisController(monitor),startup=null,packetTracker=null}={}) {
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.ico':'image/x-icon','.ttf':'font/ttf','.woff2':'font/woff2'};
  const packets=packetTracker||new GamePacketTracker({onFinish:capture=>{
    if(!capture.game||monitor.history.closed)return;
    const event={type:'event',kind:'game-packets',at:capture.endedAt||new Date().toISOString(),level:['error','needs-admin'].includes(capture.status)?'warning':'info',title:`Paket-Tracking: ${capture.game.name}`,detail:capture.reason||'Lokale Erfassung beendet. Keine Bestätigung einer Zustellung hinter dem Router.',game:{id:capture.game.id,name:capture.game.name,sessionId:capture.game.sessionId},gameSessionIds:[capture.game.sessionId].filter(Boolean),capture:Object.fromEntries(['startedAt','endedAt','status','quality','sampleIntervalMs','sentPackets','receivedPackets','sentBytes','receivedBytes','retransmits','losses'].map(key=>[key,capture[key]]))};
    monitor.state.events.unshift(event);monitor.state.events.length=Math.min(300,monitor.state.events.length);monitor.log(event);
  }});
  const snapshot=()=>({...monitor.snapshot(),gamePackets:packets.snapshot()});
  let gameActionBusy=false;
  const gameAction=async action=>{if(gameActionBusy)throw Object.assign(new Error('Eine Spiel-Aktion läuft bereits.'),{code:'MONITOR_BUSY'});gameActionBusy=true;try{return await action();}finally{gameActionBusy=false;}};
  let tracing=false;
  const server=http.createServer(async (req,res)=>{
    const port=server.address()?.port;
    const expectedHost=`127.0.0.1:${port}`;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(body));};
    if(req.headers.host!==expectedHost) return json(403,{error:'Ungültiger Host.'});
    if(req.headers.origin && req.headers.origin!==`http://${expectedHost}`) return json(403,{error:'Zugriff nur aus der lokalen App.'});
    if(req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return json(403,{error:'Fremder Webseitenzugriff abgewiesen.'});
    let url;
    try{url=new URL(req.url,`http://${expectedHost}`);}catch{return json(400,{error:'Ungültige Adresse.'});}
    try {
      if(req.method==='GET' && url.pathname==='/api/startup')return json(200,startup?.snapshot()||{available:false,enabled:true,registered:null,error:null});
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
      if(req.method==='GET' && url.pathname==='/api/history') return json(200,monitor.historySnapshot(Number(url.searchParams.get('hours')||1)));
      if(req.method==='GET' && url.pathname==='/api/export') {
        res.setHeader('Content-Disposition',`attachment; filename="netzwerk-bericht-${new Date().toISOString().slice(0,10)}.json"`);
        return json(200,{...snapshot(),history:monitor.historySnapshot(168),exportedAt:new Date().toISOString(),notes:['Ping-Ausfall ist kein sicherer Offline-Nachweis.','PC-Adapterverkehr, FRITZ!Box-Gesamtverkehr und Geräte-Internetverkehr sind getrennte, sich überschneidende Quellen; nicht addieren.','Messwerte: letzte 600 Pings pro Ziel; gespeicherter Verlauf ist mengenbegrenzt, vollständige Messungen in data/messungen-*.jsonl.','Gerätenamen, lokale IP- und MAC-Adressen sind private Informationen.']});
      }
      if(req.method==='POST' && url.pathname.startsWith('/api/')) {
        if(req.headers['x-api-token']!==token) return json(403,{error:'Die Sitzung ist abgelaufen. Bitte die Seite neu laden.'});
        if(!req.headers['content-type']?.startsWith('application/json')) return json(415,{error:'JSON erwartet.'});
        let content='';
        for await(const chunk of req) {content+=chunk; if(Buffer.byteLength(content)>8192){json(413,{error:'Anfrage zu groß.'});req.destroy();return;}}
        let body;
        try{body=JSON.parse(content||'{}');if(!body||typeof body!=='object'||Array.isArray(body))throw new Error();}catch{return json(400,{error:'Ungültiges JSON.'});}
        if(monitor.starting && url.pathname!=='/api/shutdown')return json(409,{error:'Die gespeicherten Einstellungen werden noch geladen. Bitte den Start abwarten.'});
        switch(url.pathname) {
          case '/api/startup':
            if(!startup)return json(400,{error:'Autostart ist in dieser Instanz nicht verfügbar.'});
            return json(200,await startup.setEnabled(body.enabled));
          case '/api/reset': {const result=await gameAction(async()=>{await packets.stop();const result=await monitor.reset();await packets.reset();analysis.reset();return result;});return json(200,result);}
          case '/api/games/settings': return json(200,await gameAction(async()=>{const settings=validateGameSettings(body);await packets.stop();return monitor.setGameDetection(settings);}));
          case '/api/games/capture/start': return json(202,await gameAction(async()=>{
            if(typeof body.sessionId!=='string'||body.sessionId.length>120)throw new Error('Wähle eine laufende Spielsitzung.');
            const selected=monitor.state.gameDetection?.active.find(game=>game.sessionId===body.sessionId);
            const processes=selected?monitor.gameProcesses(body.sessionId):[];
            if(!selected||!processes.length)throw new Error('Das Spiel ist nicht mehr sicher erkennbar. Warte auf die nächste Prüfung oder starte das Spiel neu.');
            return packets.start({game:{id:selected.id,sessionId:selected.sessionId,name:selected.name},processes,elevate:true});
          }));
          case '/api/games/capture/stop': return json(200,await gameAction(()=>packets.stop()));
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
      const filename={'/overview-details.js':'overview-details.js','/dashboard.css':'dashboard.css','/ui-help.js':'ui-help.js','/fonts/geist-variable.woff2':'fonts/geist-variable.woff2','/fonts/geist-mono-variable.woff2':'fonts/geist-mono-variable.woff2','/live-signal.js':'live-signal.js','/live-signal.css':'live-signal.css','/ui-presentation.js':'ui-presentation.js','/graphite.css':'graphite.css','/workspace.css':'workspace.css','/workspace-panels.css':'workspace-panels.css','/lag-incidents.css':'lag-incidents.css','/lag-incidents.js':'lag-incidents.js','/game-comparison.css':'game-comparison.css','/game-comparison.js':'game-comparison.js','/network-health.js':'network-health.js','/network-health.css':'network-health.css','/':'index.html','/index.html':'index.html','/app.js':'app.js','/games.js':'games.js','/games.css':'games.css','/overview.js':'overview.js','/overview.css':'overview.css','/fritzbox.js':'fritzbox.js','/topology.js':'topology.js','/navigation.js':'navigation.js','/lag-hotkey.js':'lag-hotkey.js','/history-selection.js':'history-selection.js','/ping-chart.js':'ping-chart.js','/ping-chart.css':'ping-chart.css','/ping-statistics.js':'ping-statistics.js','/traffic-history.js':'traffic-history.js','/storage.js':'storage.js','/scroll-state.js':'scroll-state.js','/speedtest-ui.js':'speedtest-ui.js','/speed-history.js':'speed-history.js','/speedtest-options.js':'speedtest-options.js','/stress-test-ui.js':'stress-test-ui.js','/speedtest.css':'speedtest.css','/ai.js':'ai.js','/diagnosis-result.js':'diagnosis-result.js','/diagnosis-result.css':'diagnosis-result.css','/style.css':'style.css','/topology.css':'topology.css','/favicon.ico':'brand/compass.ico','/brand/compass.ico':'brand/compass.ico','/brand/compass.png':'brand/compass.png','/brand/compass-256.png':'brand/compass-256.png','/brand/compass-64.png':'brand/compass-64.png'}[url.pathname];
      if(!filename) return json(404,{error:'Nicht gefunden.'});
      let data=await readFile(path.join(publicDir,filename));
      if(filename==='index.html') data=data.toString('utf8').replaceAll('__API_TOKEN__',token);
      res.writeHead(200,{'Content-Type':types[path.extname(filename)]});res.end(data);
    } catch(error) {if(!res.headersSent)json(['MONITOR_BUSY','ANALYSIS_BUSY'].includes(error.code)?409:400,{error:error.message||'Aktion fehlgeschlagen.'});else res.end();}
  });
  server.requestTimeout=15000;
  server.headersTimeout=10000;
  server.once('close',()=>analysis.close());
  server.closeGameCapture=()=>packets.close();
  server.once('close',()=>{packets.close().catch(()=>{});});
  return server;
}

export async function main() {
  const dataDir=dataDirectory(directory);
  const launcher=process.argv.includes('--launcher');
  const monitor=new Monitor(probes,{dataDir});
  const startup=createStartupManager({dataDir});
  const analysis=new AnalysisController(monitor);
  let stopping=false;
  let detachLauncher=()=>{};
  const shutdown=async(reason='normal')=>{
    if(stopping)return;stopping=true;
    detachLauncher();
    const hard=setTimeout(()=>process.exit(1),12000);hard.unref();
    server.close();server.closeIdleConnections();
    await server.closeGameCapture();
    await monitor.prepareClose({reason});await analysis.close();await monitor.close({reason});process.exit(0);
  };
  const server=createApp(monitor,{analysis,onShutdown:shutdown,startup});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  process.once('SIGINT',()=>shutdown('signal'));process.once('SIGTERM',()=>shutdown('signal'));
  if(launcher)detachLauncher=attachLauncherShutdown(process.stdin,shutdown);
  try {await monitor.start();if(!stopping)await startup.init();} catch(error) {detachLauncher();await monitor.close({reason:'startup_error'});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));throw error;}
  if(stopping)return {server,monitor};
  console.log(`\nNetzwerk-Kompass ${monitor.state.version}\n${url}\n\n${launcher?'Beenden in der App oder über das Symbol im Infobereich.':'Dieses Fenster offen lassen. Beenden mit Strg+C oder in der App.'}\nMessprotokolle: ${dataDir}\n`);
  if(process.platform==='win32'&&!process.argv.includes('--no-browser')) {
    const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();
  }
  return {server,monitor};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error('Start fehlgeschlagen:',error.message);process.exitCode=1;});
