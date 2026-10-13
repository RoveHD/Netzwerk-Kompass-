// Target selection is bounded; the scheduler never overlaps a probe batch.
export function measurementSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Ungültige Messeinstellungen.');
  const mode = value.mode ?? 'standard';
  if (!['standard', 'precision'].includes(mode)) throw new TypeError('Unbekannter Messmodus.');
  return { mode, localIntervalMs: 250, remoteIntervalMs: 1000 };
}

export function targetInterval(target, { mode, repeaterHost, backoffMs = 0 } = {}) {
  const critical = target.kind === 'gateway' || target.host === repeaterHost;
  return mode === 'precision' && critical ? Math.max(250, Math.min(1000, backoffMs)) : 1000;
}

export function evaluateMeasurementQuality({ durationMs = 0, scheduledIntervalMs = 1000, actualIntervalMs = null, cpuFraction = 0, schedulerDelayMs = 0, previousBackoffMs = 250 } = {}) {
  const limited = durationMs > scheduledIntervalMs || schedulerDelayMs > 150 || cpuFraction > .2;
  const backoffMs = limited ? Math.min(1000, Math.max(500, previousBackoffMs * 2)) : Math.max(250, previousBackoffMs - 50);
  return { durationMs, scheduledIntervalMs, actualIntervalMs, schedulerDelayMs, cpuFraction,
    status: limited ? 'limited' : 'normal', backoffMs,
    gap: Number.isFinite(actualIntervalMs) && actualIntervalMs > Math.max(2000, scheduledIntervalMs * 3),
    meaning: 'Tatsächlicher Abstand und lokale Messdauer; CPU-Anteil betrifft den Node-Messprozess. Keine lückenlose Erfassung.' };
}

export function pingMetrics(samples = []) {
  const ordered = samples.filter(s => s.ok === true && s.status !== 'measurement_error' && Number.isFinite(s.ms) && s.ms >= 0).map(s => s.ms).sort((a,b) => a-b);
  const quantile = p => ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * p) - 1)] : null;
  const times = samples.map(s => Date.parse(s.at)).filter(Number.isFinite).sort((a,b) => a-b);
  const gaps = times.slice(1).map((t,i) => t-times[i]).filter(gap => gap > 0);
  return { p95Ms: quantile(.95), p99Ms: quantile(.99), percentileMethod: 'nearest-rank',
    measurementErrors: samples.filter(s => s.status === 'measurement_error').length,
    actualIntervalMs: gaps.length ? gaps.reduce((a,b) => a+b,0)/gaps.length : null,
    maxIntervalMs: gaps.length ? Math.max(...gaps) : null,
    measurementGaps: samples.filter(s => s.quality?.gap === true).length };
}
