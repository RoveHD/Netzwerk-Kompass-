import { trafficSources } from './traffic-history.js';

const list = value => Array.isArray(value) ? value : [];
const timestamp = value => Date.parse(value);
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const countNumber = value => number(value) != null && value >= 0 ? value : null;
const MAX_SOURCE_INTERVAL_ROWS = 50;
const MAX_DEVICE_INTERVAL_ROWS = 5;
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
    return ms >= thresholdMs ? { kind: 'latency', host: result.host, label: result.label || result.name || result.host, at, ms } : null;
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

export function buildLagPhases(pingRecords, selectedHosts, { thresholdMs = 100, maxGapMs = 10000 } = {}) {
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
    points: chosen.map(point => ({ at: point.at, downloadMbps: number(point.downloadMbps), uploadMbps: number(point.uploadMbps), downstreamMbps: point.downstreamMbps, upstreamMbps: point.upstreamMbps })) };
}

function intervalOverlap(point, phase) {
  if(point.timeAlignment==='invalid-future')return null;
  const rawStart = timestamp(point.intervalStartedAt), end = timestamp(point.at);
  const measurementStart = timestamp(phase.measurementStartedAt);
  const start = Number.isFinite(measurementStart) ? Math.max(rawStart, measurementStart) : rawStart;
  const downloadBytes = countNumber(point.downloadDeltaBytes), uploadBytes = countNumber(point.uploadDeltaBytes);
  if (!Number.isFinite(rawStart) || !Number.isFinite(end) || end <= rawStart || end <= start || downloadBytes == null || uploadBytes == null || point.rateAvailable === false) return null;
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

function summarizeIntervals(points, phase, sourceId) {
  const candidates = [];
  for (const point of points) {
    if (!point.intervalStartedAt || !sessionMatches(point, phase) || (sourceId === 'pc' && phase.interfaceId && point.interfaceId !== phase.interfaceId)) continue;
    const overlap = intervalOverlap(point, phase);
    if (overlap) candidates.push({ point, overlap });
  }
  candidates.sort((a, b) => a.overlap.start - b.overlap.start || a.overlap.end - b.overlap.end);
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some(item => candidate.overlap.start < item.overlap.end && candidate.overlap.end > item.overlap.start)) continue;
    accepted.push(candidate);
  }
  if (!accepted.length) return null;
  const weight = item => phase.start === phase.end ? item.overlap.intervalMs : item.overlap.overlapMs;
  const totalWeight = accepted.reduce((sum, item) => sum + weight(item), 0);
  const average = (key) => accepted.reduce((sum, item) => sum + item.overlap[key] * weight(item), 0) / totalWeight;
  const direction = (rateKey, byteKey, estimatedKey) => ({
    average: average(rateKey), peak: Math.max(...accepted.map(item => item.overlap[rateKey])), count: accepted.length,
    intervalBytes: accepted.reduce((sum, item) => sum + item.overlap[byteKey], 0),
    estimatedPhaseBytes: phase.start === phase.end ? null : accepted.reduce((sum, item) => sum + item.overlap[estimatedKey], 0)
  });
  return {
    download: direction('downloadMbps', 'downloadBytes', 'estimatedDownloadBytes'),
    upload: direction('uploadMbps', 'uploadBytes', 'estimatedUploadBytes'),
    samples: accepted.length, offsets: [],
    intervals: accepted.map(({ point, overlap }) => ({
      start: point.intervalStartedAt, end: point.at,
      downloadBytes: overlap.downloadBytes, uploadBytes: overlap.uploadBytes,
      bytesDerived: point.bytesDerived === true,
      measurementBasis: typeof point.measurementBasis === 'string' ? point.measurementBasis.slice(0, 160) : null,
      timingUncertaintyMs: countNumber(point.timingUncertaintyMs),
      downloadMbps: overlap.downloadMbps, uploadMbps: overlap.uploadMbps,
      overlapMs: overlap.overlapMs, intervalMs: overlap.intervalMs,
      downstreamMbps: point.downstreamMbps, upstreamMbps: point.upstreamMbps,
      estimatedDownloadBytes: overlap.estimatedDownloadBytes ?? null,
      estimatedUploadBytes: overlap.estimatedUploadBytes ?? null
    }))
  };
}

