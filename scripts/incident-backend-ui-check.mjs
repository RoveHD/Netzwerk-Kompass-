// End-to-end synthetic incident through Monitor.start, the real worker and API.
// Probes return a private fake network; no router, DNS, WAN or packet capture runs.
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const artifacts = new URL('../test-artifacts/', import.meta.url);
await mkdir(artifacts, { recursive: true });
const dataDir = await mkdtemp(path.join(tmpdir(), 'network-compass-backend-ui-'));
const base = Date.now(), iso = value => new Date(value).toISOString();
const pcMac = '02:11:22:33:44:55';
const ids = { pc: 'node-pc', c: 'node-c', b: 'node-b', master: 'node-master' };
const macs = { pc: pcMac, c: '02:11:22:33:44:56', b: '02:11:22:33:44:57', master: '02:11:22:33:44:58' };
const hosts = { pc: '10.10.0.20', c: '10.10.0.2', b: '10.10.0.3', master: '10.10.0.1' };
const mesh = {
  schemaVersion: '8.7',
  nodes: [
    { id: ids.pc, name: 'Gaming-PC', ip: hosts.pc, mac: macs.pc, role: 'CLIENT', interfaces: [{ id: 'pc-wlan', mac: macs.pc, type: 'WLAN' }] },
    { id: ids.c, name: 'Repeater C', ip: hosts.c, mac: macs.c, role: 'SLAVE', interfaces: [{ id: 'c-up', mac: '02:11:22:33:44:61', type: 'WLAN' }, { id: 'c-down', mac: '02:11:22:33:44:62', type: 'WLAN' }] },
    { id: ids.b, name: 'Repeater B', ip: hosts.b, mac: macs.b, role: 'SLAVE', interfaces: [{ id: 'b-up', mac: '02:11:22:33:44:63', type: 'WLAN' }, { id: 'b-down', mac: '02:11:22:33:44:64', type: 'LAN' }] },
    { id: ids.master, name: 'FRITZ!Box Test', ip: hosts.master, mac: macs.master, role: 'MASTER', interfaces: [{ id: 'master-lan', mac: '02:11:22:33:44:65', type: 'LAN' }] }
  ],
  links: [
    { id: 'pc-c', from: ids.pc, to: ids.c, fromInterface: 'pc-wlan', toInterface: 'c-up', type: 'WLAN', state: 'CONNECTED', receiveRateMbps: 300, transmitRateMbps: 250 },
    { id: 'c-b', from: ids.c, to: ids.b, fromInterface: 'c-down', toInterface: 'b-up', type: 'WLAN', state: 'CONNECTED', receiveRateMbps: 180, transmitRateMbps: 160 },
    { id: 'b-master', from: ids.b, to: ids.master, fromInterface: 'b-down', toInterface: 'master-lan', type: 'LAN', state: 'CONNECTED', receiveRateMbps: 1000, transmitRateMbps: 1000 }
  ]
};
const network = {
  interfaces: [{ id: 'fake-ethernet', name: 'Testadapter', description: 'isoliertes Testnetz', status: 'Up', kind: 'ethernet', gateway: hosts.master, ipv4: [{ address: hosts.pc, prefixLength: 24 }], dns: [] }],
  defaultInterfaceId: 'fake-ethernet', neighbors: [], warnings: [], wifi: { connected: false, networks: [] }
};
const probes = {
  createPingMonitor: () => ({ close() {} }),
  async discoverNetwork() { return structuredClone(network); }
};
const monitor = new Monitor(probes, { dataDir, intervalMs: 1000 });
monitor.schedule = () => {};
monitor.scheduleGames = () => {};
monitor.state.gameDetection.enabled = false;
let server, browser, detachStarted;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = (key, ms, kind) => ({ host: hosts[key], label: key === 'master' ? 'FRITZ!Box Test' : key === 'pc' ? 'Gaming-PC' : `Repeater ${key.toUpperCase()}`, kind, ok: Number.isFinite(ms), status: Number.isFinite(ms) ? 'Success' : 'TimedOut', ms, routeInterfaceId: 'fake-ethernet' });
const ping = (at, values) => monitor.log({ type: 'ping', at: iso(at), routingConfirmed: true, pcMac, ipv4: [{ address: hosts.pc }], results: [result('master', values.master, 'gateway'), result('c', values.c, 'repeater'), result('b', values.b, 'repeater')] });
const traffic = (at, intervalStartedAt, factor = 1) => {
  const start = iso(intervalStartedAt), end = iso(at);
  monitor.log({ type: 'traffic', at: end, intervalStartedAt: start, downloadMbps: 8 * factor, uploadMbps: 2 * factor, downloadDeltaBytes: Math.round(5_000_000 * factor), uploadDeltaBytes: Math.round(1_250_000 * factor) });
  monitor.log({ type: 'fritzbox', at: end, host: hosts.master, sessionId: 'fake-router-session', mesh,
    wan: { intervalStartedAt: start, downloadMbps: 20 * factor, uploadMbps: 5 * factor, downloadDeltaBytes: Math.round(12_500_000 * factor), uploadDeltaBytes: Math.round(3_125_000 * factor), downstreamMbps: 100, upstreamMbps: 25 },
    deviceTraffic: [{ id: `mac:${macs.pc}`, nodeId: ids.pc, name: 'Gaming-PC', ip: hosts.pc, mac: macs.pc, rateAvailable: true, downloadMbps: 7 * factor, uploadMbps: 1.5 * factor, downloadDeltaBytes: Math.round(4_375_000 * factor), uploadDeltaBytes: Math.round(937_500 * factor), intervalStartedAt: start, at: end }] });
};
const readIncidents = async port => {
  const response = await fetch(`http://127.0.0.1:${port}/api/incidents`);
  assert.equal(response.status, 200, 'real incident API returns HTTP 200');
  const body = await response.json(); return body.incidents;
};

