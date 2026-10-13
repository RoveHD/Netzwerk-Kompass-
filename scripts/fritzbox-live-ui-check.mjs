// Browser QA for the FRITZ!Box page's background and high-frequency traffic updates.
// All router data is synthetic; no router login or hardware access is attempted.
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('../test-artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(path.join(tmpdir(), 'network-compass-fritzbox-ui-'));
const monitor = new Monitor({}, { dataDir });
const server = createApp(monitor);
const at = new Date().toISOString();
const fritzbox = {
  connected: true, updatedAt: at, trafficUpdatedAt: at, deviceTrafficUpdatedAt: at,
  device: { model: 'Synthetic FRITZ!Box', firmware: 'test' },
  wan: { status: 'Verbunden', downloadMbps: 20, uploadMbps: 4, totalBytesReceived: 1000000, totalBytesSent: 200000, downloadDeltaBytes: 100000, uploadDeltaBytes: 20000, elapsedMs: 5000, intervalStartedAt: at, intervalEndedAt: at, measurementBasis: 'request-observation-window', observationWindow: { from: at, to: at }, timingUncertaintyMs: 1200, measurementReason: null, source: 'tr064-wan-byte-counters', scope: 'internet', sampling: { from: at, to: at, basis: 'request-observation-window' }, receiveSampling: { from: at, to: at }, sendSampling: { from: at, to: at } },
  trafficMeasurement: { wanIntervalMs: 5000, deviceIntervalMs: 2000, durationMs: 100, responseBytes: 1200 },
  hosts: [{ name: 'PC Test', ip: '192.168.178.20', mac: '00:00:00:00:00:20', active: true }],
  deviceTraffic: [{ name: 'PC Test', ip: '192.168.178.20', available: true, rateAvailable: true, downloadMbps: 5, uploadMbps: 1, downloadDeltaBytes: 625000, uploadDeltaBytes: 125000, intervalStartedAt: at, at }],
  deviceTrafficCapability: { available: true }, deviceTrafficCount: 1, deviceTrafficTruncated: false,
  mesh: { nodes: [{ id: 'router', name: 'FRITZ!Box', role: 'master' }, { id: 'rep', name: 'Repeater', role: 'repeater' }], links: [{ id: 'link', from: 'router', to: 'rep', type: 'WLAN', state: 'CONNECTED', receiveRateMbps: 300 }] },
  warnings: [], wlan: [], diagnostics: {}, capabilities: [], log: ''
};
const state = {
  version: 'test', startedAt: at, measurementStartedAt: at, monitoring: true,
  network: { interfaces: [], warnings: [], wifi: { connected: false, networks: [] } }, selectedInterfaceId: null,
  targets: [], devices: [], traffic: { history: [] }, scan: { running: false }, speedTest: { running: false }, stressTest: { running: false },
  events: [], diagnosis: [], fritzbox, gameDetection: { enabled: false, active: [] },
  measurement: { mode: 'standard', quality: { label: 'Gut', detail: 'synthetisch' } }, analysisStatus: { status: 'bereit' },
  historyPolicy: {}, incidentCapture: { enabled: false }, routerCredentialStorage: { enabled: false }, peers: { available: false, config: {}, peers: [] }, persistence: { active: false }
};
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => route.fulfill({ json: route.request().url().endsWith('/api/state') ? state : {} }));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForTimeout(250);
  assert.equal(await page.locator('#page-router').evaluate(el => el.hidden), true);
  assert.equal(await page.locator('#fritzbox-data .mesh-topology').count(), 0, 'Hidden FRITZ!Box state polls do not render the mesh graph');

  const updated = structuredClone(fritzbox);
  updated.wan.downloadMbps = 77;
  updated.wan.downloadDeltaBytes = 9625000;
  updated.wan.uploadDeltaBytes = 325000;
  updated.wan.intervalStartedAt = new Date(Date.now() - 5000).toISOString();
  updated.wan.intervalEndedAt = new Date().toISOString();
  updated.wan.measurementReason = null;
  updated.wan.sampling = { from: updated.wan.intervalStartedAt, to: updated.wan.intervalEndedAt, basis: 'request-observation-window' };
  updated.wan.receiveSampling = { from: updated.wan.intervalStartedAt, to: updated.wan.intervalEndedAt };
  updated.wan.sendSampling = { from: updated.wan.intervalStartedAt, to: updated.wan.intervalEndedAt };
  updated.deviceTraffic[0].downloadMbps = 33;
  updated.deviceTraffic.push({ name: 'TV', ip: '192.168.178.21', available: true, rateAvailable: false, reason: 'Kein passendes Zählerintervall' });
  updated.deviceTrafficCount = 2;
  updated.trafficUpdatedAt = new Date(Date.now() + 1000).toISOString();
  updated.deviceTrafficUpdatedAt = updated.trafficUpdatedAt;
  await page.evaluate(value => window.dispatchEvent(new CustomEvent('fritzbox-state', { detail: { fritzbox: value, targets: [], repeaterHost: null } })), updated);
  assert.equal(await page.locator('#fritzbox-data .mesh-topology').count(), 0, 'Hidden event updates remain deferred');
  await page.locator('[data-nav-page="router"]').click();
  const topology = page.locator('#fritzbox-data .mesh-topology'); await topology.waitFor({ state: 'attached' });
  await page.evaluate(() => { window.__meshTopologyNode = document.querySelector('#fritzbox-data .mesh-topology'); });
  assert.match(await page.locator('#fritzbox-updated').innerText(), /WAN-Abfrage ca\. 5 s · Geräteabfrage ca\. 2 s/);
  assert.match(await page.locator('#fritzbox-updated').innerText(), /Abfragezeitfenster; interner Zählertakt unbekannt/);
  assert.match(await page.locator('#fritzbox-updated').innerText(), /WAN-Verkehr /);
  assert.match(await page.locator('#fritzbox-updated').innerText(), /Geräteverkehr /);

  const faster = structuredClone(updated);
  faster.wan.downloadMbps = 88;
  faster.wan.downloadDeltaBytes = 11000000;
  faster.wan.uploadDeltaBytes = 425000;
  faster.wan.elapsedMs = 4500;
  faster.wan.intervalStartedAt = new Date(Date.now() - 4500).toISOString();
  faster.wan.intervalEndedAt = new Date().toISOString();
  faster.wan.measurementReason = 'Neue Messung';
  faster.wan.sampling = { from: faster.wan.intervalStartedAt, to: faster.wan.intervalEndedAt, basis: 'request-observation-window' };
  faster.wan.receiveSampling = { from: faster.wan.intervalStartedAt, to: faster.wan.intervalEndedAt };
  faster.wan.sendSampling = { from: faster.wan.intervalStartedAt, to: faster.wan.intervalEndedAt };
  faster.wan.source = 'tr064-wan-byte-counters-fast';
  faster.wan.scope = 'internet-fast';
  faster.deviceTraffic[0].downloadMbps = 44;
  faster.trafficUpdatedAt = new Date(Date.now() + 2000).toISOString();
  faster.deviceTrafficUpdatedAt = faster.trafficUpdatedAt;
  await page.evaluate(value => window.dispatchEvent(new CustomEvent('fritzbox-state', { detail: { fritzbox: value, targets: [], repeaterHost: null } })), faster);
  assert.equal(await page.evaluate(() => window.__meshTopologyNode === document.querySelector('#fritzbox-data .mesh-topology')), true, 'Traffic-only updates retain the existing mesh DOM');
  assert.match(await page.locator('#router-panel-overview .fritzbox-live-overview').innerText(), /88/);
  assert.match(await page.locator('#router-panel-traffic .fritzbox-live-device-traffic').innerText(), /44/);
  assert.match(await page.locator('#router-panel-overview .fritzbox-live-counts').innerText(), /2 beobachtet · 1 ohne passendes Zählerintervall/);
  assert.match(await page.locator('#router-panel-traffic .fritzbox-traffic-resolution').innerText(), /Abfragezeitfenster; interner Zählertakt unbekannt/);
  assert.match(await page.locator('#router-panel-traffic .fritzbox-traffic-resolution').innerText(), /WAN-Abfrage ca\. 5 s · Geräteabfrage ca\. 2 s/);

  await page.locator('[data-nav-page="overview"]').click();
  const newest = structuredClone(faster); newest.wan.downloadMbps = 99;
  await page.evaluate(value => window.dispatchEvent(new CustomEvent('fritzbox-state', { detail: { fritzbox: value, targets: [], repeaterHost: null } })), newest);
  await page.locator('[data-nav-page="router"]').click();
  assert.match(await page.locator('#router-panel-overview .fritzbox-live-overview').innerText(), /99/, 'Returning to the router page renders the latest hidden-page state');
  assert.deepEqual(errors, []);
  const result = { status: 'passed', cases: ['no graph render while hidden', 'latest state rendered on navigation', 'poll timestamps and app intervals shown', 'WAN internal counter interval explicitly unknown', 'traffic-only refresh preserves mesh DOM', 'traffic values update without full graph rebuild', 'no browser errors'], errors, hardwareTested: false };
  await writeFile(new URL('fritzbox-live-ui-results.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await server.closeGameCapture?.(); await monitor.close(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true });
}
