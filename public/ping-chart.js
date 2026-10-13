const NS = 'http://www.w3.org/2000/svg';
const MIN_WINDOW = 10000;
const numeric = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const fmt = value => Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 });
const timeLabel = value => new Date(value).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const node = (tag, className, text) => { const el = document.createElement(tag); if (className) el.className = className; if (text != null) el.textContent = text; return el; };
const svgNode = (tag, attributes, text) => { const el = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value); if (text != null) el.textContent = text; return el; };

export function niceAxisTicks(maximum, targetCount = 4) {
  const max = Math.max(Number.isFinite(maximum) ? maximum : 0, Number.EPSILON);
  const raw = max / Math.max(1, targetCount);
  const power = 10 ** Math.floor(Math.log10(raw));
  const scaled = raw / power;
  const step = (scaled <= 1.25 ? 1 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * power;
  const top = Math.ceil(max / step) * step;
  const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step)) + (step / power % 1 ? 1 : 0)));
  return Array.from({ length: Math.round(top / step) + 1 }, (_, index) => Number((index * step).toFixed(digits)));
}

// An explicit range uses absolute times, so a refresh cannot move the inspected spike.
export function fitPingRange(range, domain) {
  const [start, end] = domain;
  if (!range || !range.every(Number.isFinite)) return [...domain];
  const span = Math.min(end - start, Math.max(Math.min(MIN_WINDOW, end - start), range[1] - range[0]));
  const left = Math.max(start, Math.min(end - span, range[0]));
  return [left, left + span];
}

export function zoomPingRange(range, domain, factor, anchor = .5) {
  const current = fitPingRange(range, domain);
  const fraction = Math.max(0, Math.min(1, anchor));
  const span = Math.min(domain[1] - domain[0], Math.max(Math.min(MIN_WINDOW, domain[1] - domain[0]), (current[1] - current[0]) * factor));
  const start = current[0] + (current[1] - current[0]) * fraction - span * fraction;
  return fitPingRange([start, start + span], domain);
}

export function panPingRange(range, domain, delta) {
  const current = fitPingRange(range, domain);
  return fitPingRange([current[0] + delta, current[1] + delta], domain);
}

export function followPingRange(range, domain) {
  const span = Math.min(domain[1] - domain[0], Math.max(Math.min(MIN_WINDOW, domain[1] - domain[0]), range[1] - range[0]));
  return [domain[1] - span, domain[1]];
}

export function initialPingRange(viewport, domain) {
  return viewport?.followLatest && viewport.range ? followPingRange(viewport.range, domain) : fitPingRange(viewport?.range, domain);
}

export function updatePingRange(viewport, domain) {
  if (viewport?.followLatest && !viewport.range) return fitPingRange(null, domain);
  return viewport?.followLatest ? followPingRange(viewport.range, domain) : fitPingRange(viewport?.range, domain);
}

export function mergeQueuedPingUpdate(queued, input, options = {}) {
  return queued
    ? { input: Array.isArray(input) ? input : queued.input, options: { ...queued.options, ...(options || {}) } }
    : { input, options: options || {} };
}

export function preparePingSeries(series) {
  return series.map(item => {
    let segment = 0, previousTime = null, previousEpoch;
    const values = item.values.map(point => {
      const time = Date.parse(point.at);
      if (!Number.isFinite(time) || !numeric(point.value) || point.status === 'measurement_error') {
        segment += 1; previousTime = null; previousEpoch = undefined;
        return { ...point, time, value: null, segment };
      }
      if ((previousTime != null && (time < previousTime || time - previousTime > (item.maxGapMs || 10000))) || (previousEpoch != null && point.epoch !== previousEpoch)) segment += 1;
      previousTime = time; previousEpoch = point.epoch;
      return { ...point, time, value: Number(point.value), segment };
    });
    return { ...item, values };
  });
}

export function isPingLossPoint(point) {
  return point?.status !== 'measurement_error' && !numeric(point?.value);
}

