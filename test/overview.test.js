import test from 'node:test';
import assert from 'node:assert/strict';
import { activeTargets, summarizeOverview, internetSummary, lossSummary } from '../public/overview.js';

const target = (host, status = 'ok', overrides = {}) => ({ host, label: host, kind: 'internet', enabled: true, stats: { status, sent: 10, received: status === 'down' ? 0 : 10, lossPercent: status === 'down' ? 100 : 0, lastMs: status === 'down' ? null : 12 }, ...overrides });

test('overview includes a failed second Internet target and its packet loss', () => {
  const state = { monitoring: true, targets: [target('first'), target('second', 'down'), { host: 'mesh', kind: 'repeater', enabled: true, stats: { status: 'ok', sent: 10, lossPercent: 0 } }] };
  assert.equal(internetSummary(state).status, 'down');
  assert.equal(internetSummary(state).value, '– ms');
  assert.equal(internetSummary(state).reading, '–');
  assert.equal(internetSummary(state).unit, 'ms');
  assert.equal(internetSummary(state).detail, '2 Internetziele · 3 Messziele gesamt');
  assert.equal(internetSummary(state).activeInternetCount, 2);
  assert.equal(internetSummary(state).totalActiveCount, 3);
  assert.equal(activeTargets(state).length, 3);
  assert.equal(lossSummary(state).value, '100 %');
  assert.equal(lossSummary(state).reading, '100');
  assert.equal(lossSummary(state).unit, '%');
  assert.equal(summarizeOverview(state).title, 'second: keine Ping-Antwort');
  assert.equal(summarizeOverview(state).level, 'bad');
  assert.match(summarizeOverview(state).detail, /second: keine Ping-Antwort/);
});

test('global and individual pauses cannot present old values as healthy live measurements', () => {
  const state = { monitoring: false, targets: [target('first')] };
  assert.equal(summarizeOverview(state).level, 'muted');
  assert.equal(internetSummary(state).status, 'paused');
  assert.equal(lossSummary(state).value, '– %');
  state.monitoring = true; state.targets[0].enabled = false;
  assert.equal(internetSummary(state).status, 'paused');
  assert.equal(lossSummary(state).status, 'pending');
  assert.equal(summarizeOverview(state).title, 'Keine aktiven Messziele');
});

test('probe errors and missing samples stay distinct from success and packet loss', () => {
  const state = { monitoring: true, targets: [target('first', 'ok', { lastError: 'Probe failed' })] };
  assert.equal(internetSummary(state).status, 'error');
  assert.equal(internetSummary(state).value, '– ms');
  assert.equal(lossSummary(state).status, 'pending');
  assert.equal(summarizeOverview(state).level, 'warn');
  state.targets = [target('first', 'pending', { stats: { sent: 0, status: 'pending', lossPercent: null } })];
  assert.equal(summarizeOverview(state).level, 'muted');
  assert.equal(internetSummary(state).status, 'pending');
});

test('storage and DNS warnings are not concealed by healthy ping targets', () => {
  const state = { monitoring: true, targets: [target('first')], diagnosis: [{ level: 'warning', title: 'DNS fehlgeschlagen', detail: 'Vergleichen' }] };
  assert.equal(summarizeOverview(state).title, 'DNS fehlgeschlagen');
  state.persistence = { lastError: 'Datenträger voll' };
  assert.match(summarizeOverview(state).title, /gespeichert/);
  assert.ok(summarizeOverview(state).info.includes('Datenträger voll'));
});

test('critical latency from a second target remains critical in the overview', () => {
  const state = { monitoring: true, targets: [target('first'), target('second', 'critical')] };
  assert.equal(internetSummary(state).status, 'critical');
  assert.equal(summarizeOverview(state).level, 'bad');
  assert.equal(summarizeOverview(state).title, 'second: kritische Messwerte');
  assert.match(summarizeOverview(state).detail, /second/);
});

test('healthy status uses one short statement and keeps scope limits in the info text', () => {
  const state = { monitoring: true, targets: [target('first')] };
  const summary = summarizeOverview(state);
  assert.equal(summary.title, 'Alles stabil');
  assert.equal(summary.detail, '1 aktives Messziel antwortet unauffällig.');
  assert.match(summary.info, /Nicht überwachte Geräte/);
  assert.match(summary.info, /fehlende Ping-Antwort allein beweist keinen Ausfall/);
});

test('overview info preserves every diagnosis title and detail', () => {
  const state = { monitoring: true, targets: [target('first')], diagnosis: [
    { level: 'warning', title: 'DNS nicht erreichbar', detail: 'Namensauflösung schlug fehl.' },
    { level: 'info', title: 'LAN verbunden', detail: '100 Mbit/s erkannt.' },
  ] };
  const summary = summarizeOverview(state);
  for (const phrase of ['DNS nicht erreichbar', 'Namensauflösung schlug fehl.', 'LAN verbunden', '100 Mbit/s erkannt.']) assert.ok(summary.info.includes(phrase));
});

test('active target counts share one helper and paused internet targets remain excluded', () => {
  const state = { monitoring: true, targets: [target('wan'), { ...target('mesh'), kind: 'repeater' }, { ...target('paused'), enabled: false }] };
  assert.equal(activeTargets(state).length, 2);
  assert.equal(internetSummary(state).totalActiveCount, 2);
  assert.match(summarizeOverview(state).detail, /^2 aktive Messziele/);
});
