import { trafficSources } from './traffic-history.js';

const list = value => Array.isArray(value) ? value : [];
const timestamp = value => Date.parse(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const countNumber = value => number(value) != null && value >= 0 ? value : null;
const fmt = (value, digits = 1) => Number(value).toLocaleString('de-DE', { maximumFractionDigits: digits });
const time = value => new Date(value).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const epochKey = record => [record.appSessionId || 'legacy-app', record.measurementStartedAt || 'legacy-measurement', record.sessionId || 'legacy-session', record.epoch ?? 'legacy-epoch', record.interfaceId || record.adapterId || 'legacy-adapter'].join(':');
const sessionMatches = (point, phase) => (!phase.appSessionId || point.appSessionId === phase.appSessionId)
  && (!phase.measurementStartedAt || point.measurementStartedAt === phase.measurementStartedAt)
  && (phase.epoch == null || point.measurementEpoch == null || point.measurementEpoch === phase.epoch);

function classifyResult(result, at, thresholdMs) {
  if (result.status === 'measurement_error') return { kind: 'measurement_error', host: result.host, label: result.label || result.name || result.host, at, error: result.error || '' };
  if (result.ok === true && number(result.ms) != null && result.ms >= 0) {
    const ms = Number(result.ms);
    return ms > thresholdMs ? { kind: 'latency', host: result.host, label: result.label || result.name || result.host, at, ms } : null;
  }
  if (result.ok === false) return { kind: 'loss', host: result.host, label: result.label || result.name || result.host, at, status: result.status || 'no_reply' };
  return null;
}

export function summarizeLagWindow(records, selectedHosts, phase, from, to) {
  const selected = new Set(selectedHosts || []);
  const seen = new Set();
  const byHost = new Map([...selected].map(host => [host, { host, samples: 0, answers: 0, lost: 0, errors: 0, pingSum: 0, maxPing: null }]));
  for (const record of records) {
    if (epochKey(record) !== phase.epochKey) continue;
    const at = timestamp(record.at);
    if (!Number.isFinite(at) || at < from || at > to) continue;
    for (const result of list(record.results)) {
      const stats = byHost.get(result.host);
      if (!stats) continue;
      const signature = JSON.stringify([epochKey(record), at, result.host, result.ok, result.ms, result.status, result.error]);
      if (seen.has(signature)) continue;
      seen.add(signature);
      stats.samples += 1;
      if (result.status === 'measurement_error') { stats.errors += 1; continue; }
      if (result.ok === true && number(result.ms) != null && result.ms >= 0) {
        stats.answers += 1; stats.pingSum += Number(result.ms);
        stats.maxPing = stats.maxPing == null ? Number(result.ms) : Math.max(stats.maxPing, Number(result.ms));
      } else if (result.ok === false) stats.lost += 1;
    }
  }
  return [...byHost.values()].map(stats => ({ ...stats,
    averagePing: stats.answers ? stats.pingSum / stats.answers : null,
    lossPercent: stats.answers + stats.lost ? stats.lost / (stats.answers + stats.lost) * 100 : null
  }));
}

export function buildLagPhases(pingRecords, selectedHosts, { thresholdMs = 30, maxGapMs = 10000 } = {}) {
  const selected = new Set(selectedHosts || []);
  if (!selected.size) return [];
  const records = list(pingRecords).map(record => ({ record, at: timestamp(record.at), epochKey: epochKey(record) }))
    .filter(item => Number.isFinite(item.at)).sort((a, b) => a.at - b.at);
  const streams = new Map();
  for (const item of records) {
    const key = item.epochKey;
    let frames = streams.get(key); if (!frames) streams.set(key, frames = []);
    let frame = frames.at(-1);
    if (!frame || frame.at !== item.at) { frame = { at: item.at, epochKey: key, record: item.record, seen: new Set(), events: { network: [], measurement_error: [] } }; frames.push(frame); }
    for (const result of list(item.record.results)) {
      if (!selected.has(result.host)) continue;
      const signature = JSON.stringify([result.host, result.ok, result.ms, result.status, result.error]);
      if (frame.seen.has(signature)) continue;
      frame.seen.add(signature);
      const event = classifyResult(result, item.at, thresholdMs);
      if (event) frame.events[event.kind === 'measurement_error' ? 'measurement_error' : 'network'].push(event);
    }
  }
  const phases = [];
  const close = phase => {
    if (!phase) return;
    const samples = [...new Set(phase.events.map(event => event.at))];
    const errors = phase.events.filter(event => event.kind === 'measurement_error');
    const latencyEvents = phase.events.filter(event => event.kind === 'latency');
    const losses = phase.events.filter(event => event.kind === 'loss');
    const targetCounts = new Map();
    for (const event of phase.events) {
      let summary = targetCounts.get(event.host);
      if (!summary) targetCounts.set(event.host, summary = { host: event.host, label: event.label || event.host, count: 0, latencyCount: 0, lossCount: 0, errorCount: 0, maxPing: null });
      summary.count += 1;
      if (event.kind === 'latency') { summary.latencyCount += 1; summary.maxPing = summary.maxPing == null ? event.ms : Math.max(summary.maxPing, event.ms); }
      if (event.kind === 'loss') summary.lossCount += 1;
      if (event.kind === 'measurement_error') summary.errorCount += 1;
    }
    phase.start = samples.reduce((min, value) => Math.min(min, value), Infinity); phase.end = samples.reduce((max, value) => Math.max(max, value), -Infinity); phase.sampleCount = samples.length;
    phase.durationMs = phase.end - phase.start; phase.isIsolated = phase.sampleCount === 1;
    phase.maxPing = latencyEvents.length ? latencyEvents.reduce((max, event) => Math.max(max, event.ms), -Infinity) : null;
    phase.lossCount = losses.length; phase.measurementErrorCount = errors.length;
    phase.targetCounts = [...targetCounts.values()].sort((a, b) => b.count - a.count);
    phase.title = phase.kind === 'measurement_error' ? 'Messfehler' : latencyEvents.length && losses.length ? 'Ping-Spitzen und Paketverlust' : latencyEvents.length ? 'Hoher Ping' : 'Ping-Verlust';
    phases.push(phase);
  };
  for (const [key, frames] of streams) {
    for (const kind of ['network', 'measurement_error']) {
      let active = null;
      for (const frame of frames) {
        const events = frame.events[kind];
        if (!events.length) { close(active); active = null; continue; }
        if (active && frame.at - active.lastAt > maxGapMs) { close(active); active = null; }
        if (!active) active = { id: `${kind}:${key}:${frame.at}`, kind, epochKey: key, appSessionId: frame.record.appSessionId || null, measurementStartedAt: frame.record.measurementStartedAt || null, sessionId: frame.record.sessionId || null, epoch: frame.record.epoch ?? null, interfaceId: frame.record.interfaceId || frame.record.adapterId || null, events: [], lastAt: frame.at };
        active.lastAt = frame.at; active.events.push(...events);
      }
      close(active);
    }
  }
  return phases.sort((a, b) => b.start - a.start || a.id.localeCompare(b.id));
}

function summarizeRatePoints(points, phase, sourceId) {
  const matches = point => sessionMatches(point, phase) && !(sourceId === 'pc' && phase.interfaceId && point.interfaceId !== phase.interfaceId);
  const radius = phase.start === phase.end ? 1000 : 0;
  const from = phase.start - radius, to = phase.end + radius;
  let low = 0, high = points.length;
  while (low < high) { const middle = (low + high) >> 1; if (timestamp(points[middle].at) < from) low = middle + 1; else high = middle; }
  const candidates = points.slice(low).filter(point => timestamp(point.at) <= to);
  let chosen = candidates.filter(point => matches(point) && Number.isFinite(timestamp(point.at)) && timestamp(point.at) >= phase.start && timestamp(point.at) <= phase.end);
  let offsets = [];
  if (phase.start === phase.end && !chosen.length) {
    const nearest = candidates.filter(point => matches(point) && Number.isFinite(timestamp(point.at)))
      .map(point => ({ point, offset: timestamp(point.at) - phase.start })).filter(item => Math.abs(item.offset) <= 1000).sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))[0];
    if (nearest) { chosen = [nearest.point]; offsets = [nearest.offset]; }
  }
  const summarize = key => {
    const values = chosen.map(point => number(point[key])).filter(value => value != null && value >= 0);
    return { average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, peak: values.length ? values.reduce((max, value) => Math.max(max, value), -Infinity) : null, count: values.length };
  };
  return { download: summarize('downloadMbps'), upload: summarize('uploadMbps'), samples: chosen.length, offsets,
    points: chosen.map(point => ({ at: point.at, downloadMbps: number(point.downloadMbps), uploadMbps: number(point.uploadMbps) })) };
}

