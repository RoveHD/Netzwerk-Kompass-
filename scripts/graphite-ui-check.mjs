// Isolated UI contract QA using synthetic network data only.
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Monitor } from '../lib/monitor.js';
import { createApp } from '../server.js';
import { summarize } from '../lib/analysis.js';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = path.resolve('test-artifacts/signal-ui');
await mkdir(output, { recursive: true });

const network = {
  interfaces: [{ id: 'qa-lan', name: 'LAN · Testadapter', kind: 'Ethernet', status: 'Up', gateway: '192.168.50.1', ipv4: [{ address: '192.168.50.2', prefixLength: 24 }], dns: ['192.168.50.1'], linkSpeedMbps: 1000 }],
  defaultInterfaceId: 'qa-lan', neighbors: [], warnings: [],
  wifi: { connected: true, ssid: 'QA-Fixture', signalPercent: 88, channel: 36, networks: [{ ssid: 'QA-Fixture', channel: 36, signalPercent: 88 }] },
};
const monitor = new Monitor({
  discoverNetwork: async () => structuredClone(network),
  pingMany: async hosts => hosts.map(host => ({ host, ok: true, ms: 18, status: 'Success' })),
  getTrafficCounters: async () => [],
});
monitor.maintenance = async () => {};
monitor.schedule = () => {};
await monitor.refresh();
for (let i = 0; i < 8; i++) await monitor.tick();
monitor.state.devices = Array.from({ length: 12 }, (_, i) => ({ ip: `192.168.50.${i + 10}`, name: `QA-Gerät ${i + 1}`, respondsToPing: true, interfaceId: 'qa-lan', mac: `00:11:22:33:44:${String(i).padStart(2, '0')}` }));
monitor.state.traffic.downloadMbps = 24.8;
monitor.state.traffic.uploadMbps = 3.2;
monitor.state.traffic.interfaceId = 'qa-lan';
monitor.state.traffic.history = Array.from({ length: 90 }, (_, i) => ({ at: new Date(Date.now() - (89 - i) * 2000).toISOString(), downloadMbps: 24 + i % 7, uploadMbps: 3 + i % 3 }));
monitor.state.speedTest = { phase: 'done', running: false, at: new Date().toISOString(), downloadMbps: 143.2, uploadMbps: 25.1 };
const now = Date.now();
assert.ok(monitor.state.targets.length, 'Monitor hat keine synthetischen Ziele für die UI-Fixtures');
for (const target of monitor.state.targets) target.samples = [];
for (let i = 0; i < 120; i++) {
  const at = new Date(now - (119 - i) * 2000).toISOString();
  const results = monitor.state.targets.map(target => {
    const sample = { at, ok: true, ms: target.kind === 'gateway' ? 11 + i % 7 : 18 + i % 9, status: 'Success' };
    target.samples.push(sample);
    return { host: target.host, label: target.label, kind: target.kind, ...sample };
  });
  monitor.history.record({ type: 'ping', at, results });
}
for (const target of monitor.state.targets) target.stats = summarize(target.samples, target.kind);
for (let i = 0; i < 8; i++) monitor.event('info', `QA-Fixture-Ereignis ${i + 1}`, 'Synthetisches UI-Ereignis.');
const analysis = { ensureChecked() {}, snapshot: () => ({ status: 'idle', connection: { available: false, checking: false, message: 'Isolierter UI-Test' }, savedAnalyses: [] }), close() {}, reset() {} };
const server = createApp(monitor, { analysis });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
page.setDefaultTimeout(15000);
const errors = [], failedResponses = [], results = [], loadedAssets = new Set(), requestedPaths = new Set();
page.on('request', request => requestedPaths.add(new URL(request.url()).pathname));
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
page.on('requestfailed', request => errors.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`));
page.on('response', response => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
  if (response.ok() && new URL(response.url()).origin === base) loadedAssets.add(new URL(response.url()).pathname);
});
const nav = id => page.locator(`[data-nav-page="${id}"]`).click();
const tabs = ['overview', 'devices', 'games', 'history', 'router', 'tests', 'ai', 'settings'];
const expectedSizes = ['12px', '13px', '14px', '16px', '18px', '28px', '32px'];
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(() => document.querySelector('#connection-state')?.textContent?.trim() !== 'Verbinde …');
  const fontReport = await page.evaluate(async () => {
    const loaded = await document.fonts.load('400 14px "Geist Mono"');
    await document.fonts.ready;
    return {
      loaded: loaded.map(face => ({ family: face.family, weight: face.weight, status: face.status })),
      body: getComputedStyle(document.body).fontFamily,
      measure: getComputedStyle(document.querySelector('.summary-value')).fontFamily,
    };
  });
  assert.ok(fontReport.loaded.length && fontReport.loaded.every(face => face.status === 'loaded'), 'Geist Mono wurde nicht lokal geladen');
  assert.match(fontReport.body, /Geist/i);
  assert.match(fontReport.measure, /Geist Mono/i);

  const signal = await page.evaluate(async () => {
    const { renderLiveSignal } = await import('/live-signal.js');
    const { setMeasurement } = await import('/ui-presentation.js');
    const current = await (await fetch('/api/state')).json();
    const root = document.querySelector('#live-signal');
    const track = root.querySelector('a'); track.focus();
    const firstBar = track.querySelector('.live-signal-sample');
    renderLiveSignal(root, current);
    const stable = root.querySelector('a') === track && document.activeElement === track && firstBar.isConnected;
    const sampleCount = track.querySelectorAll('.live-signal-sample').length;
    const ringCount = document.querySelectorAll('.overview-status-ring [data-host]').length;
    const ringSize = document.querySelector('.overview-status-ring').getBoundingClientRect();
    const newer = structuredClone(current);
    const target = newer.targets.find(target => target.enabled);
    target.samples.push({ at: new Date(Date.now() + 1000).toISOString(), ok: false, ms: null, status: 'TimedOut' });
    target.samples.push({ at: new Date(Date.now() + 2000).toISOString(), ok: false, ms: null, status: 'measurement_error' });
    renderLiveSignal(root, newer);
    const loss = track.querySelector('.is-loss');
    const error = track.querySelector('.is-unknown');
    const animationCount = track.getAnimations({ subtree: true }).length;
    const tooltip = loss?.title;
    const issues = track.querySelector('.live-signal-issues').textContent;
    renderLiveSignal(root, { ...current, monitoring: false, targets: current.targets.map(target => ({ ...target, samples: [] })) });
    const empty = track.querySelectorAll('.live-signal-sample').length === 0 && track.querySelector('.live-signal-issues').hidden;
    const paused = track.dataset.running === 'false' && track.querySelector('.live-signal-phase').textContent === 'Pausiert';
    const testValue = document.createElement('strong');
    document.body.append(testValue); setMeasurement(testValue, '12', 'ms'); setMeasurement(testValue, '24', 'ms');
    const fades = testValue.getAnimations({ subtree: true }).map(animation => animation.effect.getTiming().duration);
    const unit = testValue.querySelector('small')?.textContent;
    testValue.remove();
    renderLiveSignal(root, current);
    window.scrollTo(0, 500);
    const top = root.getBoundingClientRect().top;
    window.scrollTo(0, 0);
    return { stable, sampleCount, ringCount, targets: current.targets.filter(target => target.enabled).length, ringWidth: ringSize.width, ringHeight: ringSize.height, loss: !!loss, error: !!error, tooltip, issues, empty, paused, animationCount, fades, unit, top };
  });
  assert.ok(signal.stable, 'Polling ersetzt Live-Link, Balken oder Fokus');
  assert.equal(signal.sampleCount, 60);
  assert.equal(signal.ringCount, signal.targets);
  assert.ok(Math.abs(signal.ringWidth - 48) < .5 && Math.abs(signal.ringHeight - 48) < .5, 'Statusring ist nicht 48px groß');
  assert.ok(signal.loss && signal.error && /Ping-Verlust/.test(signal.tooltip));
  assert.equal(signal.issues, '1 ohne Antwort · 1 Messfehler');
  assert.ok(signal.empty && signal.paused, 'Leere oder pausierte Messungen behalten keine aktiven Signale');
  assert.ok(signal.animationCount > 0, 'Neue Live-Werte werden nicht bewegt');
  assert.deepEqual(signal.fades, [150]); assert.equal(signal.unit, 'ms');
  assert.equal(signal.top, 56, 'Live-Leiste bleibt beim Scrollen nicht unter dem Header');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reduced = await page.evaluate(async () => {
    const { setMeasurement } = await import('/ui-presentation.js');
    const testValue = document.createElement('strong'); document.body.append(testValue);
    setMeasurement(testValue, '1'); setMeasurement(testValue, '2');
    const count = testValue.getAnimations({ subtree: true }).length; testValue.remove();
    return { count, pageAnimation: getComputedStyle(document.querySelector('#page-overview')).animationName };
  });
  assert.equal(reduced.count, 0); assert.equal(reduced.pageAnimation, 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.live-signal-track').click();
  await page.locator('#page-history').waitFor({ state: 'visible' });
  await nav('overview');
  results.push('Live-Leiste: 60 Pings, stabile DOM/Fokus, Verlust/Messfehler getrennt, Klick-Verlauf und Scrollposition; 48px-Zielring; 150ms-Wertefade und reduzierte Bewegung geprüft');

  for (const width of [2560, 1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    const frame = await page.evaluate(() => {
      window.scrollTo(0, 500);
      const header = document.querySelector('.topbar').getBoundingClientRect();
      const signal = document.querySelector('#live-signal').getBoundingClientRect();
      const nav = document.querySelector('.app-navigation').getBoundingClientRect();
      const chart = document.querySelector('.live-signal-chart').getBoundingClientRect();
      window.scrollTo(0, 0);
      return { headerBottom: header.bottom, signalTop: signal.top, signalBottom: signal.bottom, navTop: nav.top, chartWidth: chart.width, chartHeight: chart.height };
    });
    assert.ok(Math.abs(frame.signalTop - frame.headerBottom) <= 1, `Live-Anzeige überlappt den Header bei ${width}px`);
    assert.ok(frame.chartWidth <= 320 && frame.chartHeight >= 20, `Live-Verlauf ist nicht kompakt und lesbar bei ${width}px`);
    if (width > 900) assert.ok(Math.abs(frame.navTop - frame.signalBottom) <= 1, `Sidebar überlappt die Live-Anzeige bei ${width}px`);
    await page.screenshot({ path: path.join(output, `header-${width}.png`), clip: { x: 0, y: 0, width, height: Math.ceil(frame.signalBottom) } });
    for (const id of tabs) {
      await nav(id);
      await page.locator(`#page-${id}`).waitFor({ state: 'visible' });
      const layout = await page.evaluate(() => {
        const visible = node => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
        const texts = [...document.querySelectorAll(`#page-${document.querySelector('[aria-current="page"]')?.dataset.navPage} *, .app-navigation *`)].filter(node => visible(node) && node.childElementCount === 0 && node.textContent.trim());
        const badSizes = [...new Set(texts.map(node => getComputedStyle(node).fontSize).filter(size => !['12px','13px','14px','16px','18px','28px','32px'].includes(size)))];
        const badFamilies = [...new Set(texts.map(node => getComputedStyle(node).fontFamily).filter(family => !/Geist/i.test(family) && !/Geist Mono/i.test(family)))];
        const navBox = document.querySelector('.app-navigation').getBoundingClientRect();
        const navMaxHeight = getComputedStyle(document.querySelector('.app-navigation')).maxHeight;
        const overflowNodes = [...document.querySelectorAll('body *')].filter(node => visible(node)).map(node => ({ node, rect: node.getBoundingClientRect() })).filter(({rect}) => rect.right > innerWidth + 1 || rect.left < -1).slice(0, 12).map(({node,rect}) => ({ tag: node.tagName, id: node.id, className: typeof node.className === 'string' ? node.className : '', text: node.textContent.trim().slice(0, 48), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }));
        const cards = [...document.querySelectorAll('#page-overview .summary-card')];
        const values = [...document.querySelectorAll('#internet-value, #loss-value, #download-value, #upload-value')];
        const overview = document.querySelector('#page-overview');
        return {
          docWidth: document.documentElement.scrollWidth,
          overflowNodes,
          badSizes, badFamilies,
          navBottom: navBox.bottom, navHeight: navBox.height,
          navMaxHeight,
          h1Size: getComputedStyle(document.querySelector('#page-title')).fontSize,
          h2Sizes: [...document.querySelectorAll(`#page-${document.querySelector('[aria-current="page"]')?.dataset.navPage} h2`)].map(node => getComputedStyle(node).fontSize),
          navNumbers: document.querySelectorAll('.nav-index').length,
          signatures: document.querySelectorAll('.instrument-signature,.sidebar-footer').length,
          visibleEyebrows: [...document.querySelectorAll('.eyebrow')].filter(visible).length,
          brandTaglines: [...document.querySelectorAll('.brand small')].filter(visible).length,
          sectionPrefixes: texts.filter(node => /^\d{2}\s*\//.test(node.textContent.trim())).map(node => node.textContent.trim()),
          overviewStatusCount: document.querySelectorAll('.overview-status').length,
          diagnosisPanels: overview.querySelectorAll('#diagnosis-list,.diagnosis-panel').length,
          cardHeights: cards.map(card => Math.round(card.getBoundingClientRect().height)),
          valueSizes: values.map(node => getComputedStyle(node).fontSize),
          badgeBackground: getComputedStyle(overview.querySelector('#internet-status')).backgroundColor,
          badgeDot: getComputedStyle(overview.querySelector('#internet-status'), '::before').backgroundColor,
          colors: Object.fromEntries(['--bg','--panel','--accent','--text','--muted','--green','--orange','--red'].map(key => [key, getComputedStyle(document.documentElement).getPropertyValue(key).trim()])),
        };
      });
      assert.ok(layout.docWidth <= width, `${id}: horizontal overflow ${layout.docWidth}px at ${width}px; elements: ${JSON.stringify(layout.overflowNodes)}`);
      assert.deepEqual(layout.badSizes, [], `${id}: Schriftgrößen außerhalb der Skala: ${layout.badSizes}`);
      assert.deepEqual(layout.badFamilies, [], `${id}: nicht erlaubte Schriftfamilien: ${layout.badFamilies}`);
      assert.equal(layout.navNumbers, 0, 'Sidebar enthält Indexnummern');
      assert.equal(layout.signatures, 0, 'Sidebar enthält entfernte Signatur/Footer-Deko');
      assert.equal(layout.visibleEyebrows, 0, 'Dekoratives Eyebrow sichtbar');
      assert.equal(layout.brandTaglines, 0, 'Brand-Tagline ist noch sichtbar');
      assert.deepEqual(layout.sectionPrefixes, [], 'Dekorative Abschnittsnummer ist sichtbar');
      assert.equal(layout.overviewStatusCount, 1, 'Statusblock muss einzeln sein');
      assert.equal(layout.diagnosisPanels, 0, 'Diagnose darf keinen zweiten Statusblock bilden');
      assert.equal(layout.h1Size, '28px', `${id}: H1 muss 28px sein`);
      assert.ok(layout.h2Sizes.every(size => size === '18px'), `${id}: H2 muss 18px sein: ${layout.h2Sizes}`);
      if (width > 900) {
        assert.ok(Math.abs(layout.navBottom - 1050) <= 1, `Sidebar endet vor dem Viewport-Boden: ${layout.navBottom}`);
        assert.ok(['none', '0px'].includes(layout.navMaxHeight), `Desktop-Sidebar hat max-height ${layout.navMaxHeight}`);
      }
      if (id === 'overview') {
        const panels = await page.locator('#page-overview .overview-analysis-grid > .panel, #page-overview .overview-support-grid > .panel, #page-overview .overview-bottom-grid > .panel').evaluateAll(nodes => nodes.map(node => ({ width: Math.round(node.getBoundingClientRect().width), height: Math.round(node.getBoundingClientRect().height) })));
        assert.equal(panels.length, 6);
        assert.equal(new Set(panels.map(panel => panel.height)).size, 1, `Die sechs großen Panels haben verschiedene Höhen: ${JSON.stringify(panels)}`);
        assert.ok(Math.max(...panels.map(panel => panel.width)) - Math.min(...panels.map(panel => panel.width)) <= 1, `Die sechs großen Panels haben verschiedene Breiten: ${JSON.stringify(panels)}`);
        assert.ok(layout.cardHeights.length && new Set(layout.cardHeights).size === 1, `Statuskarten haben unterschiedliche Höhen: ${layout.cardHeights}`);
        assert.ok(layout.valueSizes.every(size => size === '32px'), `Messwerte sind nicht 32px: ${layout.valueSizes}`);
        assert.equal(layout.badgeBackground, 'rgba(0, 0, 0, 0)', 'Statusbadge hat gefüllten Hintergrund');
        assert.notEqual(layout.badgeDot, 'rgba(0, 0, 0, 0)', 'Statusbadge-Farbpunkt fehlt');
        assert.deepEqual(layout.colors, { '--bg': '#16181A', '--panel': '#1D2023', '--accent': '#3FC1B0', '--text': '#C9CDD1', '--muted': '#8A9096', '--green': '#6FBF73', '--orange': '#E0A84A', '--red': '#E06A5F' });
        const contrast = await page.evaluate(() => {
          const lum = value => { const [r,g,b] = value.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v/255).map(v => v<=.04045?v/12.92:((v+.055)/1.055)**2.4); return .2126*r+.7152*g+.0722*b; };
          const ratio=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)};
          const actualBg=node=>{let current=node;while(current&&current!==document.documentElement){const bg=getComputedStyle(current).backgroundColor;if(bg!=='rgba(0, 0, 0, 0)')return bg;current=current.parentElement;}return getComputedStyle(document.body).backgroundColor;};
          const visible=node=>!!(node.offsetWidth||node.offsetHeight||node.getClientRects().length);
          const nodes=[...document.querySelectorAll('#page-overview p, #page-overview a, #page-overview button, #page-overview strong, #page-overview span, .app-navigation a')].filter(node=>visible(node)&&node.childElementCount===0&&node.textContent.trim());
          const values=nodes.map(node=>({text:node.textContent.trim().slice(0,50),ratio:ratio(getComputedStyle(node).color,actualBg(node))}));
          return { minimum: Math.min(...values.map(item=>item.ratio)), failures: values.filter(item=>item.ratio<4.5) };
        });
        assert.ok(contrast.minimum >= 4.5 && contrast.failures.length === 0, `Fließtext-Kontrast unterschreitet WCAG AA: ${JSON.stringify(contrast)}`);
        if ([1440, 390, 320].includes(width)) await page.screenshot({ path: path.join(output, `overview-${width}.png`), fullPage: true });
      }
      if (width === 1440) await page.screenshot({ path: path.join(output, `${id}-1440.png`), fullPage: true });
    }
    results.push(`Alle 8 Bereiche bei ${width}px ohne horizontalen Überlauf; Schrift- und Deko-Vertrag geprüft`);
  }

  await nav('overview');
  await page.locator('#monitor-btn').click();
  await page.waitForFunction(() => document.querySelector('#overview-status-title')?.textContent === 'Überwachung pausiert');
  assert.equal(await page.locator('.live-signal-phase').textContent(), 'Pausiert');
  assert.equal(await page.locator('#overview-status').getAttribute('data-level'), 'muted');
  await page.locator('#monitor-btn').click();
  await page.waitForFunction(() => document.querySelector('#overview-status-title')?.textContent !== 'Überwachung pausiert');
  results.push('Überwachung über die UI pausiert und fortgesetzt');

  const incidentTarget = monitor.state.targets.find(target => target.kind === 'internet');
  assert.ok(incidentTarget, 'Für Statusprüfung fehlt ein synthetisches Internetziel');
  incidentTarget.samples = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.now() - (29 - i) * 15000).toISOString(), ok: true, ms: 45, status: 'Success' }));
  incidentTarget.stats = summarize(incidentTarget.samples, incidentTarget.kind);
  assert.equal(incidentTarget.stats.status, 'warning');
  await page.waitForFunction(() => document.querySelector('#overview-status')?.dataset.level === 'warn' && document.querySelector('#internet-status')?.classList.contains('pill-warn'));
  assert.equal(await page.locator('#internet-status').evaluate(el => getComputedStyle(el).color), 'rgb(224, 168, 74)');
  assert.equal(await page.locator('#internet-status').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  results.push('Warnstatus bleibt gelb und transparent statt wie ein Ausfall markiert');

  incidentTarget.samples = Array.from({ length: 30 }, (_, i) => ({ at: new Date(Date.now() - (29 - i) * 15000).toISOString(), ok: i < 27, ms: i < 27 ? 24 : null, status: i < 27 ? 'Success' : 'TimedOut' }));
  incidentTarget.stats = summarize(incidentTarget.samples, incidentTarget.kind);
  assert.equal(incidentTarget.stats.status, 'down');
  await page.waitForFunction(() => document.querySelector('#overview-status')?.dataset.level === 'bad' && document.querySelector('#internet-status')?.classList.contains('pill-bad'));
  assert.equal(await page.locator('#internet-status').evaluate(el => getComputedStyle(el).color), 'rgb(224, 106, 95)');
  assert.equal(await page.locator('#internet-status').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  results.push('Nur echte drei Timeout-Ausfälle werden rot markiert');

  const eventButton = page.locator('#events-show-all');
  assert.equal(await page.locator('#events-list .event-row').count(), 5, 'Startzustand zeigt nicht genau fünf Ereignisse');
  await eventButton.waitFor({ state: 'visible' });
  const availableEvents = await page.locator('#event-count').textContent();
  assert.equal((await eventButton.textContent()).trim(), `Alle ${availableEvents.trim()} anzeigen`);
  await eventButton.click();
  assert.equal(await page.locator('#events-list .event-row').count(), Number(availableEvents), 'Erweitern zeigt nicht alle verfügbaren Ereignisse');
  results.push(`Ereignisse: fünf sichtbar, Alle ${availableEvents.trim()} anzeigen erweitert auf alle verfügbaren Ereignisse`);

  const info = page.locator('#overview-status-info');
  await page.evaluate(() => {
    window.__tooltipQaEvents = [];
    for (const type of ['focusin','focusout','keydown','keyup','click']) document.addEventListener(type, event => {
      if (event.target?.id === 'overview-status-info') window.__tooltipQaEvents.push({ type, key: event.key || '', scrollY, expanded: event.target.getAttribute('aria-expanded'), visible: !document.querySelector('.help-popover')?.hidden });
    }, true);
    window.addEventListener('scroll', () => window.__tooltipQaEvents.push({ type: 'scroll', scrollY, expanded: document.querySelector('#overview-status-info')?.getAttribute('aria-expanded'), visible: !document.querySelector('.help-popover')?.hidden }), true);
  });
  await info.focus();
  await page.keyboard.press('Space');
  await page.locator('.help-popover').waitFor({ state: 'visible' });
  assert.match(await page.locator('.help-popover').textContent(), /fehlende Ping-Antwort allein beweist keinen Ausfall/);
  const tooltipSpaceEvents = await page.evaluate(() => window.__tooltipQaEvents);
  await page.keyboard.press('Escape');
  await page.locator('.help-popover').waitFor({ state: 'hidden' });
  await info.focus();
  await page.keyboard.press('Enter');
  await page.locator('.help-popover').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await page.locator('.help-popover').waitFor({ state: 'hidden' });
  results.push(`Status-Tooltip per Space und Enter geöffnet, mit Escape geschlossen; Ereignisse ${JSON.stringify(tooltipSpaceEvents)}`);

  const ticks = await page.locator('#latency-chart .chart-label').allTextContents();
  assert.ok(ticks.length >= 4 && ticks.some(value => value.trim() === '30 ms'), `Latenzdiagramm zeigt keine passenden runden Ticks: ${ticks}`);
  assert.ok(await page.locator('#latency-chart .chart-threshold').count(), '30ms-Schwelle fehlt im Übersichtsdiagramm');
  assert.notEqual(await page.locator('#latency-chart .chart-threshold').evaluate(el => getComputedStyle(el).strokeDasharray), 'none', '30ms-Linie ist nicht gestrichelt');
  await nav('history');
  await page.locator('#history-tab-connection').click();
  await page.locator('#ping-history-chart').waitFor();
  const historyTicks = await page.locator('#ping-history-chart .history-axis-label').allTextContents();
  assert.ok(historyTicks.some(value => value.trim() === '30 ms'), `Pingverlauf zeigt keine 30-ms-Achsenmarke: ${historyTicks}`);
  assert.ok(await page.locator('#ping-history-chart .history-threshold').count(), '30ms-Schwelle fehlt im Pingverlauf');
  assert.notEqual(await page.locator('#ping-history-chart .history-threshold').evaluate(el => getComputedStyle(el).strokeDasharray), 'none', '30ms-Linie im Verlauf ist nicht gestrichelt');
  assert.ok(await page.locator('#ping-history-chart circle').count(), 'Pingdiagramm enthält keine synthetischen Punkte');
  results.push('Übersichts- und Verlaufsdiagramm mit runden ms-Ticks und gestrichelter 30-ms-Schwelle');

  const colors = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, panel: getComputedStyle(document.querySelector('.history-panel')).backgroundColor, line: getComputedStyle(document.querySelector('.history-panel')).borderTopColor, accent: getComputedStyle(document.querySelector('.history-tab.is-active')).borderBottomColor }));
  results.push(`Farbvertrag geprüft: ${JSON.stringify(colors)}`);
  assert.ok(loadedAssets.has('/graphite.css'), 'Calm Stylesheet wurde nicht geladen');
  assert.ok(loadedAssets.has('/fonts/geist-mono-variable.woff2'), 'Lokaler Geist-Mono-Font wurde nicht geladen');
  assert.ok(loadedAssets.has('/fonts/geist-variable.woff2'), 'Lokaler Geist-Font wurde nicht geladen');
  assert.ok(loadedAssets.has('/ui-help.js'), 'Tooltip-Modul wurde nicht geladen');
  assert.deepEqual(errors, []);
  assert.deepEqual(failedResponses, []);
  const report = { fixture: 'synthetische LAN/WLAN-Daten, 120 synthetische Pingpunkte und 8 synthetische Ereignisse; keine Live-Probes', viewportWidths: [2560, 1440, 1024, 768, 390, 320], tabs, results, fonts: fontReport, loadedAssets: [...loadedAssets].sort(), requestedPaths: [...requestedPaths].sort(), errors, failedResponses };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const report = { results, errors, failedResponses, loadedAssets: [...loadedAssets], requestedPaths: [...requestedPaths], failure: String(error) };
  await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
  console.error(JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await monitor.close();
}
