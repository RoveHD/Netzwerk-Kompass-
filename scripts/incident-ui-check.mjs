// Browser QA for incident and diagnostic settings UI. All API data is synthetic;
// requests are intercepted before they can reach monitor actions or hardware.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('../test-artifacts/', import.meta.url);
await mkdir(output, { recursive: true });
const dataDir = await mkdtemp(path.join(tmpdir(), 'network-compass-incident-ui-'));
const monitor = new Monitor({}, { dataDir });
const server = createApp(monitor, { analysis: { ensureChecked() {}, close() {}, snapshot: () => ({ connection: {}, savedAnalyses: [] }) } });
const started = Date.now() - 180_000;
const at = offset => new Date(started + offset).toISOString();
const targets = [...['192.168.178.1', '192.168.178.31', '1.1.1.1'].map((host, i) => ({ sourceDeviceId: 'pc-gaming', host, kind: i === 0 ? 'gateway' : i === 1 ? 'repeater' : 'internet', label: ['FRITZ!Box', 'Repeater Büro', 'Internet'][i], firstAt: at(60_000), lastAt: at(75_000), sent: 120, received: i === 1 ? 90 : 120, lossPercent: i === 1 ? 25 : 0, avgMs: i === 1 ? 42 : 8, p95Ms: i === 1 ? 120 : 12, p99Ms: i === 1 ? 180 : 15, maxMs: i === 1 ? 188 : 12 })), { sourceDeviceId: 'pc-office', host: '192.168.178.42', kind: 'device', label: 'TV-IP aus anderem PC', firstAt: at(60_000), lastAt: at(75_000), sent: 5, received: 5, avgMs: 1, maxMs: 2, lossPercent: 0 }];
const incident = {
  id: 'incident-ui-fixture', sourceDeviceId: 'pc-gaming', startedAt: at(60_000), endedAt: at(75_000), durationMs: 15_000,
  classification: 'Vorfall: Messpfad zeitweise auffällig', affectedSources: ['pc-gaming', 'pc-office'],
  pathNodes: [{ id: 'router', name: 'FRITZ!Box' }, { id: 'pc', name: 'Gaming-PC' }, { id: 'repeater', name: 'Repeater Büro' }],
  pathBoundary: { from: 'pc', to: 'repeater', type: 'WLAN' }, path: { status: 'confirmed', nodeIds: ['pc', 'repeater', 'router'] },
  windows: Object.fromEntries(['before', 'during', 'after'].map((key, i) => [key, { from: at(i * 60_000), to: at((i + 1) * 60_000), complete: key !== 'after', targets } ])),
  topology: { at: at(55_000), mesh: { nodes: [{ id: 'pc', name: 'Gaming-PC', ip: '192.168.178.20', role: 'client' }, { id: 'repeater', name: 'Repeater Büro', ip: '192.168.178.31', role: 'repeater' }, { id: 'router', name: 'FRITZ!Box', ip: '192.168.178.1', role: 'master' }], links: [{ id: 'mesh-link', from: 'pc', to: 'repeater', type: 'WLAN', state: 'connected', receiveRateMbps: 144 }, { id: 'uplink', from: 'repeater', to: 'router', type: 'LAN', state: 'connected', receiveRateMbps: 1000 }] } },
  meshChanges: [{ kind: 'rate-drop', linkId: 'mesh-link', interval: { from: at(61_000), to: at(70_000) } }],
  traffic: { pc: { samples: 2, download: { average: 14, peak: 20, count: 2 }, upload: { average: 3, peak: 4, count: 2 } }, wan: { samples: 2, download: { average: 20, peak: 28, count: 2 }, upload: { average: 4, peak: 6, count: 2 } }, wanUtilization: { downloadPercent: 25, uploadPercent: 20 }, devices: [{ label: 'Gaming-PC', ip: '192.168.178.20', intervalsDetail: [{ start: at(60_000), end: at(75_000), downloadBytes: 25000000, uploadBytes: 7000000, downloadMbps: 14, uploadMbps: 3 }] }, { label: 'TV Wohnzimmer', ip: '192.168.178.42', intervalsDetail: [{ start: at(60_000), end: at(75_000), downloadBytes: 8500000, uploadBytes: 1000000, downloadMbps: 5, uploadMbps: 1 }] }] },
  trafficComparison: Object.fromEntries(['before', 'during', 'after'].map(key => [key, { from: at(0), to: at(60_000), deviceCount: 12, observedDeviceCount: 18, unavailableDeviceCount: 6, devicesTruncated: true, pc: { samples: 2, download: { average: 8 }, upload: { average: 2 }, coverage: { mode: 'intervals', coveragePercent: 90, samples: 3, complete: false }, intervals: [{ start: at(52_500), end: at(67_500), intervalMs: 15_000, overlapMs: 7_500, downloadMbps: 8, uploadMbps: 2 }] }, wan: { samples: 2, download: { average: 18 }, upload: { average: 4 }, coverage: { mode: 'intervals', coveragePercent: 90, samples: 3 }, intervals: [{ start: at(52_500), end: at(67_500), intervalMs: 15_000, overlapMs: 7_500, downloadMbps: 18, uploadMbps: 4 }] }, devices: Array.from({ length: 12 }, (_, deviceIndex) => ({ label: deviceIndex ? `Testgerät ${deviceIndex}` : 'TV Wohnzimmer', ip: `192.168.178.${42 + deviceIndex}`, downloadMbps: 5, uploadMbps: 1, peakInterval: { from: at(52_500), to: at(67_500), intervalMs: 15_000, overlapMs: 7_500, downloadMbps: 8, uploadMbps: 2 }, intervalsDetail: [{ start: at(52_500), end: at(67_500), overlapStart: at(60_000), overlapEnd: at(67_500), intervalMs: 15_000, overlapMs: 7_500, downloadBytes: 125_000, uploadBytes: 25_000, estimatedDownloadBytes: 62_500, estimatedUploadBytes: 12_500, downloadMbps: 5, uploadMbps: 1 }, { start: at(67_500), end: at(82_500), overlapStart: at(67_500), overlapEnd: at(75_000), intervalMs: 15_000, overlapMs: 7_500, downloadBytes: 125_000, uploadBytes: 25_000, estimatedDownloadBytes: 62_500, estimatedUploadBytes: 12_500, downloadMbps: 5, uploadMbps: 1 }], coverage: { mode: 'intervals', samples: 2 } })) }])),
  packetCaptures: [{ startedAt: at(76_000), endedAt: at(90_000), relation: 'after', status: 'complete', quality: 'observed', retransmits: 2, losses: { events: 0, buffers: 0 }, deliveryBeyondRouter: 'unknown' }],
  adapterErrors: [{ at: at(66_000), delta: { receiveErrors: 1 } }],
  diagnoses: [{ category: 'mesh_backhaul', title: 'Auffälligkeit am WLAN-Backhaul', section: 'Repeater Büro → FRITZ!Box', confidence: 'Plausibler Verdacht', support: ['Repeater hatte 25 % fehlende ICMP-Antworten.', 'Änderung der gemeldeten Linkrate im Vorfallfenster.'], contradictions: ['ICMP kann priorisiert oder gedrosselt werden.'], missing: ['Direkte Airtime- und Retry-Messung fehlt.'], nextTest: 'PC testweise direkt am Router vergleichen.' }],
  limitations: ['Zeitliche Nähe beweist keine Ursache.'], missing: ['Spielserverdaten fehlen.']
};
for (const window of Object.values(incident.trafficComparison)) {
  for (const device of window.devices || []) for (const interval of device.intervalsDetail || []) {
    interval.measurementBasis = 'router-counter-timestamp';
    interval.timingUncertaintyMs = 850;
  }
  for (const interval of window.wan?.intervals || []) {
    interval.measurementBasis = 'request-observation-window';
    interval.timingUncertaintyMs = 1200;
  }
}
const state = {
  version: 'test', startedAt: at(0), measurementStartedAt: at(0), monitoring: true,
  network: { interfaces: [], warnings: [], wifi: { connected: false, networks: [] } }, selectedInterfaceId: null,
  targets: [], devices: [], traffic: { history: [] }, scan: { running: false }, speedTest: { running: false }, stressTest: { running: false },
  events: [], diagnosis: [], fritzbox: { connected: false, connecting: false, busy: false, history: [] },
  gameDetection: { enabled: true, active: [{ id: 'game-a', sessionId: 'session-a', name: 'Spiel Alpha' }, { id: 'game-b', sessionId: 'session-b', name: 'Spiel Beta' }] },
  measurement: { mode: 'standard', quality: { label: 'Gut', detail: 'synthetische Messqualität' } }, analysisStatus: { status: 'bereit', message: 'Testfixture' },
  historyPolicy: { pingHours: 24, rollupDays: 30, eventDays: 365, archiveMaxBytes: 268435456, archiveMaxDays: 30 },
  incidentCapture: { enabled: false, status: 'disabled', detail: 'Ausgeschaltet' }, routerCredentialStorage: { enabled: false },
  peers: { available: false, config: { enabled: false, role: 'agent', name: 'Dieser PC' }, peers: [] },
  persistence: { active: false, sessionCount: 0, lastError: null }, incidents: [incident]
};
const calls = [];
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.method() === 'GET' ? null : request.postDataJSON();
    if (body) calls.push({ path: url.pathname, body });
    if (url.pathname === '/api/measurement' && body?.mode) state.measurement.mode = body.mode;
    if (url.pathname === '/api/incident-capture' && body) state.incidentCapture = { enabled: body.enabled, status: body.enabled ? 'armed' : 'disabled', detail: 'Testfixture' };
    if (url.pathname === '/api/history-policy' && body) state.historyPolicy = { ...body };
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
    if (url.pathname === '/api/incidents') return route.fulfill({ json: { incidents: [incident] } });
    if (url.pathname === '/api/history') return route.fulfill({ json: { records: [], total: 0, cursor: null, measurementStartedAt: at(0), retentionDays: 30, warnings: [] } });
    if (url.pathname === '/api/startup') return route.fulfill({ json: { available: false, enabled: true, registered: null } });
    if (url.pathname === '/api/peers') return route.fulfill({ json: state.peers });
    return route.fulfill({ json: { status: 'ok', enabled: body?.enabled ?? false } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#incident-overview [data-incident-open]').waitFor();
  assert.match(await page.locator('#incident-overview').innerText(), /Auffälligkeit am WLAN-Backhaul/);
  await page.locator('.incident-overview-panel').screenshot({ path: fileURLToPath(new URL('incident-ui-overview-1024.png', output)) });
  await page.locator('#incident-history-open').click();
  await page.locator('#history-tab-incidents').click();
  const initialDetails = page.locator('#history-view details[data-incident-id="incident-ui-fixture"]');
  await initialDetails.waitFor();
  assert.equal(await initialDetails.getAttribute('open'), null);
  assert.equal(await initialDetails.locator('.mesh-topology-scroll').count(), 0, 'Closed historic incidents do not render topology');
  await page.locator('[data-nav-page="overview"]').click();
  await page.locator('#incident-overview [data-incident-open]').click();
  await page.locator('#history-tab-incidents').waitFor();
  const details = page.locator('#history-view details[data-incident-id="incident-ui-fixture"]');
  await details.waitFor();
  await page.waitForFunction(() => document.querySelector('#history-view details[data-incident-id="incident-ui-fixture"]')?.open);
  for (const text of ['60 Sekunden davor', 'Während des Vorfalls', '60 Sekunden danach', 'Belege', 'Gegenbelege', 'Fehlende Daten', 'Gaming-PC', 'TV Wohnzimmer', 'Mesh-Topologie zum Vorfall', 'Ping und Datenverkehr am Vorfall', 'Paketereignis-Mitschnitte', 'Nach dem Vorfall', 'Messintervall / Auflösung']) await details.getByText(text, { exact: false }).first().waitFor();
  const incidentText = await details.innerText();
  assert.match(incidentText, /Beobachtete Pfadknoten: Gaming-PC → Repeater Büro → FRITZ!Box/);
  assert.match(incidentText, /Download: Ø 14 Mbit\/s/);
  assert.match(incidentText, /Gesamt im Intervall/);
  assert.match(incidentText, /FRITZ!Box-Gerät · TV Wohnzimmer · 192\.168\.178\.42/);
  assert.match(incidentText, /unbekannt · dieses Gerät wurde nicht direkt angepingt/);
  assert.match(incidentText, /nur 50 % des Intervalls überlappt/);
  assert.match(incidentText, /Routerzeit nicht mit der PC-Uhr abgeglichen/);
  assert.match(incidentText, /Abfragezeitfenster; interner Zählertakt unbekannt/);
  assert.match(incidentText, /Abfrage-Zeitunsicherheit 850 ms/);
  assert.match(incidentText, /Pingziel · pc-gaming/);
  assert.doesNotMatch(incidentText, /Pingziel · pc-office/, 'A peer PC ping must not be attributed to this incident source');
  assert.match(incidentText, /FRITZ!Box-WAN · gesamter Anschluss/);
  assert.match(incidentText, /Zählerintervalle/);
  assert.match(incidentText, /Liste wegen Speichergrenze gekürzt/);
  assert.match(incidentText, /6 ohne verfügbare Zähler/);
  assert.match(incidentText, /12 mit Verkehrsdaten/);
  assert.match(incidentText, /Lag-Überdeckung/);
  assert.match(incidentText, /Testgerät 11/);
  assert.doesNotMatch(incidentText, /downloadMbps:/, 'Traffic is rendered with labels instead of raw object keys');
  const comparisonTable = details.locator('.incident-comparison-table').nth(1);
  const boundaryDeviceRow = await comparisonTable.locator('.incident-comparison-row').filter({ hasText: 'TV Wohnzimmer' }).first().innerText();
  assert.ok(boundaryDeviceRow.includes(new Date(at(52_500)).toLocaleString('de-DE')), 'Boundary row preserves original counter interval start');
  assert.ok(boundaryDeviceRow.includes(new Date(at(60_000)).toLocaleString('de-DE')), 'Boundary row separately displays the incident overlap start');
  const comparisonScroll = await comparisonTable.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(comparisonScroll.scroll > comparisonScroll.client, 'Traffic interval table scrolls independently when many device measurements are present');
  await comparisonTable.screenshot({ path: fileURLToPath(new URL('incident-ui-traffic-comparison.png', output)) });
  const list = page.locator('.incident-history-list');
  const scrollMetrics = await list.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight }));
  assert.ok(scrollMetrics.scroll > scrollMetrics.client, 'Incident list is an independently scrollable region');
  await details.scrollIntoViewIfNeeded();
  await page.locator('#history-panel').screenshot({ path: fileURLToPath(new URL('incident-ui-detail-1024.png', output)) });

  await page.locator('[data-nav-page="settings"]').click();
  await page.locator('#diagnostic-settings select[name="mode"]').selectOption('precision');
  await page.locator('#diagnostic-settings select[name="sessionId"]').selectOption('session-b');
  await page.locator('.diagnostic-setting-toggle input').check();
  await page.locator('.diagnostic-setting-toggle input').waitFor({ state: 'visible' });
  await page.locator('.diagnostic-history-policy button[type="submit"]').click();
  await page.getByText('Hintergrundbetrieb ist in der Windows-Desktop-App verfügbar.').waitFor();
  for (const width of [1024, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `No horizontal page overflow at ${width}px`);
    await page.screenshot({ path: fileURLToPath(new URL(`incident-ui-settings-${width}.png`, output)) });
  }
  await page.locator('[data-nav-page="router"]').click();
  await page.locator('#fritzbox-remember').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#fritzbox-remember').isChecked(), false, 'Remember credential defaults off');
  const posts = calls.map(call => call.path);
  assert.ok(posts.includes('/api/measurement'));
  assert.ok(posts.includes('/api/incident-capture'));
  assert.ok(posts.includes('/api/history-policy'));
  const capture = calls.find(call => call.path === '/api/incident-capture');
  assert.deepEqual(capture.body, { enabled: true, sessionId: 'session-b' });
  assert.ok(!calls.some(call => call.path === '/api/fritzbox/connect'), 'No live router login or credentials were submitted');

  assert.deepEqual(errors, []);
  const result = { status: 'passed', cases: ['overview to incident history', 'evidence and three time windows', 'synthetic multi-PC traffic and mesh details', 'independent detail scrolling', 'precision mode', 'one-time capture requires explicit game choice', 'credential remember defaults off', 'background-unavailable message', 'responsive 1024px and 1920px', 'no page errors'], errors, apiPosts: calls };
  await writeFile(new URL('incident-ui-results.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await server.closeGameCapture?.(); await monitor.close(); await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true });
}
