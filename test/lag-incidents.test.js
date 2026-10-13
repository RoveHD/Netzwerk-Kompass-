import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLagPhases, summarizeLagWindow, correlateLagTraffic, prepareLagTraffic } from '../public/lag-incidents.js';

const origin = Date.parse('2026-10-12T12:00:00.000Z');
const at = offset => new Date(origin + offset).toISOString();
const measurementStartedAt = at(-60000);
const ping = (offset, results, extra = {}) => ({ type: 'ping', at: at(offset), appSessionId: 'app-a', measurementStartedAt, sessionId: 'monitor-a', epoch: 1, interfaceId: 'eth-a', results, ...extra });
const answer = (host, ms, extra = {}) => ({ host, ok: true, ms, ...extra });
const lost = host => ({ host, ok: false, status: 'timeout' });
const error = host => ({ host, ok: false, status: 'measurement_error', error: 'Probe fehlgeschlagen' });

test('below 100 ms is no Lag spike; exactly 100 ms and losses group, measurement errors stay separate', () => {
  const records = [
    ping(0, [answer('router', 99.99)]),
    ping(1000, [answer('router', 100)]),
    ping(2000, [lost('router')]),
    ping(3000, [answer('router', 12)]),
    ping(4000, [error('router')]),
    ping(5000, [error('router')]),
  ];
  const phases = buildLagPhases(records, new Set(['router']));
  const network = phases.find(item => item.kind === 'network');
  const errors = phases.find(item => item.kind === 'measurement_error');
  assert.equal(phases.length, 2);
  assert.equal(network.sampleCount, 2);
  assert.equal(network.lossCount, 1);
  assert.equal(network.maxPing, 100);
  assert.equal(errors.sampleCount, 2);
  assert.equal(errors.lossCount, 0);
  assert.equal(errors.measurementErrorCount, 2);
});

test('selected targets, session, adapter, epoch and long gaps form separate phases', () => {
  const records = [
    ping(0, [answer('router', 100), answer('other', 120)]),
    ping(1000, [answer('router', 101)], { interfaceId: 'eth-b' }),
    ping(2000, [answer('router', 102)], { epoch: 2, interfaceId: 'eth-b' }),
    ping(13000, [answer('router', 103)], { epoch: 2, interfaceId: 'eth-b' }),
    ping(14000, [answer('router', 104)], { epoch: 2, interfaceId: 'eth-b', measurementStartedAt: at(14000) }),
  ];
  const phases = buildLagPhases(records, new Set(['router']));
  assert.equal(phases.length, 5);
  assert.ok(phases.every(phase => phase.targetCounts.every(target => target.host === 'router')));
  assert.equal(buildLagPhases(records, new Set(['unknown'])).length, 0);
});

test('missing ok is unknown and duplicate host/time/epoch results count only once', () => {
  const records = [ping(0, [{ host: 'router', ms: 90 }, lost('router'), lost('router')])];
  const phases = buildLagPhases(records, ['router']);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].lossCount, 1);
  const stats = summarizeLagWindow(records, ['router'], phases[0], origin, origin)[0];
  assert.equal(stats.samples, 2);
  assert.equal(stats.lost, 1);
});

test('before, during and after summaries keep losses, errors and absent data distinct', () => {
  const records = [
    ping(-20000, [answer('router', 19)]),
    ping(0, [lost('router')]),
    ping(20000, [error('router')]),
  ];
  const phase = buildLagPhases(records, ['router']).find(item => item.kind === 'network');
  const before = summarizeLagWindow(records, ['router'], phase, phase.start - 30000, phase.start - 1)[0];
  const during = summarizeLagWindow(records, ['router'], phase, phase.start, phase.end)[0];
  const after = summarizeLagWindow(records, ['router'], phase, phase.end + 1, phase.end + 30000)[0];
  assert.deepEqual([before.samples, before.averagePing, before.lossPercent, before.errors], [1, 19, 0, 0]);
  assert.deepEqual([during.samples, during.answers, during.lost, during.lossPercent], [1, 0, 1, 100]);
  assert.deepEqual([after.samples, after.lost, after.errors], [1, 0, 1]);
  const missing = summarizeLagWindow([], ['router'], phase, phase.start, phase.end)[0];
  assert.equal(missing.samples, 0);
  assert.equal(missing.averagePing, null);
  assert.equal(missing.lossPercent, null);
});

