import { setMeasurement } from './ui-presentation.js';

const list = value => Array.isArray(value) ? value : [];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = value => finite(value) ? value.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : '–';
const severity = { ok: 0, pending: 1, warning: 2, error: 3, critical: 4, down: 5 };
export const activeTargets = state => list(state?.targets).filter(target => target.enabled);

function overviewInfo(state, extra = '') {
  const notes = list(state?.diagnosis).flatMap(item => [item.title, item.detail]).filter(Boolean);
  notes.push('Nicht überwachte Geräte und interne Mesh-Verbindungen werden nicht geprüft. Eine fehlende Ping-Antwort allein beweist keinen Ausfall.');
  if (extra) notes.unshift(extra);
  return [...new Set(notes)].join('\n');
}

export function targetState(target) {
  if (!target?.enabled) return 'paused';
  if (target.lastError) return 'error';
  if (!(target.stats?.sent > 0)) return 'pending';
  return Object.hasOwn(severity, target.stats.status) ? target.stats.status : 'pending';
}

export function summarizeOverview(state) {
  const targets = activeTargets(state);
  const problems = targets.filter(target => ['warning', 'critical', 'down', 'error'].includes(targetState(target)));
  const pending = targets.filter(target => targetState(target) === 'pending');
  const storageError = state.persistence?.lastError;
  const info = overviewInfo(state);
  if (storageError) return { level: 'warn', title: 'Messdaten werden nicht gespeichert', detail: 'Prüfe den Speicherzugriff.', info: overviewInfo(state, String(storageError)) };
  if (!state.monitoring) return { level: 'muted', title: 'Überwachung pausiert', detail: 'Starte die Überwachung, um aktuelle Messwerte zu erhalten.', info: overviewInfo(state, 'Angezeigte Ping-Werte können aus der letzten Messung stammen.') };
  if (state.lastError) return { level: 'warn', title: 'Messung eingeschränkt', detail: 'Ein Teil der Messung ist fehlgeschlagen.', info: overviewInfo(state, String(state.lastError)) };
  if (!targets.length) return { level: 'muted', title: 'Keine aktiven Messziele', detail: 'Aktiviere ein Ziel unter Geräte & Repeater.', info };
  if (problems.length) {
    const worst = problems.reduce((selected, target) => severity[targetState(target)] > severity[targetState(selected)] ? target : selected);
    const current = targetState(worst);
    const name = worst.label || worst.host;
    const detail = `${name}: ${current === 'down' ? 'keine Ping-Antwort' : current === 'critical' ? 'kritische Messwerte' : current === 'error' ? 'Messung fehlgeschlagen' : 'Werte außerhalb des üblichen Bereichs'}.`;
    const title = detail.replace(/\.$/, '');
    return { level: ['down', 'critical'].includes(current) ? 'bad' : 'warn', title, detail, info };
  }
  const warning = list(state.diagnosis).find(item => ['warning', 'error'].includes(item.level));
  if (warning) return { level: 'warn', title: warning.title, detail: 'Die automatische Prüfung hat einen Hinweis erkannt.', info };
  if (pending.length) return { level: 'muted', title: 'Messung wird aufgebaut', detail: `${targets.length - pending.length} von ${targets.length} Zielen haben Messwerte.`, info };
  const detail = targets.length === 1 ? '1 aktives Messziel antwortet unauffällig.' : `${targets.length} aktive Messziele antworten unauffällig.`;
  return { level: 'good', title: 'Alles stabil', detail, info };
}

export function internetSummary(state) {
  const allActive = activeTargets(state);
  const targets = list(state.targets).filter(target => target.kind === 'internet');
  const active = allActive.filter(target => target.kind === 'internet');
  const worst = active.reduce((selected, target) => !selected || severity[targetState(target)] > severity[targetState(selected)] ? target : selected, null);
  const status = !state.monitoring || (targets.length && !active.length) ? 'paused' : worst ? targetState(worst) : 'pending';
  const reading = !worst || ['paused', 'error', 'pending', 'down'].includes(status) || !finite(worst.stats?.lastMs) ? '–' : number(worst.stats.lastMs);
  const value = `${reading} ms`;
  const totalActive = allActive.length;
  const detail = status === 'paused' ? 'Ping-Messung pausiert' : !active.length ? 'Kein aktives Internetziel' : `${active.length} Internetziele · ${totalActive} Messziele gesamt`;
  return { status, value, reading, unit: 'ms', detail, activeInternetCount: active.length, totalActiveCount: totalActive };
}

export function lossSummary(state) {
  if (!state.monitoring) return { value: '– %', reading: '–', unit: '%', detail: 'Ping-Messung pausiert', status: 'paused' };
  const active = activeTargets(state);
  const internet = active.filter(target => target.kind === 'internet');
  const candidates = internet.length ? internet : active.filter(target => target.kind === 'gateway');
  const measured = candidates.filter(target => target.stats?.sent > 0 && finite(target.stats.lossPercent) && !target.lastError);
  const worst = measured.reduce((selected, target) => !selected || target.stats.lossPercent > selected.stats.lossPercent ? target : selected, null);
  if (!worst) return { value: '– %', reading: '–', unit: '%', detail: 'Kein gültiges Messfenster', status: 'pending' };
  const reading = number(worst.stats.lossPercent);
  return { value: `${reading} %`, reading, unit: '%', detail: `Max. im Zeitraum · ${worst.label || worst.host}`, status: worst.stats.lossPercent > 5 ? 'down' : worst.stats.lossPercent > 0 ? 'warning' : 'ok' };
}

