import { renderOverviewDetails } from './overview-details.js';
import { renderLiveSignal } from './live-signal.js';
import { setMeasurement, initPresentation } from './ui-presentation.js';
import { initFritzbox, renderFritzboxHistory } from './fritzbox.js';
import { initAi } from './ai.js';
import { initStorage, renderStorage } from './storage.js';
import { trafficSources } from './traffic-history.js';
import { renderOverview } from './overview.js';
import { renderAdapterHealth, renderHealthHistory, renderNetworkChanges } from './network-health.js';
import { captureScroll, restoreScroll, clearScroll } from './scroll-state.js';
import { renderSpeed, initSpeedOptions, selectedSpeedOptions } from './speedtest-ui.js';
import { renderStress, formatLoadBytes, formatLoadTime } from './stress-test-ui.js';
import { initNavigation } from './navigation.js';
import { initGames } from './games.js';
import { initLagHotkey } from './lag-hotkey.js';
import { summarizeSpeedHistory } from './speed-history.js';
import { resolvePingSelection, togglePingSelection, selectPingTarget, pingTargetColor, pingTargetDash, createHistoryRequestGate, mergeHistoryRecords } from './history-selection.js';
import { jitterFor, summarizePingHistory } from './ping-statistics.js';
import { renderPingChart, niceAxisTicks } from './ping-chart.js';
import { createLagPhaseSection } from './lag-incidents.js';

const $ = (selector) => document.querySelector(selector);
const apiToken = document.querySelector('meta[name="api-token"]')?.content || '';
const state = { value: null, generation: 0, busy: new Set(), error: '', pollTimer: null, toastTimer: null, history: { records: [], hours: 1, tab: 'connection', pingHosts: null, pingTargets: new Map(), pingJitter: false, requestGate: createHistoryRequestGate(), loaded: false, loading: false, truncated: false, retentionDays: 7, error: '', updatedAt: null } };
const navigation = initNavigation({ onChange: page => { setText('#page-title', page.title); setText('.intro', page.intro); restoreScroll($('#page-'+page.id));for(const id of ['history-view','fritzbox-data','session-list'])restoreScroll($('#'+id)); if(page.id==='history')queueMicrotask(()=>loadHistory()); } });

function setText(selector, value) { const el = $(selector); if (el) { if (el.matches('.summary-value, .traffic-readings strong')) setMeasurement(el, value, ['#download-value','#upload-value'].includes(selector) ? 'Mbit/s' : ''); else { const text = value == null || value === '' ? '–' : String(value); if (el.textContent !== text) el.textContent = text; } } }
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = String(text); return node; }
function numeric(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)); }
function fmt(value, digits = 1) { return numeric(value) ? Number(value).toLocaleString('de-DE', { maximumFractionDigits: digits }) : '–'; }
function rate(value) { return numeric(value) ? `${fmt(value, 1)} Mbit/s` : '–'; }
function date(value) { if (!value) return '–'; const d = new Date(value); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function safeArray(value) { return Array.isArray(value) ? value : []; }
function shouldRenderChanged(root, value) {
  const signature = JSON.stringify(value);
  if (root.dataset.renderSignature === signature) return false;
  root.dataset.renderSignature = signature;
  return true;
}
function setBusy(key, busy) { if (busy) state.busy.add(key); else state.busy.delete(key); syncControls(); }
function syncControls() {
  const loaded = !!state.value;
  $('#export-btn').disabled = !loaded || state.busy.has('export');
  $('#shutdown-btn').disabled = !loaded || state.busy.has('shutdown');
  $('#monitor-btn').disabled = !loaded || state.busy.has('monitor');
  const resetBlocked = !!state.value?.scan?.running || !!state.value?.speedTest?.running || !!state.value?.stressTest?.running || !!state.value?.fritzbox?.connecting;
  $('#reset-btn').disabled = !loaded || state.busy.size > 0 || resetBlocked;
  $('#reset-btn').textContent = state.busy.has('reset') ? 'Wird zurückgesetzt …' : 'Reset · ab jetzt';
  $('#reset-btn').title = resetBlocked ? 'Laufenden Test oder Scan zuerst beenden bzw. Router-Anmeldung abwarten.' : 'Alle Messwerte und Verläufe ab jetzt neu beginnen. Ziele und alte Rohprotokolle bleiben erhalten.';
  $('#target-form button').disabled = !loaded || state.busy.has('target-add');
  $('#repeater-form button').disabled = !loaded || state.busy.has('repeater') || !$('#repeater-host').value.trim();
  $('#pc-repeater').disabled = !loaded || state.busy.has('primary') || state.busy.has('repeater');
  $('#history-mark').disabled = state.busy.has('history-mark');
  const scanning = !!state.value?.scan?.running;
  $('#scan-btn').disabled = !loaded || scanning || state.busy.has('scan') || !selectedInterface();
  $('#interface-select').disabled = !loaded || scanning || !safeArray(state.value?.network?.interfaces).length || state.busy.has('interface');
  const testBlocked = !loaded || state.busy.has('speedtest') || state.busy.has('stress-start') || state.busy.has('stress-stop') || state.busy.has('reset') || !!state.value?.speedTest?.running || !!state.value?.stressTest?.running;
  for (const id of ['speed-btn', 'speed-download-size', 'speed-upload-size', 'stress-start', 'stress-mode', 'stress-duration']) $(`#${id}`).disabled = testBlocked;
  $('#stress-stop').disabled = !state.value?.stressTest?.running || state.busy.has('stress-stop') || !!state.value?.stressTest?.stopping;
  $('#target-host').disabled = state.busy.has('target-add');
  $('#target-label').disabled = state.busy.has('target-add');
}
function selectedInterface() {
  const s = state.value;
  const id = s?.selectedInterfaceId || s?.network?.defaultInterfaceId || $('#interface-select')?.value;
  return safeArray(s?.network?.interfaces).find((item) => item.id === id) || safeArray(s?.network?.interfaces)[0] || null;
}
async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== 'GET') { headers.set('Content-Type', 'application/json'); headers.set('X-Api-Token', apiToken); }
  const response = await fetch(path, { ...options, headers, cache: 'no-store' });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let message = `Anfrage fehlgeschlagen (${response.status})`;
    if (contentType.includes('json')) { const data = await response.json().catch(() => ({})); if (data?.error) message = data.error; }
    throw new Error(message);
  }
  return contentType.includes('json') ? response.json() : response;
}
async function post(path, body) { return request(path, { method: 'POST', body: JSON.stringify(body) }); }
function showToast(message, error = false) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.toggle('is-error', error); toast.classList.add('visible');
  clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3800);
}
function setGlobalError(message) { state.error = message || ''; const box = $('#global-error'); box.hidden = !state.error; box.textContent = state.error; }
function pill(elementId, text, level) { const el = $(elementId); el.textContent = text; el.className = `pill pill-${level || 'muted'}`; }