const routerInterval = (mac, name, start, end, { down = 1000, up = 200, rate = 8, rateAvailable = true, available = true, id = `mac:${mac}` } = {}) => ({
  id, mac, name, available, rateAvailable, source: 'mesh-wan-counters', scope: 'internet',
  intervalStartedAt: at(start), at: at(end), downloadDeltaBytes: down, uploadDeltaBytes: up,
  downloadMbps: rate, uploadMbps: rate / 4
});
const fritz = (offset, deviceTraffic = [], extra = {}) => ({ type: 'fritzbox', at: at(offset), appSessionId: 'app-a', measurementStartedAt, sessionId: 'router-a', epoch: 1, wan: { downloadMbps: 90, uploadMbps: 12 }, deviceTraffic, ...extra });
const phaseForTraffic = (start, end, extra = {}) => ({ start, end, appSessionId: 'app-a', measurementStartedAt, epoch: 1, epochKey: 'unused', interfaceId: 'eth-a', ...extra });

test('device traffic uses exact partial interval overlap, stable source identity, and no WAN/device double counting', () => {
  const phase = phaseForTraffic(origin, origin + 8000);
  const records = [
    { type: 'traffic', at: at(1000), appSessionId: 'app-a', measurementStartedAt, sessionId: 'monitor-a', epoch: 1, interfaceId: 'eth-a', downloadMbps: 55, uploadMbps: 4 },
    fritz(5000, [routerInterval('AA:BB:CC:DD:EE:01', 'Repeater', -5000, 5000, { down: 10000000, up: 2500000, rate: 8 })]),
  ];
  const result = correlateLagTraffic(records, phase);
  assert.equal(result.pc.samples, 1);
  assert.equal(result.wan.samples, 1);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].estimatedDownloadBytes, 5000000);
  assert.equal(result.devices[0].estimatedUploadBytes, 1250000);
  assert.equal(result.devices[0].intervalRateDownloadMbps, 8);
});

test('PC, WAN and device byte intervals stay separate and compare WAN load with reported capacity', () => {
  const phase = phaseForTraffic(origin, origin + 5000);
  const records = [
    { type: 'traffic', at: at(5000), intervalStartedAt: at(-5000), downloadDeltaBytes: 10000000, uploadDeltaBytes: 2500000, interfaceId: 'eth-a', downloadMbps: 8, uploadMbps: 2, appSessionId: 'app-a', measurementStartedAt, sessionId: 'monitor-a', epoch: 1 },
    fritz(5000, [routerInterval('AA:BB:CC:DD:EE:11', 'Fernseher', -5000, 5000, { down: 100000000, up: 12500000, rate: 80 })], { wan: { downloadMbps: 80, uploadMbps: 10, intervalStartedAt: at(-5000), downloadDeltaBytes: 100000000, uploadDeltaBytes: 12500000, downstreamMbps: 100, upstreamMbps: 12 } }),
  ];
  const result = correlateLagTraffic(records, phase);
  assert.equal(result.pc.download.intervalBytes, 10000000);
  assert.equal(result.pc.download.estimatedPhaseBytes, 5000000);
  assert.equal(result.wan.download.intervalBytes, 100000000);
  assert.equal(result.wanUtilization.downloadPercent, 80);
  assert.equal(result.wanUtilization.overload, false);
  assert.equal(result.devices[0].intervalDownloadBytes, 100000000);
  assert.equal(result.devices[0].estimatedDownloadBytes, 50000000);
});

