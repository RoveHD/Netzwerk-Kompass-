import { renderTopology } from './topology.js';

const el = (tag, cls = '', text = '') => { const item = document.createElement(tag); if (cls) item.className = cls; if (text !== undefined && text !== null) item.textContent = String(text); return item; };
const array = value => Array.isArray(value) ? value : [];
const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('de-DE') : 'Zeit nicht bekannt';
const duration = value => Number.isFinite(value) && value >= 0 ? value < 60000 ? `${Math.round(value / 1000)} s` : `${Math.floor(value / 60000)} min ${Math.floor(value / 1000) % 60} s` : 'Dauer unbekannt';
const safeString = value => typeof value === 'string' && value.trim() ? value : 'Nicht angegeben';
const rate = value => Number.isFinite(value) ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mbit/s` : 'unbekannt';
const bytes = value => Number.isFinite(value) ? `${(value / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 2 })} MiB` : 'unbekannt';
const latency = value => Number.isFinite(value) ? `${value.toLocaleString('de-DE', { maximumFractionDigits: 1 })} ms` : 'unbekannt';
let peerNames = new Map();
const sourceName = source => source === 'local' ? 'Dieser PC' : peerNames.get(source) || safeString(source);

function heading(parent, title, detail = '') {
  const section = el('section', 'incident-detail-section'); section.append(el('h4', '', title));
  if (detail) section.append(el('p', 'incident-muted', detail));
  parent.append(section); return section;
}
function bulletList(parent, values, empty = 'Keine Angaben vorhanden.') {
  const list = el('ul', 'incident-evidence-list');
  if (!values.length) list.append(el('li', 'incident-empty-item', empty));
  else values.slice(0, 40).forEach(value => list.append(el('li', '', typeof value === 'string' ? value : JSON.stringify(value))));
  parent.append(list);
}
function renderWindow(parent, label, value) {
  const section = heading(parent, label, value?.complete === false ? 'Das Fenster ist unvollständig; fehlende Messungen sind kein störungsfreier Nachweis.' : '');
  section.append(el('p', 'incident-window-time', `${time(value?.from)} – ${time(value?.to)}`));
  const targets = value?.targets;
  if (Array.isArray(targets) && targets.length) {
    const table = el('div', 'incident-target-list');
    for (const target of targets.slice(0, 24)) {
      const stats = [`${target.sent ?? 'unbekannt'} gesendet`, `${target.received ?? 'unbekannt'} Antworten`, `Verlust ${target.lossPercent == null ? 'unbekannt' : `${target.lossPercent}%`}`, `Ø ${latency(target.avgMs)}`, `P95 ${latency(target.p95Ms)}`, `P99 ${latency(target.p99Ms)}`, `max. ${latency(target.maxMs)}`];
      table.append(el('p', '', `${sourceName(target.sourceDeviceId)} · ${target.label || target.host || target.kind || 'Ziel'} · ${stats.join(' · ')}`));
    }
    section.append(table);
  } else section.append(el('p', 'incident-muted', 'Für dieses Fenster fehlen auswertbare Zielwerte.'));
}
function pathNames(incident) {
  const nodes = array(incident.pathNodes), ids = array(incident.path?.nodeIds);
  if (!ids.length) return nodes.map(node => node.name || node.id || node.ip || 'Knoten');
  const byId = new Map(nodes.map(node => [node.id, node]));
  return ids.map(id => byId.get(id)).filter(Boolean).map(node => node.name || node.id || node.ip || 'Knoten');
}
function renderTraffic(parent, traffic) {
  const section = heading(parent, 'Datenverkehr', 'PC, FRITZ!Box-WAN und Geräte getrennt; Werte werden nicht addiert.');
  const renderSource = (label, summary) => {
    const group = el('section', 'incident-traffic-source'); group.append(el('h5', '', label));
    if (!summary || (!summary.samples && !array(summary.intervals).length)) group.append(el('p', 'incident-muted', 'Für diesen Zeitraum liegen keine passenden Messwerte vor.'));
    else {
      const direction = (name, value) => `${name}: Ø ${rate(value?.average)} · Spitze ${rate(value?.peak)} · ${value?.count ?? 0} Messpunkte`;
      group.append(el('p', '', direction('Download', summary.download)), el('p', '', direction('Upload', summary.upload)));
      if (array(summary.intervals).length) group.append(el('p', 'incident-muted', `${summary.intervals.length} Zählerintervalle; Bytewerte beziehen sich auf das jeweilige Intervall.`));
    }
    section.append(group);
  };
  renderSource('Dieser PC · ausgewählter Adapter', traffic.pc);
  renderSource('FRITZ!Box-WAN · gesamter Anschluss', traffic.wan);
  const utilization = traffic.wanUtilization || {};
  section.append(el('p', 'incident-muted', `Anteil der gemeldeten Anschlussrate: Download ${Number.isFinite(utilization.downloadPercent) ? `${utilization.downloadPercent.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : 'unbekannt'} · Upload ${Number.isFinite(utilization.uploadPercent) ? `${utilization.uploadPercent.toLocaleString('de-DE', { maximumFractionDigits: 1 })} %` : 'unbekannt'}.`));
  const devices = array(traffic.devices), deviceSection = heading(section, 'FRITZ!Box-Geräte', traffic.capabilityReason || 'Geräte-Zählerintervalle im Beobachtungsfenster.');
  if (!devices.length) deviceSection.append(el('p', 'incident-muted', 'Keine passenden Geräte-Zählerintervalle; Geräteverkehr bleibt unbekannt.'));
  else {
    const table = el('div', 'incident-device-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', 'Geräteverkehr während des Vorfalls');
    const header = el('div', 'incident-device-row incident-device-head'); header.setAttribute('role', 'row');
    for (const label of ['Gerät / IP', 'Zählerintervall', 'Gesamt im Intervall', 'Durchsatz']) { const cell = el('strong', '', label); cell.setAttribute('role', 'columnheader'); header.append(cell); }
    table.append(header);
    for (const device of devices) for (const interval of array(device.intervalsDetail)) {
      const row = el('div', 'incident-device-row'); row.setAttribute('role', 'row');
      const cells = [[device.label, device.ip].filter(Boolean).join(' · ') || 'Gerät unbekannt', `${time(interval.start)} – ${time(interval.end)}`, `↓ ${bytes(interval.downloadBytes)} · ↑ ${bytes(interval.uploadBytes)}`, `↓ ${rate(interval.downloadMbps)} · ↑ ${rate(interval.uploadMbps)}`];
      cells.forEach((text, index) => { const cell = el(index ? 'span' : 'strong', '', text); cell.setAttribute('role', 'cell'); row.append(cell); }); table.append(row);
    }
    deviceSection.append(table);
  }
}
function renderTrafficComparison(parent, comparison, incidentSource, incidentWindows = {}) {
  const section = heading(parent, 'Ping und Datenverkehr am Vorfall', 'Jede Zeile zeigt Quelle, tatsächliches Messintervall und verfügbare Werte. Router- und Gerätezähler sind Intervallmessungen, keine sekundengenauen Momentaufnahmen; Quellen werden nicht addiert.');
  const windows = [['Vorher', comparison.before, incidentWindows.before || incidentWindows.pre], ['Während', comparison.during, incidentWindows.during], ['Danach', comparison.after, incidentWindows.after || incidentWindows.post]];
  for (const [label, window, pingWindow] of windows) {
    const group = el('section', 'incident-traffic-source'); group.append(el('h5', '', `${label} · ${time(window?.from)} – ${time(window?.to)}`));
    const coverageText = value => value?.mode === 'unknown' || !value ? 'Abdeckung unbekannt' : `${value.mode === 'intervals' ? 'Zählerintervalle' : 'Punktmessungen'} ${Number.isFinite(value.coveragePercent) ? `${value.coveragePercent.toLocaleString('de-DE', { maximumFractionDigits: 1 })} % Abdeckung` : ''} · ${value.samples ?? 0} Messungen${value.complete === false ? ' · unvollständig' : ''}`;
    const intervalText = (from, to, overlapMs, intervalMs, overlapStart, overlapEnd) => {
      const actualFrom = from || to;
      if (!actualFrom && !to) return 'Kein konkretes Messintervall';
      const inferredMs = Number.isFinite(Date.parse(to)) && Number.isFinite(Date.parse(actualFrom)) ? Date.parse(to) - Date.parse(actualFrom) : NaN;
      const resolution = Number.isFinite(intervalMs) ? intervalMs : inferredMs > 0 ? inferredMs : NaN;
      const span = Number.isFinite(resolution) ? ` · Auflösung ${(resolution / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} s` : '';
      const overlap = Number.isFinite(overlapMs) && Number.isFinite(resolution) && overlapMs < resolution ? ` · nur ${(overlapMs / resolution * 100).toLocaleString('de-DE', { maximumFractionDigits: 0 })} % des Intervalls überlappt` : '';
      const covered = overlapStart || overlapEnd ? ` · Lag-Überdeckung ${time(overlapStart || overlapEnd)} – ${time(overlapEnd || overlapStart)}` : '';
      return `${time(actualFrom)} – ${time(to || actualFrom)}${span}${overlap}${covered}`;
    };
    const trafficValue = (interval, direction) => {
      const rateValue = interval?.[`${direction}Mbps`];
      const amount = interval?.[`${direction}Bytes`];
      const estimated = interval?.[`estimated${direction[0].toUpperCase()}${direction.slice(1)}Bytes`];
      const parts = [rate(rateValue)];
      if (Number.isFinite(amount)) parts.push(`${bytes(amount)} im Messintervall`);
      if (Number.isFinite(estimated)) parts.push(`≈ ${bytes(estimated)} geschätzt im Vorfallfenster`);
      return parts.join(' · ');
    };
    const timingNotes = (interval, kind) => {
      const notes = [];
      if (kind === 'device' && (!interval.measurementBasis || interval.measurementBasis === 'router-counter-timestamp')) notes.push('Routerzeit nicht mit der PC-Uhr abgeglichen');
      if (kind === 'wan') notes.push('Abfragezeitfenster; interner Zählertakt unbekannt');
      if (Number.isFinite(interval.timingUncertaintyMs) && interval.timingUncertaintyMs > 0) notes.push(`Abfrage-Zeitunsicherheit ${interval.timingUncertaintyMs.toLocaleString('de-DE', { maximumFractionDigits: 0 })} ms`);
      return notes;
    };
    const rows = [];
    const addRow = ({ source, ping = 'unbekannt', interval = 'Kein konkretes Messintervall', download = 'unbekannt', upload = 'unbekannt', note = '' }) => rows.push({ source, ping, interval, download, upload, note });
    const sourceId = window?.pc?.sourceDeviceId || incidentSource || 'local';
    const ownTargets = array(pingWindow?.targets).filter(target => target.sourceDeviceId === sourceId);
    const targetDescription = target => `${target.label || target.host || 'Ziel'} (${target.host || 'Host unbekannt'}): Ø ${latency(target.avgMs)}, max. ${latency(target.maxMs)}, Verlust ${target.lossPercent == null ? 'unbekannt' : `${target.lossPercent}%`}`;
    const pcTargets = ownTargets;
    const pingForDevice = device => {
      const match = ownTargets.find(target => device.ip && target.host === device.ip);
      return match ? targetDescription(match) : 'unbekannt · dieses Gerät wurde nicht direkt angepingt';
    };
    for (const [name, value, srcId] of [[`${sourceName(sourceId)} · PC-Adapter`, window?.pc, sourceId], ['FRITZ!Box-WAN · gesamter Anschluss', window?.wan, null]]) {
      const values = array(value?.intervals);
      if (values.length) for (const [index, interval] of values.entries()) addRow({ source: name, ping: srcId ? (pcTargets.length ? 'Siehe Pingziele dieses PCs' : 'unbekannt · keine passenden Pingdaten dieses PCs') : 'nicht einzeln zuordenbar', interval: intervalText(interval.start || interval.from, interval.end || interval.to, interval.overlapMs, interval.intervalMs, interval.overlapStart, interval.overlapEnd), download: trafficValue(interval, 'download'), upload: trafficValue(interval, 'upload'), note: [...timingNotes(interval, srcId ? 'pc' : 'wan'), interval.bytesDerived ? 'Bytewerte aus Rate abgeleitet' : '', index === 0 && value.intervalsTruncated ? 'Weitere Intervalle wegen Speichergrenze ausgelassen' : ''].filter(Boolean).join(' · ') });
      else if (value?.samples) addRow({ source: name, ping: srcId ? 'Siehe Pingziele dieses PCs' : 'nicht einzeln zuordenbar', interval: `Nur Fensterdurchschnitt · ${coverageText(value.coverage)}`, download: `Ø ${rate(value.download?.average)}`, upload: `Ø ${rate(value.upload?.average)}`, note: [srcId ? '' : 'Abfragezeitfenster; interner Zählertakt unbekannt', 'Kein einzelnes Zählerintervall verfügbar'].filter(Boolean).join(' · ') });
      else addRow({ source: name, ping: srcId ? 'Siehe Pingziele dieses PCs' : 'nicht einzeln zuordenbar', note: 'Verkehrsdaten unbekannt' });
    }
    const devices = array(window?.devices);
    for (const device of devices) {
      const name = `${device.label || 'Gerät unbekannt'}${device.ip ? ` · ${device.ip}` : ''}`;
      const detail = array(device.intervalsDetail);
      if (detail.length) for (const [index, interval] of detail.entries()) addRow({ source: `FRITZ!Box-Gerät · ${name}`, ping: pingForDevice(device), interval: intervalText(interval.start, interval.end, interval.overlapMs, interval.intervalMs, interval.overlapStart, interval.overlapEnd), download: trafficValue(interval, 'download'), upload: trafficValue(interval, 'upload'), note: [...timingNotes(interval, 'device'), interval.bytesDerived ? 'Bytewerte aus Rate abgeleitet' : '', index === 0 && device.intervalsTruncated ? 'Weitere Geräteintervalle wegen Speichergrenze ausgelassen' : ''].filter(Boolean).join(' · ') });
      else if (device.peakInterval) addRow({ source: `FRITZ!Box-Gerät · ${name}`, ping: pingForDevice(device), interval: `Spitzenintervall: ${intervalText(device.peakInterval.from, device.peakInterval.to, device.peakInterval.overlapMs, device.peakInterval.intervalMs)}`, download: rate(device.peakInterval.downloadMbps), upload: rate(device.peakInterval.uploadMbps), note: [...timingNotes(device.peakInterval, 'device'), 'Nur Spitzenintervall verfügbar; übrige Geräteintervalle fehlen'].join(' · ') });
      else if (device.coverage?.samples) addRow({ source: `FRITZ!Box-Gerät · ${name}`, ping: pingForDevice(device), interval: coverageText(device.coverage), download: rate(device.downloadMbps), upload: rate(device.uploadMbps), note: [...timingNotes(device, 'device'), 'Intervalldetails nicht verfügbar'].join(' · ') });
      else addRow({ source: `FRITZ!Box-Gerät · ${name}`, ping: pingForDevice(device), note: [...timingNotes(device, 'device'), device.reason || 'Verkehrsdaten unbekannt'].join(' · ') });
    }
    if (pcTargets.length) {
      for (const target of pcTargets) addRow({ source: `Pingziel · ${sourceName(target.sourceDeviceId)}`, ping: targetDescription(target), interval: `${time(target.firstAt)} – ${time(target.lastAt)} · ${target.sent ?? 0} Messungen`, note: 'Ping ist ICMP; kein Beleg für Spielpaketverlust' });
    } else {
      addRow({ source: 'Überwachte Pingziele', ping: 'unbekannt · keine Pingdaten dieser Messquelle', note: 'Keine zeitlich passende Messung dieser Quelle verfügbar' });
    }
    const knownDeviceCount = Number.isFinite(window?.deviceCount) ? window.deviceCount : devices.length;
    const deviceCoverage = el('p', 'incident-muted', `FRITZ!Box-Geräte: ${knownDeviceCount} mit Verkehrsdaten${Number.isFinite(window?.observedDeviceCount) ? ` · ${window.observedDeviceCount} im Snapshot beobachtet` : ''}${Number.isFinite(window?.unavailableDeviceCount) ? ` · ${window.unavailableDeviceCount} ohne verfügbare Zähler` : ''}${window?.devicesTruncated === true ? ' · Liste wegen Speichergrenze gekürzt' : ''}. Nicht aufgeführte oder nicht messbare Geräte bleiben unbekannt.`);
    group.append(deviceCoverage);
    const table = el('div', 'incident-comparison-table'); table.setAttribute('role', 'table'); table.setAttribute('aria-label', `${label}: Ping- und Datenverkehrsintervalle`);
    const headings = ['Quelle / Gerät', 'Ping im Fenster', 'Messintervall / Auflösung', 'Download / Upload'];
    const header = el('div', 'incident-comparison-row incident-comparison-head'); header.setAttribute('role', 'row');
    headings.forEach(text => { const cell = el('strong', '', text); cell.setAttribute('role', 'columnheader'); header.append(cell); }); table.append(header);
    for (const item of rows) { const row = el('div', 'incident-comparison-row'); row.setAttribute('role', 'row'); [item.source, item.ping, `${item.interval}${item.note ? ` · ${item.note}` : ''}`, `↓ ${item.download}\n↑ ${item.upload}`].forEach((text, index) => { const cell = el(index ? 'span' : 'strong', '', text); cell.setAttribute('role', 'cell'); row.append(cell); }); table.append(row); }
    group.append(table);
    if (label === 'Während') group.append(el('p', 'incident-muted', 'Die Pingwerte stammen aus überwachten ICMP-Zielen. Geräte ohne passenden IP-Ping zeigen „unbekannt“. Zählerintervalle können den Lag nur teilweise überdecken; das ist keine sekundengenaue Zuordnung.'));
    section.append(group);
  }
}
function renderPacketCaptures(parent, captures) {
  const section = heading(parent, 'Kurze Paketereignis-Mitschnitte', 'Lokale Windows-Metadaten; sie belegen weder Zustellung hinter dem Router noch allein die Vorfallsursache.');
  if (!captures.length) { bulletList(section, [], 'Kein passender kurzer Mitschnitt vorhanden.'); return; }
  const rows = el('ul', 'incident-evidence-list');
  for (const capture of captures.slice(0, 4)) {
    const relation = capture.relation === 'overlap' ? 'Überlappt den Vorfall' : capture.relation === 'after' ? 'Nach dem Vorfall' : 'Zeitbezug unbekannt';
    const losses = capture.losses || {};
    rows.append(el('li', '', `${relation} · ${time(capture.startedAt)} – ${time(capture.endedAt)} · ${capture.status || 'Status unbekannt'} · Qualität ${capture.quality || 'unbekannt'} · ${capture.retransmits ?? 'unbekannt'} Retransmits · Verluste: Ereignisse ${losses.events ?? 'unbekannt'}, Puffer ${losses.buffers ?? 'unbekannt'} · Zustellung hinter Router unbekannt.`));
  }
  section.append(rows);
}
function renderIncident(parent, incident, { compact = false, openHistory } = {}) {
  const card = el(compact ? 'article' : 'details', compact ? 'incident-card incident-card-compact' : 'incident-card');
  if (!compact) {
    card.dataset.incidentId = String(incident.id || 'unknown');
    const summary = el('summary', 'incident-card-summary');
    summary.append(el('strong', '', safeString(incident.diagnoses?.[0]?.title || incident.classification)), el('span', '', `${time(incident.startedAt)} · ${duration(incident.durationMs)}`));
    if (incident.endedAt) summary.append(el('small', '', `Ende ${time(incident.endedAt)}`));
    card.append(summary);
  } else {
    card.append(el('h3', '', safeString(incident.diagnoses?.[0]?.title || incident.classification)), el('p', 'incident-muted', `${time(incident.startedAt)} · ${duration(incident.durationMs)} · ${incident.endedAt ? 'beendet' : 'läuft'}`));
    const button = el('button', 'button button-quiet', 'Vorfall öffnen'); button.type = 'button'; button.dataset.incidentOpen = String(incident.id || 'unknown'); button.addEventListener('click', () => openHistory?.(incident.id)); card.append(button);
    return card;
  }

  return card;
}
function renderIncidentDetails(card, incident) {
  const summary = heading(card, 'Einordnung');
  summary.append(el('p', '', `Klassifikation: ${safeString(incident.diagnoses?.[0]?.title || incident.classification)} · Quelle: ${sourceName(incident.sourceDeviceId)}`));
  summary.append(el('p', 'incident-muted', `Betroffene Quellen: ${array(incident.affectedSources).join(', ') || 'unbekannt'}`));
  if (incident.pathBoundary) {
    const name = id => array(incident.pathNodes).find(node => node.id === id)?.name || id || '?';
    summary.append(el('p', '', `Eingrenzung des Pfads: ${name(incident.pathBoundary.from)} → ${name(incident.pathBoundary.to)}${incident.pathBoundary.type ? ` · ${incident.pathBoundary.type}` : ''}`));
  }
  if (pathNames(incident).length) summary.append(el('p', '', `Beobachtete Pfadknoten: ${pathNames(incident).join(' → ')}`));
  if (incident.path?.reason) summary.append(el('p', 'incident-muted', incident.path.reason));

  const windows = incident.windows || {};
  renderWindow(card, '60 Sekunden davor', windows.before || windows.pre);
  renderWindow(card, 'Während des Vorfalls', windows.during);
  renderWindow(card, '60 Sekunden danach', windows.after || windows.post);

  for (const diagnosis of array(incident.diagnoses).slice(0, 12)) {
    const section = heading(card, diagnosis.title || diagnosis.category || 'Diagnose', [diagnosis.section, diagnosis.confidence].filter(Boolean).join(' · '));
    for (const [label, key] of [['Belege', 'support'], ['Gegenbelege', 'contradictions'], ['Fehlende Daten', 'missing']]) {
      const group = el('div', 'incident-evidence-group'); group.append(el('h5', '', label)); bulletList(group, array(diagnosis[key])); section.append(group);
    }
    if (diagnosis.nextTest) section.append(el('p', 'incident-next-test', `Nächster sinnvoller Test: ${diagnosis.nextTest}`));
  }
  if (array(incident.meshChanges).length) { const section = heading(card, 'Gemeldete Mesh-Änderungen'); bulletList(section, array(incident.meshChanges).map(change => `${change.kind || 'Änderung'} · ${change.linkId || change.nodeId || 'Objekt unbekannt'} · ${time(change.interval?.from)} – ${time(change.interval?.to)}`)); }
  if (incident.traffic && typeof incident.traffic === 'object') renderTraffic(card, incident.traffic);
  if (incident.trafficComparison && typeof incident.trafficComparison === 'object') renderTrafficComparison(card, incident.trafficComparison, incident.sourceDeviceId, incident.windows || {});
  renderPacketCaptures(card, array(incident.packetCaptures));
  if (array(incident.adapterErrors).length) { const section = heading(card, 'Adapterfehler'); bulletList(section, array(incident.adapterErrors)); }
  const topology = incident.topology?.mesh || incident.topology;
  if (topology && Array.isArray(topology.nodes)) {
    const section = heading(card, 'Mesh-Topologie zum Vorfall', 'Historische Routermeldung; nicht gemeldete Zwischenzustände bleiben unbekannt.');
    renderTopology(section, topology, { evidence: { path: incident.path, nodes: array(incident.pathNodes) }, suspectLinkId: incident.pathBoundary?.linkId, comparison: incident.topology.comparison }, `incident-${incident.id || 'history'}`);
  }
  if (incident.windows?.during?.complete === false) card.append(el('p', 'incident-muted incident-window-warning', 'Das Vorfallfenster ist unvollständig; nach Ende des Rohpuffers sind möglicherweise nicht mehr alle Messungen verfügbar.'));
  const missing = [...array(incident.missing), ...array(incident.limitations)];
  const limits = heading(card, 'Grenzen und fehlende Daten'); bulletList(limits, missing, 'Keine zusätzlichen Grenzen gemeldet.');
}

