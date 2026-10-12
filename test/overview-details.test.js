import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSparklineSegments, overviewDeviceRows, overviewDevices, overviewQualityRows, overviewRecentTests, overviewTrafficHistory, preferredPingTarget, throughputAxis } from '../public/overview-details.js';

test('overview quality uses measured ping statistics and existing status without inventing a score', () => {
  const state = { targets: [
    { kind: 'gateway', enabled: true, label: 'Router', stats: { sent: 10, avgMs: 1, jitterMs: 0.2, lossPercent: 0, status: 'ok' } },
    { kind: 'internet', enabled: true, label: 'Internet', stats: { sent: 10, avgMs: 24.8, jitterMs: 4, lossPercent: 2, status: 'warning' } },
  ] };
  assert.equal(preferredPingTarget(state).label, 'Internet');
  assert.deepEqual(overviewQualityRows(state).map(row => row.value), ['24,8 ms', '4 ms', '2 %']);
  assert.deepEqual(overviewQualityRows(state).map(row => row.status), ['warning', 'warning', 'warning']);
  assert.ok(overviewQualityRows(state).every(row => !Object.hasOwn(row, 'score')));
});

test('the worst active internet target supplies quality values; paused, pending, and errors never appear healthy', () => {
  const targets = [
    { kind: 'internet', enabled: true, label: 'Stable', stats: { sent: 8, avgMs: 20, jitterMs: 1, lossPercent: 0, status: 'ok' } },
    { kind: 'internet', enabled: true, label: 'Failed', stats: { sent: 8, avgMs: 80, jitterMs: 15, lossPercent: 60, status: 'down' } },
  ];
  const failed = { targets, monitoring: true };
  assert.equal(preferredPingTarget(failed).label, 'Failed');
  assert.deepEqual(overviewQualityRows(failed).map(row => row.value), ['80 ms', '15 ms', '60 %']);
  assert.ok(overviewQualityRows(failed).every(row => row.status === 'down'));

  const pending = { monitoring: true, targets: [{ enabled: true, kind: 'internet', stats: { sent: 0, avgMs: 20, jitterMs: 2, lossPercent: 0, status: 'pending' } }] };
  assert.deepEqual(overviewQualityRows(pending).map(row => row.value), ['–', '–', '–']);
  assert.ok(overviewQualityRows(pending).every(row => row.status === 'pending'));

  const errored = { monitoring: true, targets: [{ enabled: true, kind: 'internet', lastError: 'lokaler Fehler', stats: { sent: 8, avgMs: 20, jitterMs: 2, lossPercent: 0, status: 'ok' } }] };
  assert.deepEqual(overviewQualityRows(errored).map(row => row.value), ['–', '–', '–']);
  assert.deepEqual(overviewQualityRows(errored).map(row => row.status), ['error', 'error', 'pending']);

  const paused = { monitoring: false, targets: [{ enabled: true, kind: 'internet', stats: { sent: 8, avgMs: 20, jitterMs: 2, lossPercent: 0, status: 'ok' } }] };
  assert.deepEqual(overviewQualityRows(paused).map(row => row.value), ['–', '–', '–']);
  assert.ok(overviewQualityRows(paused).every(row => row.status === 'paused'));
});

test('traffic chart data is restricted to the selected interface', () => {
  const history = [{ at: '2026-10-12T10:00:00Z', downloadMbps: 4, uploadMbps: 1 }];
  assert.deepEqual(overviewTrafficHistory({ selectedInterfaceId: 'wifi', traffic: { interfaceId: 'wifi', history } }), history);
  assert.deepEqual(overviewTrafficHistory({ selectedInterfaceId: 'wifi', traffic: { interfaceId: 'ethernet', history } }), []);
  assert.deepEqual(overviewTrafficHistory({ traffic: { history } }), history);
});

test('throughput axes stay finite when all measured rates are zero', () => {
  const axis = throughputAxis([0, 0, 0]);
  assert.equal(axis.axisMax, 1);
  assert.ok(Number.isFinite(axis.tickStep));
  assert.ok(Number.isFinite(axis.tickCount));
});

