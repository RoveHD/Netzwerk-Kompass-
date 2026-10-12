// Isolated UI regression: synthetic probes, no live router, account or data folder.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('test-artifacts/ui-audit');
await mkdir(output, { recursive: true });
const network = { interfaces: [{ id: 'fixture-lan', name: 'LAN · Testadapter', kind: 'Ethernet', status: 'Up', gateway: '192.168.50.1', ipv4: [{ address: '192.168.50.2', prefixLength: 24 }], dns: ['192.168.50.1'], linkSpeedMbps: 1000 }], defaultInterfaceId: 'fixture-lan', neighbors: [], warnings: [], wifi: { connected: true, ssid: 'Test-WLAN', signalPercent: 88, channel: 36, networks: [{ ssid: 'Test-WLAN', channel: 36, signalPercent: 88 }] } };
const monitor = new Monitor({ discoverNetwork: async () => structuredClone(network), pingMany: async hosts => hosts.map(host => ({ host, ok: true, ms: 12, status: 'Success' })), getTrafficCounters: async () => [] });
monitor.maintenance = async () => {};
monitor.schedule = () => {};
await monitor.refresh();
for (let i = 0; i < 8; i++) await monitor.tick();
monitor.state.devices = Array.from({ length: 12 }, (_, i) => ({ ip: `192.168.50.${i + 10}`, name: `Testgerät ${i + 1}`, reachable: true, interfaceId: 'fixture-lan', mac: '00:11:22:33:44:55' }));
monitor.state.traffic.downloadMbps = 24.8;
monitor.state.traffic.uploadMbps = 3.2;
for (let i = 0; i < 20; i++) monitor.event('info', `Testereignis ${i + 1}`, 'Synthetisches Ereignis zur Prüfung der Übersicht und der Scrollbereiche.');
const analysis = { ensureChecked() {}, snapshot: () => ({ status: 'idle', connection: { available: false, checking: false, message: 'Isolierter UI-Test' }, savedAnalyses: [] }), close() {}, reset() {} };
const server = createApp(monitor, { analysis });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(15000);
const errors = [], failedResponses = [], results = [], pendingRequests = new Set();
page.on('request', request => pendingRequests.add(request.url()));
page.on('requestfinished', request => pendingRequests.delete(request.url()));
page.on('requestfailed', request => { pendingRequests.delete(request.url()); errors.push(`${request.url()}: ${request.failure()?.errorText}`); });
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/api/targets')) failedResponses.push(`${response.status()} ${response.url()}`); });
const navigate = async id => { await page.locator(`[data-nav-page="${id}"]`).click(); await page.locator(`#page-${id}`).waitFor({ state: 'visible' }); };
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('#overview-status-title').textContent.includes('unauffällig'));
  await page.locator('.overview-status a').click(); await page.locator('#page-devices').waitFor({ state: 'visible' });
  await page.locator('#target-label').fill('Eingabe bleibt erhalten');
  await page.locator('#target-host').fill('https://invalid');
  await page.locator('#target-form button').click();
  await page.waitForFunction(() => !document.querySelector('#target-host').disabled);
  assert.equal(await page.locator('#target-host').inputValue(), 'https://invalid');
  assert.equal(await page.locator('#target-label').inputValue(), 'Eingabe bleibt erhalten');
  results.push('Fehlerhafte Zieleingabe bleibt erhalten');
  await page.locator('#target-host').fill('192.168.50.99');
  await page.locator('#target-form button').click();
  const added = page.locator('.target-card').filter({ hasText: 'Eingabe bleibt erhalten' });
  await added.waitFor();
  await page.waitForFunction(() => document.querySelector('#target-host').value === '');
  await added.getByRole('button', { name: 'Eingabe bleibt erhalten entfernen', exact: true }).click();
  await added.waitFor({ state: 'detached' });
  results.push('Ziel hinzufügen und entfernen');
  await page.locator('.brand').click(); await page.locator('#page-overview').waitFor({ state: 'visible' });
  await page.locator('#monitor-btn').click();
  await page.waitForFunction(() => document.querySelector('#overview-status-title').textContent === 'Überwachung pausiert');
  assert.equal(await page.locator('#internet-status').textContent(), 'Pausiert');
  assert.equal(await page.locator('#loss-value').textContent(), '– %');
  await page.locator('#monitor-btn').click();
  await page.waitForFunction(() => document.querySelector('#overview-status-title').textContent.includes('unauffällig'));
  results.push('Pause/Fortsetzen zeigt keine alten grünen Live-Werte');
  const second = monitor.state.targets.filter(target => target.kind === 'internet')[1];
  second.samples = Array.from({ length: 8 }, () => ({ at: new Date().toISOString(), ok: false, status: 'TimedOut', ms: null }));
  second.stats = { sent: 8, received: 0, status: 'down', lossPercent: 100, lastMs: null };
  await page.waitForFunction(() => document.querySelector('#internet-status').textContent === 'Keine Ping-Antwort');
  assert.equal(await page.locator('#loss-value').textContent(), '100 %');
  results.push('Zweites Internetziel beeinflusst Status und Verlustanzeige');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    for (const id of ['overview', 'devices', 'history', 'router', 'tests', 'ai', 'settings']) {
      await navigate(id);
      const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(dimensions.scroll <= dimensions.width, `${id} überläuft bei ${width}px: ${dimensions.scroll}`);
      if (id === 'overview' || (width === 390 && id === 'history')) await page.screenshot({ path: path.join(output, `${id}-${width}.png`), fullPage: true });
    }
    results.push(`Alle 7 Ansichten bei ${width}px ohne Seitenüberlauf`);
  }
  await navigate('devices');
  await page.waitForFunction(() => !document.querySelector('#target-form button').disabled);
  await page.evaluate(() => { window.auditDeviceRow = document.querySelector('#devices-list tr'); window.auditWifiRow = document.querySelector('#wifi-networks tr'); window.auditInterfaceOption = document.querySelector('#interface-select option'); });
  await page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.waitForFunction(() => document.querySelector('#connection-state').classList.contains('online'));
  assert.equal(await page.evaluate(() => window.auditDeviceRow === document.querySelector('#devices-list tr')), true, 'Geräteliste wurde ohne Änderung neu aufgebaut');
  assert.equal(await page.evaluate(() => window.auditWifiRow === document.querySelector('#wifi-networks tr')), true, 'WLAN-Liste wurde ohne Änderung neu aufgebaut');
  assert.equal(await page.evaluate(() => window.auditInterfaceOption === document.querySelector('#interface-select option')), true);
  results.push('Unveränderte Geräte-, WLAN- und Adapterknoten bleiben beim Polling erhalten');
  await navigate('history');
  await page.locator('#history-hours').selectOption('24');
  await page.locator('#history-tab-traffic').click();
  await page.locator('#history-tab-traffic').press('ArrowRight');
  assert.equal(await page.locator('#history-tab-wireless').getAttribute('aria-selected'), 'true');
  results.push('Verlaufszeitraum und Tastaturnavigation');
  assert.deepEqual(errors, []); assert.deepEqual(failedResponses, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors, failedResponses }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ errors, failedResponses, pendingRequests: [...pendingRequests], results, page: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally {
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close();
}
