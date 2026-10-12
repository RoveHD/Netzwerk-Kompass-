import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { Monitor } from '../lib/monitor.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('../test-artifacts/ping-history-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const monitor = new Monitor({});
const server = createApp(monitor, { analysis: { ensureChecked() {}, close() {}, snapshot: () => ({ connection: {}, savedAnalyses: [] }) } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const start = Date.parse('2026-10-12T00:00:00Z');
const at = i => new Date(start + i * 1000).toISOString();
let records = Array.from({ length: 1200 }, (_, i) => ({
  type: 'ping', at: at(i), appSessionId: 'ui-test', epoch: 0,
  results: [
    { host: '192.168.1.1', label: 'Router / Gateway', kind: 'gateway', ok: true, status: 'Success', ms: i === 500 ? 43 : 3 },
    { host: '1.1.1.1', label: 'Internet · Cloudflare', kind: 'internet', ok: i < 300 || i > 305 && i !== 400, status: i === 400 ? 'measurement_error' : i >= 300 && i <= 305 ? 'TimedOut' : 'Success', ms: i === 660 ? 340 : 20 },
  ],
}));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  await page.clock.install();
  page.setDefaultTimeout(15000);
  const errors = [], badAssets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && /\.(?:js|css)(?:\?|$)/.test(response.url())) badAssets.push(response.url()); });
  let historyReads = 0;
  await page.route('**/api/history?*', route => { historyReads++; return route.fulfill({ json: { records, total: records.length, retentionDays: 7 } }); });
  await page.goto(`http://127.0.0.1:${server.address().port}/#history`);
  const chart = page.locator('#ping-history-chart'); await chart.waitFor();
  const range = () => chart.evaluate(el => [Number(el.dataset.from), Number(el.dataset.to)]);
  const span = value => value[1] - value[0];
  const metric = kind => page.locator(`.ping-statistics tr[data-host="1.1.1.1"] [data-metric="${kind}"]`);
  assert.match(await metric('ping').innerText(), /Max\. 340 ms/);
  assert.match(await metric('jitter').innerText(), /Max\. 320 ms/);
  assert.match(await metric('loss').innerText(), /Max\. 10 % \/ Min\./);
  assert.match(await metric('loss').innerText(), /6 von 60 verloren/);
  assert.equal(await page.locator('.ping-statistics tr[data-host="1.1.1.1"] td').last().innerText(), '1');
  // A short table must pass vertical wheel input to the page, even though
  // it remains a horizontal scroll container on narrow screens.
  const statistics = page.locator('.ping-statistics');
  assert.ok(await statistics.evaluate(el => el.scrollHeight <= el.clientHeight));
  await statistics.hover({ position: { x: 80, y: 80 } });
  const beforeTableScroll = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 180);
  await page.waitForFunction(before => scrollY > before, beforeTableScroll);
  const full = await range();
  await page.locator('#ping-chart-in').click();
  const zoomed = await range(); assert.equal(span(zoomed), span(full) / 2);
  assert.match(await metric('ping').innerText(), /Max\. 340 ms/);
  const tooltip = chart.locator('circle title').filter({ hasText: '340 ms' }); assert.equal(await tooltip.count(), 1);
  await page.locator('#ping-chart-earlier').click(); assert.ok((await range())[0] < zoomed[0]);
  await page.locator('#ping-chart-later').click(); assert.ok(Math.abs((await range())[0] - zoomed[0]) < 1);
  await chart.scrollIntoViewIfNeeded();
  let box = await chart.boundingBox();
  const beforeChartScroll = await page.evaluate(() => scrollY);
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4);
  await page.mouse.wheel(0, -140);
  await page.waitForFunction(before => scrollY < before, beforeChartScroll);
  assert.deepEqual(await range(), zoomed, 'Normal wheel scrolls without zooming');
  await chart.scrollIntoViewIfNeeded(); box = await chart.boundingBox();
  const beforeControlScroll = await page.evaluate(() => scrollY);
  await page.keyboard.down('Control');
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4); await page.mouse.wheel(0, -200);
  await page.keyboard.up('Control');
  await page.waitForFunction(before => Number(document.querySelector('#ping-history-chart').dataset.to) - Number(document.querySelector('#ping-history-chart').dataset.from) < before, span(zoomed));
  assert.equal(await page.evaluate(() => scrollY), beforeControlScroll, 'Ctrl+wheel zooms without scrolling');
  const wheeled = await range();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .75, box.y + box.height * .4, { steps: 5 }); await page.mouse.up();
  const dragged = await range(); assert.ok(dragged[0] < wheeled[0]); assert.ok(Math.abs(span(dragged) - span(wheeled)) < 1);
  await chart.focus(); await page.keyboard.press('Escape'); // Leave hover inspection before keyboard panning.
  await page.keyboard.press('+'); const keyed = await range(); assert.ok(span(keyed) < span(dragged));
  await page.keyboard.press('ArrowRight'); assert.ok((await range())[0] > keyed[0]);
  const retained = await range();
  records.push({ ...records.at(-1), at: at(1205) });
  const previousReads = historyReads;
  const oldChart = await chart.elementHandle();
  const refreshed = page.waitForResponse(response => response.url().includes('/api/history?'));
  await page.locator('#history-refresh').click(); await refreshed;
  await page.waitForFunction(old => !old.isConnected, oldChart);
  await page.waitForFunction(readAt => document.querySelector('#ping-history-chart')?.dataset.from === readAt, String(retained[0]));
  assert.ok(historyReads > previousReads); assert.deepEqual(await range(), retained);
  // A target toggle and tab round-trip use the same absolute inspection window.
  await page.locator('input[data-host="192.168.1.1"]').uncheck();
  assert.deepEqual(await range(), retained); await page.locator('#ping-jitter').check();
  assert.deepEqual(await range(), retained);
  await page.locator('[data-history-tab="events"]').click();
  await page.locator('[data-history-tab="connection"]').click(); assert.deepEqual(await range(), retained);
  // Automatic live refresh retains the existing chart and the inspected range.
  const beforeAuto = await chart.elementHandle();
  const autoResponse = page.waitForResponse(response => response.url().includes('/api/history?'));
  await page.clock.runFor(2200); await autoResponse;
  assert.equal(await beforeAuto.evaluate(old => old.isConnected), true);
  assert.deepEqual(await range(), retained);
  await page.locator('#history-hours').selectOption('24');
  await page.waitForFunction(() => document.querySelector('#ping-history-chart')?.dataset.full === 'true');
  await page.locator('#ping-chart-in').click();
  await chart.scrollIntoViewIfNeeded(); box = await chart.boundingBox();
  await page.mouse.dblclick(box.x + box.width * .5, box.y + box.height * .5);
  assert.equal(await chart.getAttribute('data-full'), 'true');
  // Restore the comparison for responsive screenshots.
  await page.locator('input[data-host="192.168.1.1"]').check();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    await chart.scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const el = document.querySelector('#ping-history-chart'); return Math.abs(el.viewBox.baseVal.width - el.getBoundingClientRect().width) < 1;
    });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Seitenüberlauf ${width}`);
    assert.ok(await chart.evaluate(el => el.getBoundingClientRect().width <= innerWidth), `Diagramm zu breit ${width}`);
    await page.locator('.ping-chart').screenshot({ path: fileURLToPath(new URL(`chart-${width}.png`, output)) });
    if (width === 1440) await page.locator('.ping-statistics').screenshot({ path: fileURLToPath(new URL('statistics-1440.png', output)) });
  }
  await page.locator('#ping-chart-in').click();
  await page.route('**/api/reset', route => route.fulfill({ json: { ok: true } }));
  await page.locator('#reset-btn').click();
  await page.waitForFunction(() => document.querySelector('#ping-history-chart')?.dataset.full === 'true');
  const refresh = async () => { const response = page.waitForResponse(response => response.url().includes('/api/history?')); await page.locator('#history-refresh').click(); await response; await page.waitForFunction(() => !document.querySelector('#history-refresh').disabled); };
  records = [records[0]]; await refresh(); await chart.waitFor();
  assert.equal(await chart.locator('circle').count(), 2);
  await page.locator('#ping-chart-in').click(); assert.equal(span(await range()), 30000);
  records = [{ ...records[0], results: records[0].results.map(result => ({ ...result, ok: false, ms: null, status: 'TimedOut' })) }];
  await refresh(); assert.match(await chart.textContent(), /Keine Antworten im Ausschnitt/);
  assert.match(await metric('loss').innerText(), /Max\. 100 %/);
  // Long archives still scroll independently; reaching the end resumes page
  // scrolling. Background refresh must retain both positions.
  records = Array.from({ length: 100 }, (_, i) => ({ type: 'event', at: at(i), level: 'info', title: `Testereignis ${i}`, detail: 'Isolierte Testdaten' }));
  await page.setViewportSize({ width: 1440, height: 650 });
  await refresh(); await page.locator('[data-history-tab="events"]').click();
  const eventTable = page.locator('#history-view .history-table-wrap');
  assert.ok(await eventTable.evaluate(el => el.scrollHeight > el.clientHeight));
  await page.evaluate(() => scrollTo(0, 0));
  await eventTable.hover({ position: { x: 80, y: 80 } });
  const beforeInnerScroll = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(() => document.querySelector('#history-view .history-table-wrap').scrollTop >= 120);
  assert.equal(await page.evaluate(() => scrollY), beforeInnerScroll);
  const innerPosition = await eventTable.evaluate(el => el.scrollTop);
  const oldTable = await eventTable.elementHandle();
  const archiveRefresh = page.waitForResponse(response => response.url().includes('/api/history?'));
  await page.clock.runFor(2200); await archiveRefresh;
  await page.waitForFunction(old => !old.isConnected, oldTable);
  assert.equal(await eventTable.evaluate(el => el.scrollTop), innerPosition);
  assert.equal(await page.evaluate(() => scrollY), beforeInnerScroll);
  await eventTable.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await eventTable.hover({ position: { x: 81, y: 80 } });
  const beforeBoundaryScroll = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 150);
  await page.waitForFunction(before => scrollY > before, beforeBoundaryScroll);
  assert.ok(await eventTable.evaluate(el => el.scrollTop >= el.scrollHeight - el.clientHeight - 1));
  records = []; await refresh(); await page.locator('[data-history-tab="connection"]').click(); await chart.waitFor({ state: 'hidden' });
  assert.match(await page.locator('.ping-chart').innerText(), /keine Ping-Messungen/);
  assert.deepEqual(errors, []); assert.deepEqual(badAssets, []);
  const result = { passed: true, widths: [1440, 768, 390, 320], checks: ['peaks and worst-minute denominator', 'page scrolling over short table and chart, Ctrl+wheel zoom', 'long archive inner scroll, boundary chaining and refresh preservation', 'buttons, pointer drag, keyboard, double-click reset', 'absolute range survives manual/automatic refresh, selection and tab changes', 'period change and measurement reset clear zoom', 'raw point tooltips', 'single point, all lost, no data', 'responsive chart and no page overflow', 'all imported assets load'], errors, badAssets };
  await writeFile(new URL('results.json', output), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close(); }
