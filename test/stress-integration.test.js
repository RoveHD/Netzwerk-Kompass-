import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';
import { buildDiagnosticReport } from '../lib/report.js';

function fixture() {
  let started; const ready = new Promise(resolve => { started = resolve; });
  let signal;
  const monitor = new Monitor({ pingMany: async hosts => hosts.map(host => ({ host, ok: true, ms: 10 })) }, {
    stressTestRunner: async (update, options) => {
      signal = options.signal;
      const result = { ...options, signal: undefined, elapsedSeconds: 2, downloadBytes: 5_000_000, uploadBytes: 2_000_000, downloadMbps: 20, uploadMbps: 8 };
      update(result); started();
      if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      return { ...result, reason: 'stopped' };
    },
  });
  monitor.maintenance = async () => {};
  return { monitor, ready, get signal() { return signal; } };
}

test('stress test validates before starting and excludes speedtest, reset and duplicate load', async () => {
  const f = fixture(), m = f.monitor;
  try {
    assert.throws(() => m.startStressTest({ mode: 'bad' }));
    assert.throws(() => m.startStressTest({ durationSeconds: -1 }));
    assert.equal(m.state.stressTest.running, false);
    m.state.speedTest.running = true;
    assert.throws(() => m.startStressTest(), { code: 'MONITOR_BUSY' });
    m.state.speedTest.running = false;
    m.startStressTest({ mode: 'both', durationSeconds: 0 }); await f.ready;
    assert.equal(m.state.stressTest.downloadBytes, 5_000_000);
    assert.throws(() => m.startSpeedTest(), { code: 'MONITOR_BUSY' });
    assert.throws(() => m.startStressTest(), { code: 'MONITOR_BUSY' });
    await assert.rejects(m.reset(), { code: 'MONITOR_BUSY' });
    m.state.targets.push(m.makeTarget('192.168.1.1', 'Router', 'gateway'));
    await m.tick();
    const ping = m.historySnapshot().records.find(row => row.type === 'ping');
    assert.equal(ping.underLoad, true); assert.equal(ping.loadType, 'stress');
    await m.stopStressTest(); assert.equal(f.signal.aborted, true);
    assert.equal(m.state.stressTest.running, false); assert.equal(m.state.stressTest.reason, 'stopped');
    const records = m.historySnapshot().records.filter(row => row.type === 'stress');
    assert.equal(records.length, 1); assert.equal(records[0].durationSeconds, 0);
    assert.equal(records[0].uploadBytes, 2_000_000);
    await m.stopStressTest(); assert.equal(m.historySnapshot().records.filter(row => row.type === 'stress').length, 1);
  } finally { await m.close(); }
});

test('shutdown aborts a running load before closing its history', async () => {
  const f = fixture(); f.monitor.startStressTest(); await f.ready;
  await f.monitor.close();
  assert.equal(f.signal.aborted, true); assert.equal(f.monitor.state.stressTest.running, false);
  assert.equal(f.monitor.state.stressTest.reason, 'stopped');
  assert.equal(f.monitor.history.lastError, null);
  assert.throws(() => f.monitor.startStressTest(), /beendet/);
  const speedTest=f.monitor.state.speedTest,events=f.monitor.state.events.length;
  assert.throws(() => f.monitor.startSpeedTest(), /beendet/);
  assert.equal(f.monitor.state.speedTest,speedTest);assert.equal(f.monitor.state.events.length,events);
});

test('completed runs and partial failures remain distinct and preserve counters', async () => {
  for (const failure of [false, true]) {
    const monitor = new Monitor({}, { stressTestRunner: async () => {
      const result = { elapsedSeconds: 60, downloadBytes: 123, uploadBytes: 0, reason: 'completed' };
      if (failure) throw Object.assign(new Error('Download: HTTP 503'), { partial: result });
      return result;
    } });
    try {
      monitor.startStressTest({ mode: 'download', durationSeconds: 60 }); await monitor.stressTask;
      assert.equal(monitor.state.stressTest.reason, failure ? 'error' : 'completed');
      assert.equal(monitor.state.stressTest.running, false);
      const record = monitor.historySnapshot().records.find(row => row.type === 'stress');
      assert.equal(record.downloadBytes, 123);
      assert.equal(!!record.error, failure);
    } finally { await monitor.close(); }
  }
});