function intervalOverlap(point, phase) {
  const rawStart = timestamp(point.intervalStartedAt), end = timestamp(point.at);
  const measurementStart = timestamp(phase.measurementStartedAt);
  const start = Number.isFinite(measurementStart) ? Math.max(rawStart, measurementStart) : rawStart;
  const downloadBytes = countNumber(point.downloadDeltaBytes), uploadBytes = countNumber(point.uploadDeltaBytes);
  const reportedDownloadMbps = number(point.downloadMbps), reportedUploadMbps = number(point.uploadMbps);
  if (!Number.isFinite(rawStart) || !Number.isFinite(end) || end <= rawStart || end <= start || downloadBytes == null || uploadBytes == null || reportedDownloadMbps == null || reportedUploadMbps == null) return null;
  const intervalMs = end - rawStart;
  if (intervalMs > 90000) return null;
  const downloadMbps = downloadBytes / intervalMs * .008, uploadMbps = uploadBytes / intervalMs * .008;
  if (!sessionMatches(point, phase)) return null;
  if (phase.start === phase.end) {
    if (phase.start < start || phase.start > end) return null;
    return { start, end, intervalMs, overlapMs: 0, downloadBytes, uploadBytes, downloadMbps, uploadMbps, samplePoint: true };
  }
  const overlapMs = Math.max(0, Math.min(end, phase.end) - Math.max(start, phase.start));
  if (!overlapMs) return null;
  const share = overlapMs / intervalMs;
  return { start, end, intervalMs, overlapMs, downloadBytes, uploadBytes, downloadMbps, uploadMbps,
    estimatedDownloadBytes: downloadBytes * share, estimatedUploadBytes: uploadBytes * share, share, samplePoint: false };
}