function renderConnection(s) {
  const running = !!s.monitoring; $('#monitor-indicator').className = `status-dot ${running ? 'is-on' : ''}`;
  setText('#monitor-text', running ? 'Überwachung aktiv' : 'Überwachung pausiert');
  setText('#measurement-start', s.measurementStartedAt ? `Neue Messung seit ${historyTime(s.measurementStartedAt)}` : 'Noch keine Messung gestartet.');
  const reset = $('#reset-btn'); if (reset) reset.title = 'Alle Messwerte und Verläufe ab jetzt neu starten.';
  $('#monitor-btn').textContent = running ? 'Überwachung stoppen' : 'Überwachung starten';
  const conn = $('#connection-state'); conn.className = 'connection online'; conn.querySelector('span').textContent = 'Lokal verbunden';
  const intf = selectedInterface();
  const gatewayTarget = safeArray(s.targets).find((target) => target.kind === 'gateway');
  const internetTarget = safeArray(s.targets).find((target) => target.kind === 'internet');
  const gt = gatewayTarget?.stats; const it = internetTarget?.stats;
  setText('#router-value', intf?.gateway || '–'); setText('#router-detail', intf ? `${intf.name || intf.description || intf.kind || 'Schnittstelle'} · ${safeArray(intf.ipv4).map((ip) => ip.address).join(', ') || 'keine IPv4-Adresse'}` : 'Keine Schnittstelle ausgewählt');
  pill('#router-status', gt ? statusLabel(gt.status) : 'Noch nicht gemessen', gt ? statusLevel(gt.status) : 'muted');
  setText('#download-value', fmt(s.traffic?.downloadMbps)); setText('#upload-value', fmt(s.traffic?.uploadMbps)); setText('#traffic-interface', intf?.name || intf?.description || intf?.id || 'Schnittstelle auswählen');
}
function statusLabel(value) { return ({ ok: 'Erreichbar', warning: 'Auffällig', critical: 'Kritisch', down: 'Keine Ping-Antwort', pending: 'Warte auf Messung' })[value] || 'Unbekannt'; }
function statusLevel(value) { return ({ ok: 'good', warning: 'warn', critical: 'bad', down: 'bad', pending: 'muted' })[value] || 'muted'; }
function renderInterfaces(s) {
  const list = safeArray(s.network?.interfaces); const select = $('#interface-select'); const wanted = s.selectedInterfaceId || s.network?.defaultInterfaceId || '';
  const fingerprint = JSON.stringify(list.map(item => [item.id, item.name, item.description, item.kind, item.status]));
  if (select.dataset.fingerprint !== fingerprint) {
    select.replaceChildren();
    if (!list.length) { const o = element('option', '', 'Keine Schnittstellen gefunden'); o.value = ''; select.append(o); }
    else list.forEach((item) => { const o = element('option', '', `${item.name || item.description || item.kind || 'Schnittstelle'}${item.status ? ` · ${item.status}` : ''}`); o.value = item.id; select.append(o); });
    select.dataset.fingerprint = fingerprint;
  }
  select.value = list.some((item) => item.id === wanted) ? wanted : list[0]?.id || '';
  const intf = selectedInterface();
  pill('#interface-status', intf?.status || 'Nicht verbunden', intf?.status === 'Up' || intf?.status === 'up' ? 'good' : intf ? 'muted' : 'bad');
  setText('#interface-ip', intf ? safeArray(intf.ipv4).map((ip) => `${ip.address}/${ip.prefixLength}`).join(', ') || 'Keine IPv4-Adresse' : '–');
  setText('#interface-gateway', intf?.gateway || '–'); setText('#interface-dns', safeArray(intf?.dns).join(', ') || '–');
  setText('#interface-link', intf ? `${intf.linkSpeedMbps ? `${fmt(intf.linkSpeedMbps, 0)} Mbit/s · ` : ''}${intf.kind || intf.status || 'Verbunden'}` : '–');
  const dnsStatus = $('#dns-status'); const dns = s.dns;
  dnsStatus.textContent = dns?.ok === true ? `Auflösung erfolgreich${numeric(dns.ms) ? ` · ${fmt(dns.ms)} ms` : ''}${dns.at ? ` · ${date(dns.at)}` : ''}` : dns?.ok === false ? `Auflösung fehlgeschlagen${dns.error ? ` · ${dns.error}` : ''}${dns.at ? ` · ${date(dns.at)}` : ''}` : 'Keine DNS-Auflösung gemessen';
  dnsStatus.className = `dns-status ${dns?.ok === true ? 'dns-ok' : dns?.ok === false ? 'dns-error' : ''}`;
  setText('#tests-dns-status', dnsStatus.textContent);
  const warningRoot = $('#network-warnings'); warningRoot.replaceChildren(); const warnings = safeArray(s.network?.warnings);
  warningRoot.hidden = warnings.length === 0;
  warnings.forEach((warning) => warningRoot.append(element('p', 'network-warning', typeof warning === 'string' ? warning : warning?.message || warning?.detail || warning?.title || 'Netzwerkhinweis')));
}
function renderTargets(s) {
  const root = $('#targets-list'); const targets = safeArray(s.targets); $('#target-count').textContent = `${targets.length} ${targets.length === 1 ? 'Ziel' : 'Ziele'}`;
  const existing = new Map([...root.querySelectorAll('.target-card[data-target-id]')].map((card) => [card.dataset.targetId, card]));
  if (!targets.length) { root.replaceChildren(element('div', 'empty-state', 'Noch keine Ziele verfügbar.')); return; }
  const nextCards = [];
  targets.forEach((target) => {
    let card = existing.get(String(target.id));
    if (!card) card = createTargetCard(target);
    card._targetUi.target = target;
    const { name, status, host, stats, toggle, trace, history, remove } = card._targetUi;
    const targetStatus = !target.enabled ? 'Pausiert' : target.lastError ? 'Messfehler' : statusLabel(target.stats?.status);
    name.textContent = target.label || target.host || 'Ziel'; status.textContent = targetStatus; status.className = `pill pill-${!target.enabled ? 'muted' : target.lastError ? 'warn' : statusLevel(target.stats?.status)}`;
    host.textContent = `${target.host || ''}${target.kind ? ` · ${kindLabel(target.kind)}` : ''}${target.kind==='repeater'&&target.host===s.repeaterHost?' · PC-Anschluss':''}${target.lastError ? ` · ${target.lastError}` : ''}`;
    [['Ø Latenz', target.stats?.avgMs == null ? '–' : `${fmt(target.stats.avgMs)} ms`], ['Jitter', target.stats?.jitterMs == null ? '–' : `${fmt(target.stats.jitterMs)} ms`], ['Verlust', target.stats?.lossPercent == null ? '–' : `${fmt(target.stats.lossPercent)} %`], ['Zuletzt', target.stats?.lastMs == null ? '–' : `${fmt(target.stats.lastMs)} ms`]].forEach(([label, value], i) => { stats.children[i].lastElementChild.textContent = value; });
    toggle.textContent = target.enabled ? 'Ⅱ' : '▶'; toggle.title = target.enabled ? 'Messung für dieses Ziel pausieren' : 'Messung für dieses Ziel aktivieren'; toggle.setAttribute('aria-label', `${toggle.title}: ${target.label || target.host}`); toggle.classList.toggle('danger-button', !target.enabled); toggle.disabled = state.busy.has(`toggle:${target.id}`);
    trace.setAttribute('aria-label', `Route zu ${target.host} verfolgen`); trace.title = `Route zu ${target.host} verfolgen`;
    history.setAttribute('aria-label', `Verlauf für ${target.label || target.host || 'Ziel'} öffnen`);
    if (remove) { remove.title = `${target.label || target.host} entfernen`; remove.setAttribute('aria-label', `${target.label || target.host} entfernen`); remove.disabled = state.busy.has(`remove:${target.id}`); }
    nextCards.push(card);
  });
  nextCards.forEach((card, index) => { if (root.children[index] !== card) root.insertBefore(card, root.children[index] || null); });
  while (root.children.length > nextCards.length) root.lastElementChild.remove();
}
function createTargetCard(target) {
  const card = element('article', 'target-card'); card.dataset.targetId = String(target.id);
  const main = element('div', 'target-main'); const nameRow = element('div', 'target-name-row'); const name = element('strong', 'target-name'); const status = element('span', 'pill pill-muted'); nameRow.append(name, status); const host = element('span', 'target-host'); main.append(nameRow, host);
  const stats = element('div', 'target-stats'); [['Ø Latenz', 'avgMs'], ['Jitter', 'jitterMs'], ['Verlust', 'lossPercent'], ['Zuletzt', 'lastMs']].forEach(([label]) => { const metric = element('div', 'metric'); metric.append(element('span', '', label), element('strong', '', '–')); stats.append(metric); });
  const actions = element('div', 'target-actions');
  const toggle = element('button', 'icon-button small', 'Ⅱ'); toggle.type = 'button'; toggle.addEventListener('click', () => { const current = card._targetUi.target; runAction(`toggle:${current.id}`, '/api/targets/toggle', { id: current.id, enabled: !current.enabled }, current.enabled ? 'Zielmessung pausiert.' : 'Zielmessung aktiviert.'); }); actions.append(toggle);
  const trace = element('button', 'button button-quiet target-action-button', 'Route'); trace.type = 'button'; trace.addEventListener('click', () => runTrace(card._targetUi.target)); actions.append(trace);
  const history = element('button', 'button button-quiet target-action-button target-history-button', 'Verlauf'); history.type = 'button'; history.addEventListener('click', () => openTargetHistory(card._targetUi.target.host)); actions.append(history);
  let remove = null;
  if (target.kind === 'custom' || target.kind === 'device' || target.kind === 'repeater') { remove = element('button', 'button button-quiet target-action-button danger-button target-remove-button', 'Entfernen'); remove.type = 'button'; remove.addEventListener('click', () => removeTarget(card._targetUi.target)); actions.append(remove); }
  card._targetUi = { target, name, status, host, stats, toggle, trace, history, remove };
  card.append(main, stats, actions); return card;
}
function openTargetHistory(host) {
  navigation.navigate('history');
  state.history.pingHosts = selectPingTarget(String(host || '')); setHistoryTab('connection');
  $('#history-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadHistory(true).then(() => { $('#history-ping-target')?.querySelector('input:checked')?.focus({ preventScroll: true }); });
}
function kindLabel(kind) { return ({ gateway: 'Gateway', repeater: 'Mesh-Repeater', internet: 'Internet', device: 'Gerät', custom: 'Eigenes Ziel' })[kind] || kind; }
function renderRepeaterConnection(s) {
  const repeaters=safeArray(s.targets).filter(target=>target.kind==='repeater');
  const select=$('#pc-repeater');const fingerprint=JSON.stringify(repeaters.map(({host,label,enabled})=>[host,label,enabled]));
  if(select.dataset.fingerprint!==fingerprint){
    select.replaceChildren();const unknown=element('option','','Nicht zugeordnet / PC direkt am Router');unknown.value='';select.append(unknown);
    repeaters.forEach(target=>{const option=element('option','',`${target.label || 'Repeater'} (${target.host})${target.enabled?'':' · pausiert'}`);option.value=target.host;select.append(option);});
    select.dataset.fingerprint=fingerprint;
  }
  const primary=repeaters.find(target=>target.host===s.repeaterHost);if(!state.busy.has('primary'))select.value=primary?.host||'';
  setText('#route-title',primary?'Zugeordneter Messpfad: Repeater am PC':'PC-Anschluss noch nicht zugeordnet');
  setText('#route-path',primary?`PC → ${primary.label || primary.host} (${primary.host}) → Router → Internet`:'Repeater am PC unter „Geräte & Repeater“ auswählen');
  setText('#route-detail',primary?`${primary.enabled?'':'Dieser Repeater ist pausiert. '}Der Uplink kann WLAN oder LAN sein.`:'Repeater werden unabhängig gemessen.');
  const routeInfo = $('#route-info'); if (routeInfo) routeInfo.dataset.help = `${primary?.enabled === false ? 'Dieser Repeater ist pausiert. ' : ''}Alle Repeater werden unabhängig gemessen. Ihre Verbindung untereinander wird aus Ping-Werten nicht abgeleitet. Die Windows-Linkrate misst nur den PC-Anschluss.`;
}
function renderChart(s) {
  const svg = $('#latency-chart'); svg.replaceChildren();
  const target = safeArray(s.targets).find((item) => item.kind === 'internet' && item.enabled) || safeArray(s.targets).find((item) => item.enabled);
  const targetName = target ? `Ziel: ${target.label || target.host}` : 'Kein aktives Messziel';
  svg.setAttribute('aria-label', `Latenzverlauf für ${targetName}.`);
  setText('#chart-note', target ? (target.label || target.host) : 'Kein aktives Messziel');
  const samples = safeArray(target?.samples).slice(-50); const W = svg.clientWidth || 900; const H = svg.clientHeight || 190; const pad = { l: 58, r: 10, t: 14, b: 24 };
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (!samples.length) { setText('#timeline-range', 'Warte auf neue Messwerte'); const t = document.createElementNS('http://www.w3.org/2000/svg', 'text'); t.setAttribute('x', W / 2); t.setAttribute('y', H / 2); t.setAttribute('text-anchor', 'middle'); t.setAttribute('class', 'chart-empty'); t.textContent = s.monitoring ? 'Warte auf erste Messung' : 'Warte auf Messwerte'; svg.append(t); return; }
  const values = samples.filter((x) => x.ok && numeric(x.ms)).map((x) => Number(x.ms)); const ticks = niceAxisTicks(Math.max(30, ...values)); const max = ticks.at(-1) || 30;
  const y = (v) => H - pad.b - Math.max(0, Math.min(1, v / max)) * (H - pad.t - pad.b);
  ticks.forEach((tick) => { const py = y(tick); const line = document.createElementNS(svg.namespaceURI, 'line'); line.setAttribute('x1', pad.l); line.setAttribute('x2', W - pad.r); line.setAttribute('y1', py); line.setAttribute('y2', py); line.setAttribute('class', 'chart-grid'); line.setAttribute('style', 'stroke:#24282C;stroke-width:1;stroke-dasharray:none'); svg.append(line); const label = document.createElementNS(svg.namespaceURI, 'text'); label.setAttribute('x', pad.l - 8); label.setAttribute('y', py + 4); label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'chart-label'); label.textContent = `${fmt(tick, 0)} ms`; svg.append(label); });
  const thresholdY = y(30); const threshold = document.createElementNS(svg.namespaceURI, 'line'); threshold.setAttribute('x1', pad.l); threshold.setAttribute('x2', W - pad.r); threshold.setAttribute('y1', thresholdY); threshold.setAttribute('y2', thresholdY); threshold.setAttribute('class', 'chart-threshold'); threshold.setAttribute('style', 'stroke:var(--orange,#E0A84A);stroke-width:1;stroke-dasharray:5 4'); threshold.setAttribute('aria-label', '30 ms Schwelle'); svg.append(threshold); const thresholdLabel = document.createElementNS(svg.namespaceURI, 'text'); thresholdLabel.setAttribute('x', W - pad.r); thresholdLabel.setAttribute('y', thresholdY - 5); thresholdLabel.setAttribute('text-anchor', 'end'); thresholdLabel.setAttribute('class', 'chart-threshold-label'); thresholdLabel.setAttribute('style', 'fill:var(--orange,#E0A84A)'); thresholdLabel.textContent = '30 ms'; svg.append(thresholdLabel);
  const x = (i) => pad.l + (samples.length === 1 ? (W - pad.l - pad.r) / 2 : i * (W - pad.l - pad.r) / (samples.length - 1));
  let segment = [];
  const flush = () => { if (segment.length > 1) { const points = segment.map((p) => `${p.x},${p.y}`).join(' '); const area = document.createElementNS(svg.namespaceURI, 'polygon'); area.setAttribute('points', `${segment[0].x},${H - pad.b} ${points} ${segment.at(-1).x},${H - pad.b}`); area.setAttribute('class', 'latency-area'); area.setAttribute('style', 'fill:var(--turquoise,var(--accent,#3FC1B0));fill-opacity:.08;stroke:none'); svg.append(area); const line = document.createElementNS(svg.namespaceURI, 'polyline'); line.setAttribute('points', points); line.setAttribute('class', 'latency-line'); line.setAttribute('style', 'stroke:var(--turquoise,var(--accent,#3FC1B0));stroke-width:1.5px;fill:none'); svg.append(line); } segment = []; };
  samples.forEach((sample, i) => {
    if (sample.ok && numeric(sample.ms)) { const point = { x: x(i), y: y(Number(sample.ms)) }; segment.push(point); const dot = document.createElementNS(svg.namespaceURI, 'circle'); dot.setAttribute('cx', point.x); dot.setAttribute('cy', point.y); dot.setAttribute('r', samples.length > 35 ? '2.5' : '4'); dot.setAttribute('class', 'latency-point'); dot.setAttribute('aria-label', `${date(sample.at)}: ${fmt(sample.ms)} ms`); svg.append(dot); }
    else {
      flush(); const lx = x(i);
      if (sample.status === 'measurement_error') { const gap = document.createElementNS(svg.namespaceURI, 'circle'); gap.setAttribute('cx', lx); gap.setAttribute('cy', H - pad.b + 5); gap.setAttribute('r', '2.5'); gap.setAttribute('class', 'measurement-gap'); gap.setAttribute('aria-label', 'Messfehler'); svg.append(gap); }
      else { const loss = document.createElementNS(svg.namespaceURI, 'circle'); loss.setAttribute('cx', lx); loss.setAttribute('cy', H - pad.b + 3); loss.setAttribute('r', '2.5'); loss.setAttribute('class', 'loss-mark'); loss.setAttribute('style', 'fill:var(--red,#E06A5F)'); loss.setAttribute('aria-label', 'Paketverlust'); svg.append(loss); }
    }
  }); flush();
  setText('#timeline-range', `${date(samples[0]?.at)} – ${date(samples.at(-1)?.at)}`);
}
function renderWifi(wifi) {
  if (!wifi) return;
  const body = $('#wifi-networks');
  const signature = {
    error: wifi.error, connected: wifi.connected, ssid: wifi.ssid, bssid: wifi.bssid,
    signalPercent: wifi.signalPercent, channel: wifi.channel, radio: wifi.radio,
    receiveRateMbps: wifi.receiveRateMbps, transmitRateMbps: wifi.transmitRateMbps,
    networks: safeArray(wifi.networks).map(network => [network.ssid, network.channel, network.signalPercent]),
  };
  if (!shouldRenderChanged(body, signature)) return;
  setText('#wifi-ssid', wifi.error ? 'Status nicht messbar' : wifi.connected ? wifi.ssid || 'Verbundenes WLAN' : 'Nicht verbunden');
  setText('#wifi-description', wifi.error || (wifi.connected ? `${wifi.bssid || 'BSSID nicht verfügbar'}${wifi.signalPercent != null ? ` · Signal ${fmt(wifi.signalPercent, 0)} %` : ''}` : 'Keine aktive WLAN-Verbindung erkannt'));
  pill('#wifi-pill', wifi.error ? 'Nicht messbar' : wifi.connected ? 'Verbunden' : 'Nicht verbunden', wifi.error ? 'warn' : wifi.connected ? 'good' : 'muted');
  setText('#wifi-signal', wifi.signalPercent == null ? '–' : `${fmt(wifi.signalPercent, 0)} %`); setText('#wifi-channel', wifi.channel ?? '–'); setText('#wifi-radio', wifi.radio || '–');
  setText('#wifi-receive', wifi.receiveRateMbps == null ? '–' : rate(wifi.receiveRateMbps)); setText('#wifi-transmit', wifi.transmitRateMbps == null ? '–' : rate(wifi.transmitRateMbps));
  body.replaceChildren(); const networks = safeArray(wifi.networks);
  if (!networks.length) { const tr = element('tr'); const td = element('td', 'table-empty', wifi.error || 'Keine sichtbaren WLAN-Netze'); td.colSpan = 3; tr.append(td); body.append(tr); return; }
  networks.forEach((network) => { const tr = element('tr'); tr.append(element('td', 'network-name', network.ssid || '(ohne Namen)'), element('td', '', network.channel ?? '–'), element('td', '', network.signalPercent == null ? '–' : `${fmt(network.signalPercent, 0)} %`)); body.append(tr); });
}
function renderDevices(s) {
  const intf = selectedInterface();
  const body = $('#devices-list');
  const allDevices = safeArray(s.devices); const interfaceId = s.selectedInterfaceId || selectedInterface()?.id;
  const devices = interfaceId ? allDevices.filter((device) => !device.interfaceId || device.interfaceId === interfaceId) : allDevices;
  const busyKeys = [...state.busy].filter(key => key === 'repeater' || key.startsWith('device:')).sort();
  const signature = {
    interfaceId, gateway: intf?.gateway, scanRunning: !!s.scan?.running, busyKeys,
    targets: safeArray(s.targets).map(target => [target.host, target.kind]),
    devices: devices.map(device => [device.name, device.mac, device.source, device.lastSeen,
      !!device.lastSeen && Date.now() - new Date(device.lastSeen).getTime() > 5 * 60 * 1000,
      device.ip, device.respondsToPing, device.measurementError, device.interfaceId]),
  };
  if (!shouldRenderChanged(body, signature)) return;
  body.replaceChildren();
  $('#device-count').textContent = `${devices.length} ${devices.length === 1 ? 'Gerät' : 'Geräte'}`;
  if (!devices.length) { const tr = element('tr'); const td = element('td', 'table-empty', s.scan?.running ? 'Scan läuft …' : 'Noch keine Geräte gefunden'); td.colSpan = 4; tr.append(td); body.append(tr); return; }
  devices.forEach((device) => {
    const tr = element('tr'); const nameCell = element('td', 'device-name'); nameCell.append(element('strong', '', device.name || device.mac || 'Unbekanntes Gerät'));
    const seen = device.lastSeen ? date(device.lastSeen) : 'Zeit unbekannt'; const stale = device.lastSeen && Date.now() - new Date(device.lastSeen).getTime() > 5 * 60 * 1000;
    nameCell.append(element('small', 'device-meta', `${device.source || 'Quelle unbekannt'} · zuletzt ${seen}${stale ? ' · möglicherweise veraltet' : ''}`));
    const ipCell = element('td', '', device.ip || '–'); const statusCell = element('td');
    const statusText = device.measurementError ? 'Messfehler' : device.respondsToPing === true ? 'Antwortet' : device.respondsToPing === false ? 'Keine Ping-Antwort' : 'Nur Nachbartabelle';
    statusCell.append(element('span', `device-status ${device.respondsToPing === true ? 'reachable' : ''}`, statusText));
    const actionCell = element('td'); actionCell.className = 'device-actions'; const monitored = safeArray(s.targets).some((target) => target.host === device.ip); const add = element('button', 'text-button', monitored ? 'Überwacht' : '+ überwachen'); add.type = 'button'; add.disabled = monitored || !device.ip || state.busy.has(`device:${device.ip}`); add.setAttribute('aria-label', `${monitored ? 'Bereits überwacht' : 'Überwachen'}: ${device.name || device.ip}`); if (!monitored) add.addEventListener('click', () => addDeviceTarget(device)); actionCell.append(add);
    const repeaterMonitored = safeArray(s.targets).some((target) => target.kind === 'repeater' && target.host === device.ip); const isGateway = device.ip === intf?.gateway || safeArray(s.targets).some((target) => target.kind === 'gateway' && target.host === device.ip); const asRepeater = element('button', 'text-button repeater-device-button', repeaterMonitored ? 'Repeater ✓' : isGateway ? 'Gateway' : 'Als Repeater'); asRepeater.type = 'button'; asRepeater.disabled = repeaterMonitored || isGateway || !device.ip || state.busy.has('repeater'); asRepeater.setAttribute('aria-label', `${repeaterMonitored ? 'Repeater wird bereits überwacht' : isGateway ? 'Gateway kann nicht als Repeater markiert werden' : 'Als Mesh-Repeater überwachen'}: ${device.name || device.ip}`); if (!repeaterMonitored && !isGateway) asRepeater.addEventListener('click', () => addRepeater(device.ip)); actionCell.append(asRepeater); tr.append(nameCell, ipCell, statusCell, actionCell); body.append(tr);
  });
}
function renderEvents(s) {
  const root = $('#events-list'); const items = safeArray(s.events);
  const signature = items.map(item => [item.level, item.at, item.title, item.detail]);
  const button = $('#events-show-all');
  if (button) button.onclick = () => { root.dataset.expanded = root.dataset.expanded === 'true' ? 'false' : 'true'; renderEvents(state.value || s); };
  if (!shouldRenderChanged(root, { items: signature, expanded: root.dataset.expanded === 'true' })) return;
  root.replaceChildren(); $('#event-count').textContent = `${items.length}`;
  const expanded = root.dataset.expanded === 'true';
  if (button) { button.hidden = items.length <= 5; button.textContent = expanded ? 'Weniger anzeigen' : `Alle ${items.length} anzeigen`; }
  if (!items.length) { root.append(element('div', 'empty-state compact', 'Noch keine Ereignisse.')); return; }
  items.slice(0, expanded ? items.length : 5).forEach((item) => { const row = element('div', `event-row level-${item.level || 'info'}`); row.append(element('time', 'event-time measurement', date(item.at)), element('span', 'event-marker'), element('div', 'event-copy')); row.lastChild.append(element('strong', '', item.title || 'Ereignis'), element('p', '', item.detail || '')); root.append(row); });
}
function historyTime(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function historyRecords(type) { return state.history.records.filter((record) => record.type === type).sort((a, b) => new Date(a.at) - new Date(b.at)); }
function historyEmpty(message = 'Für diesen Zeitraum liegen keine gespeicherten Messwerte vor.') { return element('div', 'history-empty', message); }
function hint(className, text, help) { const item = element('p', className, text); item.dataset.help = help; return item; }
function historyTitle(title, detail = '', help = '') { const box = element('div', 'history-section-title'); box.append(element('h3', '', title)); if (detail) box.append(help ? hint('', detail, help) : element('p', '', detail)); return box; }
function historyMetric(label, value, note = '') { const card = element('article', 'history-metric'); card.append(element('span', '', label), element('strong', '', value)); if (note) card.append(element('small', '', note)); return card; }
function renderHistoryChart(parent, series, options = {}) {
  const sampleValues = (values) => {
    if (values.length <= 500) return values;
    const bucketSize = values.length / 250; const sampled = [];
    for (let start = 0; start < values.length; start += bucketSize) {
      const bucket = values.slice(Math.floor(start), Math.min(values.length, Math.ceil(start + bucketSize)));
      const valid = bucket.filter((point) => numeric(point.value)); const picks = new Set();
      if (valid.length) { picks.add(valid.reduce((min, point) => Number(point.value) < Number(min.value) ? point : min)); picks.add(valid.reduce((max, point) => Number(point.value) > Number(max.value) ? point : max)); }
      for (let i = 0; i < bucket.length; i += 1) if (!numeric(bucket[i].value) && (i === 0 || numeric(bucket[i - 1].value))) picks.add(bucket[i]);
      sampled.push(...[...picks].sort((a, b) => new Date(a.at) - new Date(b.at)));
    }
    return sampled;
  };
  series = series.map((item) => {
    let segment = 0, previousTime = null, previousEpoch;
    const marked = item.values.map((point) => {
      const time = new Date(point.at).getTime();
      if (!numeric(point.value) || !Number.isFinite(time)) { const gapPoint = { ...point, segment }; segment += 1; previousTime = null; previousEpoch = undefined; return gapPoint; }
      if ((item.maxGapMs && previousTime != null && time - previousTime > item.maxGapMs) || (point.epoch != null && previousEpoch != null && point.epoch !== previousEpoch)) segment += 1;
      const markedPoint = { ...point, segment }; previousTime = time; previousEpoch = point.epoch; return markedPoint;
    });
    return { ...item, values: sampleValues(marked) };
  });
  const usable = series.flatMap((item) => item.values.filter((point) => numeric(point.value)).map((point) => Number(point.value)));
  if (!usable.length) { parent.append(historyEmpty(options.empty || 'Für diesen Zeitraum gibt es noch keine Messpunkte.')); return; }
  const W = 1000, H = 340, pad = { l: 68, r: 24, t: 24, b: 60 };
  const chart = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); chart.setAttribute('viewBox', `0 0 ${W} ${H}`); chart.setAttribute('role', 'img'); chart.setAttribute('aria-label', options.label || 'Messverlauf');
  const times = series.flatMap((item) => item.values.map((point) => new Date(point.at).getTime()).filter(Number.isFinite));
  let minT = Infinity, maxT = -Infinity;
  for (const time of times) { if (time < minT) minT = time; if (time > maxT) maxT = time; }
  if (maxT - minT < 60000) { const mid = (minT + maxT) / 2; minT = mid - 30000; maxT = mid + 30000; }
  let maxObserved = options.minimumMax || 1;
  for (const value of usable) if (value > maxObserved) maxObserved = value;
  const axisTicks = niceAxisTicks(maxObserved); const maxV = axisTicks.at(-1) || 1;
  const x = (time) => pad.l + (time - minT) / (maxT - minT) * (W - pad.l - pad.r);
  const y = (value) => H - pad.b - value / maxV * (H - pad.t - pad.b);
  axisTicks.forEach((tick) => {
    const py = y(tick); const grid = document.createElementNS(chart.namespaceURI, 'line'); grid.setAttribute('x1', pad.l); grid.setAttribute('x2', W - pad.r); grid.setAttribute('y1', py); grid.setAttribute('y2', py); grid.setAttribute('class', 'history-grid'); grid.setAttribute('style', 'stroke:#24282C;stroke-width:1;stroke-dasharray:none'); chart.append(grid);
    const label = document.createElementNS(chart.namespaceURI, 'text'); label.setAttribute('x', pad.l - 10); label.setAttribute('y', py + 5); label.setAttribute('text-anchor', 'end'); label.setAttribute('class', 'history-axis-label'); label.textContent = `${fmt(tick, 1)}${options.unit || ''}`; chart.append(label);
  });
  [0, .5, 1].forEach((fraction) => { const px = pad.l + fraction * (W - pad.l - pad.r); const label = document.createElementNS(chart.namespaceURI, 'text'); label.setAttribute('x', px); label.setAttribute('y', H - 20); label.setAttribute('text-anchor', fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'); label.setAttribute('class', 'history-axis-label'); label.textContent = historyTime(new Date(minT + fraction * (maxT - minT)).toISOString()); chart.append(label); });
  series.forEach((item) => {
    let segment = []; let previousSegment = null;
    const draw = () => { if (segment.length > 1) { const path = document.createElementNS(chart.namespaceURI, 'polyline'); path.setAttribute('points', segment.map((point) => `${point.x},${point.y}`).join(' ')); path.setAttribute('class', 'history-line'); path.setAttribute('stroke', item.color); path.setAttribute('stroke-dasharray', item.dash || 'none'); chart.append(path); } segment = []; };
    item.values.forEach((point) => {
      const t = new Date(point.at).getTime();
      if (!Number.isFinite(t) || !numeric(point.value)) { draw(); previousSegment = point.segment; return; }
      if (previousSegment != null && point.segment !== previousSegment) draw();
      const coords = { x: x(t), y: y(Number(point.value)) }; segment.push(coords);
      previousSegment = point.segment;
      const dot = document.createElementNS(chart.namespaceURI, 'circle'); dot.setAttribute('cx', coords.x); dot.setAttribute('cy', coords.y); dot.setAttribute('r', '3.5'); dot.setAttribute('fill', item.color); dot.setAttribute('aria-label', `${item.name}: ${historyTime(point.at)}, ${fmt(point.value)}${options.unit || ''}`); chart.append(dot);
    }); draw();
  });
  parent.append(chart);
  const legend = element('div', 'history-legend'); series.forEach((item) => { const entry = element('span'); const mark = element('i'); mark.style.backgroundColor = item.color; entry.append(mark, document.createTextNode(item.name)); legend.append(entry); }); if (options.legend !== false) parent.append(legend);
}
function renderHistoryConnection(view, { deferChart = false } = {}) {
  let chartUpdate = null;
  const records = historyRecords('ping');
  const targetMap = state.history.pingTargets; records.forEach(record => safeArray(record.results).forEach(result => { if (result.host) targetMap.set(result.host, result); }));
  safeArray(state.value?.targets).forEach(target => { if (target.host) targetMap.set(target.host, target); });
  const targets = [...targetMap.values()];
  state.history.pingHosts = resolvePingSelection(state.history.pingHosts, targets);
  const selected = state.history.pingHosts || new Set();
  const chooser = element('fieldset', 'ping-target-picker'); chooser.id = 'history-ping-target';
  chooser.append(element('legend', '', 'Ping-Ziele im Diagramm'), hint('field-help', 'Wähle die Ziele für den Vergleich.', 'Die Auswahl bleibt beim Aktualisieren und Zeitraumwechsel erhalten.'));
  const options = element('div', 'ping-target-options');
  targets.forEach((target, index) => {
    const row = element('label', 'ping-target-option'); row.classList.toggle('is-selected', selected.has(target.host));
    const input = element('input'); input.type = 'checkbox'; input.checked = selected.has(target.host); input.dataset.host = target.host; input.id = 'ping-target-' + index;
    const dot = element('i', 'ping-color-dot'); dot.style.backgroundColor = pingTargetColor(target.host, [...selected].indexOf(target.host)); dot.setAttribute('aria-hidden', 'true');
    const text = element('span', 'ping-target-copy'); text.append(element('strong', '', target.label || target.host), element('small', '', target.host));
    input.addEventListener('change', () => {
      state.history.pingHosts = togglePingSelection(state.history.pingHosts || new Set(), target.host, input.checked);
      renderHistoryView(); [...$('#history-ping-target').querySelectorAll('input')].find(item => item.dataset.host === target.host)?.focus({ preventScroll: true });
    });
    row.append(input, dot, text); options.append(row);
  });
  if (!targets.length) options.append(historyEmpty('Noch keine Ping-Ziele vorhanden.'));
  chooser.append(options);
  const jitterLabel = element('label', 'ping-jitter-option'); const jitterInput = element('input'); jitterInput.type = 'checkbox'; jitterInput.id = 'ping-jitter';
  jitterInput.checked = state.history.pingJitter && selected.size === 1; jitterInput.disabled = selected.size !== 1;
  jitterInput.addEventListener('change', () => { state.history.pingJitter = jitterInput.checked; renderHistoryView(); $('#ping-jitter')?.focus({ preventScroll: true }); });
  const jitterDot = element('i', 'ping-color-dot'); jitterDot.style.backgroundColor = 'var(--series-tertiary)'; jitterDot.setAttribute('aria-hidden', 'true');
  jitterLabel.append(jitterInput, jitterDot, document.createTextNode('Jitter zusätzlich zeigen · nur bei einem Ziel')); chooser.append(jitterLabel); view.append(chooser);
  const valuesFor = host => records.flatMap(record => {
    const result = safeArray(record.results).find(item => item.host === host);
    return result ? [{ at: record.at, epoch: `${record.appSessionId||'legacy'}:${record.epoch??'legacy'}`, host, label: targetMap.get(host)?.label || host, value: result.ok ? result.ms : null, status: result.status, error: result.error }] : [];
  });
  const measured = [...selected].map(host => ({ host, values: valuesFor(host) }));
  const series = measured.map(({ host, values }, index) => ({ name: targetMap.get(host)?.label || host, color: pingTargetColor(host, index), dash: pingTargetDash(host), values, maxGapMs: 10000 }));
  if (selected.size === 1 && state.history.pingJitter) series.push({ name: 'Jitter (Nachbardifferenz)', color: '#8A9096', values: jitterFor(measured[0].values), maxGapMs: 10000 });
  if (!selected.size) view.append(historyEmpty('Keine Ping-Ziele angehakt. Wähle oben mindestens ein Ziel für Diagramm und Statistik.'));
  else {
    const table = historyTable(['Ziel', 'Messpunkte', 'Antworten', 'Ping', 'Jitter', 'Paketverlust', 'Messfehler']); table.classList.add('ping-statistics');
    table.tabIndex = 0; table.setAttribute('role', 'region'); table.setAttribute('aria-label', 'Ping-Statistik im gewählten Zeitraum');
    measured.forEach(({host, values}) => {
      const stats = summarizePingHistory(values);
      appendHistoryRow(table, [(targetMap.get(host)?.label || host) + ' (' + host + ')', fmt(stats.counts.samples, 0), fmt(stats.counts.answers, 0), '', '', '', fmt(stats.counts.errors, 0)]);
      const row = table.querySelector('tbody').lastElementChild; row.dataset.host = host;
      [[3, stats.averagePing, stats.peakPing, 'ping'], [4, stats.averageJitter, stats.peakJitter, 'jitter'], [5, stats.lossPercent, stats.peakLoss, 'loss']].forEach(([column, average, peak, kind]) => {
        const cell = row.children[column]; cell.dataset.metric = kind;
        const unit = kind === 'loss' ? ' %' : ' ms';
        cell.append(element('span', '', `${kind === 'loss' ? 'Gesamt' : 'Ø'} ${average === null ? '–' : fmt(average) + unit}`));
        cell.append(element('strong', 'ping-peak', `Max. ${peak ? fmt(peak.value) + unit : '–'}${kind === 'loss' ? ' / Min.' : ''}`));
        if (peak) {
          cell.append(element('small', '', historyTime(peak.at)));
          if (kind === 'loss') cell.append(element('small', '', `${peak.lost} von ${peak.attempts} verloren`));
        }
      });
    }); view.append(table);
    view.append(hint('ping-statistics-note', 'Statistik für den gesamten gewählten Zeitraum.', 'Der Zoom ändert den Zeitraum der Statistik nicht. Max. Paketverlust zeigt die schlimmste Kalenderminute, auch angefangene Minuten; Messfehler zählen nicht als Verlust.'));
    const chart = element('div', 'history-chart'); view.append(chart);
    if (deferChart) chartUpdate = { chart, series };
    else {
      state.history.disposeChart = renderPingChart(chart, series, state.history.pingViewport ||= { range: null });
      state.history.disposeChart.update?.(undefined, historyChartStatus());
    }
  }
  const trafficRecords = state.history.records.filter(record => record.type === 'traffic' || record.type === 'fritzbox');
  view.append(createLagPhaseSection({ pingRecords: records, selectedHosts: selected, trafficRecords, historyTruncated: state.history.truncated, onShowWindow: (from, to) => {
    state.history.pingViewport ||= { range: null };
    state.history.pingViewport.range = [from, to];
    state.history.pingViewport.followLatest = false;
    renderHistoryView();
    const chart = document.querySelector('#ping-history-chart');
    chart?.scrollIntoView({ block: 'center' });
    chart?.focus({ preventScroll: true });
  } }));
  view.append(historyTitle('Ausfälle und Messfehler', 'Nur für angehakte Ziele. Verlorene Antworten und Fehler der Messung bleiben getrennt.'));
  const incidents = measured.flatMap(item => item.values).filter(point => !numeric(point.value)).sort((a,b) => new Date(b.at) - new Date(a.at));
  if (!incidents.length) view.append(historyEmpty(selected.size ? 'Keine Ausfälle oder Messfehler für diese Auswahl im Zeitraum.' : 'Keine Ziele ausgewählt.'));
  else { const list = historyScrollList('history-incidents', 'Ausfälle und Messfehler'); incidents.forEach(point => { const error = point.status === 'measurement_error'; const row = element('article', 'history-row ' + (error ? 'history-warning' : 'history-loss')); row.append(element('time', 'measurement', historyTime(point.at)), element('strong', '', point.label + ': ' + (error ? 'Messfehler' : 'Keine Ping-Antwort')), element('span', '', point.error || (error ? 'Messung fehlgeschlagen' : 'Ping-Ziel ' + point.host + ' antwortete nicht'))); list.append(row); }); view.append(list); }
  const marks = historyRecords('event').filter(record => /lag|spiel|mark/i.test((record.title || '') + ' ' + (record.detail || '')));
  view.append(historyTitle('Manuelle Lag-Markierungen', 'Messwerte der angehakten Ziele innerhalb von 30 Sekunden vor oder nach dem markierten Moment.'));
  if (!marks.length) view.append(historyEmpty('Noch keine Lag-Momente markiert. Die Markierung findest du in der Übersicht.'));
  else {const list=historyScrollList('history-lag-markers','Manuelle Lag-Markierungen');view.append(list);marks.slice().reverse().forEach(mark => {
    const card = element('article', 'lag-correlation'); card.append(element('h4', '', mark.title || 'Spiellag manuell markiert'), element('time', '', historyTime(mark.at))); if (mark.detail) card.append(element('p', '', mark.detail));
    const markAt = new Date(mark.at).getTime(); const nearest = new Map();
    records.filter(record => Math.abs(new Date(record.at).getTime() - markAt) <= 30000).forEach(record => safeArray(record.results).forEach(result => { if (!selected.has(result.host)) return; const dist = Math.abs(new Date(record.at).getTime() - markAt); if (!nearest.has(result.host) || dist < nearest.get(result.host).dist) nearest.set(result.host, { result, record, dist }); }));
    if (!nearest.size) card.append(historyEmpty(selected.size ? 'Keine Messung der gewählten Ziele innerhalb von ±30 Sekunden.' : 'Keine Ziele ausgewählt.'));
    else { const table = historyTable(['Ziel', 'Zeit zum Marker', 'Messwert']); nearest.forEach(({ result, record }) => appendHistoryRow(table, [result.label || result.host, Math.round((new Date(record.at).getTime() - markAt) / 1000) + ' s', result.ok ? fmt(result.ms) + ' ms' : result.status === 'measurement_error' ? 'Messfehler' : 'Keine Ping-Antwort'])); card.append(table); }
    list.append(card);
  });}
  return chartUpdate;
}
function renderHistoryTraffic(view) {
  renderHealthHistory(view,historyRecords('traffic'));
  const records=state.history.records.filter(record=>['traffic','fritzbox'].includes(record.type)).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const sources=trafficSources(records,state.value?.fritzbox);
  const selected=state.history.trafficSources ||= new Set(['pc','wan']);
  const colors=state.history.trafficColors ||= new Map([['pc','var(--series-primary)'],['wan','var(--series-secondary)']]);
  const palette=['var(--series-primary)','var(--series-secondary)','var(--series-tertiary)'];
  for(const source of sources)if(!colors.has(source.id))colors.set(source.id,palette[colors.size % palette.length]);
  view.append(historyTitle('Datenverkehr: PC, Router & Geräte','Vergleiche die Quellen getrennt.','PC-Verkehr enthält auch lokale Übertragungen. Die FRITZ!Box-Werte messen Internetverkehr. Addiere diese Werte nicht, sie überschneiden sich.'));
  const groups=[['FRITZ!Box gesamt',sources.filter(source=>source.id==='wan')],['Einzelgeräte',sources.filter(source=>source.kind==='device')],['Dieser PC',sources.filter(source=>source.id==='pc')]];
  for(const [title,items]of groups){
    if(!items.length)continue;
    const picker=element('fieldset','ping-target-picker');picker.append(element('legend','',title));
    const options=element('div','ping-target-options');
    for(const source of items) {
      const inputId=`traffic-source-${encodeURIComponent(source.id)}`;
      const label=element('label',`ping-target-option${selected.has(source.id)?' is-selected':''}`);const input=element('input');input.type='checkbox';input.checked=selected.has(source.id);input.id=inputId;
      input.addEventListener('change',()=>{input.checked?selected.add(source.id):selected.delete(source.id);renderHistoryView();$(`#${CSS.escape(inputId)}`)?.focus({preventScroll:true});});
      const dot=element('i','ping-color-dot');dot.style.background=colors.get(source.id);dot.setAttribute('aria-hidden','true');
      const status=source.kind==='device'?(source.active===false?'Offline':source.active===true?'Online':'Status unbekannt'):source.id==='wan'?'Routergesamt':'Adapter';
      const availability=source.kind==='device'?(source.available?'Zähler gemeldet':'keine Geräte-Zähler'):(source.reason||'');
      const description=[source.ip,status,availability].filter(Boolean).join(' · ');
      const copy=element('span','ping-target-copy');copy.append(element('strong','',source.label),element('small','',description));label.append(input,dot,copy);options.append(label);
    }
    picker.append(options);view.append(picker);
  }
  const controls=element('div','traffic-picker-actions');
  const devices=sources.filter(source=>source.kind==='device');
  for(const [label,ids]of [['FRITZ!Box + alle Geräte',['wan',...devices.map(source=>source.id)]],['Nur FRITZ!Box',['wan']],['Nur eigener PC',['pc']],['Keine',[]]]){const button=element('button','button button-quiet',label);button.type='button';button.addEventListener('click',()=>{state.history.trafficSources=new Set(ids);renderHistoryView();});controls.append(button);}view.append(controls);
  if(!devices.length){
    const empty=element('div','history-empty');empty.append(element('p','','Melde deine FRITZ!Box an, um Geräte zu sehen.'));
    const actions=element('div','traffic-picker-actions');const router=element('button','button button-secondary','FRITZ!Box öffnen');router.type='button';router.addEventListener('click',()=>navigation.navigate('router',{focus:true}));
    const refresh=element('button','button button-quiet','Erneut laden');refresh.type='button';refresh.addEventListener('click',()=>loadHistory(true));actions.append(router,refresh);empty.append(actions);view.append(empty);
  }
  const chosen=sources.filter(source=>selected.has(source.id));
  if(!chosen.length){view.append(historyEmpty('Keine Datenquelle angehakt. Wähle PC, Router oder Geräte aus.'));return;}
  const table=element('table','history-table traffic-summary');const head=element('thead');const heading=element('tr');
  for(const label of ['Quelle','Letzter Download','Letzter Upload','Erfasst ↓ / ↑','Status / Messwerte'])heading.append(element('th','',label));head.append(heading);table.append(head);const body=element('tbody');
  const bytes=value=>numeric(value)?`${fmt(value/1000000,2)} MB`:'–';
  for(const source of chosen){const row=element('tr');const status=source.kind==='device'?(source.active===false?'Offline':source.active===true?'Online':'Status unbekannt'):(source.reason?'Anmeldung erforderlich':'Router');const measured=source.measured?`${source.measured} Messpunkte`:source.kind==='device'?(source.available?'Zähler vorhanden, noch keine Rate':'Keine messbaren Geräte-Zähler'):'Noch keine messbaren Routerwerte';for(const value of [source.label,rate(source.latest?.downloadMbps),rate(source.latest?.uploadMbps),`${bytes(source.downloadBytes)} / ${bytes(source.uploadBytes)}`,`${status} · ${measured}${source.reason?' · '+source.reason:''}`])row.append(element('td','',value));body.append(row);}table.append(body);const scroll=element('div','table-scroll');scroll.append(table);view.append(scroll);
  view.append(hint('traffic-source-note','Erfasst wird die Datenmenge im Messzeitraum.','Lücken und unbekannte Werte zählen nicht als null. Gerätewerte sind vom FRITZ!OS abhängig; WLAN-Linkraten sind kein Verbrauch.'));
  for(const direction of ['download','upload']) {
    const chart=element('div','history-chart');view.append(historyTitle(direction==='download'?'Download im Verlauf':'Upload im Verlauf'));
    renderHistoryChart(chart,chosen.map(source=>({name:source.label,color:colors.get(source.id),dash:pingTargetDash(source.id),maxGapMs:source.id==='pc'?15000:90000,values:source.points.map(point=>({at:point.at,epoch:point.epoch,value:point[`${direction}Mbps`]}))})),{unit:' Mbit/s',label:direction==='download'?'Download der angehakten Quellen':'Upload der angehakten Quellen',empty:'Noch keine Verkehrsmessungen für diese Auswahl.'});view.append(chart);
  }
}
function renderHistoryWireless(view) {
  renderNetworkChanges(view,state.history.records);
  const dns = historyRecords('dns'); const wifi = historyRecords('wifi');
  view.append(historyTitle('WLAN und DNS', 'Änderungen und Auflösungszeiten aus den gespeicherten Messungen.'));
  const metrics = element('div', 'history-metrics'); const dnsOk = dns.filter((record) => record.ok && numeric(record.ms)); const dnsAvg = dnsOk.length ? dnsOk.reduce((total, record) => total + Number(record.ms), 0) / dnsOk.length : null; metrics.append(historyMetric('DNS-Auflösungen', fmt(dns.length, 0)), historyMetric('Ø DNS-Dauer', dnsAvg == null ? '–' : `${fmt(dnsAvg)} ms`), historyMetric('DNS-Fehler', fmt(dns.filter((record) => record.ok === false).length, 0)), historyMetric('WLAN-Messungen', fmt(wifi.length, 0))); view.append(metrics);
  const chart = element('div', 'history-chart'); renderHistoryChart(chart, [{ name: 'DNS-Dauer', color: 'var(--series-primary)', values: dns.map((record) => ({ at: record.at, value: record.ok ? record.ms : null })), maxGapMs: 75000 }], { unit: ' ms', label: 'DNS-Auflösungsdauer', empty: 'Keine DNS-Auflösungen im gewählten Zeitraum.' }); view.append(chart);
  view.append(historyTitle('WLAN-Signal', 'Signalstärke des verbundenen WLANs. Änderungen an Kanal und BSSID stehen in der Liste darunter.'));
  const signalChart = element('div', 'history-chart'); renderHistoryChart(signalChart, [{ name: 'Signal', color: 'var(--series-tertiary)', values: wifi.map((record) => ({ at: record.at, value: record.connected ? record.signalPercent : null })), maxGapMs: 150000 }], { unit: ' %', label: 'WLAN-Signalstärke', minimumMax: 100, empty: 'Keine verbundenen WLAN-Messungen mit Signalwert im Zeitraum.' }); view.append(signalChart);
  view.append(historyTitle('WLAN-Änderungen'));
  const changes = []; let previous = null;
  wifi.forEach((record) => { const fingerprint = [record.connected, record.ssid, record.bssid, record.channel, record.signalPercent].join('|'); if (!previous || previous.fingerprint !== fingerprint) changes.push(record); previous = { fingerprint }; });
  if (!changes.length) view.append(historyEmpty('Keine WLAN-Daten im Zeitraum.'));
  else { const table = historyTable(['Zeit', 'Netzwerk', 'Signal', 'Kanal', 'BSSID']); changes.slice().reverse().forEach((record) => appendHistoryRow(table, [historyTime(record.at), record.error ? 'Nicht messbar: ' + record.error : record.connected ? record.ssid || 'Verbunden' : 'Nicht verbunden', record.signalPercent == null ? '–' : `${fmt(record.signalPercent, 0)} %`, record.channel ?? '–', record.bssid || '–'])); view.append(table); }
  view.append(historyTitle('DNS-Auflösungen'));
  if (!dns.length) view.append(historyEmpty('Keine DNS-Ergebnisse im Zeitraum.'));
  else { const list = historyScrollList('history-dns', 'DNS-Auflösungen'); dns.slice().reverse().forEach((record) => { const row = element('article', `history-row ${record.ok ? '' : 'history-loss'}`); row.append(element('time', 'measurement', historyTime(record.at)), element('strong', record.ok ? 'measurement' : '', record.ok ? `${fmt(record.ms)} ms` : 'Auflösung fehlgeschlagen'), element('span', '', record.error || 'DNS-Auflösung')); list.append(row); }); view.append(list); }
}
function historyTable(headers) { const wrap = element('div', 'history-table-wrap'); const table = element('table', 'history-table'); const thead = element('thead'); const tr = element('tr'); headers.forEach((header) => tr.append(element('th', '', header))); thead.append(tr); table.append(thead, element('tbody')); wrap.append(table); return wrap; }
function appendHistoryRow(tableWrap, values) { const tr = element('tr'); values.forEach((value) => { const text = String(value ?? '–'); const measurement = /^(?:\d{1,3}\.){3}\d{1,3}$|^\d{2}\.\d{2}\.\s?\d{2}:\d{2}:\d{2}$|^-?[\d.,]+\s?(?:ms|%|Mbit\/s|s|Geräte?)$/i.test(text); tr.append(element('td', measurement ? 'measurement' : '', text)); }); tableWrap.querySelector('tbody').append(tr); }
function renderHistoryDevices(view) {
  const scans = historyRecords('scan'); view.append(historyTitle('Gerätescans', 'Jeder Eintrag ist ein gespeicherter Scan-Schnappschuss.'));
  if (!scans.length) { view.append(historyEmpty('Für diesen Zeitraum sind keine Scans gespeichert.')); return; }
  const list=historyScrollList('history-scans','Gespeicherte Gerätescans');view.append(list);
  scans.slice().reverse().forEach((scan) => { const card = element('details', 'scan-history'); const summary = element('summary'); summary.append(element('time', '', historyTime(scan.at)), element('strong', '', `${fmt(scan.devices?.length || 0, 0)} Geräte`), element('span', '', scan.error || scan.message || (scan.limited ? 'Scan begrenzt' : 'Scan abgeschlossen'))); card.append(summary);
    const devices = safeArray(scan.devices); if (!devices.length) card.append(historyEmpty(scan.error || 'Dieser Scan hat keine Geräte gefunden.'));
    else { const table = historyTable(['Gerät', 'IP-Adresse', 'MAC', 'Ping-Status', 'Quelle']); devices.forEach((device) => appendHistoryRow(table, [device.name || 'Unbekannt', device.ip, device.mac, device.measurementError ? 'Messfehler' : device.respondsToPing === true ? 'Antwortet' : device.respondsToPing === false ? 'Keine Ping-Antwort' : 'Nicht gemessen', device.source])); card.append(table); }
    list.append(card);
  });
}
function renderHistorySpeed(view) {
  const records = [...historyRecords('speedtest'), ...historyRecords('stress')].sort((a,b) => Date.parse(a.at)-Date.parse(b.at)); view.append(historyTitle('Speedtests & Dauerbelastung', 'Ausdrücklich gestartete Tests; Dauerbelastung zeigt Durchschnittsraten über die gesamte Laufzeit.'));
  if (!records.length) { view.append(historyEmpty('Im Zeitraum wurde kein Test gespeichert.')); return; }
  for (const type of ['speedtest', 'stress']) {
    const summary = summarizeSpeedHistory(records, type);
    if (!summary.total) continue;
    const section = element('section', 'speed-history-summary'); section.dataset.testType = type;
    const heading = type === 'speedtest' ? 'Speedtests im Zeitraum' : 'Dauerbelastung im Zeitraum';
    section.setAttribute('aria-label', heading); section.append(element('h4', '', heading));
    const metrics = element('div', 'history-metrics');
    metrics.append(historyMetric('Tests', fmt(summary.total, 0), `${summary.usable} auswertbar · ${summary.failed} fehlgeschlagen`));
    const latest = records.filter(record => record.type === type).at(-1);
    for (const [label, key] of [['Download', 'downloadMbps'], ['Upload', 'uploadMbps']]) {
      const value = summary.metrics[key];
      const card = historyMetric(`Ø ${label}`, rate(value.mean), `${value.count} gültige Testwerte`);
      card.dataset.metric = key;
      if (value.count) card.append(element('small', '', `Min: ${rate(value.min)} · Max: ${rate(value.max)}`));
      const inactive = type === 'stress' && ((key === 'downloadMbps' && latest.mode === 'upload') || (key === 'uploadMbps' && latest.mode === 'download'));
      card.append(element('small', '', `Letzter Test: ${latest.error || latest.reason === 'error' ? 'Fehlgeschlagen' : inactive ? 'Nicht gemessen' : rate(latest[key])}`));
      metrics.append(card);
    }
    metrics.append(historyMetric('Zeitraum', `${state.history.hours} Std.`)); section.append(metrics);
    if (type === 'speedtest') {
      const pings = element('div', 'history-metrics speed-history-ping-summary');
      for (const [label, key] of [['Ø Ping vorher', 'pingBeforeMs'], ['Ø Ping bei Download', 'pingDuringDownloadMs'], ['Ø Ping bei Upload', 'pingDuringUploadMs'], ['Ø Ping nachher', 'pingAfterMs']]) {
        const value = summary.metrics[key];
        const card = historyMetric(label, value.count ? `${fmt(value.mean)} ms` : '–', `${value.count} gültige Testwerte`);
        card.dataset.metric = key; pings.append(card);
      }
      section.append(pings);
    }
    section.append(element('p', 'traffic-source-note', 'Mittelwerte berücksichtigen nur erfolgreiche Tests mit gültigen Werten.'));
    if (summary.pingTargets.length > 1) section.append(element('p', 'traffic-source-note', `Die Ping-Mittelwerte enthalten ${summary.pingTargets.length} unterschiedliche Zielangaben.`));
    view.append(section);
  }
  const list=historyScrollList('history-speedtests','Gespeicherte Leistungstests');view.append(list);
  records.slice().reverse().forEach((record) => { const row = element('article', `speed-history-row ${record.error ? 'history-loss' : ''}`); const title = element('div', 'speed-history-time'); title.append(element('time', '', historyTime(record.at)), record.error ? element('strong', '', 'Fehler') : element('strong', '', `${fmt(record.downloadMbps)} / ${fmt(record.uploadMbps)} Mbit/s`)); row.append(title);
    if (!record.error) [['Download', record.downloadMbps, 'var(--series-primary)'], ['Upload', record.uploadMbps, 'var(--series-tertiary)']].forEach(([label, value, color]) => { const track = element('div', 'speed-bar-row'); track.append(element('span', '', label)); const trackBg = element('div', 'speed-bar-track'); const bar = element('i', ''); bar.style.background = color; bar.style.width = numeric(value) ? `${Math.max(0, Math.min(100, Number(value) / Math.max(1, Number(record.downloadMbps), Number(record.uploadMbps)) * 100))}%` : '0%'; trackBg.append(bar); track.append(trackBg, element('strong', '', rate(value))); row.append(track); });
    else row.append(element('p', 'speed-error', record.error));
    if (record.type === 'stress') {
      const mode = { both: 'Download + Upload', download: 'Download', upload: 'Upload' }[record.mode] || 'Dauerbelastung';
      row.prepend(element('strong', '', `Dauerbelastung · ${mode}`));
      row.append(element('p','traffic-source-note',`${formatLoadTime(record.elapsedSeconds)} · ${formatLoadBytes(record.downloadBytes)} empfangen · ${formatLoadBytes(record.uploadBytes)} Upload bestätigt · ${record.reason === 'completed' ? 'Laufzeit erreicht' : record.error ? 'Abgebrochen' : 'Gestoppt'}`));
      list.append(row); return;
    }
    if (numeric(record.downloadBytes) && numeric(record.uploadBytes)) row.append(element('p','traffic-source-note',`Gewählt: ${formatLoadBytes(record.downloadBytes)} Download · ${formatLoadBytes(record.uploadBytes)} Upload`));
    const pings=element('div','speed-history-pings');
    for(const [label,key]of [['Ping vorher','pingBeforeMs'],['Ø Ping Download','pingDuringDownloadMs'],['Ø Ping Upload','pingDuringUploadMs'],['Ping nachher','pingAfterMs']]) {
      const metric=element('div');metric.append(element('span','',label),element('strong','',numeric(record[key])?`${fmt(record[key])} ms`:'Nicht gemessen'));pings.append(metric);
    }
    row.append(pings);if(record.pingTarget)row.append(element('p','traffic-source-note',`Internet-Pingziel: ${record.pingTarget}`));list.append(row);
  });
}
function renderHistoryEvents(view) {
  const events = historyRecords('event'); view.append(historyTitle('Ereignisse', 'Chronologischer Verlauf aus dem lokalen Archiv.'));
  if (!events.length) { view.append(historyEmpty('Keine Ereignisse im gewählten Zeitraum.')); return; }
  const table = historyTable(['Zeit', 'Stufe', 'Ereignis', 'Details']); events.slice().reverse().forEach((record) => appendHistoryRow(table, [historyTime(record.at), record.level || 'info', record.title || 'Ereignis', record.detail || ''])); view.append(table);
}
function historyScrollList(id,label) {
  const list=element('div','history-list history-scroll-list');
  list.id=id;list.tabIndex=0;list.setAttribute('role','region');list.setAttribute('aria-label',`${label} – separat scrollbar`);
  return list;
}
function historyChartStatus() { return { monitoring: state.value?.monitoring ?? false, connected: !state.history.error && state.apiConnected !== false }; }
function patchHistorySections(view, next, chart, placeholder) {
  const before = [], after = []; let passed = false;
  for (const child of view.childNodes) { if (child === chart) passed = true; else (passed ? after : before).push(child); }
  const nextBefore = [], nextAfter = []; passed = false;
  for (const child of next.childNodes) { if (child === placeholder) passed = true; else (passed ? nextAfter : nextBefore).push(child); }
  const patch = (oldNodes, newNodes, anchor) => {
    newNodes.forEach((node, index) => {
      if (!oldNodes[index]) view.insertBefore(node, anchor);
      else if (!oldNodes[index].isEqualNode(node)) oldNodes[index].replaceWith(node);
    });
    oldNodes.slice(newNodes.length).forEach(node => node.remove());
  };
  patch(before, nextBefore, chart); patch(after, nextAfter, null);
}
function renderHistoryView({ live = false } = {}) {
  const view = $('#history-view'); if (!view) return;
  captureScroll(view);
  const focusedId = view.contains(document.activeElement) ? document.activeElement.id : '';
  const chart = live && state.history.tab === 'connection' && state.history.disposeChart?.update && view.querySelector('.history-chart.ping-chart');
  const content = chart ? document.createDocumentFragment() : view;
  if (!chart) { state.history.disposeChart?.(); state.history.disposeChart = null; view.replaceChildren(); }
  view.setAttribute('aria-labelledby', `history-tab-${state.history.tab}`);
  if (state.history.error) { content.append(element('div', 'history-error', state.history.error)); }
  else if (!state.history.loaded) content.append(historyEmpty('Verlauf wird geladen …'));
  if (state.history.truncated) content.append(element('div', 'history-notice', 'Ältere Messungen findest du im lokalen Protokollarchiv.'));
  const messages = [...safeArray(state.history.warnings).map((warning) => typeof warning === 'string' ? warning : warning?.message || warning?.detail || warning?.title || 'Hinweis zum Verlauf'), ...(state.history.lastError ? [state.history.lastError] : [])];
  messages.forEach((message) => content.append(element('div', 'history-service-message', message)));
  const renderers = { connection: renderHistoryConnection, traffic: renderHistoryTraffic, wireless: renderHistoryWireless, devices: renderHistoryDevices, speed: renderHistorySpeed, events: renderHistoryEvents, fritzbox: (container) => renderFritzboxHistory(container, historyRecords('fritzbox')) };
  const update = state.history.loaded && (renderers[state.history.tab] || renderHistoryConnection)(content, { deferChart: !!chart });
  if (chart && update) {
    patchHistorySections(view, content, chart, update.chart);
    state.history.disposeChart.update(update.series, historyChartStatus());
  } else if (chart) { state.history.disposeChart?.(); state.history.disposeChart = null; view.replaceChildren(content); }
  view.dataset.scrollScope=state.history.tab;restoreScroll(view);
  const restore = focusedId && view.querySelector(`#${CSS.escape(focusedId)}`); if (restore && document.activeElement !== restore) restore.focus({ preventScroll: true });
}
async function loadHistory(force = false) {
  const h = state.history;
  const requestToken = h.requestGate.begin(h.hours, force);
  if (!requestToken) return;
  const generation = state.generation;
  let changed = false;
  h.loading = true; const view = $('#history-view'); if (view && !h.loaded) { view.replaceChildren(historyEmpty('Verlauf wird geladen …')); }
  try {
    const cursor = !force && h.loadedHours === h.hours && h.cursor ? `&cursor=${encodeURIComponent(h.cursor)}` : '';
    const payload = await request(`/api/history?hours=${encodeURIComponent(h.hours)}${cursor}`);
    if (!h.requestGate.isCurrent(requestToken) || generation !== state.generation || h !== state.history) return;
    if (h.loadedHours !== h.hours || h.measurementStartedAt !== payload.measurementStartedAt) { h.pingViewport = { range: null }; h.loadedHours = h.hours; liveResetChart(); }
    const merged = mergeHistoryRecords(h, payload);
    changed = merged.changed || !!h.error || h.truncated !== !!payload.truncated || JSON.stringify(h.warnings) !== JSON.stringify(payload.warnings || []) || h.lastError !== (payload.lastError || '');
    h.records = merged.records; h.recordIds = merged.recordIds; h.cursor = merged.cursor; h.measurementStartedAt = payload.measurementStartedAt;
    h.from = payload.from; h.to = payload.to; h.truncated = !!payload.truncated; h.retentionDays = payload.retentionDays || 7; h.warnings = safeArray(payload.warnings); h.lastError = payload.lastError || ''; h.error = ''; h.loaded = true; h.updatedAt = Date.now();
    setText('#history-retention', `Bis zu ${h.retentionDays} Tage lokal gespeichert; bei vielen Messungen kürzer.`);
    setText('#history-updated', `Aktualisiert ${historyTime(new Date().toISOString())} · ${fmt(payload.total ?? h.records.length, 0)} Einträge`);
  } catch (error) { if (h.requestGate.isCurrent(requestToken) && generation === state.generation && h === state.history) { changed = true; h.cursor = null; h.error = `Verlauf konnte nicht geladen werden: ${error.message}`; h.updatedAt = Date.now(); } }
  finally {
    const current = h.requestGate.isCurrent(requestToken);
    h.requestGate.finish(requestToken);
    h.loading = h.requestGate.pending;
    if (current && generation === state.generation && h === state.history && !h.requestGate.pending) {
      if (changed) renderHistoryView({ live: !force });
      h.disposeChart?.update?.(undefined, historyChartStatus());
    }
  }
}
function liveResetChart() { state.history.disposeChart?.(); state.history.disposeChart = null; }
function setHistoryTab(tab) {
  state.history.tab = tab;
  document.querySelectorAll('[data-history-tab]').forEach((button) => { const active = button.dataset.historyTab === tab; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
  renderHistoryView();
}
function renderScan(scan) {
  const progress = $('#scan-progress'); progress.hidden = !scan || (!scan.running && !scan.done && !scan.error && !scan.message);
  if (!scan) return;
  setText('#scan-message', scan.error || (scan.running ? scan.message || 'Lokales Netz wird geprüft …' : scan.done ? 'Scan abgeschlossen' : scan.message || 'Noch nicht gescannt'));
  setText('#scan-count', scan.total ? `${fmt(scan.done, 0)} / ${fmt(scan.total, 0)}` : '');
  const percent = scan.total ? Math.min(100, Math.max(0, (Number(scan.done) / Number(scan.total)) * 100)) : 0; $('#scan-bar').style.width = `${percent}%`; $('#scan-bar').parentElement.hidden = !scan.running;
  $('#scan-btn').textContent = scan.running ? 'Scan läuft …' : 'Netzwerk scannen';
}
function render(s) {
  state.apiConnected = true;
  renderAdapterHealth($('#adapter-health'),s.traffic);
  const visiblePage=$('[data-page]:not([hidden])');captureScroll(visiblePage);
  const testFinished = ['speedTest','stressTest'].some(key => !s[key]?.running && s[key]?.at && (state.value?.[key]?.running || state.value?.[key]?.at !== s[key].at));
  gamesView.render(s);
  renderStorage(s.persistence);
  state.value = s; setGlobalError(s.lastError || ''); renderInterfaces(s); renderConnection(s); renderOverview(s); renderLiveSignal($('#live-signal'), s); renderOverviewDetails(s); renderTargets(s); renderRepeaterConnection(s); renderChart(s); renderWifi(s.network?.wifi); renderDevices(s); renderEvents(s); renderSpeed(s); renderStress(s); renderScan(s.scan); window.dispatchEvent(new CustomEvent('fritzbox-state', { detail: { fritzbox: s.fritzbox || null, targets: s.targets, repeaterHost: s.repeaterHost } })); syncControls();restoreScroll(visiblePage);
  if (testFinished) loadHistory(true);
  state.history.disposeChart?.update?.(undefined, historyChartStatus());
}
async function poll() {
  if (state.polling) return; state.polling = true;
  const generation = state.generation;
  try { const result = await request('/api/state'); if (generation === state.generation && !state.busy.has('reset')) render(result); }
  catch (error) {
    if (generation !== state.generation || state.busy.has('reset')) return;
    state.apiConnected = false; state.history.disposeChart?.update?.(undefined, historyChartStatus());
    gamesView.connectionLost();
    const conn = $('#connection-state'); conn.className = 'connection offline'; conn.querySelector('span').textContent = 'Server nicht erreichbar';
    setGlobalError(`Die Diagnose-API ist gerade nicht erreichbar. ${error.message}`); $('#monitor-btn').disabled = true; $('#export-btn').disabled = true;
  } finally { state.polling = false; state.pollTimer = setTimeout(poll, 2000); }
}
async function runAction(key, path, body, success) {
  if (state.busy.has(key)) return; setBusy(key, true);
  try { await post(path, body); if (success) showToast(success); await pollOnce(); return true; }
  catch (error) { showToast(error.message, true); return false; }
  finally { setBusy(key, false); }
}
async function pollOnce() { const generation = state.generation; try { const result = await request('/api/state'); if (generation === state.generation) render(result); } catch { /* next scheduled poll presents connectivity state */ } }
async function resetMeasurement() {
  if ($('#reset-btn').disabled) return;
  setBusy('reset', true); state.generation += 1;
  try {
    await post('/api/reset', {}); state.generation += 1; window.dispatchEvent(new Event('measurement-reset'));
    clearScroll($('#history-view'));
    clearScroll($('#page-history'));
    state.history = { ...state.history, pingViewport: { range: null }, records: [], recordIds: [], cursor: null, loaded: false, loading: false, truncated: false, warnings: [], lastError: '', error: '', updatedAt: null };
    setText('#history-updated', 'Neue Messung wird geladen …'); renderHistoryView();
    await pollOnce(); await loadHistory(true);
    showToast('Neue Messung gestartet. Ziele bleiben erhalten; alte Rohprotokolle liegen im data-Ordner.');
  } catch (error) { showToast(error.message, true); }
  finally { setBusy('reset', false); }
}
async function addDeviceTarget(device) { await runAction(`device:${device.ip}`, '/api/targets', { host: device.ip, label: device.name || device.ip }, `${device.ip} wird überwacht.`); }
async function addRepeater(host) {
  if (state.busy.has('repeater')) return; setBusy('repeater', true);
  try { await post('/api/repeater', { host, label: 'Mesh-Repeater' }); showToast('Mesh-Repeater wird überwacht.'); $('#repeater-host').value = ''; await pollOnce(); }
  catch (error) { showToast(error.message, true); }
  finally { setBusy('repeater', false); }
}
async function removeTarget(target) { if (state.busy.has(`remove:${target.id}`)) return; setBusy(`remove:${target.id}`, true); try { await post('/api/targets/remove', { id: target.id }); showToast('Überwachungsziel entfernt.'); await pollOnce(); } catch (e) { showToast(e.message, true); } finally { setBusy(`remove:${target.id}`, false); } }
async function runTrace(target) {
  const dialog = $('#trace-dialog'); $('#trace-title').textContent = `Weg zu ${target.label || target.host}`; setText('#trace-host', target.host); setText('#trace-output', 'Traceroute wird gestartet …'); dialog.showModal();
  try { const result = await post('/api/trace', { host: target.host }); setText('#trace-output', result.output || 'Der Server hat keine Ausgabe geliefert.'); }
  catch (error) { setText('#trace-output', `Traceroute fehlgeschlagen: ${error.message}`); }
}
async function exportState() {
  if (state.busy.has('export')) return; setBusy('export', true);
  try { const report = await request('/api/export'); const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = element('a'); a.href = url; a.download = `netzwerk-kompass-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); showToast('Diagnose exportiert.'); }
  catch (error) { showToast(error.message, true); }
  finally { setBusy('export', false); }
}
async function markLag() {
  if (state.busy.has('history-mark')) return; setBusy('history-mark', true);
  try {
    const result = await post('/api/mark', { note: 'Spiellag manuell markiert' });
    showToast(result.event?.title || 'Lag-Moment markiert.'); await loadHistory(true);
  } catch (error) { showToast(error.message, true); }
  finally { setBusy('history-mark', false); }
}
$('#shutdown-btn').addEventListener('click', async () => {
  if (!window.confirm('Netzwerk-Kompass beenden? Die laufende Überwachung wird gestoppt.')) return;
  await runAction('shutdown', '/api/shutdown', {}, 'Netzwerk-Kompass wird beendet.');
});
$('#monitor-btn').addEventListener('click', () => runAction('monitor', '/api/monitor', { enabled: !state.value?.monitoring }, state.value?.monitoring ? 'Überwachung pausiert.' : 'Überwachung gestartet.'));
$('#reset-btn').addEventListener('click', resetMeasurement);
$('#scan-btn').addEventListener('click', () => { const intf = selectedInterface(); if (intf) runAction('scan', '/api/scan', { interfaceId: intf.id }, 'Netzwerkscan gestartet.'); });
$('#interface-select').addEventListener('change', (event) => runAction('interface', '/api/interface', { interfaceId: event.target.value }, 'Schnittstelle gewechselt.'));
$('#export-btn').addEventListener('click', exportState);
initSpeedOptions();
$('#speed-btn').addEventListener('click', () => runAction('speedtest', '/api/speedtest', selectedSpeedOptions(), 'Speedtest gestartet.'));
$('#stress-start').addEventListener('click', () => runAction('stress-start', '/api/stress/start', { mode: $('#stress-mode').value, durationSeconds: Number($('#stress-duration').value) }, 'Dauerbelastung gestartet.'));
$('#stress-stop').addEventListener('click', () => runAction('stress-stop', '/api/stress/stop', {}, 'Dauerbelastung gestoppt.'));
$('#target-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const host = String(data.get('host') || '').trim(); const label = String(data.get('label') || '').trim(); if (!host) return; if (await runAction('target-add', '/api/targets', { host, label }, 'Überwachungsziel hinzugefügt.')) form.reset(); });
$('#repeater-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const host = String(new FormData(form).get('host') || '').trim(); if (!host) return; await addRepeater(host); });
$('#repeater-host').addEventListener('input', syncControls);
$('#pc-repeater').addEventListener('change', () => runAction('primary', '/api/repeater/primary', { host: $('#pc-repeater').value || null }, 'PC-Anschluss gespeichert.'));
$('#history-mark').addEventListener('click', markLag);
$('#trace-close').addEventListener('click', () => $('#trace-dialog').close()); $('#trace-done').addEventListener('click', () => $('#trace-dialog').close()); $('#trace-dialog').addEventListener('click', (event) => { if (event.target === event.currentTarget) event.currentTarget.close(); });
document.querySelectorAll('[data-history-tab]').forEach((button) => button.addEventListener('click', () => setHistoryTab(button.dataset.historyTab)));
window.addEventListener('open-traffic-history', event => {
  const sourceId=event.detail?.sourceId;
  state.history.tab='traffic';
  if(sourceId)state.history.trafficSources=new Set(['wan',sourceId]);
  navigation.navigate('history',{focus:true});
  setHistoryTab('traffic');
  if(!state.history.loaded)loadHistory(true);
});
document.querySelector('.history-tabs').addEventListener('keydown', event => {
  const buttons = [...document.querySelectorAll('[data-history-tab]')]; const index = buttons.indexOf(event.target);
  if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  setHistoryTab(buttons[next].dataset.historyTab); buttons[next].focus();
});
initFritzbox(post);
initAi({ post, request });
initStorage({ post, request });
const gamesView = initGames({post,refresh:pollOnce,notify:showToast});
initLagHotkey({ markLag, showToast });
initPresentation();
// Keep labels and points at their natural size when the chart panel changes width.
new ResizeObserver(() => { if (state.value) renderChart(state.value); }).observe($('#latency-chart'));
$('#history-hours').addEventListener('change', (event) => { state.history.hours = Number(event.target.value) || 24; loadHistory(true); });
$('#history-refresh').addEventListener('click', () => loadHistory(true));
setInterval(() => { if (!document.hidden && !$('#page-history').hidden) loadHistory(); }, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('#page-history').hidden) loadHistory(); });
poll();
loadHistory(true);
