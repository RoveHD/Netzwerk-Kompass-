// Isolated router/traffic fixtures; no network probing, router login or real user data.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Monitor } from '../lib/monitor.js';
import { summarize } from '../lib/analysis.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('../test-artifacts/lag-traffic-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const monitor = new Monitor({});
const start = Date.now() - 120000;
const at = seconds => new Date(start + seconds * 1000).toISOString();
const meta = { appSessionId: 'lag-ui', measurementStartedAt: at(-1), epoch: 0, interfaceId: 'eth-test' };
const samples = Array.from({ length: 90 }, (_, i) => ({ at: at(i), ms: i === 30 ? 99.99 : i === 40 ? 100 : i === 80 ? 175 : 20, ok: true, status: 'Success' }));
const target = { host: '1.1.1.1', id: 'internet', label: 'Internet', kind: 'internet', enabled: true, samples, stats: summarize(samples, 'internet') };
monitor.state.targets = [target];
for (const sample of samples) monitor.history.record({ type: 'ping', ...meta, at: sample.at, results: [{ ...sample, host: target.host, kind: target.kind, label: target.label }] });
for (const end of [45, 85]) {
  const device = (name, mac, down, up, ip) => ({ id: `mac:${mac}`, name, mac, ip, available: true, rateAvailable: true, intervalStartedAt: at(end - 30), at: at(end), downloadDeltaBytes: down, uploadDeltaBytes: up, downloadMbps: down / 30000 * .008, uploadMbps: up / 30000 * .008 });
  monitor.history.record({ type: 'traffic', ...meta, at: at(end), intervalStartedAt: at(end - 30), downloadMbps: 10, uploadMbps: 1 });
  monitor.history.record({ type: 'fritzbox', ...meta, sessionId: 'router-test', at: at(end), capture: { reason: 'lag', triggeredAt: at(end - 5) }, wan: { intervalStartedAt: at(end - 30), downloadDeltaBytes: 356250000, uploadDeltaBytes: 71250000, downloadMbps: 95, uploadMbps: 19, downstreamMbps: 100, upstreamMbps: 20 }, deviceTraffic: [device('Wohnzimmer-TV', '12:34:56:78:90:01', 300000000, 100000, '192.168.1.21'), device('Backup-PC', '12:34:56:78:90:02', 1000000, 64000000, '192.168.1.22')] });
}
const server = createApp(monitor, { analysis: { ensureChecked() {}, close() {}, snapshot: () => ({ connection: {}, savedAnalyses: [] }) } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  await page.clock.install(); page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#lag-traffic-open').click();
  assert.equal(await page.locator('#ping-history-chart .history-threshold-label').textContent(), '100 ms');
  assert.equal(await page.locator(`#ping-history-chart [data-lag-at="${Date.parse(at(30))}"]`).count(), 0);
  assert.equal(await page.locator(`#ping-history-chart [data-lag-at="${Date.parse(at(40))}"]`).count(), 1);
  const section = page.locator('#history-lag-traffic');
  const latest = section.locator(`[data-lag-start="${Date.parse(at(80))}"]`);
  await latest.locator('.lag-traffic-device-table').waitFor();
  assert.equal(await latest.getAttribute('open'), '');
  assert.match(await latest.innerText(), /Wohnzimmer-TV/);
  assert.match(await latest.innerText(), /Backup-PC/);
  assert.match(await latest.locator('.lag-traffic-capacity').innerText(), /95 %/);
  assert.equal(await latest.locator('.lag-traffic-overload').count(), 1);
  assert.match(await latest.innerText(), /ganze Zählerintervall/);
  assert.match(await latest.innerText(), /Verbrauch genau im Ping-Moment ist nicht messbar/);
  // Select an older spike by its real pointer interaction, not dispatchEvent.
  const earlierAt = Date.parse(at(40));
  const dot = page.locator(`#ping-history-chart [data-lag-at="${earlierAt}"]`);
  await dot.scrollIntoViewIfNeeded(); await dot.click();
  const older = section.locator(`[data-lag-start="${earlierAt}"]`);
  await older.locator('.lag-traffic-device-table').waitFor();
  const key = await older.getAttribute('data-disclosure-key');
  const read = page.waitForResponse(response => response.url().includes('/api/history?'));
  monitor.history.record({ type: 'ping', ...meta, at: at(91), results: [{ host: target.host, kind: target.kind, label: target.label, ok: true, status: 'Success', ms: 20 }] });
  await page.clock.runFor(2300); await read;
  await page.waitForFunction(key => document.querySelector(`[data-disclosure-key="${CSS.escape(key)}"]`)?.open, key);
  assert.equal(await older.locator('.lag-phase-traffic-disclosure').getAttribute('open'), '');
  await older.locator('.lag-phase-traffic-disclosure > summary').click();
  const previousSection = await section.elementHandle();
  await page.locator('#history-refresh').click();
  await page.waitForFunction(element => !element.isConnected, previousSection);
  await page.waitForFunction(key => !document.querySelector(`[data-disclosure-key="${CSS.escape(key)}"] .lag-phase-traffic-disclosure`)?.open, key);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1050 });
    await latest.locator('.lag-traffic-device-table').scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    for (const source of await latest.locator('.lag-traffic-source').all()) {
      assert.ok(await source.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'Source text wraps inside its card');
      assert.ok(await source.evaluate(el => el.getBoundingClientRect().width <= el.parentElement.clientWidth + 1), 'Source card stays inside its grid');
    }
    // A viewport capture represents the clipped, independently scrollable list.
    await page.screenshot({ path: fileURLToPath(new URL(`traffic-${width}.png`, output)) });
  }
  assert.deepEqual(errors, []);
  const result = { status: 'passed', cases: ['overview shortcut', 'spike click opens correct traffic', 'device download and upload intervals', 'WAN utilization', 'inclusive 100 ms markers', 'open and collapsed state across refresh', 'desktop and mobile layout'], errors };
  await writeFile(new URL('results.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close(); await monitor.close(); await new Promise(resolve => server.close(resolve));
}
