import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';
import { Monitor } from '../lib/monitor.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = new URL('../test-artifacts/history-live-ui/', import.meta.url);
await mkdir(output, { recursive: true });
const monitor = new Monitor({});
monitor.state.monitoring = true;
const sample = at => ({ type: 'ping', at: new Date(at).toISOString(), epoch: 0, results: [
  { host: '192.168.1.1', label: 'Router', kind: 'gateway', ok: true, status: 'Success', ms: 3 },
  { host: '1.1.1.1', label: 'Internet', kind: 'internet', ok: true, status: 'Success', ms: 18 },
] });
const start = Date.now() - 120000;
for (let i = 0; i < 120; i++) monitor.history.record(sample(start + i * 1000));
const server = createApp(monitor, { analysis: { ensureChecked() {}, close() {}, snapshot: () => ({ connection: {}, savedAnalyses: [] }) } });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  await page.clock.install(); page.setDefaultTimeout(10000);
  const errors = [], responses = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => { if (response.url().includes('/api/history?') && response.ok()) responses.push(await response.json()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/#history`);
  const chart = page.locator('#ping-history-chart'), live = page.locator('#ping-chart-live');
  await chart.waitFor();
  const range = () => chart.evaluate(el => [Number(el.dataset.from), Number(el.dataset.to)]);
  const tick = async () => { const response = page.waitForResponse(res => res.url().includes('/api/history?')); await page.clock.runFor(2200); await response; };
  const initialNode = await chart.elementHandle();
  assert.equal(await live.getAttribute('aria-pressed'), 'true');
  const original = await range();
  const addedAt = Date.now(); monitor.history.record(sample(addedAt));
  await tick();
  await page.waitForFunction(at => Number(document.querySelector('#ping-history-chart').dataset.to) === at, addedAt);
  assert.equal((await range())[0], original[0], 'Full live view grows with new data');
  assert.equal(await initialNode.evaluate(el => el.isConnected), true, 'Live updates retain chart DOM');
  assert.ok(responses.some(item => item.incremental && item.records.length === 1), 'Actual backend sends one-record delta');
  assert.equal(await page.locator('.ping-statistics tbody tr').first().locator('td').nth(1).innerText(), '121');
  await page.locator('#ping-chart-in').click();
  const zoomed = await range();
  assert.equal(zoomed[1], addedAt);
  const newAt = Date.now(); monitor.history.record(sample(newAt));
  await tick();
  const followed = await range(); assert.equal(followed[1], newAt); assert.equal(followed[1] - followed[0], zoomed[1] - zoomed[0]);
  // Selection and manual refresh must not discard a zoomed live window.
  await page.locator('input[data-host="192.168.1.1"]').uncheck();
  assert.deepEqual(await range(), followed);
  await page.locator('#history-refresh').click();
  await page.waitForFunction(to => Number(document.querySelector('#ping-history-chart').dataset.to) === to, newAt);
  assert.deepEqual(await range(), followed);
  await page.locator('#ping-chart-earlier').click();
  const held = await range(); assert.equal(await live.getAttribute('aria-pressed'), 'false');
  const heldNode = await chart.elementHandle();
  await chart.focus(); await page.keyboard.press('Enter');
  const cursorTime = await page.locator('.ping-chart-tooltip-heading').innerText();
  monitor.history.record(sample(Date.now())); await tick();
  assert.deepEqual(await range(), held);
  assert.equal(await heldNode.evaluate(el => el.isConnected && document.activeElement === el), true);
  assert.equal(await page.locator('.ping-chart-tooltip-heading').innerText(), cursorTime);
  await live.click(); assert.equal(await live.getAttribute('aria-pressed'), 'true');
  assert.ok((await range())[1] > held[1]);
  assert.equal((await range())[1] - (await range())[0], held[1] - held[0]);
  // A data update arriving during dragging must survive subsequent status polls.
  await page.locator('#ping-chart-in').click(); await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  await page.mouse.move(box.x + box.width * .45, box.y + box.height * .6); await page.mouse.down();
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .6, { steps: 3 });
  const duringDrag = Date.now(); monitor.history.record(sample(duringDrag));
  await tick(); await page.mouse.up();
  await live.click(); assert.equal((await range())[1], duringDrag);
  monitor.state.monitoring = false; await page.clock.runFor(2300);
  await page.waitForFunction(() => document.querySelector('.ping-chart-status').textContent.includes('pausiert'));
  assert.equal(await live.innerText(), 'Live bereit');
  await page.route('**/api/history?*', route => route.abort());
  await page.clock.runFor(2200);
  await page.waitForFunction(() => document.querySelector('.ping-chart-status').textContent.includes('unterbrochen'));
  await page.unroute('**/api/history?*'); monitor.state.monitoring = true;
  await tick();
  await page.waitForFunction(() => document.querySelector('.ping-chart-status').textContent.includes('Live'));
  // Hidden history is not downloaded in a loop.
  await page.locator('[data-nav-page="overview"]').click();
  const reads = responses.length; await page.clock.runFor(4500); assert.equal(responses.length, reads);
  await page.locator('[data-nav-page="history"]').click();
  await page.waitForResponse(res => res.url().includes('/api/history?'));
  await chart.scrollIntoViewIfNeeded();
  await page.locator('.ping-chart').screenshot({ path: fileURLToPath(new URL('live-1440.png', output)) });
  // A reset from another control/client invalidates the cursor and clears the
  // old plot. New samples then populate the same empty chart automatically.
  const period = new Date().toISOString(); monitor.state.measurementStartedAt = period;
  await tick(); await chart.waitFor({ state: 'hidden' });
  assert.match(await page.locator('.ping-chart .history-empty').innerText(), /keine Ping-Messungen/);
  const emptyChart = await chart.elementHandle();
  monitor.history.record({ ...sample(Date.now()), measurementStartedAt: period });
  await tick(); await chart.waitFor();
  assert.equal(await emptyChart.evaluate(el => el.isConnected), true);
  assert.equal(await page.locator('.ping-statistics tbody tr').first().locator('td').nth(1).innerText(), '1');
  const point = await chart.locator('circle').first().elementHandle(); await tick();
  assert.equal(await point.evaluate(el => el.isConnected), true, 'Idle status poll does not redraw the graph');
  assert.deepEqual(errors, []);
  const result = { passed: true, checks: ['2-second append delta without duplicated statistics', 'full and zoomed live follow', 'zoom retained through selection and refresh', 'held viewport, focus and inspection retained', 'drag update survives status poll', 'pause, connection error and recovery', 'no hidden history polling', 'reset resync and empty-to-live chart', 'unchanged graph is not redrawn'], errors };
  await writeFile(new URL('results.json', output), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
} finally { await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close(); }