export function prepareLagTraffic(records) {
  const history = list(records).filter(record => record.type === 'traffic' || record.type === 'fritzbox').sort((a, b) => timestamp(a.at) - timestamp(b.at));
  return { sources: trafficSources(history), capabilityReason: history.filter(record => record.type === 'fritzbox').at(-1)?.deviceTrafficCapability?.reason || null, truncated: history.some(record => record.deviceTrafficTruncated === true) };
}

export function correlateLagTraffic(recordsOrIndex, phase) {
  const index = Array.isArray(recordsOrIndex) ? prepareLagTraffic(recordsOrIndex) : recordsOrIndex;
  const sources = list(index?.sources);
  const pc = summarizeRatePoints(sources.find(source => source.id === 'pc')?.points || [], phase, 'pc');
  const wan = summarizeRatePoints(sources.find(source => source.id === 'wan')?.points || [], phase, 'wan');
  const devices = [];
  for (const source of sources.filter(item => item.kind === 'device')) {
    const candidates = new Map();
    for (const point of source.points) {
      const overlap = intervalOverlap(point, phase); if (!overlap) continue;
      const key = `${overlap.start}:${overlap.end}`;
      const previous = candidates.get(key);
      if (!previous || timestamp(point.at) >= timestamp(previous.point.at)) candidates.set(key, { point, overlap });
    }
    const unique = [...candidates.values()].sort((a, b) => b.overlap.end - a.overlap.end);
    const accepted = [];
    for (const candidate of unique) {
      if (accepted.some(item => candidate.overlap.start < item.overlap.end && candidate.overlap.end > item.overlap.start)) continue;
      accepted.push(candidate);
    }
    if (!accepted.length) continue;
    const weight = item => phase.start === phase.end ? item.overlap.intervalMs : item.overlap.overlapMs;
    const totalWeight = accepted.reduce((sum, item) => sum + weight(item), 0);
    devices.push({ id: source.id, label: source.label, ip: source.ip || '', mac: source.mac || '', intervals: accepted.length,
      intervalRateDownloadMbps: accepted.reduce((sum, item) => sum + item.overlap.downloadMbps * weight(item), 0) / totalWeight,
      intervalRateUploadMbps: accepted.reduce((sum, item) => sum + item.overlap.uploadMbps * weight(item), 0) / totalWeight,
      estimatedDownloadBytes: phase.start === phase.end ? null : accepted.reduce((sum, item) => sum + item.overlap.estimatedDownloadBytes, 0),
      estimatedUploadBytes: phase.start === phase.end ? null : accepted.reduce((sum, item) => sum + item.overlap.estimatedUploadBytes, 0),
      intervalsDetail: accepted.map(item => ({ start: item.overlap.start, end: item.overlap.end, overlapMs: item.overlap.overlapMs, intervalMs: item.overlap.intervalMs, downloadMbps: item.overlap.downloadMbps, uploadMbps: item.overlap.uploadMbps })) });
  }
  devices.sort((a, b) => phase.start === phase.end
    ? (b.intervalRateDownloadMbps + b.intervalRateUploadMbps) - (a.intervalRateDownloadMbps + a.intervalRateUploadMbps)
    : ((b.estimatedDownloadBytes || 0) + (b.estimatedUploadBytes || 0)) - ((a.estimatedDownloadBytes || 0) + (a.estimatedUploadBytes || 0)));
  return { pc, wan, devices, pointPhase: phase.start === phase.end,
    capabilityReason: index?.capabilityReason || null, truncated: index?.truncated === true };
}

