import { activeTargets, targetState } from './overview.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const numeric = value => finite(value) && value >= 0;
const format = value => numeric(value) ? value.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '–';
const labelFor = target => target?.label || target?.host || 'Messziel';
const enabledTargets = state => activeTargets(state);

const statusSeverity = { ok: 0, pending: 1, warning: 2, error: 3, critical: 4, down: 5 };

function worstByStatus(targets) {
  return targets.reduce((worst, target) => !worst || statusSeverity[targetState(target)] > statusSeverity[targetState(worst)] ? target : worst, null);
}

function timeDetail(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return { detail: null, detailTitle: null, sortTime: -Infinity };
  const date = new Date(time);
  return {
    detail: date.toLocaleTimeString('de-DE'),
    detailTitle: date.toLocaleString('de-DE'),
    sortTime: time,
    detailMono: true,
  };
}

export function preferredPingTarget(state) {
  const targets = enabledTargets(state);
  const internet = targets.filter(target => target.kind === 'internet');
  return worstByStatus(internet.length ? internet : targets.filter(target => target.kind === 'gateway').length ? targets.filter(target => target.kind === 'gateway') : targets);
}

export function overviewTrafficHistory(state) {
  const traffic = state?.traffic;
  if (state?.selectedInterfaceId && traffic?.interfaceId && state.selectedInterfaceId !== traffic.interfaceId) return [];
  return list(traffic?.history);
}

export function overviewDevices(state, limit = 5) {
  const interfaceId = state?.selectedInterfaceId || state?.network?.defaultInterfaceId;
  if (!interfaceId) return [];
  return list(state?.devices).filter(device => !device?.interfaceId || device.interfaceId === interfaceId).slice(0, Math.max(0, limit));
}

export function buildSparklineSegments(points, { width = 240, height = 52, padding = 4, maxGapMs = 15000 } = {}) {
  const segments = [];
  let segment = [], previous = null;
  const flush = () => { if (segment.length > 1) segments.push(segment); segment = []; previous = null; };
  for (const point of list(points)) {
    const time = typeof point?.at === 'number' ? point.at : Date.parse(point?.at);
    if (!Number.isFinite(time) || !numeric(point?.value) || point.status === 'measurement_error') { flush(); continue; }
    if (previous && ((time < previous.time) || (time - previous.time > maxGapMs) || (point.epoch != null && previous.epoch != null && point.epoch !== previous.epoch))) flush();
    segment.push({ time, value: point.value });
    previous = { time, epoch: point.epoch };
  }
  flush();
  const all = segments.flat();
  if (!all.length) return [];
  const minTime = Math.min(...all.map(point => point.time)), maxTime = Math.max(...all.map(point => point.time));
  const maxValue = Math.max(1, ...all.map(point => point.value));
  const plotWidth = width - padding * 2, plotHeight = height - padding * 2;
  return segments.map(pointsInSegment => pointsInSegment.map(point => ({
    x: padding + (maxTime === minTime ? .5 : (point.time - minTime) / (maxTime - minTime)) * plotWidth,
    y: height - padding - point.value / maxValue * plotHeight,
  })));
}

function svg(doc, id, label, width, height) {
  const root = doc.getElementById(id);
  if (!root) return null;
  root.replaceChildren();
  root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  root.setAttribute('role', 'img');
  root.setAttribute('aria-label', label);
  return root;
}

function svgElement(doc, name, attributes = {}, text = null) {
  const element = doc.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text != null) element.textContent = text;
  return element;
}

