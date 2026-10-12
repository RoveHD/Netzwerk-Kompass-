import test from 'node:test';
import assert from 'node:assert/strict';
import { liveSignalModel } from '../public/live-signal.js';

const stamp = second => `2026-10-12T10:00:${String(second).padStart(2, '0')}Z`;
const makeTarget = (host, samples, enabled = true) => ({ host, label: host, enabled, kind: 'internet', stats: { status: 'ok', sent: samples.length }, samples });

test('live model deduplicates identical samples per host, sorts oldest to newest and limits to 60', () => {
  const samples = Array.from({ length: 61 }, (_, i) => ({ at: new Date(Date.parse('2026-10-12T10:00:00Z') + i * 1000).toISOString(), ok: true, ms: i + 1 }));
  const model = liveSignalModel({ targets: [makeTarget('wan', [samples[0], ...samples]), makeTarget('disabled', [{ at: stamp(1), ok: true, ms: 4 }], false)] });
  assert.equal(model.samples.length, 60);
  assert.equal(model.samples[0].latency, 2);
  assert.equal(model.samples.at(-1).latency, 61);
});

test('loss and local measurement errors remain distinct; only real ping values get latency tones', () => {
  const model = liveSignalModel({ targets: [makeTarget('wan', [
    { at: stamp(1), ok: true, ms: 18 },
    { at: stamp(2), ok: true, ms: 31 },
    { at: stamp(3), ok: false, ms: null, status: 'down' },
    { at: stamp(4), ok: false, ms: null, status: 'measurement_error' },
  ])] });
  assert.deepEqual(model.samples.map(sample => [sample.kind, sample.tone]), [
    ['ping', 'ok'], ['ping', 'slow'], ['loss', 'loss'], ['error', 'unknown'],
  ]);
});

test('ring data includes only enabled targets and preserves overview diagnosis states', () => {
  const model = liveSignalModel({ targets: [
    { ...makeTarget('ok', []), stats: { sent: 2, status: 'ok' } },
    { ...makeTarget('bad', []), stats: { sent: 2, status: 'critical' } },
    makeTarget('paused', [], false),
  ] });
  assert.deepEqual(model.targets.map(target => [target.label, target.status, target.tone]), [
    ['ok', 'ok', 'ok'], ['bad', 'critical', 'critical'],
  ]);
});