function el(tag, className, text) {
  const item = document.createElement(tag); if (className) item.className = className; if (text != null) item.textContent = text; return item;
}

function helpNote(item, text) { item.title=text; item.dataset.help=text; return item; }

function rateText(summary) {
  if (!summary.samples) return 'Keine Messpunkte';
  const dir = (label, value) => `${label} ${value.average == null ? '–' : `${fmt(value.average)} Mbit/s`}${value.count ? ` (Max. ${fmt(value.peak)}; ${value.count} Messpunkte)` : ''}`;
  return `${dir('↓', summary.download)} · ${dir('↑', summary.upload)}${summary.offsets?.length ? ` · Messzeit ${summary.offsets[0] === 0 ? 'genau' : `${fmt(Math.abs(summary.offsets[0] / 1000), 2)} s ${summary.offsets[0] < 0 ? 'davor' : 'danach'}`}` : ''}`;
}

function appendWindowTable(container, records, selectedHosts, phase) {
  const windows = [
    { label: '30 s davor', start: phase.start - 30000, end: phase.start - 1 },
    { label: phase.isIsolated ? 'Lag-Messpunkt' : 'Lag-Phasen-Messpunkte', start: phase.start, end: phase.end },
    { label: '30 s danach', start: phase.end + 1, end: phase.end + 30000 }
  ];
  const table = el('div', 'lag-window-table'); table.setAttribute('role', 'table');
  const header = el('div', 'lag-window-row lag-window-header'); header.setAttribute('role', 'row');
  for (const label of ['Zeitraum / Ziel', 'Messpunkte', 'Ø Ping', 'Max. Ping', 'Verlust', 'Messfehler']) { const cell = el('strong', '', label); cell.setAttribute('role', 'columnheader'); header.append(cell); }
  table.append(header);
  for (const window of windows) {
    const summaries = summarizeLagWindow(records, selectedHosts, phase, window.start, window.end);
    if (!summaries.length) {
      const empty = el('div', 'lag-window-empty', `${window.label}: keine Ziele ausgewählt.`); table.append(empty); continue;
    }
    for (const stats of summaries) {
      const row = el('div', 'lag-window-row'); row.setAttribute('role', 'row');
      const label = el('strong', '', `${window.label} · ${stats.host}`); label.setAttribute('role', 'cell'); row.append(label);
      for (const text of [`${stats.samples}`, stats.averagePing == null ? '–' : `${fmt(stats.averagePing)} ms`, stats.maxPing == null ? '–' : `${fmt(stats.maxPing)} ms`, stats.answers + stats.lost ? `${fmt(stats.lossPercent)} % (${stats.lost}/${stats.answers + stats.lost})` : '–', `${stats.errors}`]) { const cell = el('span', '', text); cell.setAttribute('role', 'cell'); row.append(cell); }
      table.append(row);
    }
  }
  container.append(table);
}

function appendRateSummary(container, label, summary) {
  const item = el('p', 'lag-traffic-rate'); item.append(el('strong', '', `${label}: `), document.createTextNode(rateText(summary))); container.append(item);
}