function summarizeSource(points, phase, sourceId) {
  return summarizeIntervals(points, phase, sourceId) || summarizeRatePoints(points.filter(point => !point.intervalStartedAt), phase, sourceId);
}

export function prepareLagTraffic(records) {
  const history = list(records).filter(record => record.type === 'traffic' || record.type === 'fritzbox').sort((a, b) => timestamp(a.at) - timestamp(b.at));
  return { sources: trafficSources(history), capabilityReason: history.filter(record => record.type === 'fritzbox' && record.deviceTrafficCapability).at(-1)?.deviceTrafficCapability?.reason || null, truncated: history.some(record => record.deviceTrafficTruncated === true) };
}

export function correlateLagTraffic(recordsOrIndex, phase) {
  const index = Array.isArray(recordsOrIndex) ? prepareLagTraffic(recordsOrIndex) : recordsOrIndex;
  const sources = list(index?.sources);
  const pcSource = sources.find(source => source.id === 'pc');
  const wanSource = sources.find(source => source.id === 'wan');
  const pc = summarizeSource(pcSource?.points || [], phase, 'pc');
  const wan = summarizeSource(wanSource?.points || [], phase, 'wan');
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
      intervalDownloadBytes: accepted.reduce((sum, item) => sum + item.overlap.downloadBytes, 0),
      intervalUploadBytes: accepted.reduce((sum, item) => sum + item.overlap.uploadBytes, 0),
      intervalsDetail: accepted.map(item => ({ start: item.point.intervalStartedAt, end: item.point.at,
        overlapStart: new Date(Math.max(item.overlap.start, phase.start)).toISOString(), overlapEnd: new Date(Math.min(item.overlap.end, phase.end)).toISOString(),
        overlapMs: item.overlap.overlapMs, intervalMs: item.overlap.intervalMs, downloadBytes: item.overlap.downloadBytes, uploadBytes: item.overlap.uploadBytes,
        bytesDerived: item.point.bytesDerived === true,
        measurementBasis: typeof item.point.measurementBasis === 'string' ? item.point.measurementBasis.slice(0, 160) : null,
        timingUncertaintyMs: countNumber(item.point.timingUncertaintyMs),
        estimatedDownloadBytes: item.overlap.estimatedDownloadBytes ?? null, estimatedUploadBytes: item.overlap.estimatedUploadBytes ?? null, downloadMbps: item.overlap.downloadMbps, uploadMbps: item.overlap.uploadMbps })) });
  }
  devices.sort((a, b) => phase.start === phase.end
    ? (b.intervalRateDownloadMbps + b.intervalRateUploadMbps) - (a.intervalRateDownloadMbps + a.intervalRateUploadMbps)
    : ((b.estimatedDownloadBytes || 0) + (b.estimatedUploadBytes || 0)) - ((a.estimatedDownloadBytes || 0) + (a.estimatedUploadBytes || 0)));
  const capacityPercent = (rateKey, capacityKey, intervals = [], points = []) => {
    const uniquePoints = [...new Map(points.map(item => [item.at, item])).values()];
    const values = intervals.length
      ? intervals.map(item => ({ rate: item[rateKey], capacity: item[capacityKey], weight: phase.start === phase.end ? item.intervalMs : item.overlapMs }))
      : uniquePoints.map(item => ({ rate: item[rateKey], capacity: item[capacityKey], weight: 1 }));
    const known = values.filter(item => number(item.rate) != null && number(item.capacity) > 0 && number(item.weight) > 0);
    const totalWeight = known.reduce((sum, item) => sum + item.weight, 0);
    return totalWeight ? known.reduce((sum, item) => sum + item.rate / item.capacity * 100 * item.weight, 0) / totalWeight : null;
  };
  const wanUtilization = {
    downloadPercent: capacityPercent('downloadMbps', 'downstreamMbps', wan.intervals || [], wan.points || []),
    uploadPercent: capacityPercent('uploadMbps', 'upstreamMbps', wan.intervals || [], wan.points || [])
  };
  wanUtilization.overload = [wanUtilization.downloadPercent, wanUtilization.uploadPercent].some(value => value != null && value >= 90);
  return { pc, wan, wanUtilization, devices, pointPhase: phase.start === phase.end,
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

function formatMiB(bytes) { return bytes == null ? '–' : `${fmt(bytes / 1048576, 2)} MiB`; }

function applyDisclosure(details, key, disclosureState, defaultOpen = false) {
  details.dataset.disclosureKey = key;
  details.open = disclosureState.has(key) ? disclosureState.get(key) === true : defaultOpen;
}

function appendTrafficDirection(container, label, value) {
  const p = el('p', 'lag-traffic-rate');
  const totals = value.intervalBytes == null ? '' : ` · ganzes Zählerintervall ${formatMiB(value.intervalBytes)}`;
  const estimate = value.estimatedPhaseBytes == null ? '' : ` · Phase geschätzt ${formatMiB(value.estimatedPhaseBytes)}`;
  p.append(el('strong', '', `${label}: `), document.createTextNode(`${value.average == null ? '–' : `${fmt(value.average)} Mbit/s`}${totals}${estimate}`));
  container.append(p);
}

function topDeviceLabel(traffic) {
  const device = traffic.devices[0];
  if (!device) return 'Kein passender Geräte-Zähler';
  if (traffic.pointPhase) return `Höchster Durchsatz: ${device.label} (${fmt(device.intervalRateDownloadMbps + device.intervalRateUploadMbps)} Mbit/s)`;
  const bytes = (device.estimatedDownloadBytes || 0) + (device.estimatedUploadBytes || 0);
  return bytes ? `Meiste geschätzte Phasenmenge: ${device.label} (${formatMiB(bytes)})` : `Höchster Durchsatz: ${device.label}`;
}

function appendTrafficIntervals(container, intervals, pointPhase, scrollKey) {
  const list = el('ol', 'lag-traffic-intervals');
  list.dataset.scrollKey = scrollKey;
  for (const interval of intervals.slice(0, MAX_SOURCE_INTERVAL_ROWS)) {
    const item = el('li', 'lag-traffic-interval');
    const range = `${time(interval.start)} – ${time(interval.end)}`;
    const total = `${interval.bytesDerived ? 'Aus Rate × Intervall berechnet' : 'Ganzes Zählerintervall'}: ↓ ${formatMiB(interval.downloadBytes)} · ↑ ${formatMiB(interval.uploadBytes)}`;
    const rate = `↓ ${fmt(interval.downloadMbps)} / ↑ ${fmt(interval.uploadMbps)} Mbit/s`;
    const estimate = pointPhase || interval.estimatedDownloadBytes == null ? '' : ` · Phase geschätzt ↓ ${formatMiB(interval.estimatedDownloadBytes)} / ↑ ${formatMiB(interval.estimatedUploadBytes)}`;
    item.append(el('strong', '', range), el('span', '', `${total} · ${rate}${estimate}`));
    list.append(item);
  }
  container.append(list);
  if (intervals.length > MAX_SOURCE_INTERVAL_ROWS) container.append(el('p', 'lag-traffic-note', `${intervals.length - MAX_SOURCE_INTERVAL_ROWS} weitere Zählerintervalle ausgeblendet.`));
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

export function createLagPhaseSection({ pingRecords = [], selectedHosts = [], trafficRecords = [], onShowWindow = () => {}, historyTruncated = false, disclosureState = new Map() } = {}) {
  selectedHosts = [...selectedHosts];
  const section = el('details', 'lag-phases'); section.id = 'history-lag-traffic'; applyDisclosure(section, 'lag-phases', disclosureState, true);
  const phases = buildLagPhases(pingRecords, selectedHosts);
  const summary = el('summary', 'lag-phases-summary');
  summary.append(el('strong', '', 'Datenverkehr bei Ping-Spitzen'), el('span', '', `${phases.length} beobachtete Phase${phases.length === 1 ? '' : 'n'}`)); section.append(summary);
  section.append(helpNote(el('p', 'lag-phases-intro', 'Lag-Phasen zeigen Ping-Spitzen ab 100 ms und unbeantwortete Pings.'),'Erkennung basiert auf den angehakten Ping-Zielen. Genau 100 ms zählt bereits als Lag-Spitze; Messfehler bleiben getrennt. Eine Messpunktspanne belegt keine durchgehende Störung und zeitgleicher Datenverkehr keine Ursache.'));
  if (historyTruncated) section.append(helpNote(el('p', 'lag-coverage-note', 'Der gespeicherte Verlauf ist gekürzt.'),'Die angezeigte Abdeckung umfasst nur geladene Messungen.'));
  if (!selectedHosts.length) { section.append(el('div', 'history-empty', 'Wähle Ping-Ziele oben an, um Lag-Phasen zu bilden.')); return section; }
  if (!phases.length) { section.append(el('div', 'history-empty', 'Keine Ping-Spitzen ab 100 ms, Paketverluste oder Messfehler in den angehakten Messungen.')); return section; }
  const trafficIndex = prepareLagTraffic(trafficRecords);
  const listRegion = el('div', 'lag-phases-list'); listRegion.tabIndex = 0; listRegion.setAttribute('role', 'region'); listRegion.setAttribute('aria-label', 'Lag-Phasen, separat scrollbar');
  const visiblePhases = phases.slice(0, 100);
  const defaultTrafficPhaseId = visiblePhases.find(phase => phase.kind === 'network')?.id || visiblePhases[0]?.id;
  section.append(helpNote(el('p', 'lag-coverage-note', `${visiblePhases.length} neueste von ${phases.length} Phasen geladen.`),'Ältere Phasen bleiben im Verlauf gespeichert; die Liste scrollt separat.'), listRegion);
  for (const phase of visiblePhases) {
    const card = el('details', 'lag-phase');
    card.dataset.lagStart = String(phase.start); card.dataset.lagEnd = String(phase.end);
    const phaseDisclosureKey = `lag-phase:${phase.id}`;
    applyDisclosure(card, phaseDisclosureKey, disclosureState, phase.id === defaultTrafficPhaseId);
    const title = phase.kind === 'measurement_error' ? 'Messfehler' : phase.isIsolated && phase.lossCount ? 'Einzelner Ping-Verlust' : phase.isIsolated ? 'Einzelner Lag-Spike' : phase.title;
    const header = el('summary', 'lag-phase-summary');
    header.append(el('strong', '', title), el('time', '', phase.start === phase.end ? time(phase.start) : `${time(phase.start)} – ${time(phase.end)}`));
    header.append(el('span', '', phase.kind === 'measurement_error' ? `${phase.measurementErrorCount} Messfehler` : `${phase.sampleCount} auffällige Messzeitpunkte · ${phase.lossCount} Verlust${phase.lossCount === 1 ? '' : 'e'}${phase.maxPing == null ? '' : ` · Max. ${fmt(phase.maxPing)} ms`}`));
    const trafficPreview = el('span', 'lag-phase-traffic-preview', ''); header.append(trafficPreview);
    card.append(header);
    card.append(helpNote(el('p', 'lag-phase-coverage', phase.isIsolated
      ? 'Ein einzelner Zeitpunkt ist belegt.'
      : `Messpunktspanne ${fmt(phase.durationMs / 1000, 1)} s.`),phase.isIsolated
      ? 'Aus einem Einzelmesspunkt lässt sich keine Störungsdauer ableiten.'
      : 'Nicht gemessene Zeit zwischen den Abfragen bleibt unbekannt.'));
    const targetList = el('ul', 'lag-phase-targets');
    for (const target of phase.targetCounts) {
      const parts = [];
      if (target.latencyCount) parts.push(`${target.latencyCount}× ab 100 ms${target.maxPing == null ? '' : `, Max. ${fmt(target.maxPing)} ms`}`);
      if (target.lossCount) parts.push(`${target.lossCount}× keine Antwort`);
      if (target.errorCount) parts.push(`${target.errorCount}× Messfehler`);
      targetList.append(el('li', '', `${target.label} (${target.host}): ${parts.join(' · ')}`));
    }
    card.append(targetList);
    const zoom = el('button', 'button button-quiet lag-show-chart', 'Im Diagramm zeigen'); zoom.type = 'button'; zoom.addEventListener('click', () => onShowWindow(phase.start - 30000, phase.end + 30000)); card.append(zoom);
    const comparisons = el('details', 'lag-phase-comparisons'); applyDisclosure(comparisons, `lag-comparisons:${phase.id}`, disclosureState);
    comparisons.append(el('summary', '', '30 s davor / Phase / 30 s danach je Ping-Ziel'));
    let comparisonsPopulated = false;
    const populateComparisons = () => { if (comparisonsPopulated) return; comparisonsPopulated = true; appendWindowTable(comparisons, pingRecords, selectedHosts, phase); };
    comparisons.addEventListener('toggle', () => { if (comparisons.open) populateComparisons(); });
    card.append(comparisons);
    if (comparisons.open) populateComparisons();
    const trafficDisclosure = el('details', 'lag-phase-traffic-disclosure');
    const trafficDisclosureKey = `lag-traffic:${phase.id}`;
    applyDisclosure(trafficDisclosure, trafficDisclosureKey, disclosureState, phase.id === defaultTrafficPhaseId);
    const trafficSummary = el('summary', 'lag-traffic-disclosure-summary', 'Datenverkehr bei Ping-Spitzen · Geräteverbrauch laden');
    trafficDisclosure.append(trafficSummary);
    let trafficPopulated = false;
    const populateTraffic = () => {
      if (trafficPopulated) return;
      trafficPopulated = true;
      const traffic = correlateLagTraffic(trafficIndex, phase);
      const consumer = topDeviceLabel(traffic);
      trafficSummary.textContent = `Datenverkehr bei Ping-Spitzen · ${consumer}`;
      trafficPreview.textContent = consumer;
      const trafficSection = el('div', 'lag-phase-traffic');
      trafficSection.append(el('h4', '', 'Datenverkehr bei Ping-Spitzen'));
      trafficSection.append(helpNote(el('p', 'lag-traffic-note', 'PC, FRITZ!Box-WAN und einzelne Geräte werden getrennt angezeigt und nicht addiert.'),'Gleichzeitiger Datenverkehr ist eine zeitliche Korrelation, kein Beleg für die Ursache des Pings.'));
      const sourceSummary = (label, result, sourceKey) => {
        const group = el('section', 'lag-traffic-source'); group.append(el('h5', '', label));
        if (result.intervals?.length) {
          appendTrafficDirection(group, 'Download', result.download); appendTrafficDirection(group, 'Upload', result.upload);
          appendTrafficIntervals(group, result.intervals, traffic.pointPhase, `lag-traffic:${phase.id}:${sourceKey}:intervals`);
          if (result.intervals.some(interval => interval.bytesDerived)) group.append(el('p', 'lag-traffic-note', 'PC-Bytewerte aus gemessener Rate × Intervall berechnet.'));
        } else if (result.samples) group.append(el('p', 'lag-traffic-note', rateText(result)));
        else group.append(el('p', 'lag-traffic-note', 'Für diesen Zeitraum liegen keine passenden Messwerte vor.'));
        return group;
      };
      const sources = el('div', 'lag-traffic-sources');
      sources.append(sourceSummary('Dieser PC · ausgewählter Adapter', traffic.pc, 'pc'));
      const wanGroup = sourceSummary('FRITZ!Box-WAN · gesamter Anschluss', traffic.wan, 'wan');
      const utilization = traffic.wanUtilization;
      if (utilization.downloadPercent != null || utilization.uploadPercent != null) {
        const percent = value => value == null ? 'unbekannt' : `${fmt(value)} %`;
        wanGroup.append(helpNote(el('p', 'lag-traffic-capacity', `Anteil der gemeldeten Anschlussrate im Intervall: ↓ ${percent(utilization.downloadPercent)} · ↑ ${percent(utilization.uploadPercent)}.`),'Verglichen mit den aktuell gemeldeten Downstream-/Upstream-Raten.'));
        if (utilization.overload) wanGroup.append(helpNote(el('p', 'lag-traffic-overload', 'Gemessener Verkehr erreicht im Intervall mindestens 90 % der gemeldeten Anschlussrate. Hinweis, kein Schuldbeweis.'),'Gemeldete Anschlussrate ist keine garantierte Nutzdatenkapazität.'));
      } else wanGroup.append(el('p', 'lag-traffic-note', 'Anschlussrate nicht bekannt; kein Auslastungsvergleich möglich.'));
      sources.append(wanGroup); trafficSection.append(sources);
      trafficSection.append(el('h5', 'lag-traffic-device-title', 'FRITZ!Box-Geräte'));
      if (!traffic.devices.length) {
        trafficSection.append(traffic.capabilityReason ? el('p', 'lag-traffic-note', traffic.capabilityReason) : helpNote(el('p', 'lag-traffic-note', 'Keine passenden Geräte-Zählerintervalle.'),'Fehlende, unvollständige oder veraltete FRITZ!Box-Zähler bleiben unbekannt.'));
      } else {
        const rows = el('div', 'lag-traffic-device-table'); rows.setAttribute('role', 'table'); rows.setAttribute('aria-label', 'FRITZ!Box-Geräteverkehr bei Ping-Spitzen');
        const head = el('div', 'lag-traffic-device-row lag-traffic-device-head'); head.setAttribute('role', 'row');
        for (const label of ['Gerät / IP', 'Zählerintervall', 'Gesamt im Intervall', 'Durchsatz', ...(traffic.pointPhase ? [] : ['Phase, geschätzt'])]) { const cell = el('strong', '', label); cell.setAttribute('role', 'columnheader'); head.append(cell); }
        rows.append(head);
        for (const device of traffic.devices.slice(0, 100)) for (const interval of device.intervalsDetail.slice(0, MAX_DEVICE_INTERVAL_ROWS)) {
          const row = el('div', 'lag-traffic-device-row'); row.setAttribute('role', 'row');
          const cells = [[device.label, device.ip].filter(Boolean).join(' · '), `${time(interval.start)} – ${time(interval.end)}`, `↓ ${formatMiB(interval.downloadBytes)} · ↑ ${formatMiB(interval.uploadBytes)}`, `↓ ${fmt(interval.downloadMbps)} / ↑ ${fmt(interval.uploadMbps)} Mbit/s`];
          if (!traffic.pointPhase) cells.push(interval.estimatedDownloadBytes == null ? '–' : `↓ ${formatMiB(interval.estimatedDownloadBytes)} · ↑ ${formatMiB(interval.estimatedUploadBytes)}`);
          for (const [index, text] of cells.entries()) { const cell = index === 0 ? el('strong', '', text) : el('span', '', text); cell.setAttribute('role', 'cell'); row.append(cell); }
          rows.append(row);
        }
        trafficSection.append(rows);
        if (traffic.devices.length > 100) trafficSection.append(el('p', 'lag-traffic-note', `${traffic.devices.length - 100} weitere Geräte ausgeblendet.`));
        const omittedIntervals = traffic.devices.slice(0, 100).reduce((sum, device) => sum + Math.max(0, device.intervalsDetail.length - MAX_DEVICE_INTERVAL_ROWS), 0);
        if (omittedIntervals) trafficSection.append(el('p', 'lag-traffic-note', `${omittedIntervals} weitere Geräte-Zählerintervalle ausgeblendet.`));
      }
      trafficSection.append(helpNote(el('p', 'lag-traffic-note', traffic.pointPhase
        ? 'Beim Einzelmesspunkt zeigen Bytewerte das ganze Zählerintervall. Der Verbrauch genau im Ping-Moment ist nicht messbar.'
        : 'Bytewerte zeigen das ganze Zählerintervall; Phasenmengen sind proportional zur Zeitüberlappung geschätzt.'),
      'Unbekannte Werte bleiben unbekannt. Der Datenverkehr der Quellen wird nicht zusammengerechnet.'));
      if (traffic.truncated) trafficSection.append(helpNote(el('p', 'lag-coverage-note', 'Mindestens eine FRITZ!Box-Geräteliste wurde gekürzt.'),'Die Kürzung erfolgte beim Speichern.'));
      trafficDisclosure.append(trafficSection);
    };
    card.addEventListener('toggle', () => {
      if (card.open && !disclosureState.has(trafficDisclosureKey)) trafficDisclosure.open = true;
    });
    trafficDisclosure.addEventListener('toggle', () => {
      disclosureState.set(trafficDisclosureKey, trafficDisclosure.open);
      if (trafficDisclosure.open) populateTraffic();
    });
    card.append(trafficDisclosure); listRegion.append(card);
    if (card.open && !disclosureState.has(trafficDisclosureKey)) trafficDisclosure.open = true;
    if (trafficDisclosure.open) populateTraffic();
  }
  return section;
}