test('fast WAN-only records preserve the most recent explicit device traffic capability',()=>{
  const records=[fritz(0,[],{deviceTrafficCapability:{available:false,reason:'Gerätezähler nicht verfügbar.'}}),
    fritz(1000,[],{capture:{reason:'traffic'},wan:{downloadMbps:20,uploadMbps:1}})];
  assert.equal(prepareLagTraffic(records).capabilityReason,'Gerätezähler nicht verfügbar.');
  records.push(fritz(2000,[],{deviceTrafficCapability:{available:true,reason:null}}));
  assert.equal(prepareLagTraffic(records).capabilityReason,null);
});

test('interval projections preserve timing uncertainty and actual overlap rather than whole counter span',()=>{
  const point={at:at(10000),intervalStartedAt:at(-10000),downloadDeltaBytes:10000000,uploadDeltaBytes:1000000,
    downloadMbps:4,uploadMbps:.4,rateAvailable:true,measurementBasis:'router-reported-last-update',timingUncertaintyMs:350};
  const index={sources:[{id:'wan',kind:'wan',points:[point]},{id:'device',kind:'device',label:'TV',points:[point]}]};
  const result=correlateLagTraffic(index,{start:origin,end:origin+5000});
  assert.equal(result.wan.intervals[0].measurementBasis,point.measurementBasis);
  assert.equal(result.wan.intervals[0].timingUncertaintyMs,350);
  const interval=result.devices[0].intervalsDetail[0];
  assert.equal(interval.start,at(-10000)); assert.equal(interval.end,at(10000));
  assert.equal(interval.overlapStart,at(0)); assert.equal(interval.overlapEnd,at(5000));
  assert.equal(interval.measurementBasis,point.measurementBasis); assert.equal(interval.timingUncertaintyMs,350);
  const spike=correlateLagTraffic(index,{start:origin,end:origin}).devices[0].intervalsDetail[0];
  assert.equal(spike.overlapStart,at(0)); assert.equal(spike.overlapEnd,at(0)); assert.equal(spike.overlapMs,0);
});

test('WAN capacity zero or unknown never becomes zero utilization; 90 percent is only a load hint', () => {
  const phase = phaseForTraffic(origin, origin + 5000);
  const record = fritz(5000, [], { wan: { downloadMbps: 90, uploadMbps: 0, intervalStartedAt: at(-5000), downloadDeltaBytes: 112500000, uploadDeltaBytes: 0, downstreamMbps: 100, upstreamMbps: 0 } });
  const loaded = correlateLagTraffic([record], phase);
  assert.equal(loaded.wanUtilization.downloadPercent, 90);
  assert.equal(loaded.wanUtilization.uploadPercent, null);
  assert.equal(loaded.wanUtilization.overload, true);
  const unknown = correlateLagTraffic([fritz(5000, [], { wan: { downloadMbps: 90, intervalStartedAt: at(-5000), downloadDeltaBytes: 112500000, uploadDeltaBytes: 0, downstreamMbps: null, upstreamMbps: 0 } })], phase);
  assert.equal(unknown.wanUtilization.downloadPercent, null);
  assert.equal(unknown.wanUtilization.uploadPercent, null);
  assert.equal(unknown.wanUtilization.overload, false);
});

test('WAN utilization uses the accepted intervals once and matches each legacy rate to its own capacity', () => {
  const phase = phaseForTraffic(origin, origin + 5000);
  const duplicateIntervals = [
    fritz(5000, [], { wan: { downloadMbps: 80, uploadMbps: 0, intervalStartedAt: at(-5000), downloadDeltaBytes: 100000000, uploadDeltaBytes: 0, downstreamMbps: 100, upstreamMbps: 0 } }),
    fritz(6000, [], { wan: { downloadMbps: 900, uploadMbps: 0, intervalStartedAt: at(-4000), downloadDeltaBytes: 1125000000, uploadDeltaBytes: 0, downstreamMbps: 10, upstreamMbps: 0 } }),
  ];
  const intervals = correlateLagTraffic(duplicateIntervals, phase);
  assert.equal(intervals.wan.samples, 1);
  assert.equal(intervals.wanUtilization.downloadPercent, 80);
  const legacy = correlateLagTraffic([
    fritz(1000, [], { wan: { downloadMbps: 50, uploadMbps: 0, downstreamMbps: 100, upstreamMbps: 0 } }),
    fritz(1000, [], { wan: { downloadMbps: 50, uploadMbps: 0, downstreamMbps: 100, upstreamMbps: 0 } }),
    fritz(4000, [], { wan: { downloadMbps: 800, uploadMbps: 0, downstreamMbps: 1000, upstreamMbps: 0 } }),
  ], phase);
  assert.equal(legacy.wanUtilization.downloadPercent, 65);
});

