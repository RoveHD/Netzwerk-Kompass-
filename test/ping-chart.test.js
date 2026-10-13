import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPingRange, zoomPingRange, panPingRange, followPingRange, initialPingRange, updatePingRange, mergeQueuedPingUpdate, preparePingSeries, isPingLossPoint, visiblePingValues, nearestPingPoint, nearestPingTime, pingTimeX, niceAxisTicks } from '../public/ping-chart.js';

test('latency axes use rounded ticks for observed ranges', () => {
  assert.deepEqual(niceAxisTicks(75), [0,25,50,75]);
  assert.deepEqual(niceAxisTicks(61), [0,25,50,75]);
  assert.deepEqual(niceAxisTicks(1), [0,0.25,0.5,0.75,1]);
});

test('zoom anchors to pointer and clamps minimum span and domain', () => {
  assert.deepEqual(zoomPingRange(null, [0, 100000], .5, .2), [10000, 60000]);
  assert.deepEqual(zoomPingRange([10000, 20000], [0, 100000], .01), [10000, 20000]);
  assert.deepEqual(zoomPingRange([10000, 20000], [0, 100000], 100), [0, 100000]);
  assert.deepEqual(fitPingRange(null, [0, 1000]), [0, 1000]);
});

test('live range follows the newest timestamp while preserving zoom span', () => {
  assert.deepEqual(followPingRange([20000, 50000], [10000, 110000]), [80000, 110000]);
  assert.deepEqual(followPingRange([0, 100000], [30000, 50000]), [30000, 50000]);
});

test('live initialization preserves stored zoom and a stored full view stays full after data growth', () => {
  assert.deepEqual(initialPingRange({ followLatest: true, range: [20000, 50000] }, [10000, 110000]), [80000, 110000]);
  assert.deepEqual(initialPingRange({ followLatest: true, range: null }, [0, 100000]), [0, 100000]);
  assert.deepEqual(updatePingRange({ followLatest: true, range: null }, [0, 200000]), [0, 200000]);
});

test('status-only drag update preserves queued measurement data and merges state', () => {
  const measurements = [{ name: 'Gateway', values: [] }];
  const queued = mergeQueuedPingUpdate(null, measurements, { monitoring: true });
  const merged = mergeQueuedPingUpdate(queued, undefined, { connected: false });
  assert.equal(merged.input, measurements);
  assert.deepEqual(merged.options, { monitoring: true, connected: false });
});

test('pan keeps the span at both boundaries and refresh keeps absolute inspected times', () => {
  assert.deepEqual(panPingRange([20000, 50000], [0, 100000], -50000), [0, 30000]);
  assert.deepEqual(panPingRange([20000, 50000], [0, 100000], 90000), [70000, 100000]);
  assert.deepEqual(fitPingRange([20000, 50000], [10000, 110000]), [20000, 50000]);
  assert.deepEqual(fitPingRange([20000, 50000], [30000, 110000]), [30000, 60000]);
  assert.deepEqual(fitPingRange([0, 100000], [30000, 50000]), [30000, 50000]);
});

test('losses, measurement errors, session changes and pauses break lines', () => {
  const at = second => new Date(second * 1000).toISOString();
  const values = [{ at: at(0), value: 10, epoch: 'a' }, { at: at(1), value: null, epoch: 'a' }, { at: at(2), value: 10, epoch: 'a' }, { at: at(3), value: 10, status: 'measurement_error', epoch: 'a' }, { at: at(4), value: 10, epoch: 'a' }, { at: at(5), value: 10, epoch: 'b' }, { at: at(30), value: 10, epoch: 'b' }];
  const [series] = preparePingSeries([{ values }]);
  assert.equal(series.values[3].value, null);
  assert.equal(new Set([0, 2, 4, 5, 6].map(i => series.values[i].segment)).size, 5);
});

test('loss markers include unanswered pings and exclude measurement errors', () => {
  assert.equal(isPingLossPoint({ value: null, status: 'timeout' }), true);
  assert.equal(isPingLossPoint({ value: undefined, status: 'no_reply' }), true);
  assert.equal(isPingLossPoint({ value: null, status: 'measurement_error' }), false);
  assert.equal(isPingLossPoint({ value: 0, status: 'ok' }), false);
});

test('overview sampling preserves peaks, zoom reveals raw neighbors and gap segments remain distinct', () => {
  const values = Array.from({ length: 2000 }, (_, i) => ({ at: new Date(i * 1000).toISOString(), epoch: 'a', value: i === 1001 ? 987 : i % 3 === 0 ? 11 : 10 }));
  values[999].value = null;
  const [series] = preparePingSeries([{ values }]);
  const overview = visiblePingValues(series.values, [0, 2000000]);
  assert.ok(overview.length < 1000); assert.ok(overview.some(point => point.value === 987));
  const zoomed = visiblePingValues(series.values, [990000, 1010000]);
  assert.equal(zoomed.length, 21); assert.equal(zoomed[9].value, null);
  assert.notEqual(zoomed[8].segment, zoomed[10].segment);
});

test('cursor selects a real nearby sample and preserves loss and measurement-error states', () => {
  const values = [
    { at: new Date(0).toISOString(), value: 12, epoch: 'a' },
    { at: new Date(1000).toISOString(), value: null, status: 'timeout', epoch: 'a' },
    { at: new Date(2000).toISOString(), value: null, status: 'measurement_error', epoch: 'a' },
    { at: new Date(3000).toISOString(), value: 18, epoch: 'a' },
  ];
  const [series] = preparePingSeries([{ values }]);
  assert.equal(nearestPingPoint(series.values, 950).status, 'timeout');
  assert.equal(nearestPingPoint(series.values, 2050).status, 'measurement_error');
  assert.equal(nearestPingPoint(series.values, 20000), null);
});

test('cursor leaves a gap between epochs empty and maps through the zoomed range', () => {
  const [series] = preparePingSeries([{ maxGapMs: 10000, values: [
    { at: new Date(0).toISOString(), value: 12, epoch: 'a' },
    { at: new Date(10000).toISOString(), value: 20, epoch: 'b' },
  ] }]);
  assert.equal(nearestPingPoint(series.values, 5000, 10000), null);
  assert.equal(nearestPingPoint(series.values, 10000, 10000).value, 20);
  assert.equal(pingTimeX(15000, [10000, 20000], 76, 908), 530);
});

test('cursor snaps to a real visible time and never borrows a point outside the zoom', () => {
  const [series] = preparePingSeries([{ maxGapMs: 1200, values: [
    { at: new Date(1000).toISOString(), value: 12, epoch: 'a' },
    { at: new Date(2000).toISOString(), value: 15, epoch: 'a' },
    { at: new Date(30000).toISOString(), value: 18, epoch: 'a' },
  ] }]);
  assert.equal(nearestPingTime([series], 1450, [0, 5000]), 1000);
  assert.equal(nearestPingTime([series], 9000, [0, 5000]), null);
  assert.equal(nearestPingPoint(series.values, 2000, 1200, [1500, 2500]).value, 15);
  assert.equal(nearestPingPoint(series.values, 1000, 1200, [1100, 1900]), null);
  assert.equal(nearestPingTime([series], 12000, [10000, 20000], Infinity), null);
});