try {
  await monitor.start();
  // Keep Monitor.log's own route validation active against the isolated fake adapter.
  monitor.state.network = structuredClone(network);
  monitor.state.selectedInterfaceId = 'fake-ethernet';
  monitor.state.network.interfaces[0].mac = pcMac;
  monitor.setRepeater(hosts.c, 'Repeater C', false);
  monitor.setRepeater(hosts.b, 'Repeater B', false);
  server = createApp(monitor, { analysis: { ensureChecked() {}, close() {}, snapshot: () => ({ connection: {}, savedAnalyses: [] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const incidentStart = Date.now() - 3000;
  // Pre-incident samples span almost one minute so the worker can create a real baseline.
  for (let i = 0; i <= 12; i++) ping(incidentStart - 60_000 + i * 5000, { master: 8, c: 6, b: 10 });
  for (let i = 1; i <= 11; i++) traffic(incidentStart - 60_000 + i * 5000, incidentStart - 60_000 + (i - 1) * 5000, 1);
  const startedPromise = new Promise(resolve => { detachStarted = monitor.onIncident(incident => resolve(incident)); });
  ping(incidentStart, { master: 200, c: 3, b: 180 });
  ping(incidentStart + 250, { master: 210, c: 4, b: 190 });
  ping(incidentStart + 500, { master: 9, c: 8, b: 12 });
  const startedIncident = await Promise.race([startedPromise, delay(10_000).then(() => { throw new Error('Der echte IncidentWorker hat keinen Vorfall gestartet.'); })]);
  assert.ok(startedIncident.id, 'worker supplied a stable incident id');
  const captureEnd = Date.now() - 100;
  monitor.log({ type: 'event', kind: 'incident-packets', incidentId: startedIncident.id, at: iso(captureEnd),
    capture: { startedAt: iso(captureEnd - 1800), endedAt: iso(captureEnd), status: 'complete', quality: 'observed', sentPackets: 80, receivedPackets: 78, sentBytes: 24000, receivedBytes: 19000, retransmits: 2, sampleIntervalMs: 10, losses: { events: 0, buffers: 0 } } });

  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', args: ['--disable-extensions', '--disable-component-extensions-with-background-pages'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.setDefaultTimeout(15000);
  const errors = [], externalRequests = [], injectedExtensionRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = request.url();
    // The installed Chrome policy injects AdGuard's own content script even
    // with extensions disabled; report it separately from app-originated URLs.
    const safeLocation = () => { const parsed = new URL(url); return parsed.origin + parsed.pathname; };
    if (url.startsWith('http://local.adguard.org/')) injectedExtensionRequests.push(safeLocation());
    else if (!url.startsWith(`http://127.0.0.1:${port}/`)) externalRequests.push(safeLocation());
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('[data-nav-page="overview"]').waitFor();

  // Fill the after-window with real Monitor.log records, not API or route mocks.
  const afterEnd = incidentStart + 750;
  let previousAt = Date.now();
  while (Date.now() < afterEnd + 61_500) {
    await delay(Math.min(5000, Math.max(100, afterEnd + 61_500 - Date.now())));
    const at = Date.now();
    ping(at, { master: 8, c: 6, b: 10 });
    traffic(at, previousAt, 1.25);
    previousAt = at;
  }
  const deadline = Date.now() + 25_000;
  let incidents = [];
  while (Date.now() < deadline) {
    incidents = await readIncidents(port);
    if (incidents.some(item => item.id === startedIncident.id && item.status === 'complete')) break;
    await delay(500);
  }
  const stored = incidents.find(item => item.id === startedIncident.id);
  assert.ok(stored, 'the actual GET /api/incidents returns the worker-produced incident');
  assert.equal(stored.status, 'complete');
  assert.match(stored.diagnoses?.[0]?.category || '', /mesh_backhaul|router_path|router_icmp/);
  assert.ok(stored.topology?.mesh?.nodes?.length >= 4, 'real incident includes its earlier fake mesh snapshot');
  assert.ok(stored.path?.nodeIds?.length >= 4, 'PC → C → B → Master is recovered from stable MAC and link data');
  assert.equal(stored.pathBoundary?.from, `mac:${macs.c}`);
  assert.equal(stored.pathBoundary?.to, `mac:${macs.b}`);
  assert.ok(stored.trafficComparison?.before?.pc?.samples > 0, 'PC baseline counters reached worker analysis');
  assert.ok(stored.trafficComparison?.during && stored.trafficComparison?.after, 'all three traffic windows are available');
  assert.equal(stored.packetCaptures?.length, 1);
  assert.equal(stored.packetCaptures[0].relation, 'after');

  // Reload without interception so the normal page boot fetches the real endpoint.
  await page.reload();
  await page.locator('#incident-overview [data-incident-open]').first().waitFor();
  await page.locator('#incident-overview [data-incident-open]').first().click();
  const detail = page.locator(`#history-view details[data-incident-id="${startedIncident.id}"]`);
  await page.waitForFunction(id => document.querySelector(`#history-view details[data-incident-id="${CSS.escape(id)}"]`)?.open, startedIncident.id);
  for (const label of ['Ping und Datenverkehr am Vorfall', 'Paketereignis-Mitschnitte', 'Nach dem Vorfall', 'Gaming-PC', 'Repeater C', 'Repeater B', 'FRITZ!Box Test']) await detail.getByText(label, { exact: false }).first().waitFor();
  assert.match(await detail.innerText(), /Zustellung hinter Router unbekannt/);
  assert.match(await detail.innerText(), /Abdeckung|unvollständig|Messpunkte/);
  assert.equal(await detail.locator('.mesh-link-pc-path').count(),3,'historical confirmed path reaches the actual tree renderer');
  assert.equal(await detail.locator('.mesh-link-suspect').count(),1,'only the measured boundary is highlighted');
  const suspect=detail.locator('.mesh-link-group').filter({has:page.locator('.mesh-link-suspect')});
  await suspect.click();
  assert.match(await detail.locator('.mesh-topology-detail').innerText(),/Verdachtsabschnitt/);
  const link = detail.locator('.mesh-topology-scroll .mesh-link-group').first();
  await link.click();
  await detail.locator('.mesh-topology-detail').getByText('Gemeldete Verbindung').waitFor();
  assert.match(await detail.locator('.mesh-topology-detail').innerText(), /RX zu/);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.locator('#history-panel').screenshot({ path: fileURLToPath(new URL('incident-backend-ui-1920.png', artifacts)) });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow at 1920px');
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, [], 'Browser requested only local static files and local APIs');
  const result = { status: 'passed', incidentId: stored.id, classification: stored.diagnoses[0].category, path: stored.path.nodeIds, pathBoundary: stored.pathBoundary, trafficWindows: Object.keys(stored.trafficComparison), packetCaptureRelation: stored.packetCaptures[0].relation, cases: ['real Monitor.start and real IncidentWorker', 'real /api/incidents without API interception', 'synthetic mesh path and localized diagnosis', 'real trafficComparison baseline and after window', 'packet capture relation rendering', 'interactive historical mesh-link details', '1920px layout', 'no JS errors or app-originated external requests'], errors, externalRequests, injectedExtensionRequests };
  await writeFile(new URL('incident-backend-ui-results.json', artifacts), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  detachStarted?.();
  await browser?.close();
  await server?.closeGameCapture?.();
  await monitor.close({ reason: 'normal' }).catch(() => {});
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}
