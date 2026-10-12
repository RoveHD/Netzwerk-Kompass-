import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { AnalysisController } from '../lib/ai-analysis.js';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';

const ready = { available: true, authenticated: true, authMode: 'chatgpt', message: 'Bereit' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(overrides = {}) {
  const monitor = new Monitor({}); monitor.addTarget('192.168.1.1', 'Router');
  monitor.log({ type: 'ping', at: new Date().toISOString(), results: [{ host: '192.168.1.1', kind: 'gateway', ok: true, ms: 3 }] });
  const calls = [];
  const client = { check: async () => ({ ...ready }), analyze: async prompt => { calls.push(prompt); return 'Keine eindeutige Ursache; erst weiter messen.'; }, login: async () => {}, cancel() {}, close() {}, ...overrides };
  return { monitor, calls, controller: new AnalysisController(monitor, { client }) };
}

test('status and preview never send reports; explicit start captures the chosen period once', async () => {
  const { monitor, calls, controller } = setup();
  try {
    controller.ensureChecked(); await controller.checking; controller.preview(1); controller.snapshot();
    assert.equal(calls.length, 0); assert.equal(controller.state.connection.authenticated, true);
    controller.start(1); await controller.job;
    assert.equal(calls.length, 1); assert.match(calls[0], /BEGINN BERICHT/); assert.ok(!calls[0].includes('192.168.1.1'));
    assert.equal(controller.state.status, 'completed'); assert.ok(controller.state.result); assert.equal(controller.state.running, false);
  } finally { await controller.close(); await monitor.close(); }
});

test('double submission is blocked and cancel prevents a late successful result', async () => {
  const gate = deferred(); let sent = false;
  const { monitor, controller } = setup({ analyze: async () => { sent = true; return gate.promise; } });
  try {
    controller.start(); await Promise.resolve(); assert.equal(sent, true);
    assert.throws(() => controller.start(), { code: 'ANALYSIS_BUSY' });
    controller.cancel(); gate.resolve('Must not be displayed'); await controller.job;
    assert.equal(controller.state.status, 'cancelled'); assert.equal(controller.state.result, null);
  } finally { await controller.close(); await monitor.close(); }
});

test('reset cancels old report and ignores old results in the new measurement period', async () => {
  const gate = deferred(); const { monitor, controller } = setup({ analyze: async () => gate.promise });
  try {
    controller.start(); await Promise.resolve(); await monitor.reset(); controller.reset();
    gate.resolve('Old period diagnosis'); await controller.job;
    assert.equal(controller.state.status, 'idle'); assert.equal(controller.state.result, null); assert.equal(controller.state.reportSummary, null);
    assert.equal(controller.state.measurementStartedAt, monitor.state.measurementStartedAt);
  } finally { await controller.close(); await monitor.close(); }
});

test('missing authentication and model failure are explicit, never a fabricated diagnosis', async () => {
  for (const authenticated of [false, true]) {
    const { monitor, calls, controller } = setup({ check: async () => ({ ...ready, authenticated, message: 'Bitte anmelden' }), analyze: async () => { throw new Error('Kontingent erschöpft'); } });
    try {
      controller.start(); await controller.job;
      assert.equal(controller.state.status, 'error'); assert.equal(controller.state.result, null); assert.equal(calls.length, 0);
      assert.match(controller.state.error, authenticated ? /Kontingent/ : /anmelden/);
    } finally { await controller.close(); await monitor.close(); }
  }
});

test('cancel while checking cannot submit later and login runs only on an explicit action', async () => {
  const gate = deferred(); let logins = 0;
  const { monitor, controller, calls } = setup({ check: () => gate.promise, login: async () => { logins++; } });
  try {
    controller.start(); controller.cancel(); gate.resolve(ready); await controller.job; assert.equal(calls.length, 0); assert.equal(logins, 0);
    await controller.check(); controller.login(); await controller.job;
    assert.equal(logins, 1); assert.equal(controller.state.connection.authenticated, true);
  } finally { await controller.close(); await monitor.close(); }
});

test('analysis API guards actions and exposes safe preview without sending it', async () => {
  const { monitor, controller, calls } = setup();
  const server = createApp(monitor, { token: 'analysis-test', analysis: controller }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Token': 'analysis-test', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(base + '/api/analysis')).status, 200); await controller.checking;
    const preview = await (await fetch(base + '/api/analysis/report?hours=1')).json(); assert.equal(preview.summary.targets, 1); assert.equal(calls.length, 0);
    assert.equal((await post('/api/analysis/start', {}, { 'X-Api-Token': 'bad' })).status, 403);
    assert.equal((await post('/api/analysis/start', {}, { Origin: 'https://elsewhere.example' })).status, 403);
    assert.equal((await post('/api/analysis/login', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/analysis/start', { hours: 2 })).status, 400); assert.equal(calls.length, 0);
    assert.equal((await post('/api/analysis/start', { hours: 1 })).status, 202); await controller.job; assert.equal(calls.length, 1);
    assert.equal((await (await fetch(base + '/api/analysis')).json()).status, 'completed');
    await post('/api/reset'); assert.equal(controller.state.result, null); assert.equal(controller.state.status, 'idle');
    assert.equal((await fetch(base + '/ai.js')).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close(); }
});