test('point incidents only show rates with a nearby sample and router intervals containing that moment', () => {
  const phase = phaseForTraffic(origin, origin, { interfaceId: 'eth-a' });
  const records = [
    { type: 'traffic', at: at(-900), appSessionId: 'app-a', measurementStartedAt, sessionId: 'monitor-a', epoch: 1, interfaceId: 'eth-a', downloadMbps: 9, uploadMbps: 2 },
    fritz(10000, [routerInterval('AA:BB:CC:DD:EE:02', 'Access Point', -10000, 10000, { down: 100000000, up: 10000000, rate: 40 })]),
  ];
  const result = correlateLagTraffic(records, phase);
  assert.deepEqual(result.pc.offsets, [-900]);
  assert.equal(result.devices.length, 1);
  assert.equal(result.devices[0].estimatedDownloadBytes, null);
  assert.equal(result.pointPhase, true);
});

test('stale, reset, unsupported and overlapping router intervals are not counted as exact device traffic', () => {
  const phase = phaseForTraffic(origin, origin + 1000);
  const records = [fritz(5000, [
    routerInterval('AA:BB:CC:DD:EE:03', 'Alt', -20000, -10000),
    routerInterval('AA:BB:CC:DD:EE:04', 'Reset', -5000, 5000, { down: -1 }),
    routerInterval('AA:BB:CC:DD:EE:05', 'Nicht verfügbar', -5000, 5000, { rateAvailable: false }),
    routerInterval('AA:BB:CC:DD:EE:06', 'Duplikat 1', -5000, 5000, { down: 10000000 }),
    routerInterval('AA:BB:CC:DD:EE:06', 'Duplikat 2', -5000, 5000, { down: 10000000 }),
    routerInterval('AA:BB:CC:DD:EE:07', 'Zu alt', -100000, 5000, { down: 10000000 }),
  ], { deviceTrafficTruncated: true, deviceTrafficCapability: { reason: 'Einige Zähler fehlen.' } })];
  const result = correlateLagTraffic(records, phase);
  assert.deepEqual(result.devices.map(item => item.label), ['Duplikat 2']);
  assert.equal(result.devices[0].intervals, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.capabilityReason, 'Einige Zähler fehlen.');
});

test('traffic from another app session or PC adapter is excluded', () => {
  const phase = phaseForTraffic(origin, origin, { interfaceId: 'eth-a' });
  const records = [
    { type: 'traffic', at: at(0), appSessionId: 'app-b', measurementStartedAt, epoch: 1, interfaceId: 'eth-a', downloadMbps: 90, uploadMbps: 90 },
    { type: 'traffic', at: at(0), appSessionId: 'app-a', measurementStartedAt, epoch: 1, interfaceId: 'eth-b', downloadMbps: 80, uploadMbps: 80 },
    { type: 'traffic', at: at(0), appSessionId: 'app-a', measurementStartedAt: at(-30000), epoch: 1, interfaceId: 'eth-a', downloadMbps: 70, uploadMbps: 70 },
    { type: 'traffic', at: at(5000), intervalStartedAt: at(-5000), appSessionId: 'app-b', measurementStartedAt, epoch: 1, interfaceId: 'eth-a', downloadDeltaBytes: 5000000, uploadDeltaBytes: 5000000 },
  ];
  const result = correlateLagTraffic(records, phase);
  assert.equal(result.pc.samples, 0);
  assert.equal(result.pc.download.average, null);
});
