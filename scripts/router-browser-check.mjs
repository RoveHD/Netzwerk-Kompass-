// Isolated, simulated FRITZ!Box data: no real probes, router login or AI calls.
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { Monitor } from '../lib/monitor.js';
import { AnalysisController } from '../lib/ai-analysis.js';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const monitor=new Monitor({});
const analysis=new AnalysisController(monitor,{client:{check:async()=>({available:false,authenticated:false,message:'Isolierte Prüfung'}),cancel(){},close(){}}});
const now=Date.now(),mac=i=>`02:00:00:00:00:0${i}`;
const snapshot={host:'fritz.box',updatedAt:new Date(now).toISOString(),device:{model:'SIMULIERT FRITZ!Box 6690 Cable',firmware:'8.25 (Testdaten)',uptimeSeconds:1000},wan:{status:'Connected',totalBytesReceived:10000000,totalBytesSent:1000000,downstreamMbps:1000,upstreamMbps:50},hosts:[
  {name:'SIMULIERT Gaming-PC',ip:'192.168.178.20',mac:mac(2),active:true,guest:false,wanAccess:'granted',priority:true,linkRateMbps:1000,interfaceType:'Ethernet',lanPort:1},
  {name:'SIMULIERT Gast-Tablet',ip:'192.168.179.2',mac:mac(3),active:false,guest:true,wanAccess:'denied',interfaceType:'802.11'},
  {name:'SIMULIERT Status unbekannt',ip:'192.168.178.40',mac:mac(4),active:null,guest:null,wanAccess:null},
],mesh:{nodes:[{id:'box',mac:mac(1),role:'MASTER',name:'SIMULIERT Router'},{id:'pc',mac:mac(2),name:'SIMULIERT Gaming-PC',latency:{roundTripMs:1.25,measuredAtMs:now,status:'SUCCESS'}},{id:'tablet',mac:mac(3),name:'SIMULIERT Gast-Tablet'},{id:'unknown',mac:mac(4),name:'SIMULIERT Status unbekannt'}],links:[{id:'link',from:'box',to:'pc',state:'CONNECTED',type:'LAN',receiveRateMbps:1000}]},wlan:[{id:'wifi',ssid:'SIMULIERT WLAN',enabled:true,status:'Up',channel:36,frequencyBand:'5GHz',standard:'ax',associatedDevices:1,beaconType:'WPA3',macFilterEnabled:false,packetStats:{available:false,reason:'Ab FRITZ!OS 8.10 keine verwendbaren Paketzähler.'}}],diagnostics:{internet:{available:true,status:'Connected',natEnabled:true,portMappingCount:2,ipv6Status:'Connected'},lan:{available:true,dhcpEnabled:true,minAddress:'192.168.178.20',maxAddress:'192.168.178.200',subnetMask:'255.255.255.0',dnsServers:['192.168.178.1']},ethernet:[{id:'LAN 1',available:true,enabled:true,status:'Up',maxBitRateMbps:1000,duplexMode:'Full',totalBytesReceived:12500000,totalBytesSent:3000000}]},capabilities:[{service:'LANEthernetInterfaceConfig',action:'GetInfo',available:true},{service:'WANDSLInterfaceConfig',action:'GetInfo',available:false,reason:'Nicht von der Cable-Box gemeldet.'}],log:'SIMULIERTE TESTDATEN\nInternetverbindung hergestellt\nGastgerät abgemeldet',warnings:['SIMULIERTE TESTDATEN – keine Messung am Router.']};
for(let i=0;i<3;i++){
  const data=structuredClone(snapshot);data.device.uptimeSeconds+=i*30;
  data.deviceTraffic=data.hosts.map((host,index)=>({id:'mac:'+host.mac,nodeId:['pc','tablet','unknown'][index],mac:host.mac,name:host.name,ip:host.ip,source:'mesh-wan-counters',scope:'internet',available:index===0,reason:index===0?null:'Keine Internet-Bytezähler gemeldet.',totalBytesReceived:index===0?1000000+i*3000000:null,totalBytesSent:index===0?100000+i*300000:null,lastUpdateMs:now-(90-i*30)*1000}));
  monitor.applyFritz(data);
}
monitor.state.fritzbox.wan.downloadMbps=42;monitor.state.fritzbox.wan.uploadMbps=4;
monitor.state.lastError='SIMULIERTE TESTDATEN – keine realen Routerdaten.';
const server=createApp(monitor,{analysis});server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
let browser;const results=[],errors=[];await mkdir('test-artifacts',{recursive:true});
try{
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE}:{})});
  const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/#router');await page.locator('#router-tab-devices').waitFor();
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});
    for(const id of ['overview','devices','traffic','mesh','wlan','connection','system']){
      await page.locator('#router-tab-'+id).click();
      assert.equal(await page.locator('#router-panel-'+id).isVisible(),true);
      assert.equal(await page.locator('.router-panel:visible').count(),1);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Page overflow ${width}/${id}`);
    }
    await page.locator('#router-tab-devices').click();
    await page.locator('#router-device-filter').selectOption('guest');assert.equal(await page.locator('.router-device-results tbody tr').count(),1);
    assert.match(await page.locator('.router-device-results').innerText(),/Gast-Tablet/);
    await page.locator('#router-device-filter').selectOption('all');
    await page.locator('#router-device-search').fill('Gaming');assert.equal(await page.locator('.router-device-results tbody tr').count(),1);
    if(!await page.locator('.router-host-details').evaluate(item=>item.open))await page.locator('.router-host-details summary').click();assert.match(await page.locator('.router-host-details').innerText(),/1,25 ms/);
    await page.screenshot({path:`test-artifacts/router-devices-${width}.png`,fullPage:true});
    await page.locator('#router-device-search').fill('');
    await page.locator('#router-tab-connection').click();assert.equal(await page.getByRole('heading',{name:'DSL-Daten',exact:true}).count(),0);assert.match(await page.locator('#router-panel-connection').innerText(),/DOCSIS/);
    await page.screenshot({path:`test-artifacts/router-connection-${width}.png`,fullPage:true});
    results.push(`Seven router panels, filters and no page overflow at ${width}px`);
  }
  await page.locator('#router-tab-system').click();await page.locator('#router-log-search').fill('Gastgerät');assert.equal(await page.locator('.fritzbox-log').innerText(),'Gastgerät abgemeldet');
  await page.locator('#router-tab-devices').click();await page.locator('#router-device-search').fill('Gaming');
  monitor.state.fritzbox.updatedAt=new Date(now+1000).toISOString();
  // Force the same public state event used by polling, then assert retained input/tab/details.
  await page.evaluate(async()=>window.dispatchEvent(new CustomEvent('fritzbox-state',{detail:await(await fetch('/api/state')).json()})));
  assert.equal(await page.locator('#router-device-search').inputValue(),'Gaming');assert.equal(await page.locator('#router-panel-devices').isVisible(),true);
  await page.locator('#router-tab-traffic').click();await page.locator('#router-panel-traffic').getByRole('button',{name:'Im Verlauf vergleichen'}).click();
  await page.locator('#history-tab-traffic[aria-selected=true]').waitFor();
  assert.equal(await page.locator('#history-view input[type=checkbox]').count(),5);
  await page.getByRole('button',{name:'FRITZ!Box + alle Geräte',exact:true}).click();assert.equal(await page.locator('#history-view input:checked').count(),4);
  assert.match(await page.locator('#history-view').innerText(),/Status unbekannt/);
  await page.getByRole('button',{name:'Keine',exact:true}).click();assert.equal(await page.locator('#history-view input:checked').count(),0);
  await page.getByRole('button',{name:'Nur FRITZ!Box',exact:true}).click();assert.equal(await page.locator('#history-view input:checked').count(),1);
  await page.getByRole('button',{name:'FRITZ!Box + alle Geräte',exact:true}).click();
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Traffic page overflow at 320px');
  await page.screenshot({path:'test-artifacts/router-traffic-320.png',fullPage:true});
  results.push('Device/total selection, unknown values, log filter and poll state retained');
  assert.deepEqual(errors,[]);await writeFile('test-artifacts/router-browser-results.json',JSON.stringify({simulated:true,results,errors},null,2));console.log(JSON.stringify({results,errors}));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await analysis.close();await monitor.close();}