test('stress API requires the local token and starts and stops only explicitly', async () => {
  const f = fixture(), monitor = f.monitor;
  const server = createApp(monitor, { token: 'stress-api' });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, token = 'stress-api') => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Token': token }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/stress/start', {}, 'wrong')).status, 403);
    assert.equal(monitor.state.stressTest.running, false);
    assert.equal((await post('/api/stress/start', { durationSeconds: 42 })).status, 400);
    assert.equal((await post('/api/stress/start', { mode: 'both', durationSeconds: 60 })).status, 202);
    await f.ready;
    assert.equal((await post('/api/speedtest', {})).status, 409);
    assert.equal((await post('/api/stress/stop', {})).status, 200);
    assert.equal(monitor.state.stressTest.running, false);
    for (const asset of ['/speedtest-options.js', '/stress-test-ui.js']) assert.equal((await fetch(url + asset)).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close(); }
});

test('diagnostic reports distinguish sustained load from speedtest measurements', async () => {
  const f = fixture(), m = f.monitor;
  try {
    m.state.targets.push(m.makeTarget('192.168.1.1', 'Router', 'gateway'));
    m.startStressTest(); await f.ready; await m.tick(); await m.stopStressTest();
    const { report } = buildDiagnosticReport(m);
    assert.equal(report.stressTests.length, 1);
    assert.equal(report.stressTests[0].downloadBytes, 5_000_000);
    assert.equal(report.pingTimeline.buckets[0].underStressTest, true);
    assert.equal(report.pingTimeline.buckets[0].underSpeedtest, false);
    assert.equal(report.notablePingRounds[0].underStressTest, true);
  } finally { await m.close(); }
});

test('load markers and spike details retain the state at Ping start across stress start and stop',async()=>{
  for(const startsDuringPing of [true,false]) {
    const f=fixture(),m=f.monitor;let finishPing;
    m.pingProbe={pingMany:()=>new Promise(resolve=>{finishPing=resolve;})};
    const target=m.makeTarget('192.168.1.1','Router','gateway');m.state.targets.push(target);
    try {
      if(!startsDuringPing){m.startStressTest();await f.ready;}
      const pending=m.tick();
      if(startsDuringPing){m.startStressTest();await f.ready;}
      else await m.stopStressTest();
      finishPing([{host:target.host,ok:true,ms:100,status:'Success'}]);await pending;
      const ping=m.historySnapshot().records.find(record=>record.type==='ping');
      assert.equal(ping.underLoad,!startsDuringPing);assert.equal(ping.loadType,startsDuringPing?null:'stress');
      const spike=m.state.events.find(event=>event.title==='Router: Ping-Spitze');
      assert.equal(spike.detail.includes('während der Dauerbelastung'),!startsDuringPing);
      const {report}=buildDiagnosticReport(m);
      assert.equal(report.notablePingRounds[0].underStressTest,!startsDuringPing);
      if(startsDuringPing)await m.stopStressTest();
    } finally {await m.close();}
  }
});

test('running stress reports contain a bounded live snapshot and a momentary-data warning',async()=>{
  const f=fixture(),m=f.monitor;
  try {
    for(let i=0;i<9;i++)m.log({type:'stress',at:new Date().toISOString(),startedAt:new Date(Date.now()-10000-i).toISOString(),running:false,reason:'completed',downloadBytes:i});
    m.startStressTest({mode:'both',durationSeconds:0});await f.ready;
    m.state.stressTest.password='must-not-leak';
    const {report}=buildDiagnosticReport(m);
    assert.equal(m.historySnapshot().records.filter(row=>row.type==='stress').length,9);
    assert.equal(report.stressTests.length,8);
    const live=report.stressTests.at(-1);
    assert.equal(live.running,true);assert.equal(live.stopping,false);assert.equal(live.reason,null);
    assert.equal(live.startedAt,m.state.stressTest.startedAt);assert.equal(live.at,report.period.to);
    assert.equal(live.elapsedSeconds,2);assert.equal(live.downloadBytes,5_000_000);assert.equal(live.uploadBytes,2_000_000);
    assert.equal(live.downloadMbps,20);assert.equal(live.uploadMbps,8);
    assert.ok(report.warnings.some(warning=>warning.includes('Test läuft noch')&&warning.includes('Momentaufnahme')));
    assert.ok(!JSON.stringify(report).includes('must-not-leak'));
    await m.stopStressTest();
    const stopped=buildDiagnosticReport(m).report;
    assert.equal(stopped.stressTests.length,8);assert.equal(stopped.stressTests.at(-1).running,false);
    assert.equal(stopped.stressTests.at(-1).reason,'stopped');
    assert.ok(!stopped.warnings.some(warning=>warning.includes('Test läuft noch')));
  } finally {await m.close();}
});
