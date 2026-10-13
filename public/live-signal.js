import { activeTargets, targetState } from './overview.js';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const statusColor = { ok: 'ok', warning: 'warning', critical: 'critical', down: 'down', error: 'error', pending: 'pending' };

export function liveSignalModel(state) {
  const targets = activeTargets(state);
  const seen = new Set();
  const samples = targets.flatMap(target => (Array.isArray(target.samples) ? target.samples : []).map(sample => ({
    ...sample,
    host: target.host,
    label: target.label || target.host || 'Messziel',
    key: `${target.host || target.label || 'target'}:${sample.at || ''}:${sample.status || ''}:${sample.ms ?? ''}`,
  }))).filter(sample => {
    if (!sample.at || !Number.isFinite(new Date(sample.at).getTime()) || seen.has(sample.key)) return false;
    seen.add(sample.key); return true;
  }).sort((a, b) => new Date(a.at) - new Date(b.at)).slice(-60).map(sample => {
    const error = sample.status === 'measurement_error';
    const lost = !error && (sample.ok === false || sample.status === 'down' || sample.status === 'loss');
    const latency = !error && !lost && finite(sample.ms) ? sample.ms : null;
    return { ...sample, latency, kind: error ? 'error' : lost ? 'loss' : latency == null ? 'unknown' : 'ping', tone: lost ? 'loss' : error || latency == null ? 'unknown' : latency >= 100 ? 'slow' : 'ok' };
  });
  return {
    samples,
    targets: targets.map(target => ({ label: target.label || target.host || 'Messziel', host: target.host || target.label || '', status: targetState(target), tone: statusColor[targetState(target)] || 'pending' })),
  };
}

const rendered = new WeakMap();
export function renderLiveSignal(container, state) {
  if (!container) return;
  let track = container.querySelector('.live-signal-track');
  if (!track) {
    track = document.createElement('a'); track.className = 'live-signal-track'; track.href = '#history';
    const heading = document.createElement('span'); heading.className = 'live-signal-heading';
    const label = document.createElement('strong'); label.textContent = 'Live-Ping';
    const phase = document.createElement('span'); phase.className = 'live-signal-phase';
    heading.append(label, phase);
    const chart = document.createElement('span'); chart.className = 'live-signal-chart';
    const summary = document.createElement('span'); summary.className = 'live-signal-summary';
    const count = document.createElement('span'); count.className = 'live-signal-count';
    const issues = document.createElement('span'); issues.className = 'live-signal-issues';
    summary.append(count, issues);
    const action = document.createElement('span'); action.className = 'live-signal-action'; action.textContent = 'Verlauf ansehen';
    const arrow = document.createElement('span'); arrow.textContent = '↗'; arrow.setAttribute('aria-hidden', 'true');
    action.append(arrow);
    track.append(heading, chart, summary, action);
    container.replaceChildren(track);
  }
  const model = liveSignalModel(state);
  const chart = track.querySelector('.live-signal-chart');
  const phase = state.monitoring ? 'Aktiv' : 'Pausiert';
  const count = model.samples.length ? `Letzte ${model.samples.length} Messwerte · ${model.targets.length} ${model.targets.length === 1 ? 'Ziel' : 'Ziele'}` : 'Warte auf Messwerte';
  const losses = model.samples.filter(sample => sample.kind === 'loss').length;
  const errors = model.samples.filter(sample => sample.kind === 'error').length;
  const issues = [losses ? `${losses} ohne Antwort` : '', errors ? `${errors} Messfehler` : ''].filter(Boolean).join(' · ');
  track.querySelector('.live-signal-phase').textContent = phase;
  track.querySelector('.live-signal-count').textContent = count;
  const issueLabel = track.querySelector('.live-signal-issues');
  issueLabel.textContent = issues; issueLabel.hidden = !issues;
  issueLabel.classList.toggle('has-loss', losses > 0);
  track.dataset.running = String(!!state.monitoring);
  track.setAttribute('aria-label', `Ping-Verlauf öffnen: ${phase}. ${count}${issues ? `. ${issues}` : ''}`);
  chart.title = 'Messwerte aller aktiven Ziele: von links nach rechts. Türkis: unter 100 ms · Gelb: Lag-Spitze ab 100 ms · Rot: keine Ping-Antwort · Grau: kein gültiger Messwert.';
  track.dataset.sampleCount = String(model.samples.length);
  const previous = rendered.get(track) || { keys: new Set(), initialized: false, bars: new Map() };
  const valid = model.samples.filter(sample => sample.latency != null).map(sample => sample.latency);
  const max = Math.max(100, ...valid);
  const wanted = new Set();
  model.samples.forEach((sample, index) => {
    const slot = index + (60 - model.samples.length);
    wanted.add(sample.key);
    let bar = previous.bars.get(sample.key);
    if (!bar) { bar = document.createElement('span'); bar.className = 'live-signal-sample'; previous.bars.set(sample.key, bar); }
    const oldSlot = bar.dataset.slot === undefined ? null : Number(bar.dataset.slot);
    bar.className = `live-signal-sample is-${sample.tone}`;
    bar.dataset.key = sample.key; bar.dataset.slot = String(slot); bar.dataset.host = sample.host || '';
    bar.style.gridColumn = String(slot + 1);
    bar.style.height = sample.kind === 'ping' ? `${Math.max(2, Math.min(100, sample.latency / max * 100))}%` : sample.kind === 'loss' ? '100%' : '20%';
    const time = new Date(sample.at).toLocaleString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const value = sample.kind === 'ping' ? `${sample.latency} ms` : sample.kind === 'loss' ? 'Ping-Verlust' : sample.kind === 'error' ? 'Messfehler (kein Verlust)' : 'Kein Latenzwert';
    bar.title = `${sample.label} · ${time} · ${value}`; bar.setAttribute('aria-hidden', 'true');
    if (bar.parentNode !== chart) chart.append(bar);
    const reduced = container.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (previous.initialized && !reduced && (oldSlot !== slot || !previous.keys.has(sample.key))) {
      bar.getAnimations?.().forEach(animation => animation.cancel());
      const distance = oldSlot == null ? 1 : oldSlot - slot;
      bar.animate?.([
        { transform: `translateX(${distance * 100}%)`, opacity: oldSlot == null ? 0 : 1 },
        { transform: 'translateX(0)', opacity: 1 },
      ], { duration: 240, easing: 'cubic-bezier(.2,.7,.2,1)' });
    }
  });
  for (const [key, bar] of previous.bars) if (!wanted.has(key)) { bar.remove(); previous.bars.delete(key); }
  previous.keys = new Set(model.samples.map(sample => sample.key)); previous.initialized = true; rendered.set(track, previous);
}