function noHistory(root, doc, width, height) {
  if (!root) return;
  root.setAttribute('aria-label', 'Kein Verlauf verfügbar');
  root.append(svgElement(doc, 'text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'overview-chart-empty' }, '–'));
}

function historyPoints(history, key) {
  return history.map(point => ({ at: point?.at, epoch: point?.epoch, value: numeric(point?.[key]) ? point[key] : null }));
}

export function throughputAxis(values) {
  const maxValue = Math.max(1, ...list(values).filter(numeric));
  const rawStep = maxValue / 4;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const scaled = rawStep / power;
  const tickStep = (scaled <= 1.25 ? 1 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * power;
  const axisMax = Math.max(1, tickStep, Math.ceil(maxValue / tickStep) * tickStep);
  return { maxValue, tickStep, axisMax, tickCount: Math.round(axisMax / tickStep) };
}

function appendSparkline(doc, id, points, label, color = 'var(--accent)', dash = 'none') {
  const width = 240, height = 52;
  const root = svg(doc, id, label, width, height);
  if (!root) return;
  const segments = buildSparklineSegments(points, { width, height, padding: 4 });
  if (!segments.length) { noHistory(root, doc, width, height); return; }
  for (const segment of segments) {
    const coordinates = segment.map(point => `${point.x},${point.y}`).join(' ');
    root.append(svgElement(doc, 'polyline', { points: coordinates, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': dash, class: 'overview-sparkline' }));
  }
}

function drawTrafficChart(doc, state) {
  const width = 720, height = 184, pad = { left: 54, right: 12, top: 14, bottom: 28 };
  const root = svg(doc, 'overview-traffic-chart', 'Datenverkehrsverlauf: Download und Upload in Mbit/s', width, height);
  if (!root) return;
  const history = overviewTrafficHistory(state);
  const series = [
    { key: 'downloadMbps', color: 'var(--accent)', dash: 'none', label: 'Download' },
    { key: 'uploadMbps', color: 'var(--muted)', dash: '5 4', label: 'Upload' },
  ].map(item => ({ ...item, points: historyPoints(history, item.key) }));
  const allValues = series.flatMap(item => item.points.filter(point => numeric(point.value)).map(point => point.value));
  const timestamps = history.map(point => Date.parse(point?.at)).filter(Number.isFinite);
  if (allValues.length < 2 || timestamps.length < 2) { noHistory(root, doc, width, height); return; }
  const minTime = Math.min(...timestamps), maxTime = Math.max(...timestamps);
  if (maxTime <= minTime) { noHistory(root, doc, width, height); return; }
  const { tickStep, axisMax, tickCount } = throughputAxis(allValues);
  const plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
  const x = time => pad.left + (time - minTime) / (maxTime - minTime) * plotWidth;
  const y = value => pad.top + plotHeight - value / axisMax * plotHeight;
  for (let index = 0; index <= tickCount; index += 1) {
    const value = index * tickStep;
    const py = y(value);
    root.append(svgElement(doc, 'line', { x1: pad.left, x2: width - pad.right, y1: py, y2: py, class: 'overview-chart-grid', style: 'stroke:#24282C;stroke-width:1;stroke-dasharray:none' }));
    root.append(svgElement(doc, 'text', { x: pad.left - 8, y: py + 4, 'text-anchor': 'end', class: 'overview-chart-axis' }, format(value)));
  }
  root.append(svgElement(doc, 'text', { x: 8, y: 12, class: 'overview-chart-axis' }, 'Mbit/s'));
  const maxGapMs = 15000;
  let drewLine = false;
  for (const item of series) {
    let segment = [], previous = null;
    const flush = () => {
      if (segment.length > 1) {
        drewLine = true;
        const coords = segment.map(point => `${point.x},${point.y}`).join(' ');
        root.append(svgElement(doc, 'polygon', { points: `${segment[0].x},${y(0)} ${coords} ${segment.at(-1).x},${y(0)}`, fill: item.color, 'fill-opacity': '.08', stroke: 'none', class: 'overview-traffic-area' }));
        root.append(svgElement(doc, 'polyline', { points: coords, fill: 'none', stroke: item.color, 'stroke-width': 1.5, 'stroke-dasharray': item.dash, class: 'overview-traffic-line' }));
      }
      segment = []; previous = null;
    };
    for (const point of item.points) {
      const time = Date.parse(point.at);
      if (!Number.isFinite(time) || !numeric(point.value)) { flush(); continue; }
      if (previous && (time < previous.time || time - previous.time > maxGapMs || (point.epoch != null && previous.epoch != null && point.epoch !== previous.epoch))) flush();
      segment.push({ x: x(time), y: y(point.value) });
      previous = { time, epoch: point.epoch };
    }
    flush();
  }
  if (!drewLine) { noHistory(root, doc, width, height); return; }
  root.append(svgElement(doc, 'text', { x: pad.left, y: height - 7, 'text-anchor': 'start', class: 'overview-chart-axis' }, new Date(minTime).toLocaleTimeString('de-DE')));
  root.append(svgElement(doc, 'text', { x: width - pad.right, y: height - 7, 'text-anchor': 'end', class: 'overview-chart-axis' }, new Date(maxTime).toLocaleTimeString('de-DE')));
}

function appendRows(doc, id, rows, emptyText) {
  const root = doc.getElementById(id);
  if (!root) return;
  root.replaceChildren();
  if (!rows.length) {
    const empty = doc.createElement('p'); empty.className = 'overview-details-empty'; empty.textContent = emptyText; root.append(empty); return;
  }
  for (const row of rows) {
    const item = doc.createElement('div'); item.className = row.className || 'overview-detail-row';
    if (row.status) item.dataset.status = row.status;
    const name = doc.createElement('span'); name.className = 'overview-detail-label'; name.textContent = row.label;
    const value = doc.createElement('strong'); value.className = `overview-detail-value${row.mono ? ' overview-mono' : ''}`; value.textContent = row.value;
    item.append(name, value);
    if (row.detail) { const detail = doc.createElement('small'); detail.className = `overview-detail-meta${row.detailMono ? ' overview-mono' : ''}`; detail.textContent = row.detail; if (row.detailTitle) detail.title = row.detailTitle; item.append(detail); }
    root.append(item);
  }
}

export function overviewQualityRows(state) {
  const ping = preferredPingTarget(state);
  const pingStatus = state?.monitoring === false ? 'paused' : ping ? targetState(ping) : 'pending';
  const internet = enabledTargets(state).filter(target => target.kind === 'internet');
  const lossCandidates = internet.length ? internet : enabledTargets(state).filter(target => target.kind === 'gateway');
  const measuredLoss = lossCandidates.filter(target => target.stats?.sent > 0 && finite(target.stats?.lossPercent) && !target.lastError);
  const lossTarget = measuredLoss.reduce((worst, target) => !worst || target.stats.lossPercent > worst.stats.lossPercent ? target : worst, null);
  const lossStatus = state?.monitoring === false ? 'paused' : lossTarget ? targetState(lossTarget) : 'pending';
  const readingAllowed = status => state?.monitoring !== false && ['ok', 'warning', 'critical', 'down'].includes(status);
  return [
    { label: 'Latenz', value: readingAllowed(pingStatus) && ping?.stats?.sent > 0 && !ping.lastError && finite(ping?.stats?.avgMs) ? `${format(ping.stats.avgMs)} ms` : '–', mono: readingAllowed(pingStatus) && finite(ping?.stats?.avgMs), detail: ping ? labelFor(ping) : 'Kein aktives Messziel', status: pingStatus },
    { label: 'Jitter', value: readingAllowed(pingStatus) && ping?.stats?.sent > 0 && !ping.lastError && finite(ping?.stats?.jitterMs) ? `${format(ping.stats.jitterMs)} ms` : '–', mono: readingAllowed(pingStatus) && finite(ping?.stats?.jitterMs), detail: ping ? labelFor(ping) : 'Kein aktives Messziel', status: pingStatus },
    { label: 'Paketverlust', value: readingAllowed(lossStatus) && lossTarget?.stats?.sent > 0 && finite(lossTarget?.stats?.lossPercent) && !lossTarget.lastError ? `${format(lossTarget.stats.lossPercent)} %` : '–', mono: readingAllowed(lossStatus) && finite(lossTarget?.stats?.lossPercent), detail: lossTarget ? labelFor(lossTarget) : 'Kein gültiges Messfenster', status: lossStatus },
  ];
}

function latestPing(target) {
  return list(target?.samples).slice().reverse().find(sample => sample?.status === 'measurement_error' || typeof sample?.ok === 'boolean');
}

export function overviewRecentTests(state) {
  const rows = [];
  const speed = state?.speedTest;
  if (speed && (speed.running || speed.phase && speed.phase !== 'idle' || speed.at || speed.error)) {
    const detail = speed.error || (speed.running ? `${speed.phase || 'Läuft'}${finite(speed.progress) ? ` · ${format(speed.progress)} %` : ''}` : speed.phase === 'done' ? `${format(speed.downloadMbps)} / ${format(speed.uploadMbps)} Mbit/s` : speed.phase || 'Test beendet');
    rows.push({ label: 'Speedtest', value: detail, mono: speed.phase === 'done' && !speed.error, ...timeDetail(speed.at || speed.startedAt), status: speed.error ? 'error' : speed.running ? 'pending' : 'ok' });
  }
  for (const target of enabledTargets(state)) {
    const sample = latestPing(target);
    if (!sample) continue;
    const status = sample.status === 'measurement_error' ? 'error' : sample.ok ? 'ok' : 'down';
    const value = sample.status === 'measurement_error' ? 'Messfehler' : sample.ok && numeric(sample.ms) ? `${format(sample.ms)} ms` : 'Keine Ping-Antwort';
    rows.push({ label: `Ping · ${labelFor(target)}`, value, mono: sample.ok === true && numeric(sample.ms), ...timeDetail(sample.at), status });
  }
  const dns = state?.dns;
  if (dns && (dns.ok === true || dns.ok === false)) rows.push({ label: 'DNS-Auflösung', value: dns.ok ? (numeric(dns.ms) ? `${format(dns.ms)} ms` : 'Erfolgreich') : 'Fehlgeschlagen', mono: dns.ok && numeric(dns.ms), ...timeDetail(dns.at), ...(dns.error ? { error: dns.error } : {}), status: dns.ok ? 'ok' : 'error' });
  return rows.sort((a, b) => b.sortTime - a.sortTime).slice(0, 5).map(({ sortTime, ...row }) => row);
}

export function overviewDeviceRows(state) {
  return overviewDevices(state).map(device => ({
    label: device.name || device.ip || 'Gerät',
    value: device.respondsToPing === true ? 'Erreichbar' : device.respondsToPing === false ? 'Keine Ping-Antwort' : device.measurementError ? 'Messfehler' : device.neighborState || 'Status unbekannt',
    detail: device.ip && device.name ? device.ip : null,
    detailMono: !!(device.ip && device.name),
    status: device.measurementError ? 'error' : device.respondsToPing === true ? 'ok' : device.respondsToPing === false ? 'down' : 'pending',
  }));
}

function pingSamples(state) {
  const target = preferredPingTarget(state);
  return list(target?.samples).slice(-60).map(sample => ({ at: sample?.at, value: sample?.ok === true && sample?.status !== 'measurement_error' ? sample.ms : null, lost: sample?.ok === false && sample?.status !== 'measurement_error', status: sample?.status }));
}

export function renderOverviewDetails(state, doc = document) {
  appendRows(doc, 'overview-quality', overviewQualityRows(state), 'Noch keine Qualitätsmesswerte.');
  drawTrafficChart(doc, state);
  appendRows(doc, 'overview-recent-tests', overviewRecentTests(state), 'Noch keine gültigen Ping-, DNS- oder Speedtestwerte.');
  appendRows(doc, 'overview-devices', overviewDeviceRows(state), 'Für die ausgewählte Schnittstelle liegen keine Gerätedaten vor.');
  const history = overviewTrafficHistory(state);
  const ping = pingSamples(state);
  const pingLabel = preferredPingTarget(state) ? `Latenzverlauf für ${labelFor(preferredPingTarget(state))}` : 'Latenzverlauf';
  appendSparkline(doc, 'ping-sparkline', ping, pingLabel);
  appendSparkline(doc, 'download-sparkline', historyPoints(history, 'downloadMbps'), 'Downloadverlauf', 'var(--accent)');
  appendSparkline(doc, 'upload-sparkline', historyPoints(history, 'uploadMbps'), 'Uploadverlauf', 'var(--muted)');
  appendSparkline(doc, 'loss-sparkline', ping.map(point => ({ ...point, value: point.lost ? 100 : numeric(point.value) ? 0 : null })), 'Paketverlustverlauf', ping.some(point => point.lost) ? 'var(--red)' : 'var(--muted)');
}