export function createLagPhaseSection({ pingRecords = [], selectedHosts = [], trafficRecords = [], onShowWindow = () => {}, historyTruncated = false } = {}) {
  selectedHosts = [...selectedHosts];
  const section = el('details', 'lag-phases'); section.open = true;
  const phases = buildLagPhases(pingRecords, selectedHosts);
  const summary = el('summary', 'lag-phases-summary');
  summary.append(el('strong', '', 'Lag-Phasen'), el('span', '', `${phases.length} beobachtete Phase${phases.length === 1 ? '' : 'n'}`)); section.append(summary);
  section.append(helpNote(el('p', 'lag-phases-intro', 'Lag-Phasen zeigen Ping-Spitzen und unbeantwortete Pings.'),'Erkennung basiert auf den angehakten Ping-Zielen und einem Grenzwert über 30 ms. Genau 30 ms ist unauffällig; Messfehler bleiben getrennt. Eine Messpunktspanne belegt keine durchgehende Störung und zeitgleicher Datenverkehr keine Ursache.'));
  if (historyTruncated) section.append(helpNote(el('p', 'lag-coverage-note', 'Der gespeicherte Verlauf ist gekürzt.'),'Die angezeigte Abdeckung umfasst nur geladene Messungen.'));
  if (!selectedHosts.length) { section.append(el('div', 'history-empty', 'Wähle Ping-Ziele oben an, um Lag-Phasen zu bilden.')); return section; }
  if (!phases.length) { section.append(el('div', 'history-empty', 'Keine Ping-Spitzen über 30 ms, Paketverluste oder Messfehler in den angehakten Messungen.')); return section; }
  const trafficIndex = prepareLagTraffic(trafficRecords);
  const listRegion = el('div', 'lag-phases-list'); listRegion.tabIndex = 0; listRegion.setAttribute('role', 'region'); listRegion.setAttribute('aria-label', 'Lag-Phasen, separat scrollbar');
  const visiblePhases = phases.slice(0, 100);
  section.append(helpNote(el('p', 'lag-coverage-note', `${visiblePhases.length} neueste von ${phases.length} Phasen geladen.`),'Ältere Phasen bleiben im Verlauf gespeichert; die Liste scrollt separat.'), listRegion);
  for (const phase of visiblePhases) {
    const card = el('details', 'lag-phase');
    const title = phase.kind === 'measurement_error' ? 'Messfehler' : phase.isIsolated && phase.lossCount ? 'Einzelner Ping-Verlust' : phase.isIsolated ? 'Einzelner Lag-Spike' : phase.title;
    const header = el('summary', 'lag-phase-summary');
    header.append(el('strong', '', title), el('time', '', phase.start === phase.end ? time(phase.start) : `${time(phase.start)} – ${time(phase.end)}`));
    header.append(el('span', '', phase.kind === 'measurement_error' ? `${phase.measurementErrorCount} Messfehler` : `${phase.sampleCount} auffällige Messzeitpunkte · ${phase.lossCount} Verlust${phase.lossCount === 1 ? '' : 'e'}${phase.maxPing == null ? '' : ` · Max. ${fmt(phase.maxPing)} ms`}`));
    card.append(header);
    card.append(helpNote(el('p', 'lag-phase-coverage', phase.isIsolated
      ? 'Ein einzelner Zeitpunkt ist belegt.'
      : `Messpunktspanne ${fmt(phase.durationMs / 1000, 1)} s.`),phase.isIsolated
      ? 'Aus einem Einzelmesspunkt lässt sich keine Störungsdauer ableiten.'
      : 'Nicht gemessene Zeit zwischen den Abfragen bleibt unbekannt.'));
    const targetList = el('ul', 'lag-phase-targets');
    for (const target of phase.targetCounts) {
      const parts = [];
      if (target.latencyCount) parts.push(`${target.latencyCount}× über 30 ms${target.maxPing == null ? '' : `, Max. ${fmt(target.maxPing)} ms`}`);
      if (target.lossCount) parts.push(`${target.lossCount}× keine Antwort`);
      if (target.errorCount) parts.push(`${target.errorCount}× Messfehler`);
      targetList.append(el('li', '', `${target.label} (${target.host}): ${parts.join(' · ')}`));
    }
    card.append(targetList);
    const zoom = el('button', 'button button-quiet lag-show-chart', 'Im Diagramm zeigen'); zoom.type = 'button'; zoom.addEventListener('click', () => onShowWindow(phase.start - 30000, phase.end + 30000)); card.append(zoom);
    const details = el('details', 'lag-phase-details'); details.append(el('summary', '', 'Messwerte und Datenverkehr anzeigen'));
    let populated = false;
    details.addEventListener('toggle', () => {
      if (!details.open || populated) return;
      populated = true;
      const comparisons = el('details', 'lag-phase-comparisons'); comparisons.append(el('summary', '', '30 s davor / Phase / 30 s danach je Ping-Ziel'));
      appendWindowTable(comparisons, pingRecords, selectedHosts, phase); details.append(comparisons);
      const traffic = correlateLagTraffic(trafficIndex, phase);
      const trafficSection = el('div', 'lag-phase-traffic');
      trafficSection.append(el('h4', '', 'Zeitgleicher Datenverkehr · getrennte Quellen'));
      appendRateSummary(trafficSection, 'Dieser PC', traffic.pc); appendRateSummary(trafficSection, 'FRITZ!Box-WAN', traffic.wan);
      trafficSection.append(helpNote(el('p', 'lag-traffic-note', 'PC, WAN und Geräte werden getrennt gemessen.'),'Diese Messsichten werden nicht zusammengezählt.'));
      const deviceTitle = traffic.pointPhase ? 'Geräte mit einem Zählerintervall über dem Lag-Messpunkt' : 'Geräteverkehr in überlappenden FRITZ!Box-Zählerintervallen';
      trafficSection.append(el('strong', 'lag-traffic-device-title', deviceTitle));
      if (!traffic.devices.length) {
        const reason = traffic.capabilityReason;
        trafficSection.append(reason?el('p','lag-traffic-note',reason):helpNote(el('p', 'lag-traffic-note', 'Keine passenden Geräte-Zählerintervalle.'),'Fehlende, unvollständige oder veraltete FRITZ!Box-Zähler bleiben unbekannt.'));
      } else {
        const rows = el('ol', 'lag-traffic-devices'); rows.tabIndex = 0; rows.setAttribute('role', 'region'); rows.setAttribute('aria-label', 'Geräte mit zeitgleichen FRITZ!Box-Zählerintervallen, separat scrollbar');
        trafficSection.append(helpNote(el('p', 'lag-traffic-note', `${Math.min(traffic.devices.length, 100)} von ${traffic.devices.length} Geräten.`),'Die Geräte sind nach Datenmenge sortiert; die Liste scrollt separat.'));
        for (const device of traffic.devices.slice(0, 100)) {
        const identity = [device.ip, device.mac].filter(Boolean).join(' · ');
        const rate = `↓ ${fmt(device.intervalRateDownloadMbps)} / ↑ ${fmt(device.intervalRateUploadMbps)} Mbit/s (Mittel des/der Zählerintervalle)`;
        const amount = device.estimatedDownloadBytes == null ? 'Verbrauch innerhalb eines einzelnen Ping-Messpunkts nicht zeitlich auflösbar.' : `Geschätzt im überlappenden Zeitanteil: ↓ ${fmt(device.estimatedDownloadBytes / 1048576, 2)} MiB · ↑ ${fmt(device.estimatedUploadBytes / 1048576, 2)} MiB.`;
        const li = el('li', 'lag-traffic-device'); li.append(el('strong', '', `${device.label}${identity ? ` · ${identity}` : ''}`), el('span', '', rate), el('small', '', amount)); rows.append(li);
      }
        trafficSection.append(rows);
        if (traffic.devices.length > 100) trafficSection.append(helpNote(el('p', 'lag-coverage-note', 'Weitere Geräte sind gespeichert.'),'Sie werden hier zur Übersichtlichkeit nicht angezeigt.'));
        trafficSection.append(helpNote(el('p', 'lag-traffic-note', traffic.pointPhase
        ? 'Der Einzelmesspunkt enthält keinen auflösbaren Geräteverbrauch.'
        : 'Geräteverbrauch im überlappenden Zeitfenster geschätzt.'),traffic.pointPhase
        ? 'Die FRITZ!Box-Zähler sind Intervalle. Das Intervall enthält den Ping-Messpunkt, belegt aber keinen exakt zeitgleichen Geräteverbrauch.'
        : 'Die Schätzung nutzt Byte-Deltas und die Zeitüberlappung, da die Box Intervallmittel liefert. Hoher Verkehr oder Updates sind eine zeitliche Korrelation, kein Schuldbeweis.'));
      }
      if (traffic.truncated) trafficSection.append(helpNote(el('p', 'lag-coverage-note', 'Mindestens eine FRITZ!Box-Geräteliste wurde gekürzt.'),'Die Kürzung erfolgte beim Speichern.'));
      trafficSection.append(helpNote(el('p', 'lag-traffic-note', 'Nur vorhandene Messwerte werden angezeigt.'),'Es werden nur Messwerte aus genau diesem Zeitfenster einbezogen. Fehlende Werte sind keine Nullwerte.'));
      details.append(trafficSection);
    });
    card.append(details); listRegion.append(card);
  }
  return section;
}