test('sparkline segments stop at missing values, long gaps, epoch changes, and measurement errors', () => {
  const points = [
    { at: 0, value: 2, epoch: 'a' }, { at: 1000, value: 4, epoch: 'a' },
    { at: 2000, value: null, epoch: 'a' }, { at: 3000, value: 3, epoch: 'a' }, { at: 4000, value: 5, epoch: 'a' },
    { at: 15000, value: 1, epoch: 'a' }, { at: 16000, value: 3, epoch: 'a' },
    { at: 30000, value: 1, epoch: 'a' }, { at: 31000, value: 3, epoch: 'a' },
    { at: 32000, value: 2, epoch: 'b' }, { at: 33000, value: 6, epoch: 'b' },
    { at: 34000, value: 2, epoch: 'b', status: 'measurement_error' },
  ];
  const segments = buildSparklineSegments(points);
  assert.deepEqual(segments.map(segment => segment.length), [2, 6, 2]);
  assert.equal(buildSparklineSegments([{ at: 'invalid', value: 3 }, { at: '2026-10-12T10:00:00Z', value: null }]).length, 0);
});

test('devices are selected by interface and capped at five using actual host and state fields', () => {
  const devices = Array.from({ length: 7 }, (_, index) => ({ ip: `192.168.1.${index + 2}`, interfaceId: 'wifi', respondsToPing: index === 0, name: index === 0 ? 'Laptop' : '' }));
  devices.push({ ip: '10.0.0.2', interfaceId: 'ethernet', respondsToPing: true });
  const state = { selectedInterfaceId: 'wifi', devices };
  assert.equal(overviewDevices(state).length, 5);
  assert.equal(overviewDeviceRows(state)[0].label, 'Laptop');
  assert.equal(overviewDeviceRows(state)[0].value, 'Erreichbar');
  assert.equal(overviewDeviceRows(state)[0].detail, '192.168.1.2');
  assert.equal(overviewDeviceRows(state)[0].detailMono, true);
  assert.deepEqual(overviewDevices({ devices }), []);
  assert.equal(overviewDevices({ network: { defaultInterfaceId: 'wifi' }, devices }).length, 5);
  assert.deepEqual(overviewDevices({ network: { defaultInterfaceId: 'wifi' }, devices: [{ ip: '192.168.1.99' }, ...devices] }).map(device => device.ip), ['192.168.1.99', ...devices.slice(0, 4).map(device => device.ip)]);
});

test('recent-test rows show the latest observation status, short times, and at most five real tests', () => {
  const state = {
    speedTest: { running: false, phase: 'done', at: '2026-10-12T10:00:00Z', downloadMbps: 100, uploadMbps: 20 },
    targets: [{ enabled: true, kind: 'internet', label: 'Cloudflare', samples: [
      { at: '2026-10-12T09:59:00Z', ok: true, ms: 21 },
      { at: '2026-10-12T10:00:00Z', ok: false, status: 'timeout' },
      { at: '2026-10-12T10:00:30Z', ok: false, status: 'measurement_error' },
    ] }],
    dns: { ok: true, ms: 12, at: '2026-10-12T10:00:20Z' },
  };
  const rows = overviewRecentTests(state);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].value, 'Messfehler');
  assert.equal(rows[0].status, 'error');
  assert.match(rows[0].detail, /^\d\d:\d\d:\d\d$/);
  assert.match(rows[0].detailTitle, /2026/);
  assert.equal(rows[1].value, '12 ms');
  assert.equal(rows[2].value, '100 / 20 Mbit/s');
  assert.deepEqual(overviewRecentTests({ speedTest: { phase: 'idle' }, targets: [], dns: null }), []);

  const many = { monitoring: true, targets: Array.from({ length: 8 }, (_, index) => ({ enabled: true, kind: 'internet', label: String(index), samples: [{ at: new Date(1000 + index * 1000).toISOString(), ok: true, ms: index + 1 }] })) };
  assert.equal(overviewRecentTests(many).length, 5);
  assert.equal(overviewRecentTests(many)[0].label, 'Ping · 7');
});