export function initIncidentViews({ overview, history, request, openHistory, isHistoryActive = () => !document.querySelector('#page-history')?.hidden }) {
  let incidents = [], lastLoad = 0, loading = false, error = '';
  const openIds = new Set();
  let pendingOpenId = '';
  let historyScrollTop = 0;
  const renderOverview = () => {
    const focusedId = overview.contains(document.activeElement) ? document.activeElement.dataset.incidentOpen || '' : '';
    overview.replaceChildren();
    if (error) overview.append(el('p', 'incident-error', `Vorfallsliste nicht geladen: ${error}`));
    else if (!incidents.length) overview.append(el('p', 'incident-muted', 'Noch keine abgeschlossenen oder laufenden Vorfälle erfasst.'));
    incidents.slice(0, 4).forEach(item => overview.append(renderIncident(overview, item, { compact: true, openHistory })));
    if (incidents.length > 4) overview.append(el('p', 'incident-muted', `${incidents.length - 4} weitere Vorfälle im Verlauf.`));
    if (focusedId) overview.querySelector(`[data-incident-open="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  };
  const renderHistory = parent => {
    const previousList = parent.querySelector('.incident-history-list');
    if (previousList) {
      historyScrollTop = previousList.scrollTop;
      previousList.querySelectorAll('details[data-incident-id][open]').forEach(card => openIds.add(card.dataset.incidentId));
      previousList.querySelectorAll('details[data-incident-id]:not([open])').forEach(card => openIds.delete(card.dataset.incidentId));
    }
    parent.replaceChildren();
    parent.append(el('h3', '', 'Vorfälle')); parent.append(el('p', 'incident-muted', 'Belege, Gegenbelege und fehlende Messungen werden getrennt gezeigt. Ein Ping-Ausfall allein beweist keinen Spiel- oder TCP-Abbruch.'));
    if (error) { parent.append(el('p', 'incident-error', `Vorfallsliste nicht geladen: ${error}`)); return; }
    if (!incidents.length) { parent.append(el('p', 'incident-muted', 'Keine Vorfälle im lokalen Archiv.')); return; }
  const list = el('div', 'incident-history-list'); list.tabIndex = 0; list.setAttribute('role', 'region'); list.setAttribute('aria-label', 'Detaillierte Vorfälle – separat scrollbar');
    incidents.slice(0, 200).forEach(item => {
      const card = renderIncident(list, item);
      if (openIds.has(String(item.id || 'unknown'))) { card.open = true; renderIncidentDetails(card, item); card.dataset.populated = 'true'; }
      card.addEventListener('toggle', () => {
        if (card.open) { openIds.add(card.dataset.incidentId); if (!card.dataset.populated) { renderIncidentDetails(card, item); card.dataset.populated = 'true'; } }
        else openIds.delete(card.dataset.incidentId);
      });
      list.append(card);
    });
    parent.append(list); list.scrollTop = historyScrollTop;
    if (pendingOpenId) {
      const card = list.querySelector(`[data-incident-id="${CSS.escape(pendingOpenId)}"]`);
      if (card) { card.open = true; if (!card.dataset.populated) { const incident = incidents.find(item => String(item.id || 'unknown') === pendingOpenId); if (incident) renderIncidentDetails(card, incident); card.dataset.populated = 'true'; } card.scrollIntoView({ block: 'nearest' }); pendingOpenId = ''; }
    }
  };
  const refresh = async (force = false) => {
    if (loading || (!force && Date.now() - lastLoad < 10000)) return;
    loading = true; lastLoad = Date.now();
    try { const result = await request('/api/incidents'); incidents = array(result?.incidents); error = ''; }
    catch (e) { error = e.message || 'Unbekannter Fehler'; }
    finally {
      loading = false;
      if (!document.querySelector('#page-overview')?.hidden) renderOverview();
      if (isHistoryActive()) renderHistory(history);
    }
  };
  renderOverview();
  const open = id => {
    const key = String(id || 'unknown'); pendingOpenId = key; openIds.add(key);
    const card = history.querySelector(`[data-incident-id="${CSS.escape(key)}"]`);
    if (card) { card.open = true; if (!card.dataset.populated) { const incident = incidents.find(item => String(item.id || 'unknown') === key); if (incident) renderIncidentDetails(card, incident); card.dataset.populated = 'true'; } card.scrollIntoView({ block: 'nearest' }); pendingOpenId = ''; }
    else refresh(true);
  };
  const updateState = state => {
    const peers = Array.isArray(state?.peers) ? state.peers : Array.isArray(state?.peers?.peers) ? state.peers.peers : [];
    peerNames = new Map(peers.filter(peer => peer?.id && peer?.name).map(peer => [peer.id, peer.name]));
  };
  return { refresh, renderHistory, renderOverview, open, updateState, get incidents() { return incidents; } };
}