export function visiblePingValues(values, range) {
  // Filter the raw data first: zoom reveals all nearby samples, not just overview samples.
  const visible = values.filter(point => point.time >= range[0] && point.time <= range[1]);
  if (visible.length <= 500) return visible;
  const picks = new Set([visible[0], visible.at(-1)]);
  for (let bucket = 0; bucket < 250; bucket += 1) {
    const points = visible.slice(Math.floor(bucket * visible.length / 250), Math.floor((bucket + 1) * visible.length / 250));
    let min, max;
    for (const point of points) {
      if (!numeric(point.value)) continue;
      if (!min || point.value < min.value) min = point;
      if (!max || point.value > max.value) max = point;
    }
    if (min) picks.add(min);
    if (max) picks.add(max);
  }
  return [...picks].sort((a, b) => a.time - b.time);
}

// Return a recorded observation only. The gap guard prevents a cursor in an empty
// interval from borrowing an old value; epoch boundaries are never bridged.
export function nearestPingPoint(values, time, maxGapMs = 10000, range = null) {
  if (!Number.isFinite(time)) return null;
  let nearest = null, before = null, after = null;
  for (const point of values) {
    if (!Number.isFinite(point.time) || (range && (point.time < range[0] || point.time > range[1]))) continue;
    if (point.time <= time && (!before || point.time > before.time)) before = point;
    if (point.time >= time && (!after || point.time < after.time)) after = point;
    if (!nearest || Math.abs(point.time - time) < Math.abs(nearest.time - time)) nearest = point;
  }
  if (!nearest || Math.abs(nearest.time - time) > Math.max(0, maxGapMs)) return null;
  if (before && after && before !== after && before.segment !== after.segment && numeric(before.value) && numeric(after.value) && time !== before.time && time !== after.time) return null;
  return nearest;
}

export function pingTimeX(time, range, left, plotWidth) {
  return left + (time - range[0]) / (range[1] - range[0]) * plotWidth;
}

export function nearestPingTime(series, time, range, maxDistance = null) {
  let nearest = null, distance = Infinity, maxGap = Infinity;
  for (const item of series) {
    const limit = item.maxGapMs || 10000;
    for (const point of item.values) {
      if (!Number.isFinite(point.time) || point.time < range[0] || point.time > range[1]) continue;
      const nextDistance = Math.abs(point.time - time);
      const allowedDistance = maxDistance == null ? limit : maxDistance;
      if (nextDistance <= allowedDistance && nextDistance < distance) { nearest = point.time; distance = nextDistance; maxGap = allowedDistance; }
    }
  }
  return nearest != null && distance <= maxGap ? nearest : null;
}