export function renderOverview(state, doc = document) {
  const text = (id, value) => { const el = doc.getElementById(id); if (el && el.textContent !== value) el.textContent = value; };
  const labels = { ok: 'Erreichbar', warning: 'Auffällig', critical: 'Kritisch', down: 'Keine Ping-Antwort', pending: 'Warte auf Messung', error: 'Messfehler', paused: 'Pausiert' };
  const levels = { ok: 'good', warning: 'warn', critical: 'bad', down: 'bad', pending: 'muted', error: 'warn', paused: 'muted' };
  const pill = (id, status, label = labels[status]) => { const el = doc.getElementById(id); if (el) { text(id, label); el.className = `pill pill-${levels[status] || 'muted'}`; } };
  const summary = summarizeOverview(state);
  const banner = doc.getElementById('overview-status');
  if (banner) banner.dataset.level = summary.level;
  text('overview-status-title', summary.title);
  const active = activeTargets(state);
  text('overview-target-count', state.monitoring ? `${active.filter(target => targetState(target) === 'ok').length} von ${active.length} Zielen unauffällig` : 'Messung pausiert');
  const statusDetail = doc.getElementById('overview-status-detail');
  if (statusDetail) { statusDetail.textContent = summary.detail; statusDetail.classList.add('sr-only'); }
  const icon = doc.getElementById('overview-status-icon');
  if (icon) {
    const targets = activeTargets(state);
    const ns = 'http://www.w3.org/2000/svg';
    let svg = icon.querySelector('svg.overview-status-ring');
    if (!svg) { svg = doc.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('class', 'overview-status-ring'); svg.setAttribute('aria-hidden', 'true'); icon.replaceChildren(svg); }
    const colors = { ok: 'var(--green)', warning: 'var(--orange)', critical: 'var(--red)', down: 'var(--red)', error: 'var(--orange)', pending: 'var(--muted)' };
    const circumference = 2 * Math.PI * 19;
    const segments = state.monitoring ? targets : [];
    const gap = 2;
    icon.dataset.targetCount = String(segments.length);
    const wanted = new Set(segments.map(target => String(target.host || target.label || '')));
    for (const circle of Array.from(svg.querySelectorAll('circle[data-host]'))) if (!wanted.has(circle.dataset.host)) circle.remove();
    if (!segments.length) {
      let circle = svg.querySelector('circle[data-neutral]');
      if (!circle) { circle = doc.createElementNS(ns, 'circle'); circle.dataset.neutral = 'true'; circle.setAttribute('cx', '24'); circle.setAttribute('cy', '24'); circle.setAttribute('r', '19'); circle.setAttribute('fill', 'none'); circle.setAttribute('stroke-width', '4'); circle.setAttribute('transform', 'rotate(-90 24 24)'); svg.append(circle); }
      circle.setAttribute('stroke', 'var(--muted)'); circle.setAttribute('stroke-dasharray', `${circumference} 0`);
      for (const circle of Array.from(svg.querySelectorAll('circle[data-host]'))) circle.remove();
    }
    else svg.querySelector('circle[data-neutral]')?.remove();
    segments.forEach((target, index) => {
      const host = String(target.host || target.label || '');
      let circle = Array.from(svg.querySelectorAll('circle[data-host]')).find(item => item.dataset.host === host);
      if (!circle) { circle = doc.createElementNS(ns, 'circle'); circle.dataset.host = host; circle.setAttribute('cx', '24'); circle.setAttribute('cy', '24'); circle.setAttribute('r', '19'); circle.setAttribute('fill', 'none'); circle.setAttribute('stroke-width', '4'); circle.setAttribute('transform', 'rotate(-90 24 24)'); svg.append(circle); }
      delete circle.dataset.neutral;
      circle.dataset.status = targetState(target);
      circle.setAttribute('stroke', colors[targetState(target)] || colors.pending);
      const length = circumference / segments.length;
      circle.setAttribute('stroke-dasharray', `${Math.max(0, length - gap)} ${circumference - Math.max(0, length - gap)}`);
      circle.setAttribute('stroke-dashoffset', String(-index * length));
    });
  }
  const info = doc.getElementById('overview-status-info');
  if (info) { const help = [summary.info, summary.detail].filter(Boolean).join('\n'); info.title = help; info.dataset.help = help; info.setAttribute('aria-label', 'Diagnose und Messgrenzen'); }
  const action = doc.getElementById('overview-status-action');
  if (action) { action.textContent = summary.level === 'good' ? 'Messziele ansehen' : summary.level === 'muted' ? 'Überwachung prüfen' : 'Details ansehen'; action.href = ['good', 'muted'].includes(summary.level) ? '#devices' : '#history'; }
  const internet = internetSummary(state);
  const internetValue = doc.getElementById('internet-value'); if (internetValue) setMeasurement(internetValue, internet.reading, internet.unit);
  text('internet-detail', internet.detail); pill('internet-status', internet.status);
  const gateway = list(state.targets).find(target => target.kind === 'gateway');
  pill('router-status', !state.monitoring ? 'paused' : gateway ? targetState(gateway) : 'pending');
  const loss = lossSummary(state);
  const lossValue = doc.getElementById('loss-value'); if (lossValue) setMeasurement(lossValue, loss.reading, loss.unit);
  text('loss-detail', loss.detail);
  pill('loss-status', loss.status, loss.status === 'ok' ? 'Keine Verluste' : ['warning', 'down'].includes(loss.status) ? 'Verlust erkannt' : labels[loss.status]);
  // Keep truncated addresses and long labels available without expanding the cards.
  for (const id of ['router-value', 'router-detail', 'internet-detail', 'loss-detail', 'traffic-interface']) {
    const el = doc.getElementById(id); if (el) el.title = el.textContent;
  }
}
