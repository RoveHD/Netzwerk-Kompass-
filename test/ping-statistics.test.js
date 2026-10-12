import test from 'node:test';
import assert from 'node:assert/strict';
import { jitterFor, summarizePingHistory } from '../public/ping-statistics.js';

const point = (seconds, value, { epoch = 1, status = value === null ? 'TimedOut' : 'Success' } = {}) => ({ at: new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString(), epoch, value, status });

test('summary reports the highest individual ping and jitter, not averages', () => {
  const result = summarizePingHistory([point(0, 10), point(1, 12), point(2, 100)]);
  assert.ok(Math.abs(result.averagePing - (10 + 12 + 100) / 3) < 1e-10);
  assert.equal(result.averageJitter, 45);
  assert.deepEqual(result.peakPing, { value: 100, at: point(2, 100).at });
  assert.deepEqual(result.peakJitter, { value: 88, at: point(2, 100).at });
});

test('measurement errors do not count as attempts or answers and reset the jitter neighbor', () => {
  const values = [point(0, 10), point(1, 999, { status: 'measurement_error' }), point(2, 15), point(3, 18), point(4, null)];
  const result = summarizePingHistory(values);
  assert.deepEqual(result.counts, { samples: 5, answers: 3, errors: 1, attempts: 4 });
  assert.equal(result.lossPercent, 25);
  assert.deepEqual(jitterFor(values).map(item => item.value), [null, null, null, 3, null]);
});

test('jitter resets across long or backwards gaps and session changes', () => {
  const values = [
    point(0, 10),
    point(11, 30),
    point(12, 35),
    { ...point(13, 40), epoch: 2 },
    { ...point(12, 50), epoch: 2 },
  ];
  assert.deepEqual(jitterFor(values).map(item => item.value), [null, null, 5, null, null]);
});

test('empty, null, invalid timestamps and invalid values stay unknown', () => {
  assert.deepEqual(summarizePingHistory([]), {
    counts: { samples: 0, answers: 0, errors: 0, attempts: 0 },
    averagePing: null, averageJitter: null, lossPercent: null,
    peakPing: null, peakJitter: null, peakLoss: null,
  });
  const result = summarizePingHistory([null, {}, point(0, null), { ...point(1, 10), at: 'bad' }, point(2, -1)]);
  assert.deepEqual(result.counts, { samples: 2, answers: 0, errors: 0, attempts: 2 });
  assert.equal(result.averagePing, null);
  assert.equal(result.peakPing, null);
  assert.equal(result.peakJitter, null);
});

test('peak loss uses per-minute, per-epoch attempt denominators and permits partial minutes', () => {
  const a = [point(2, null, { epoch: 'a' }), point(3, 10, { epoch: 'a' })];
  const b = [point(20, null, { epoch: 'b' }), point(21, null, { epoch: 'b' }), point(22, 20, { epoch: 'b' }), point(23, 30, { epoch: 'b' })];
  const errors = [point(24, 1000, { epoch: 'b', status: 'measurement_error' })];
  const partialMinute = [point(61, null, { epoch: 'b' })];
  const result = summarizePingHistory([...a, ...b, ...errors, ...partialMinute]);
  assert.deepEqual(result.peakLoss, { value: 100, at: point(61, null).at.replace(/:\d{2}\.\d{3}Z$/, ':00.000Z'), lost: 1, attempts: 1 });
  assert.equal(result.counts.errors, 1);
  assert.equal(result.counts.attempts, 7);
  assert.equal(result.lossPercent, 100 * 4 / 7);
});

test('equal minute loss rates prefer the bucket with more attempts', () => {
  const values = [
    point(1, null, { epoch: 1 }), point(2, 12, { epoch: 1 }),
    point(10, null, { epoch: 2 }), point(11, null, { epoch: 2 }), point(12, 12, { epoch: 2 }), point(13, 12, { epoch: 2 }),
  ];
  assert.deepEqual(summarizePingHistory(values).peakLoss, {
    value: 50, at: '2026-01-01T12:00:00.000Z', lost: 2, attempts: 4,
  });
});