export function renderPingChart(parent, input, viewport = {}) {
  parent.classList.add('ping-chart');
  let series = preparePingSeries(input || []), domain, range, stateOptions = {};
  const seriesDomain = items => {
    let first = Infinity, last = -Infinity;
    for (const item of items) for (const point of item.values) if (Number.isFinite(point.time)) { first = Math.min(first, point.time); last = Math.max(last, point.time); }
    if (!Number.isFinite(first)) { const now = Date.now(); return [now - 30000, now + 30000]; }
    return last - first < 60000 ? [last - 60000, last] : [first, last];
  };
  domain = seriesDomain(series);
  if (typeof viewport.followLatest !== 'boolean') viewport.followLatest = true;
  range = initialPingRange(viewport, domain);
  const full = () => range[1] - range[0] >= domain[1] - domain[0] - 1;
  viewport.range = full() ? null : [...range];
  const toolbar = node('div', 'ping-chart-toolbar');
  const status = node('strong', 'ping-chart-status');
  status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  const controls = node('div', 'ping-chart-controls'); controls.setAttribute('role', 'group'); controls.setAttribute('aria-label', 'Diagrammausschnitt');
  const button = (key, label, title, action) => {
    const el = node('button', 'button button-quiet', label); el.type = 'button'; el.id = `ping-chart-${key}`; el.title = title; el.setAttribute('aria-label', title); el.addEventListener('click', action); controls.append(el); return el;
  };
  const zoomIn = button('in', '+', 'Diagramm vergrößern', () => commit(zoomPingRange(range, domain, .5), { zoom: true }));
  const zoomOut = button('out', '−', 'Diagramm verkleinern', () => commit(zoomPingRange(range, domain, 2), { zoom: true }));
  const earlier = button('earlier', '←', 'Frühere Messungen anzeigen', () => commit(panPingRange(range, domain, -(range[1] - range[0]) * .4), { pan: true }));
  const later = button('later', '→', 'Spätere Messungen anzeigen', () => commit(panPingRange(range, domain, (range[1] - range[0]) * .4), { pan: true }));
  const reset = button('reset', 'Alles', 'Gesamten Messzeitraum anzeigen', () => commit(domain, { resetView: true }));
  const live = button('live', 'Live folgen', 'Zum neuesten Messzeitpunkt wechseln und weiter folgen', () => commit(followPingRange(viewport.range, domain), { resetView: true }));
  live.setAttribute('aria-pressed', String(Boolean(viewport.followLatest)));
  toolbar.append(status, controls);
  const frame = node('div', 'ping-chart-frame');
  const chart = svgNode('svg', { role: 'img', tabindex: '0', id: 'ping-history-chart', 'aria-label': 'Ping-Verlauf. Maus bewegt das Fadenkreuz. Eingabe oder Leertaste startet die Tastaturauswahl, Pfeiltasten wechseln Messpunkte, Escape beendet sie.', 'aria-describedby': 'ping-chart-help' });
  const tooltip = node('div', 'ping-chart-tooltip-html'); tooltip.hidden = true; tooltip.setAttribute('role', 'status'); tooltip.setAttribute('aria-live', 'polite');
  frame.append(chart, tooltip);
  const rangeLabel = node('p', 'ping-chart-range');
  const help = node('p', 'chart-note', 'Mausrad scrollt · Strg + Mausrad zoomt · Markierte Spitze anklicken: Datenverkehr ansehen.'); help.id = 'ping-chart-help'; help.dataset.help = 'Maus: Messzeitpunkt anzeigen; Mausrad: Seite scrollen; Strg + Mausrad: zoomen; Ziehen: verschieben; Doppelklick: alles. Orange umrandete Punkte markieren Lag-Spitzen ab 100 ms. Ein Klick auf eine Spitze oder einen Verlust öffnet den zugehörigen Datenverkehr. Tastatur: Eingabe oder Leertaste starten, Pfeiltasten wechseln Messpunkte, Escape beendet die Auswahl.';
  const empty = node('div', 'history-empty', 'Für die angehakten Ziele liegen im Zeitraum keine Ping-Messungen vor.');
  parent.append(toolbar, empty, frame, rangeLabel, help);
  let width = 1000, height = 340, drag = null, ignoreLagClick = false, queuedUpdate = null, disposed = false, inspectedTime = null, pinned = false, inspectionLayer = null, inspectionFrame = 0, maxVisibleValue = 1;
  const padding = () => ({ left: width < 500 ? 65 : 76, right: 16, top: 22, bottom: 42 });
  function updateStatus() {
    const hasData = series.some(item => item.values.some(point => Number.isFinite(point.time)));
    const mode = stateOptions.connected === false ? 'Verbindung unterbrochen' : stateOptions.monitoring === false ? 'Monitoring pausiert' : !hasData ? 'Warte auf Messwerte' : viewport.followLatest ? 'Live · neueste Messungen folgen' : 'Ausschnitt angehalten';
    status.textContent = `${mode} · ${full() ? 'Gesamtansicht' : `${fmt((domain[1] - domain[0]) / (range[1] - range[0]))}× vergrößert`}`;
    live.setAttribute('aria-pressed', String(Boolean(viewport.followLatest)));
    const active = viewport.followLatest && hasData && stateOptions.connected !== false && stateOptions.monitoring !== false;
    live.dataset.liveState = active ? 'active' : 'waiting';
    live.textContent = viewport.followLatest ? active ? 'Live aktiv' : 'Live bereit' : 'Zurück zu Live';
  }
  function draw() {
    const hasPoints = series.some(item => item.values.some(point => Number.isFinite(point.time)));
    empty.hidden = hasPoints; frame.hidden = rangeLabel.hidden = !hasPoints;
    const rect = chart.getBoundingClientRect();
    if (rect.width) { width = rect.width; height = rect.height || 300; }
    chart.setAttribute('viewBox', `0 0 ${width} ${height}`);
    chart.dataset.from = String(range[0]); chart.dataset.to = String(range[1]);
    chart.dataset.full = String(full()); chart.classList.toggle('is-zoomed', !full());
    chart.replaceChildren();
    const pad = padding(); const plotWidth = width - pad.left - pad.right; const plotHeight = height - pad.top - pad.bottom;
    const visible = series.map(item => ({ ...item, values: visiblePingValues(item.values, range) }));
    let observedMax = 0, count = 0;
    for (const item of visible) for (const point of item.values) if (numeric(point.value)) { observedMax = Math.max(observedMax, point.value); count += 1; }
    const ticks = niceAxisTicks(Math.max(observedMax, 100));
    const maxValue = ticks.at(-1) || 1;
    maxVisibleValue = maxValue;
    const x = time => pad.left + (time - range[0]) / (range[1] - range[0]) * plotWidth;
    const y = value => pad.top + plotHeight - value / maxValue * plotHeight;
    for (const tick of ticks) {
      const py = y(tick);
      chart.append(svgNode('line', { x1: pad.left, x2: width - pad.right, y1: py, y2: py, class: 'history-grid' }), svgNode('text', { x: pad.left - 9, y: py + 4, 'text-anchor': 'end', class: 'history-axis-label' }, `${fmt(tick)} ms`));
    }
    const thresholdY = y(100);
    chart.append(svgNode('line', { x1: pad.left, x2: width - pad.right, y1: thresholdY, y2: thresholdY, class: 'history-threshold', 'aria-label': '100 ms Lag-Schwelle' }), svgNode('text', { x: width - pad.right, y: thresholdY - 6, 'text-anchor': 'end', class: 'history-threshold-label' }, '100 ms'));
    for (const fraction of width < 600 ? [0, 1] : [0, .5, 1]) {
      const time = range[0] + (range[1] - range[0]) * fraction;
      const label = width < 600 ? new Date(time).toLocaleTimeString('de-DE') : timeLabel(time);
      chart.append(svgNode('text', { x: pad.left + fraction * plotWidth, y: height - 12, 'text-anchor': fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle', class: 'history-axis-label' }, label));
    }
    for (const item of visible) {
      let points = [], previousSegment;
      const flush = () => {
        if (points.length > 1) {
          const baseline = y(0);
          chart.append(svgNode('polygon', { points: `${points[0].split(',')[0]},${baseline} ${points.join(' ')} ${points.at(-1).split(',')[0]},${baseline}`, class: 'history-area', fill: item.color, 'fill-opacity': '.08' }));
          chart.append(svgNode('polyline', { points: points.join(' '), class: 'history-line', stroke: item.color, 'stroke-dasharray': item.dash || 'none' }));
        }
        points = [];
      };
      for (const point of item.values) {
        if (!numeric(point.value) || point.segment !== previousSegment) flush();
        previousSegment = point.segment;
        if (numeric(point.value)) points.push(`${x(point.time)},${y(point.value)}`);
        else if (isPingLossPoint(point) && Number.isFinite(point.time)) {
          const loss = svgNode('circle', { cx: x(point.time), cy: height - pad.bottom + 3, r: 3.5, class: 'history-loss-marker', 'data-lag-at': point.time, 'aria-label': 'Keine Ping-Antwort – Datenverkehr ansehen' });
          loss.append(svgNode('title', {}, `${item.name}: Paketverlust · ${timeLabel(point.time)}`)); chart.append(loss);
        }
      }
      flush();
      for (const point of item.values) if (numeric(point.value)) {
        const label = `${item.name}: ${fmt(point.value)} ms · ${timeLabel(point.time)}`;
        const dot = svgNode('circle', { cx: x(point.time), cy: y(point.value), r: point.value >= 100 ? 5 : 3.5, fill: item.color, 'aria-label': label });
        if (point.value >= 100) { dot.classList.add('history-spike-marker'); dot.dataset.lagAt = String(point.time); }
        dot.append(svgNode('title', {}, label)); chart.append(dot);
      }
    }
    inspectionLayer = svgNode('g', { class: 'ping-chart-inspection', 'pointer-events': 'none', 'aria-hidden': 'true' }); chart.append(inspectionLayer);
    if (!count) chart.append(svgNode('text', { x: pad.left + plotWidth / 2, y: pad.top + plotHeight / 2, 'text-anchor': 'middle', class: 'history-axis-label' }, series.some(item => item.values.length) ? 'Keine Antworten im Ausschnitt' : 'Für die angehakten Ziele liegen im Zeitraum keine Ping-Messungen vor.'));
    updateStatus();
    rangeLabel.textContent = `${timeLabel(range[0])} – ${timeLabel(range[1])}`;
    zoomIn.disabled = !hasPoints || range[1] - range[0] <= Math.min(MIN_WINDOW, domain[1] - domain[0]) + 1;
    zoomOut.disabled = reset.disabled = !hasPoints || full(); earlier.disabled = !hasPoints || range[0] <= domain[0] + 1; later.disabled = !hasPoints || range[1] >= domain[1] - 1;
    updateInspection();
  }
  function commit(next, { pan = false, resetView = false, zoom = false } = {}) {
    if (pan) viewport.followLatest = false;
    if (resetView) viewport.followLatest = true;
    range = viewport.followLatest && zoom ? followPingRange(next, domain) : fitPingRange(next, domain);
    viewport.range = full() ? null : [...range]; draw();
  }
  const localPoint = event => {
    const matrix = chart.getScreenCTM(); if (!matrix) return null;
    const point = chart.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
    return point.matrixTransform(matrix.inverse());
  };
  const inside = point => { const pad = padding(); return point && point.x >= pad.left && point.x <= width - pad.right && point.y >= pad.top && point.y <= height - pad.bottom; };
  function updateInspection() {
    if (!inspectionLayer) return;
    inspectionLayer.replaceChildren(); tooltip.replaceChildren();
    if (!Number.isFinite(inspectedTime) || inspectedTime < range[0] || inspectedTime > range[1]) { tooltip.hidden = true; return; }
    const pad = padding(), plotWidth = width - pad.left - pad.right, plotHeight = height - pad.top - pad.bottom;
    const cursorX = pingTimeX(inspectedTime, range, pad.left, plotWidth);
    inspectionLayer.append(svgNode('line', { x1: cursorX, x2: cursorX, y1: pad.top, y2: height - pad.bottom, class: 'ping-chart-crosshair' }));
    const readings = series.map(item => ({ item, point: nearestPingPoint(item.values, inspectedTime, item.maxGapMs || 10000, range) }));
    for (const { item, point } of readings) if (point && numeric(point.value)) {
      inspectionLayer.append(svgNode('circle', { cx: cursorX, cy: pad.top + plotHeight - point.value / maxValueForRange() * plotHeight, r: 5, fill: item.color, class: 'ping-chart-crosshair-dot' }));
    }
    const heading = node('strong', 'ping-chart-tooltip-heading', `Messzeitpunkt: ${timeLabel(inspectedTime)}`); tooltip.append(heading);
    for (const { item, point } of readings) {
      const row = node('div', 'ping-chart-tooltip-row');
      const name = node('strong', '', item.name); name.style.setProperty('--series-color', item.color || 'var(--series-primary)');
      let valueText = 'Keine Messung in der Nähe', sampleTime = '';
      if (point) {
        if (point.status === 'measurement_error') valueText = 'Messfehler';
        else if (!numeric(point.value)) valueText = 'Keine Ping-Antwort';
        else valueText = `${fmt(point.value)} ms`;
        const delta = (point.time - inspectedTime) / 1000;
        sampleTime = `${timeLabel(point.time)} · ${delta === 0 ? 'genau' : `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} s`}`;
      }
      row.append(name, node('span', 'ping-chart-tooltip-value', valueText));
      if (sampleTime) row.append(node('small', 'ping-chart-tooltip-sample-time', sampleTime));
      tooltip.append(row);
    }
    tooltip.hidden = false;
    const canvasRect = frame.getBoundingClientRect();
    const screen = chart.createSVGPoint(); screen.x = cursorX; screen.y = pad.top;
    const cursorScreen = screen.matrixTransform(chart.getScreenCTM());
    tooltip.style.left = `${Math.max(8, Math.min(canvasRect.width - 8, cursorScreen.x - canvasRect.left + 10))}px`;
    tooltip.style.top = '8px';
    const tooltipRect = tooltip.getBoundingClientRect();
    if (tooltipRect.right > canvasRect.right - 8) tooltip.style.left = `${Math.max(8, cursorScreen.x - canvasRect.left - tooltipRect.width - 10)}px`;
  }
  function maxValueForRange() { return maxVisibleValue; }
  function setInspectionAt(point, isPinned) {
    if (!inside(point)) inspectedTime = null;
    else inspectedTime = nearestPingTime(series, range[0] + (point.x - padding().left) / (width - padding().left - padding().right) * (range[1] - range[0]), range);
    pinned = isPinned;
    if (!inspectionFrame) inspectionFrame = requestAnimationFrame(() => { inspectionFrame = 0; updateInspection(); });
  }
  chart.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    const point = localPoint(event); if (!inside(point) || !event.deltaY) return;
    event.preventDefault(); const pad = padding();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
    commit(zoomPingRange(range, domain, Math.exp(Math.max(-1, Math.min(1, pixels * .003))), (point.x - pad.left) / (width - pad.left - pad.right)), { zoom: true });
  }, { passive: false });
  chart.addEventListener('pointerdown', event => {
    ignoreLagClick = false;
    const point = localPoint(event); if (event.button !== 0 || !inside(point) || full() || drag) return;
    drag = { id: event.pointerId, x: point.x, moved: 0, range: [...range] };
    chart.setPointerCapture(event.pointerId); chart.classList.add('is-dragging'); chart.focus({ preventScroll: true });
  });
  chart.addEventListener('pointermove', event => {
    if (!drag) {
      if (event.pointerType !== 'touch') {
        setInspectionAt(localPoint(event), false);
      }
      return;
    }
    if (drag.id !== event.pointerId) return;
    const point = localPoint(event); if (!point) return; const pad = padding(); drag.moved = Math.max(drag.moved || 0, Math.abs(drag.x - point.x));
    commit(panPingRange(drag.range, domain, (drag.x - point.x) / (width - pad.left - pad.right) * (drag.range[1] - drag.range[0])), { pan: true });
  });
  const finishDrag = event => {
    if (drag) ignoreLagClick = drag.moved >= 3;
    if (drag && event?.pointerId === drag.id && drag.moved < 3 && event.pointerType === 'touch') {
      const point = localPoint(event); const pad = padding();
      if (inside(point)) setInspectionAt(point, true);
    }
    drag = null; chart.classList.remove('is-dragging');
    if (queuedUpdate && !disposed) { const update = queuedUpdate; queuedUpdate = null; applyUpdate(update.input, update.options); }
  };
  chart.addEventListener('pointerup', event => {
    if (!drag && event.pointerType === 'touch') {
      const point = localPoint(event); const pad = padding();
      if (inside(point)) setInspectionAt(point, true);
      return;
    }
    finishDrag(event);
  }); chart.addEventListener('pointercancel', finishDrag); chart.addEventListener('lostpointercapture', finishDrag);
  chart.addEventListener('click', event => {
    const at = Number(event.target.closest('[data-lag-at]')?.dataset.lagAt);
    if (!ignoreLagClick && Number.isFinite(at)) stateOptions.onSelectTime?.(at);
  });
  chart.addEventListener('pointerleave', event => {
    if (event.pointerType !== 'touch' && !pinned && inspectedTime != null && !tooltip.contains(event.relatedTarget)) {
      inspectedTime = null; if (inspectionFrame) cancelAnimationFrame(inspectionFrame); inspectionFrame = 0; updateInspection();
    }
  });
  tooltip.addEventListener('pointerleave', () => {
    if (!pinned) { inspectedTime = null; if (inspectionFrame) cancelAnimationFrame(inspectionFrame); inspectionFrame = 0; updateInspection(); }
  });
  chart.addEventListener('dblclick', event => { if (inside(localPoint(event))) commit(domain, { resetView: true }); });
  chart.addEventListener('keydown', event => {
    const timestamps = [...new Set(series.flatMap(item => item.values.filter(point => Number.isFinite(point.time) && point.time >= range[0] && point.time <= range[1]).map(point => point.time)))].sort((a, b) => a - b);
    const moveInspection = delta => {
      if (!timestamps.length) return;
      const index = timestamps.findIndex(time => time >= (inspectedTime ?? timestamps[0]));
      const next = Math.max(0, Math.min(timestamps.length - 1, Math.max(0, index) + delta));
      inspectedTime = timestamps[next]; pinned = true; draw();
    };
    const startKeyboardInspection = () => {
      const middle = (range[0] + range[1]) / 2;
      inspectedTime = nearestPingTime(series, middle, range, Infinity); pinned = true; updateInspection();
    };
    const actions = { '+': () => zoomIn.click(), '=': () => zoomIn.click(), '-': () => zoomOut.click(), ArrowLeft: () => inspectedTime != null ? moveInspection(-1) : earlier.click(), ArrowRight: () => inspectedTime != null ? moveInspection(1) : later.click(), Home: () => { inspectedTime = null; pinned = false; reset.click(); }, Escape: () => { inspectedTime = null; pinned = false; updateInspection(); }, Enter: startKeyboardInspection, ' ': startKeyboardInspection };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
  });
  const observer = new ResizeObserver(draw); observer.observe(chart); draw();
  function applyUpdate(nextInput, options = {}) {
    if (disposed) return false;
    if (drag) {
      queuedUpdate = mergeQueuedPingUpdate(queuedUpdate, nextInput, options);
      return true;
    }
    if (Array.isArray(nextInput)) {
      const previousViewport = { followLatest: viewport.followLatest, range: viewport.range };
      series = preparePingSeries(nextInput); domain = seriesDomain(series);
      range = updatePingRange(previousViewport, domain);
      viewport.range = full() ? null : [...range];
    }
    stateOptions = { ...stateOptions, ...(options || {}) };
    if (Array.isArray(nextInput)) draw(); else updateStatus();
    return true;
  }
  const dispose = () => { if (disposed) return; disposed = true; observer.disconnect(); finishDrag(); queuedUpdate = null; if (inspectionFrame) cancelAnimationFrame(inspectionFrame); inspectionFrame = 0; frame.replaceChildren(); };
  dispose.update = applyUpdate;
  return dispose;
}
