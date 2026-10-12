// Isolated browser checks: injected transfers, no Cloudflare traffic or user data.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import path from 'node:path';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('test-artifacts/load-tests-ui');
await mkdir(output, { recursive: true });
let releaseSpeed, speedOptions, stressOptions;
const monitor = new Monitor({ pingMany: async hosts => hosts.map(host => ({ host, ok: true, ms: 12 })) }, {
  speedTestRunner: async (update, options) => {
    speedOptions = options;
    update({ phase: 'download', progress: 25, transferredBytes: options.downloadBytes / 4, totalBytes: options.downloadBytes });
    await new Promise(resolve => { releaseSpeed = resolve; });
    return { downloadMbps: 83.7, uploadMbps: 17.9 };
  },
  stressTestRunner: async (update, options) => {
    stressOptions = options;
    const result = { elapsedSeconds: 65, downloadBytes: 812_500_000, uploadBytes: 130_000_000, downloadMbps: 100, uploadMbps: 16 };
    update(result);
    if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    return { ...result, reason: 'stopped' };
  },
});
monitor.maintenance = async () => {};
monitor.schedule = () => {};
monitor.state.targets.push(monitor.makeTarget('1.1.1.1', 'Internet · Testziel', 'internet'));
await monitor.tick();
const analysis = { ensureChecked() {}, snapshot: () => ({ status: 'idle', connection: { available: false, checking: false, message: 'Isolierter Test' }, savedAnalyses: [] }), close() {}, reset() {} };
const server = createApp(monitor, { analysis });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(15000);
const errors = [], results = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
const navigate = async id => { await page.locator(`[data-nav-page="${id}"]`).click(); await page.locator(`#page-${id}`).waitFor({ state: 'visible' }); };
const enabled = async id => page.waitForFunction(id => !document.getElementById(id).disabled, id);
const disabled = async ids => { for (const id of ids) assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id} must be disabled`); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await navigate('tests'); await enabled('speed-btn');
  assert.equal(await page.locator('#speed-download-size option').count(), 6);
  assert.equal(await page.locator('#speed-upload-size option').count(), 6);
  await page.locator('#speed-download-size').selectOption('100000000');
  await page.locator('#speed-upload-size').selectOption('20000000');
  assert.match(await page.locator('#speed-data-note').textContent(), /120 MB/);
  await page.waitForResponse(response => response.url().endsWith('/api/state'));
  assert.equal(await page.locator('#speed-download-size').inputValue(), '100000000');
  await page.locator('#speed-btn').click();
  await page.waitForFunction(() => document.querySelector('#speed-progress-label').textContent.includes('100 MB'));
  assert.equal(speedOptions.downloadBytes, 100_000_000); assert.equal(speedOptions.uploadBytes, 20_000_000);
  await disabled(['speed-btn', 'speed-download-size', 'speed-upload-size', 'stress-start', 'reset-btn']);
  releaseSpeed(); await enabled('speed-btn');
  assert.equal(await page.locator('#speed-download-value').textContent(), '83,7');
  assert.match(await page.locator('#speed-measured-size').textContent(), /100 MB Download · 20 MB Upload/);
  results.push('Speedtest: Datenmengen, Gesamtvolumen, Polling-Stabilität, Fortschritt und gegenseitige Sperren');
  await page.locator('#stress-mode').selectOption('both');
  await page.locator('#stress-duration').selectOption('0');
  await page.locator('#stress-start').click(); await enabled('stress-stop');
  await page.waitForFunction(() => document.querySelector('#stress-elapsed').textContent === '1:05 min');
  assert.equal(stressOptions.durationSeconds, 0); assert.equal(stressOptions.mode, 'both');
  assert.equal(await page.locator('#stress-download-total').textContent(), '812,5 MB');
  await disabled(['speed-btn', 'speed-download-size', 'stress-start', 'stress-mode', 'stress-duration', 'reset-btn']);
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(dimensions.scroll <= width, `Tests-Seite überläuft bei ${width}: ${dimensions.scroll}`);
    if ([1440, 390].includes(width)) await page.screenshot({ path: path.join(output, `tests-running-${width}.png`), fullPage: true });
    results.push(`Speedtest und Dauerbelastung bei ${width}px ohne Seitenüberlauf`);
  }
  await navigate('history'); await navigate('tests');
  await page.locator('#stress-stop').click(); await enabled('stress-start');
  assert.equal(stressOptions.signal.aborted, true);
  assert.equal(await page.locator('#stress-state').textContent(), 'Dauerbelastung gestoppt');
  await disabled(['stress-stop']);
  results.push('Manuelle Dauerlast: Live-Zähler, Seitenwechsel und sofortiger Stop mit freigegebenen Bedienelementen');
  await navigate('history'); await page.locator('#history-tab-speed').click();
  await page.waitForFunction(() => document.querySelector('#history-view').textContent.includes('Dauerbelastung · Download + Upload'));
  assert.match(await page.locator('#history-view').textContent(), /100 MB Download/);
  assert.match(await page.locator('#history-view').textContent(), /812,5 MB empfangen/);
  results.push('Speedtest-Auswahl und Dauerlast-Ergebnis im gemeinsamen Verlauf');
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
  console.error(JSON.stringify({ errors, results, page: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally {
  releaseSpeed?.(); await monitor.stopStressTest();
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close();
}
