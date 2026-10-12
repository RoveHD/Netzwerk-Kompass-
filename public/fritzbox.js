import { renderTopology } from './topology.js';
import { captureScroll, restoreScroll } from './scroll-state.js';

const $ = (selector) => document.querySelector(selector);
const sensitiveKey = /password|passwort|kennwort|secret|credential|token|username/i;

function node(tag, className, text) { const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = String(text); return item; }
function valueText(value) {
  if (value === null || value === undefined || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if (typeof value === 'object') return Object.entries(value).filter(([key]) => !sensitiveKey.test(key)).map(([key, child]) => `${humanLabel(key)}: ${valueText(child)}`).join(' · ') || '–';
  return String(value).replace(/(password|passwort|kennwort|secret|token)\s*[:=]\s*\S+/gi, '$1: [entfernt]');
}
function humanLabel(key) {
  const known = { status: 'Status', uptimeSeconds: 'Laufzeit', downstreamMbps: 'Downstream', upstreamMbps: 'Upstream', downloadMbps: 'Download', uploadMbps: 'Upload', attenuation: 'Dämpfung', noiseMargin: 'Störabstand', attainableRate: 'Erreichbare Datenrate', currentRate: 'Aktuelle Datenrate', crcErrors: 'CRC-Fehler', atucCrcErrors: 'CRC-Fehler der Gegenstelle', fecErrors: 'FEC-Fehler', erroredSeconds: 'Sekunden mit Fehlern', severelyErroredSeconds: 'Sekunden mit schweren Fehlern', linkRetrains: 'Neusynchronisationen', downstreamRateRaw: 'Downstream (Router-Rohwert)', upstreamRateRaw: 'Upstream (Router-Rohwert)', downstreamNoiseMarginRaw: 'Störabstand Downstream (Rohwert)', upstreamNoiseMarginRaw: 'Störabstand Upstream (Rohwert)', totalBytesReceived: 'Empfangen gesamt', totalBytesSent: 'Gesendet gesamt' };
  return known[key] || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}
function formatRate(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? '–' : `${Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mbit/s`; }
function isNumeric(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function formatBytes(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '–';
  const n = Number(value); const units = ['B', 'KB', 'MB', 'GB', 'TB']; let size = n, index = 0; while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ${units[index]}`;
}
function formatUptime(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value))) return '–';
  const seconds = Math.max(0, Math.floor(Number(value))); const days = Math.floor(seconds / 86400); const hours = Math.floor(seconds % 86400 / 3600); const minutes = Math.floor(seconds % 3600 / 60);
  return [days ? `${days} T` : '', hours ? `${hours} Std.` : '', `${minutes} Min.`].filter(Boolean).join(' ');
}
function addFact(parent, label, value) { const item = node('div', 'fritzbox-fact'); item.append(node('span', '', label), node('strong', '', valueText(value))); parent.append(item); }
function section(parent, title, subtitle = '', detail = subtitle) { const heading = node('div', 'fritzbox-section-heading'); heading.append(node('h3', '', title)); if (subtitle) { const note=node('p', '', subtitle); note.title=note.dataset.help=detail; heading.append(note); } parent.append(heading); }
function table(headers, rows) {
  const wrap = node('div', 'fritzbox-table-wrap'); const tableEl = node('table', 'fritzbox-table'); const head = node('thead'); const headRow = node('tr'); headers.forEach((text) => headRow.append(node('th', '', text))); head.append(headRow); tableEl.append(head);
  const body = node('tbody'); rows.forEach((values) => { const row = node('tr'); values.forEach((value) => { const cell = node('td'); if (value instanceof Node) cell.append(value); else cell.textContent = valueText(value); row.append(cell); }); body.append(row); }); tableEl.append(body); wrap.append(tableEl); return wrap;
}
function setMessage(message, error = false) { const box = $('#fritzbox-error'); box.hidden = !message; box.textContent = message || ''; box.classList.toggle('is-error', error); }
function renderStatus(fritzbox) {
  const pill = $('#fritzbox-status');
  const busy = localBusy || fritzbox?.connecting || fritzbox?.busy;
  if (busy) { pill.textContent = 'Lädt Routerdaten …'; pill.className = 'pill pill-warn'; }
  else if (fritzbox?.connected) { pill.textContent = 'Verbunden'; pill.className = 'pill pill-good'; }
  else { pill.textContent = 'Nicht verbunden'; pill.className = 'pill pill-muted'; }
  $('#fritzbox-connect').disabled = !!busy;
  $('#fritzbox-refresh').disabled = !fritzbox?.connected || !!busy;
  $('#fritzbox-disconnect').disabled = !fritzbox?.connected || !!busy;
  $('#fritzbox-host').disabled = !!busy;
  $('#fritzbox-username').disabled = !!busy;
  $('#fritzbox-password').disabled = !!busy;
  $('#fritzbox-connect').textContent = fritzbox?.connecting ? 'Verbinde …' : 'Verbinden und lesen';
}
let routerTab = 'overview';
let hostQuery = '';
let hostFilter = 'all';
let logQuery = '';
const openHostDetails = new Set();
const routerTabs = [['overview','Übersicht'],['traffic','Datenverkehr'],['devices','Geräte'],['mesh','Mesh'],['wlan','WLAN & Gastnetz'],['connection','Anschluss & LAN'],['system','System & Ereignisse']];

function routerPanels(parent) {
  const nav = node('div','router-tabs'); nav.setAttribute('role','tablist'); nav.setAttribute('aria-label','FRITZ!Box-Bereiche');
  const panels = new Map();
  for (const [id,label] of routerTabs) {
    const button = node('button','button button-quiet',label); button.type='button'; button.id=`router-tab-${id}`; button.dataset.routerTab=id; button.setAttribute('role','tab'); button.setAttribute('aria-controls',`router-panel-${id}`); nav.append(button);
    const panel = node('section','router-panel'); panel.id=`router-panel-${id}`; panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',button.id); panels.set(id,panel);
    button.addEventListener('click',()=>activate(id));
  }
  const activate = id => {
    routerTab=id;
    for(const button of nav.children){const selected=button.dataset.routerTab===id;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;button.classList.toggle('is-active',selected);}
    for(const [key,panel] of panels)panel.hidden=key!==id;
  };
  nav.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const buttons=[...nav.children],index=buttons.indexOf(event.target);if(index<0)return;
    event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
    activate(buttons[next].dataset.routerTab);buttons[next].focus();
  });
  parent.append(nav,...panels.values());activate(routerTab);return id=>panels.get(id);
}
function facts(parent, entries) { const grid=node('div','fritzbox-facts');for(const [label,value]of entries)addFact(grid,label,value);parent.append(grid); }
function trafficHistoryButton(sourceId) {
  const button=node('button','button button-secondary','Im Verlauf vergleichen');button.type='button';
  button.addEventListener('click',()=>window.dispatchEvent(new CustomEvent('open-traffic-history',{detail:{sourceId}})));return button;
}
function renderConnectionDetails(parent,diagnostics) {
  const internet=diagnostics?.internet,lan=diagnostics?.lan;
  section(parent,'Internetverbindung','Von der Box gemeldete Verbindungs- und Freigabeinformationen.');
  if(internet?.available)facts(parent,[['Verbindung',internet.status],['Verbindungstyp',internet.connectionType],['Aktiviert',internet.enabled],['NAT',internet.natEnabled],['Externe IP-Adresse',internet.externalIp],['DNS-Server',internet.dnsServers],['Portfreigaben (Anzahl)',internet.portMappingCount],['Letzter Verbindungsfehler',internet.lastConnectionError],['IPv6-Status',internet.ipv6Status],['IPv6-Laufzeit',formatUptime(internet.ipv6UptimeSeconds)]]);
  else parent.append(node('p','fritzbox-empty',internet?.reason||'Keine zusätzlichen Internet-Verbindungsdetails gemeldet.'));
  section(parent,'LAN-Anschlüsse','Ausgehandelte Verbindung am LAN-Port.','Linkrate = ausgehandelte Verbindung am Port. Bytezähler enthalten auch lokalen Datenverkehr und sind kein Internetverbrauch.');
  const ports=diagnostics?.ethernet||[];
  if(ports.length)parent.append(table(['Anschluss','Aktiviert / Status','Linkrate','Duplex','Empfangen / Gesendet','Pakete RX / TX'],ports.map(port=>[port.id,`${valueText(port.enabled)} / ${valueText(port.status)}`,formatRate(port.maxBitRateMbps),port.duplexMode,`${formatBytes(port.totalBytesReceived)} / ${formatBytes(port.totalBytesSent)}`,`${valueText(port.totalPacketsReceived)} / ${valueText(port.totalPacketsSent)}`])));
  else parent.append(node('p','fritzbox-empty','Keine einzelnen LAN-Portdaten von der Box bereitgestellt.'));
  section(parent,'Heimnetz & DHCP');
  if(lan?.available)facts(parent,[['DHCP aktiv',lan.dhcpEnabled],['Adressbereich',lan.minAddress&&lan.maxAddress?`${lan.minAddress} – ${lan.maxAddress}`:null],['Subnetzmaske',lan.subnetMask],['DNS-Server',lan.dnsServers],['Gateway',lan.routers],['Lokale Domain',lan.domainName],['DHCP-Relay',lan.dhcpRelay]]);
  else parent.append(node('p','fritzbox-empty',lan?.reason||'Keine DHCP- oder Heimnetz-Konfiguration gemeldet.'));
}
function renderRouterHosts(parent,hosts,mesh) {
  section(parent,'Alle Router-Geräte',`${hosts.length} gemeldet · ${hosts.filter(host=>host.active===true).length} aktiv · ${hosts.filter(host=>host.guest===true).length} im Gastnetz`);
  const controls=node('div','router-device-controls');const search=node('input');search.type='search';search.id='router-device-search';search.placeholder='Name, IP oder MAC suchen';search.setAttribute('aria-label','Router-Geräte suchen');search.value=hostQuery;
  const filter=node('select');filter.id='router-device-filter';filter.setAttribute('aria-label','Router-Geräte filtern');for(const [id,label]of [['all','Alle Geräte'],['active','Aktiv'],['inactive','Inaktiv'],['guest','Gastnetz'],['blocked','Internetzugang gesperrt']]){const option=node('option','',label);option.value=id;filter.append(option);}filter.value=hostFilter;controls.append(search,filter);parent.append(controls);
  const results=node('div','router-device-results');parent.append(results);
  const render=()=>{
    results.replaceChildren();const query=hostQuery.trim().toLocaleLowerCase('de');
    const selected=hosts.filter(host=>(!query||[host.name,host.ip,host.mac,host.model].some(value=>String(value||'').toLocaleLowerCase('de').includes(query)))&&(hostFilter==='all'||hostFilter==='active'&&host.active===true||hostFilter==='inactive'&&host.active===false||hostFilter==='guest'&&host.guest===true||hostFilter==='blocked'&&host.wanAccess==='denied'));
    if(!selected.length){results.append(node('p','fritzbox-empty',hosts.length?'Keine Geräte passen zu dieser Auswahl.':'Die Box hat noch keine Geräteliste geliefert. Unter System & Ereignisse stehen Hinweise zur Abfrage.'));return;}
    const rows=selected.map(host=>{
      const identity=host.mac||host.ip;const detail=node('details','router-host-details');detail.open=openHostDetails.has(identity);detail.append(node('summary','',host.name||host.ip||'Unbenanntes Gerät'));
      const latency=(mesh.nodes||[]).find(item=>host.mac&&item.mac?.toUpperCase()===host.mac.toUpperCase())?.latency;
      facts(detail,[['MAC',host.mac],['Modell',host.model],['Geräteklasse',host.deviceClass],['LAN-Port',host.lanPort],['Linkrate',formatRate(host.linkRateMbps)],['Priorisiert',host.priority],['Zugangsprofil-ID',host.filterProfileId],['VPN-Gerät',host.vpn],['Update verfügbar',host.updateAvailable],['Adressvergabe',host.addressSource],['DHCP-Lease verbleibend',formatUptime(host.leaseTimeRemainingSeconds)],['Router-Latenzmessung',latency?.roundTripMs==null?null:`${latency.roundTripMs.toLocaleString('de-DE')} ms`],['Latenz gemessen am',latency?.measuredAtMs?new Date(latency.measuredAtMs).toLocaleString('de-DE'):null]]);
      detail.addEventListener('toggle',()=>{if(!identity)return;detail.open?openHostDetails.add(identity):openHostDetails.delete(identity);});
      const actions=node('div','router-row-actions');
      if(host.ip){
        const key=encodeURIComponent(host.ip),monitored=monitoredTargets.some(target=>target.host===host.ip),monitor=node('button','text-button',monitored?'Überwacht':'+ überwachen');monitor.id=`fritzbox-monitor-${key}`;monitor.type='button';monitor.disabled=monitored;monitor.addEventListener('click',async()=>{monitor.disabled=true;try{await activePost('/api/targets',{host:host.ip,label:host.name||host.ip});monitor.textContent='Überwacht';}catch(error){monitor.disabled=false;setMessage(error.message,true);}});actions.append(monitor);
        const repeaterTarget=currentRepeaterHost===host.ip||monitoredTargets.some(target=>target.host===host.ip&&target.kind==='repeater'),special=monitoredTargets.find(target=>target.host===host.ip&&['gateway','internet'].includes(target.kind)),repeater=node('button','text-button',repeaterTarget?'Repeater überwacht':special?'Festes Messziel':'Als Repeater');repeater.id=`fritzbox-repeater-${key}`;repeater.type='button';repeater.disabled=repeaterTarget||!!special;repeater.addEventListener('click',async()=>{repeater.disabled=true;try{await activePost('/api/repeater',{host:host.ip,label:host.name||'Mesh-Repeater'});repeater.textContent='Repeater überwacht';}catch(error){repeater.disabled=false;setMessage(error.message,true);}});actions.append(repeater);
      }
      return [detail,host.ip,host.active===true?'Aktiv':host.active===false?'Inaktiv':'Unbekannt',host.guest===true?'Gastnetz':host.guest===false?'Heimnetz':'Unbekannt',host.interfaceType,({granted:'Erlaubt',denied:'Gesperrt',error:'Abfragefehler',unknown:'Unbekannt'})[host.wanAccess]||'Unbekannt',actions];
    });results.append(table(['Gerät / Details','IP-Adresse','Status','Netz','Verbindung','Internetzugang','Aktionen'],rows));
  };search.addEventListener('input',()=>{hostQuery=search.value;render();});filter.addEventListener('change',()=>{hostFilter=filter.value;render();});render();
}
function renderDevice(fritzbox) {
  const root = $('#fritzbox-data'); root.replaceChildren();
  if (!fritzbox?.connected) { const note=node('div', 'history-empty', fritzbox?.error ? 'Verbindung fehlgeschlagen. Prüfe Zugangsdaten und TR-064-Zugriff.' : 'Melde dich an deiner FRITZ!Box an.');if(!fritzbox?.error)note.title=note.dataset.help='Danach erscheinen Gesamtverkehr, gemeldete Geräte, Mesh, WLAN und Anschlussdaten direkt aus der Box. Ein PC-Gerätescan allein liefert diese Routerdaten nicht.';root.append(note); return; }
  const panel=routerPanels(root);let data=panel('overview');
  const device = fritzbox.device && typeof fritzbox.device === 'object' ? fritzbox.device : {}; const wan = fritzbox.wan && typeof fritzbox.wan === 'object' ? fritzbox.wan : {}; const dsl = fritzbox.dsl && typeof fritzbox.dsl === 'object' ? fritzbox.dsl : {}; const mesh = fritzbox.mesh && typeof fritzbox.mesh === 'object' ? fritzbox.mesh : {};
  const overview = node('div', 'fritzbox-facts'); addFact(overview, 'Modell', device.model); addFact(overview, 'Firmware', device.firmware); addFact(overview, 'Router-Laufzeit', formatUptime(device.uptimeSeconds)); addFact(overview, 'WAN-Status', wan.status); addFact(overview, 'WAN-Laufzeit', formatUptime(wan.uptimeSeconds)); addFact(overview, 'Gemessener Download', formatRate(wan.downloadMbps)); addFact(overview, 'Gemessener Upload', formatRate(wan.uploadMbps)); addFact(overview, 'Anschlussrate Downstream', formatRate(wan.downstreamMbps)); addFact(overview, 'Anschlussrate Upstream', formatRate(wan.upstreamMbps)); addFact(overview, 'Empfangen gesamt', formatBytes(wan.totalBytesReceived)); addFact(overview, 'Gesendet gesamt', formatBytes(wan.totalBytesSent)); data.append(overview);
  if (dsl.error || wan.error) { const error = node('div', 'fritzbox-router-error', `${wan.error ? `WAN-Fehler: ${valueText(wan.error)} ` : ''}${dsl.error ? `DSL-Fehler: ${valueText(dsl.error)}` : ''}`); data.append(error); }
  const hosts = Array.isArray(fritzbox.hosts) ? fritzbox.hosts : [];
  facts(data,[['Bekannte Geräte',hosts.length],['Aktive Geräte',hosts.filter(host=>host.active===true).length],['Geräte mit Internetzählern',(fritzbox.deviceTraffic||[]).filter(row=>row.available).length],['Mesh-Knoten',(mesh.nodes||[]).length]]);
  data.append(trafficHistoryButton());
  data=panel('connection');
  const cable=/cable/i.test(device.model||'');
  section(data, cable?'Kabelanschluss':'DSL-Daten', cable?'Verbindungswerte findest du in der Übersicht.':'Gemeldete Anschlusswerte.', cable?'DOCSIS-Kanäle, Kabelsignalpegel und Segmentauslastung werden durch die angebundene Schnittstelle nicht bereitgestellt.':'Rohwerte werden ohne angenommene Einheit angezeigt. Fehlerzähler sind kumulativ; ihr Anstieg im Verlauf ist aussagekräftiger als der Gesamtwert.');
  const dslGrid = node('div', 'fritzbox-facts dsl-facts'); const dslEntries = Object.entries(dsl).filter(([key, value]) => key !== 'error' && !sensitiveKey.test(key) && value !== null && value !== undefined && value !== '');
  if (dslEntries.length&&!cable) dslEntries.forEach(([key, value]) => addFact(dslGrid, humanLabel(key), value)); else if(!cable)dslGrid.append(node('div', 'fritzbox-empty', 'Keine DSL-Werte verfügbar.')); if(!cable)data.append(dslGrid);
  renderConnectionDetails(data,fritzbox.diagnostics);
  data=panel('wlan');
  section(data, 'WLAN der FRITZ!Box', 'Gemeldete Funknetze und verbundene Geräte.','Gemeldete Funknetze und verbundene Geräte. Ein fehlender Wert bleibt unbekannt.');
  renderWlan(data, fritzbox.wlan);
  data=panel('devices');renderRouterHosts(data,hosts,mesh);
  data=panel('mesh');
  const nodes = Array.isArray(mesh.nodes) ? mesh.nodes : []; const links = Array.isArray(mesh.links) ? mesh.links : [];
  section(data, 'Grafische Mesh-Topologie', 'Verbindungen laut Routermeldung.','Die Darstellung verbindet ausschließlich Endpunkte aus der Routermeldung. Geräte ohne gemeldete Zuordnung bleiben getrennt.');
  renderTopology(data, mesh, liveTopologyState);
  section(data, 'Mesh-Knoten', `${nodes.length} Knoten gemeldet`);
  if (nodes.length) data.append(table(['Name', 'Modell', 'IP-Adresse', 'Rolle'], nodes.map((item) => [item.name, item.model, item.ip, item.role]))); else data.append(node('div', 'fritzbox-empty', 'Keine Mesh-Knoten verfügbar.'));
  data=panel('traffic');
  section(data,'FRITZ!Box gesamt','Internetverkehr des gesamten Anschlusses, direkt aus der Box.');
  facts(data,[['Download',formatRate(wan.downloadMbps)],['Upload',formatRate(wan.uploadMbps)],['Empfangen (Zählerstand)',formatBytes(wan.totalBytesReceived)],['Gesendet (Zählerstand)',formatBytes(wan.totalBytesSent)]]);
  data.append(trafficHistoryButton());
  section(data, 'Internetverkehr je Gerät', 'Werte aus dem letzten gültigen Messintervall.','Gemessener Internetverkehr, sofern die Box Bytezähler liefert. Die Datenmenge gehört nur zum letzten gültigen Messintervall. Längere Zeiträume und auswählbare Kurven stehen unter Verlauf → Datenverkehr.');
  const traffic=Array.isArray(fritzbox.deviceTraffic)?fritzbox.deviceTraffic:[];
  if(traffic.length)data.append(table(['Gerät','Download','Upload','Letztes Intervall ↓ / ↑','Messzeit / Verfügbarkeit'],traffic.map(row=>{
    const valid=row.rateAvailable===true;
    const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?`${(value/1000000).toLocaleString('de-DE',{maximumFractionDigits:2})} MB`:'–';
    const period=valid&&row.intervalStartedAt&&row.at?`${new Date(row.intervalStartedAt).toLocaleTimeString('de-DE')}–${new Date(row.at).toLocaleTimeString('de-DE')}`:row.measurementReason||row.reason||'Noch keine zwei passenden Messungen';
    return [[row.name||'Unbenanntes Gerät',row.ip].filter(Boolean).join(' · '),formatRate(valid?row.downloadMbps:null),formatRate(valid?row.uploadMbps:null),valid?`${amount(row.downloadDeltaBytes)} / ${amount(row.uploadDeltaBytes)}`:'–',period];
  })));
  else data.append(node('p','fritzbox-empty',fritzbox.deviceTrafficCapability?.reason||'Die Box liefert derzeit keine Internet-Bytezähler einzelner Geräte.'));
  if(!traffic.some(row=>row.available)){const note=node('p','traffic-source-note','Keine Einzelgeräte-Zähler verfügbar.');note.title=note.dataset.help='Der Online-Monitor der FRITZ!Box unterstützt Einzelgeräte. Die Datenfreigabe an Apps hängt zusätzlich von FRITZ!OS und der Geräteerfassung der Box ab. Prüfe in der Box unter Internet → Online-Monitor die erfassten Geräte. Fehlende Zähler bleiben hier unbekannt.';data.append(note);}
  data=panel('mesh');
  section(data, 'Bekannte Mesh-Verbindungen');
  const meshName = id => nodes.find(item => item.id === id)?.name || id;
  if (links.length) data.append(table(['Von', 'Nach', 'Verbindung', 'Status', 'Linkrate RX (zu Von)', 'Linkrate TX (zu Nach)', 'Signal'], links.map((link) => [meshName(link.from), meshName(link.to), link.type, link.state === 'DISCONNECTED' ? 'Getrennt' : link.state === 'CONNECTED' ? 'Verbunden' : 'Unbekannt', formatRate(link.receiveRateMbps ?? link.rateMbps), formatRate(link.transmitRateMbps), link.signalPercent == null ? '–' : `${valueText(link.signalPercent)} %`]))); else data.append(node('div', 'fritzbox-empty', 'Keine Mesh-Verbindungen verfügbar.'));
  data=panel('system');
  facts(data,[['Modell',device.model],['FRITZ!OS',device.firmware],['Laufzeit',formatUptime(device.uptimeSeconds)],['Letzte erfolgreiche Abfrage',fritzbox.updatedAt?new Date(fritzbox.updatedAt).toLocaleString('de-DE'):null]]);
  if (Array.isArray(fritzbox.capabilities)) {
    const capabilities = node('details', 'fritzbox-capabilities'); capabilities.open = capabilitiesOpen;
    capabilities.append(node('summary', '', 'Verfügbare Routerfunktionen und Grenzen'));
    capabilities.append(table(['Dienst', 'Instanz', 'Funktion', 'Verfügbarkeit'], fritzbox.capabilities.map(item => [item.service, item.instance, item.action, item.available ? 'Verfügbar' : item.reason || 'Nicht verfügbar'])));
    capabilities.addEventListener('toggle', () => { capabilitiesOpen = capabilities.open; }); data.append(capabilities);
  }
  const warnings = [...(Array.isArray(fritzbox.warnings) ? fritzbox.warnings : []), ...(Array.isArray(mesh.warnings) ? mesh.warnings : [])];
  if (warnings.length) { section(data, 'Hinweise'); const list = node('ul', 'fritzbox-warnings'); warnings.forEach((warning) => list.append(node('li', '', typeof warning === 'string' ? warning : warning.message || warning.detail || valueText(warning)))); data.append(list); }
  section(data, 'Router-Ereignisprotokoll', 'Bis zu 20.000 Zeichen aus der aktuellen Routerabfrage.');
  const search=node('input');search.type='search';search.id='router-log-search';search.setAttribute('aria-label','Routerereignisse durchsuchen');search.placeholder='Ereignisse durchsuchen';search.value=logQuery;
  const log=node('pre','fritzbox-log');const filterLog=()=>{const lines=valueText(fritzbox.log).slice(0,20000).split('\n');log.textContent=lines.filter(line=>line.toLocaleLowerCase('de').includes(logQuery.toLocaleLowerCase('de'))).join('\n')||'Keine passenden Ereignisse.';};search.addEventListener('input',()=>{logQuery=search.value;filterLog();});filterLog();data.append(search,log);
}
let activePost = async () => { throw new Error('Routeraktion ist noch nicht bereit.'); };
let lastFritzboxState = null;
let localBusy = false;
let lastRenderFingerprint = null;
let monitoredTargets = [];
let currentRepeaterHost = null;
const liveTopologyState = {};
const historyTopologyState = {};
let historySnapshotKey = null;
let capabilitiesOpen = false;
function renderWlan(parent, radios) {
  if (!Array.isArray(radios) || !radios.length) { parent.append(node('p', 'fritzbox-empty', 'Keine WLAN-Funknetze von der Box gemeldet.')); return; }
  parent.append(table(['Funknetz / SSID', 'Band', 'Aktiv', 'Status', 'Kanal', 'Standard', 'Verbundene Geräte'], radios.map(radio => [radio.ssid, radio.frequencyBand, radio.enabled, radio.status, radio.channel === 0 ? 'Automatisch / unbekannt' : radio.channel, radio.standard, radio.associatedDevices])));
  section(parent,'WLAN-Details','Gastgeräte werden in der Geräteliste anhand der Routermeldung gekennzeichnet.');
  parent.append(table(['Funknetz','BSSID','Sicherheitsmodus','Verschlüsselung','MAC-Filter','Paketstatistik'],radios.map(radio=>[radio.ssid,radio.bssid,radio.beaconType,radio.basicEncryptionModes,radio.macFilterEnabled,radio.packetStats?.available?`${valueText(radio.packetStats.totalPacketsReceived)} RX / ${valueText(radio.packetStats.totalPacketsSent)} TX`:radio.packetStats?.reason||'Nicht gemeldet'])));
}
function render(payload) {
  const fritzbox = payload && Object.hasOwn(payload, 'fritzbox') ? payload.fritzbox : payload;
  if (payload && Object.hasOwn(payload, 'fritzbox')) { monitoredTargets = Array.isArray(payload.targets) ? payload.targets : []; currentRepeaterHost = payload.repeaterHost || null; }
  lastFritzboxState = fritzbox; renderStatus(fritzbox);
  $('#fritzbox-host').value = $('#fritzbox-host').value || fritzbox?.host || 'fritz.box';
  $('#fritzbox-updated').textContent = fritzbox?.updatedAt ? `Aktualisiert ${new Date(fritzbox.updatedAt).toLocaleString('de-DE')}` : 'Noch keine Routerdaten geladen';
  setMessage(fritzbox?.error || '', !!fritzbox?.error);
  const targetFingerprint = monitoredTargets.map(({ host, kind, enabled }) => [host, kind, enabled]);
  const fingerprint = JSON.stringify([fritzbox || null, targetFingerprint, currentRepeaterHost]); if (fingerprint === lastRenderFingerprint) return; lastRenderFingerprint = fingerprint;
  const focusedId = $('#fritzbox-data').contains(document.activeElement) ? document.activeElement.id : '';
  const selection = focusedId&&typeof document.activeElement.selectionStart==='number' ? [document.activeElement.selectionStart,document.activeElement.selectionEnd] : null;
  captureScroll($('#fritzbox-data'));
  renderDevice(fritzbox);
  restoreScroll($('#fritzbox-data'));
  if (focusedId) {const focused=document.getElementById(focusedId);focused?.focus({ preventScroll: true });if(selection&&focused?.setSelectionRange)focused.setSelectionRange(...selection);}
}
export function initFritzbox(post) {
  activePost = post;
  window.addEventListener('fritzbox-state', (event) => render(event.detail));
  $('#fritzbox-login').addEventListener('submit', async (event) => {
    event.preventDefault(); if (localBusy || lastFritzboxState?.connecting || lastFritzboxState?.busy) return;
    const host = $('#fritzbox-host').value.trim() || 'fritz.box'; const username = $('#fritzbox-username').value.trim(); let password = $('#fritzbox-password').value;
    localBusy = true; setMessage(''); renderStatus({ ...lastFritzboxState, connecting: true });
    try { await post('/api/fritzbox/connect', { host, username, password }); }
    catch (error) { const details = /401|403/.test(error.message) ? `Anmeldung abgelehnt oder fehlende Rechte. Prüfe Benutzerrechte und „Zugriff für Anwendungen zulassen“. ${error.message}` : /TR.?064|disabled|deaktiv/i.test(error.message) ? `Der FRITZ!Box-Zugriff für Anwendungen (TR-064) ist möglicherweise deaktiviert. ${error.message}` : error.message; setMessage(details, true); }
    finally { password = ''; $('#fritzbox-password').value = ''; localBusy = false; renderStatus(lastFritzboxState); }
  });
  $('#fritzbox-refresh').addEventListener('click', async () => { if (localBusy || !lastFritzboxState?.connected || lastFritzboxState?.busy) return; localBusy = true; renderStatus({ ...lastFritzboxState, busy: true }); try { await post('/api/fritzbox/refresh', {}); setMessage(''); } catch (error) { setMessage(error.message, true); } finally { localBusy = false; renderStatus(lastFritzboxState); } });
  $('#fritzbox-disconnect').addEventListener('click', async () => { if (localBusy || !lastFritzboxState?.connected || lastFritzboxState?.busy) return; localBusy = true; renderStatus({ ...lastFritzboxState, busy: true }); try { await post('/api/fritzbox/disconnect', {}); setMessage(''); } catch (error) { setMessage(error.message, true); } finally { localBusy = false; renderStatus(lastFritzboxState); } });
  window.addEventListener('fritzbox-action-error', (event) => setMessage(event.detail || 'Routeraktion fehlgeschlagen.', true));
}

function appendCell(row, text, header = false) { const cell = document.createElement(header ? 'th' : 'td'); cell.textContent = valueText(text); row.append(cell); }
function historicalChart(parent, records) {
  let previousSession = null; let previousUptime = null; let sessionNumber = 0;
  const points = records.map((record, index) => {
    const previous = records[index - 1]; const elapsed = previous ? (new Date(record.at) - new Date(previous.at)) / 1000 : 0;
    const host = String(record.host || ''); const device = record.device && typeof record.device === 'object' ? record.device : {};
    const explicitSession = record.sessionId ?? record.epoch ?? device.sessionId ?? '';
    const baseSession = `${host}|${device.model || ''}|${device.firmware || ''}|${explicitSession}`;
    const uptimeValue = device.uptimeSeconds ?? record.uptimeSeconds; const uptime = isNumeric(uptimeValue) ? Number(uptimeValue) : null;
    if (index === 0 || baseSession !== previousSession || (uptime !== null && previousUptime !== null && uptime < previousUptime)) sessionNumber += 1;
    const session = `${baseSession}#${sessionNumber}`;
    const sameSession = !!host && !!previous?.host && host === String(previous.host) && previousSession === baseSession && session === `${baseSession}#${sessionNumber}` && uptime !== null && previousUptime !== null && uptime >= previousUptime;
    const counterRate = (current, old) => isNumeric(current) && isNumeric(old) && sameSession && elapsed > 0 && elapsed <= 90 && Number(current) >= Number(old) ? (Number(current) - Number(old)) * 8 / elapsed / 1000000 : null;
    const directRate = (value) => isNumeric(value) ? Number(value) : null;
    const point = { at: record.at, session, down: directRate(record.wan?.downloadMbps) ?? counterRate(record.wan?.totalBytesReceived, previous?.wan?.totalBytesReceived), up: directRate(record.wan?.uploadMbps) ?? counterRate(record.wan?.totalBytesSent, previous?.wan?.totalBytesSent) };
    previousSession = baseSession; previousUptime = uptime;
    return point;
  }).filter((point) => Number.isFinite(new Date(point.at).getTime()));
  if (!points.some((point) => isNumeric(point.down) || isNumeric(point.up))) { parent.append(node('div', 'history-empty', 'Keine Router-Durchsatzwerte im Zeitraum gespeichert.')); return; }
  const W = 1000, H = 330, pad = { l: 72, r: 24, t: 22, b: 55 }; const times = points.map((point) => new Date(point.at).getTime()); let minT = Math.min(...times), maxT = Math.max(...times); if (maxT - minT < 60000) { const mid = (minT + maxT) / 2; minT = mid - 30000; maxT = mid + 30000; }
  const values = points.flatMap((point) => [point.down, point.up]).filter(isNumeric).map(Number); const maxV = Math.max(1, ...values) * 1.12;
  const x = (time) => pad.l + (time - minT) / (maxT - minT) * (W - pad.l - pad.r); const y = (value) => H - pad.b - Number(value) / maxV * (H - pad.t - pad.b);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'FRITZ!Box WAN Durchsatz im Verlauf');
  [0, .5, 1].forEach((f) => { const py = pad.t + f * (H - pad.t - pad.b); const line = document.createElementNS(svg.namespaceURI, 'line'); line.setAttribute('x1', pad.l); line.setAttribute('x2', W - pad.r); line.setAttribute('y1', py); line.setAttribute('y2', py); line.setAttribute('class', 'history-grid'); svg.append(line); const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', pad.l - 10); label.setAttribute('y', py + 5); label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'history-axis-label'); label.textContent = `${((1 - f) * maxV).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mbit/s`; svg.append(label); });
  [0, .5, 1].forEach((f) => { const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', pad.l + f * (W - pad.l - pad.r)); label.setAttribute('y', H - 18); label.setAttribute('text-anchor', f === 0 ? 'start' : f === 1 ? 'end' : 'middle'); label.setAttribute('class', 'history-axis-label'); label.textContent = new Date(minT + f * (maxT - minT)).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); svg.append(label); });
  [['WAN-Download', 'down', 'var(--series-primary)'], ['WAN-Upload', 'up', 'var(--series-secondary)']].forEach(([name, key, color]) => { let segment = []; let previousAt = null; let previousSessionKey = null; const draw = () => { if (segment.length > 1) { const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', segment.map((p) => `${p.x},${p.y}`).join(' ')); line.setAttribute('class', 'history-line'); line.setAttribute('stroke', color); svg.append(line); } segment = []; };
    points.forEach((point) => { const time = new Date(point.at).getTime(); const value = point[key]; if (!isNumeric(value)) { draw(); previousAt = time; previousSessionKey = point.session; return; } if (previousAt != null && (time - previousAt > 90000 || point.session !== previousSessionKey)) draw(); segment.push({ x: x(time), y: y(value) }); previousAt = time; previousSessionKey = point.session; }); draw(); });
  if (points.length === 1) [['down', 'var(--series-primary)'], ['up', 'var(--series-secondary)']].forEach(([key, color]) => { if (!isNumeric(points[0][key])) return; const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', x(new Date(points[0].at).getTime())); dot.setAttribute('cy', y(points[0][key])); dot.setAttribute('r', '6'); dot.setAttribute('fill', color); svg.append(dot); });
  parent.append(svg); const legend = node('div', 'history-legend'); [['WAN-Download', 'var(--series-primary)'], ['WAN-Upload', 'var(--series-secondary)']].forEach(([label, color]) => { const entry = node('span'); const dot = node('i'); dot.style.backgroundColor = color; entry.append(dot, document.createTextNode(label)); legend.append(entry); }); parent.append(legend); parent.append(node('p', 'chart-note', 'Zeitachse zeigt vorhandene Routermessungen; lange Messpausen sind unterbrochen.'));
}
export function renderFritzboxHistory(view, records) {
  const history = [...records].sort((a, b) => new Date(a.at) - new Date(b.at)); const latest = history.at(-1);
  section(view, 'FRITZ!Box-Daten');
  if (!history.length) { view.append(node('div', 'history-empty', 'Keine FRITZ!Box-Messungen im gewählten Zeitraum.')); return; }
  section(view, 'Mesh-Topologie im Verlauf', 'Wähle einen gespeicherten Messzeitpunkt.','Gespeicherte Routermeldungen auswählen. Ältere Messungen ohne Graphdaten können nicht rekonstruiert werden.');
  const snapshots = history.filter(record => Array.isArray(record.mesh?.nodes));
  if (snapshots.length) {
    const key = record => `${record.sessionId || ''}|${record.host || ''}|${record.at}`;
    const selected = snapshots.find(record => key(record) === historySnapshotKey) || snapshots.at(-1); historySnapshotKey = key(selected);
    const control = node('label', 'mesh-history-control'); control.append(node('span', '', 'Router-Snapshot'));
    const select = node('select'); select.id = 'mesh-history-snapshot'; snapshots.slice().reverse().forEach(record => { const option = node('option', '', `${new Date(record.at).toLocaleString('de-DE')} · ${record.mesh.nodes.length} Knoten`); option.value = key(record); select.append(option); }); select.value = historySnapshotKey; control.append(select); view.append(control);
    const graph = node('div'); view.append(graph);
    const show = record => {
      graph.replaceChildren(); renderTopology(graph, record.mesh, historyTopologyState, 'history'); section(graph, 'WLAN in diesem Snapshot'); renderWlan(graph, record.wlan);
      if(Array.isArray(record.hosts)){
        section(graph,'Geräte in diesem Snapshot','Diese Geräteinformationen gelten für den ausgewählten Messzeitpunkt.');
        graph.append(table(['Gerät','IP','Aktiv','Gastnetz','Internetzugang','Linkrate'],record.hosts.map(host=>[host.name,host.ip,host.active,host.guest,host.wanAccess,formatRate(host.linkRateMbps)])));
        if(record.hostsTruncated)graph.append(node('p','traffic-source-note','Die gespeicherte Geräteliste wurde wegen der maximalen Snapshot-Größe gekürzt.'));
      }
      if(record.diagnostics)renderConnectionDetails(graph,record.diagnostics);
    };
    show(selected); select.addEventListener('change', () => { const record = snapshots.find(item => key(item) === select.value); if (record) { historySnapshotKey = select.value; show(record); } });
  } else view.append(node('p', 'history-empty', 'Diese älteren Routermessungen enthalten keine gespeicherten Mesh-Knoten und Verbindungen. Neue Messungen speichern die Topologie.'));
  const metrics = node('div', 'history-metrics'); metrics.append(node('article', 'history-metric')); const nodes = [
    ['Snapshots', history.length], ['WAN-Status', latest.wan?.status], ['Geräte (letzter Snapshot)', latest.hostCount], ['Aktive Geräte', latest.activeHostCount], ['Mesh-Knoten', latest.meshNodes]
  ];
  metrics.replaceChildren(); nodes.forEach(([label, value]) => { const card = node('article', 'history-metric'); card.append(node('span', '', label), node('strong', '', valueText(value))); metrics.append(card); }); view.append(metrics);
  const chart = node('div', 'history-chart'); historicalChart(chart, history); view.append(chart);
  const rows = history.slice().reverse().map((record) => [new Date(record.at).toLocaleString('de-DE'), record.wan?.status, formatRate(record.wan?.downloadMbps), formatRate(record.wan?.uploadMbps), formatRate(record.wan?.downstreamMbps), formatRate(record.wan?.upstreamMbps), record.dsl?.status, record.dsl?.error || record.wan?.error || '–']);
  section(view, 'WAN-/DSL-Status und gemeldete Fehler', 'Durchsatzwerte sind Messwerte; Anschlussraten werden getrennt ausgewiesen.'); view.append(table(['Zeit', 'WAN', 'Download gemessen', 'Upload gemessen', 'Anschluss Downstream', 'Anschluss Upstream', 'DSL', 'Fehler'], rows));
  const dslKeys = [...new Set(history.flatMap((record) => Object.keys(record.dsl && typeof record.dsl === 'object' ? record.dsl : {}).filter((key) => !sensitiveKey.test(key))))];
  section(view, 'Gespeicherte DSL-Felder', 'Feldbezeichnungen werden lesbar dargestellt; sensible Felder werden ausgelassen.');
  if (dslKeys.length) { const dslRows = history.slice().reverse().map((record) => [new Date(record.at).toLocaleString('de-DE'), ...dslKeys.map((key) => valueText(record.dsl?.[key]))]); view.append(table(['Zeit', ...dslKeys.map(humanLabel)], dslRows)); } else view.append(node('div', 'history-empty', 'Keine DSL-Felder gespeichert.'));
  const transitions = []; let previous = null;
  history.forEach((record) => { const status = record.wan?.status; if (status == null || status === '') return; if (previous && String(previous.status) !== String(status)) transitions.push([new Date(record.at).toLocaleString('de-DE'), previous.status, status]); previous = { status }; });
  section(view, 'Beobachtete WAN-Statuswechsel', 'Unbekannte oder fehlende Statuswerte werden nicht als Abbruch gewertet.');
  if (transitions.length) view.append(table(['Zeit', 'Vorher', 'Danach'], transitions.reverse())); else view.append(node('div', 'history-empty', 'Keine Statuswechsel bei gemeldeten WAN-Statuswerten.'));
}
