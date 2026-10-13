import test from 'node:test';
import assert from 'node:assert/strict';
import { measurementSettings, targetInterval, evaluateMeasurementQuality, pingMetrics } from '../lib/measurement-quality.js';

test('standard and precision retain bounded 250 ms local / 1000 ms remote targets', () => {
  assert.deepEqual(measurementSettings(), { mode: 'standard', localIntervalMs: 250, remoteIntervalMs: 1000 });
  const precision = measurementSettings({ mode: 'precision' });
  const router = { host: '192.168.178.1', kind: 'gateway' }, repeater = { host: '192.168.178.2', kind: 'device' };
  assert.equal(targetInterval(router, { mode: 'standard' }), 1000);
  assert.equal(targetInterval(router, precision), 250);
  assert.equal(targetInterval(repeater, { ...precision, repeaterHost: repeater.host }), 250);
  assert.equal(targetInterval({ host: '192.168.178.3', kind: 'repeater' }, { ...precision, repeaterHost: repeater.host }), 1000);
  assert.equal(targetInterval({ host: '1.1.1.1', kind: 'internet' }, precision), 1000);
  assert.equal(targetInterval(router, { ...precision, backoffMs: -1 }), 250);
  assert.equal(targetInterval(router, { ...precision, backoffMs: 500 }), 500);
  assert.equal(targetInterval(router, { ...precision, backoffMs: 1001 }), 1000);
  for (const value of [null, [], 'precision', { mode: 'turbo' }]) assert.throws(() => measurementSettings(value), TypeError);
});

test('measurement overload boundaries use actual duration, CPU share and scheduler delay', () => {
  const atBoundary = { durationMs: 250, scheduledIntervalMs: 250, schedulerDelayMs: 150, cpuFraction: .2 };
  assert.equal(evaluateMeasurementQuality(atBoundary).status, 'normal');
  for (const change of [{ durationMs: 251 }, { schedulerDelayMs: 151 }, { cpuFraction: .2001 }]) {
    const quality = evaluateMeasurementQuality({ ...atBoundary, ...change });
    assert.equal(quality.status, 'limited'); assert.equal(quality.backoffMs, 500);
    assert.equal(quality.gap, false, 'local overload alone is not a missing measurement');
  }
  const standard = evaluateMeasurementQuality({ durationMs: 1000, scheduledIntervalMs: 1000 });
  assert.equal(standard.status, 'normal');
  assert.equal(evaluateMeasurementQuality({ durationMs: 1001, scheduledIntervalMs: 1000 }).status, 'limited');
});

test('adaptive backoff increases at most to one second and recovers without crossing 250 ms', () => {
  let backoffMs = 250;
  for (let i = 0; i < 8; i++) {
    const quality = evaluateMeasurementQuality({ durationMs: 2000, previousBackoffMs: backoffMs });
    assert.ok(quality.backoffMs >= backoffMs); assert.ok(quality.backoffMs <= 1000);
    backoffMs = quality.backoffMs;
  }
  assert.equal(backoffMs, 1000);
  for (let i = 0; i < 20; i++) {
    const quality = evaluateMeasurementQuality({ previousBackoffMs: backoffMs });
    assert.ok(quality.backoffMs <= backoffMs); assert.ok(quality.backoffMs >= 250);
    backoffMs = quality.backoffMs;
  }
  assert.equal(backoffMs, 250);
});

test('measurement gaps are strict above two seconds or three scheduled intervals', () => {
  for (const [scheduledIntervalMs, boundary] of [[250, 2000], [1000, 3000]]) {
    assert.equal(evaluateMeasurementQuality({ scheduledIntervalMs, actualIntervalMs: boundary }).gap, false);
    assert.equal(evaluateMeasurementQuality({ scheduledIntervalMs, actualIntervalMs: boundary + 1 }).gap, true);
    assert.equal(evaluateMeasurementQuality({ scheduledIntervalMs, actualIntervalMs: null }).gap, false);
  }
});

test('P95/P99 use nearest rank of successful non-error values, including real zero', () => {
  const at = index => new Date(Date.UTC(2026, 9, 13) + index * 250).toISOString();
  const samples = Array.from({ length: 100 }, (_, index) => ({ ok: true, ms: index, at: at(index) }));
  samples.push({ ok: false, timeout: true, ms: 100000 }, { ok: true, status: 'measurement_error', ms: 999999 }, { status: 'measurement_error', ok: false }, { ok: true, ms: -1 }, { ok: true, ms: NaN });
  const metrics = pingMetrics(samples);
  assert.equal(metrics.p95Ms, 94); assert.equal(metrics.p99Ms, 98); assert.equal(metrics.percentileMethod, 'nearest-rank');
  assert.equal(metrics.measurementErrors, 2); assert.equal(metrics.actualIntervalMs, 250); assert.equal(metrics.maxIntervalMs, 250);
  assert.equal(pingMetrics([{ ok: true, ms: 0 }]).p99Ms, 0);
  assert.equal(pingMetrics([{ ok: false, timeout: true }]).p95Ms, null);
  assert.equal(pingMetrics().p99Ms, null);
});

test('observed intervals survive unordered timestamps, and explicit gaps stay separate from errors', () => {
  const baseline = Date.UTC(2026, 9, 13);
  const samples = [
    { at: new Date(baseline + 4000).toISOString(), ok: true, ms: 3, quality: { gap: true } },
    { at: new Date(baseline).toISOString(), ok: true, ms: 1 },
    { at: new Date(baseline + 1000).toISOString(), status: 'measurement_error' },
    { at: new Date(baseline + 1000).toISOString(), ok: true, ms: 2 },
    { at: 'invalid', ok: false }
  ];
  const metrics = pingMetrics(samples);
  assert.equal(metrics.actualIntervalMs, 2000); assert.equal(metrics.maxIntervalMs, 3000);
  assert.equal(metrics.measurementGaps, 1); assert.equal(metrics.measurementErrors, 1);
  assert.equal(pingMetrics([{ at: samples[1].at }]).actualIntervalMs, null);
});
