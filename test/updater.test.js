import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FEED, createBackgroundUpdater } from '../desktop/updater.cjs';

function fixture(extra = {}) {
  const native = new EventEmitter(); let checks = 0, installs = [];
  native.setFeedURL = value => { native.feed = value; };
  native.checkForUpdates = async () => { checks++; return {}; };
  native.quitAndInstall = (...args) => installs.push(args);
  const logs = [], status = [];
  const controller = createBackgroundUpdater({ updater: native, isPackaged: true, installed: true, platform: 'win32', log: value => logs.push(value), onStatus: value => status.push(value), ...extra });
  return { native, controller, logs, status, installs, get checks() { return checks; } };
}

test('updates use only the public GitHub feed with silent downloads and stable versions', () => {
  const r = fixture();
  assert.deepEqual(r.native.feed, FEED);
  assert.equal(r.native.feed.token, undefined); assert.equal(r.native.feed.url, undefined);
  assert.equal(r.native.autoDownload, true); assert.equal(r.native.autoInstallOnAppQuit, true);
  assert.equal(r.native.autoRunAppAfterInstall, false); assert.equal(r.native.allowPrerelease, false); assert.equal(r.native.allowDowngrade, false);
  r.controller.close();
});

test('portable, development and other platforms never configure or call the updater', async () => {
  for (const extra of [{ installed: false }, { isPackaged: false }, { platform: 'linux' }]) {
    const r = fixture(extra); await r.controller.check(); assert.equal(await r.controller.checkBeforeStart(5), false);
    assert.equal(r.native.feed, undefined); assert.equal(r.checks, 0); assert.equal(r.controller.installAndRestart(), false);
  }
});

test('startup update can restart before monitoring exists, without a prompt', async () => {
  const r = fixture(); const gate = r.controller.checkBeforeStart(1000);
  r.native.emit('update-available'); r.native.emit('update-downloaded');
  assert.equal(await gate, true); assert.equal(r.controller.downloaded, true);
  assert.equal(r.controller.installAndRestart(), true); assert.deepEqual(r.installs, [[true, true]]);
  r.controller.close();
});

test('offline errors open startup immediately and future checks remain possible', async () => {
  const r = fixture(); r.native.checkForUpdates = () => { throw new Error('offline'); };
  assert.equal(await r.controller.checkBeforeStart(1000), false);
  await r.controller.check(); assert.equal(r.controller.status, 'error'); assert.ok(r.logs.some(value => value.includes('offline')));
  r.native.checkForUpdates = async () => { r.native.emit('update-not-available'); return {}; };
  await r.controller.check(); assert.equal(r.controller.status, 'current'); r.controller.close();
});

test('startup deadline releases UI, and a later completed download never forces a restart', async () => {
  const r = fixture(); r.native.checkForUpdates = async () => { r.native.emit('update-available'); return {}; };
  assert.equal(await r.controller.checkBeforeStart(5), false);
  r.native.emit('update-downloaded'); assert.equal(r.controller.downloaded, true); assert.equal(r.installs.length, 0);
  assert.equal(r.native.autoInstallOnAppQuit, true); r.controller.close();
});

test('concurrent checks are coalesced and repeated checks resume after completion', async () => {
  const r = fixture(); let resolve, calls = 0;
  r.native.checkForUpdates = () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = r.controller.check(); const second = r.controller.check();
  await new Promise(done => setImmediate(done)); assert.equal(calls, 1);
  resolve({}); await Promise.all([first, second]);
  r.native.checkForUpdates = async () => { calls++; return {}; };
  await r.controller.check(); assert.equal(calls, 2); r.controller.close();
});

test('late shutdown errors remain handled and OS shutdown suppresses installation', () => {
  const r = fixture(); r.controller.close(true);
  r.native.emit('error', new Error('download cancelled')); assert.equal(r.native.autoInstallOnAppQuit, false);
  assert.ok(r.logs.some(value => value.includes('download cancelled')));
});

test('installer startup failure does not strand startup and can be retried', () => {
  const r = fixture(); r.native.emit('update-downloaded');
  r.native.quitAndInstall = () => r.native.emit('error', new Error('installer missing'));
  assert.equal(r.controller.installAndRestart(), false);
  r.native.quitAndInstall = (...args) => r.installs.push(args);
  assert.equal(r.controller.installAndRestart(), true); r.controller.close();
});

test('periodic background checks continue after startup without reopening the gate', async () => {
  const r = fixture({ intervalMs: 5 }); let calls = 0, next;
  const nextCheck = new Promise(resolve => { next = resolve; });
  r.native.checkForUpdates = async () => { calls++; r.native.emit('update-not-available'); if (calls === 2) next(); return {}; };
  assert.equal(await r.controller.checkBeforeStart(1000), false);
  let timer;
  try {
    await Promise.race([nextCheck, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No scheduled check')), 1000); })]);
    assert.ok(calls >= 2); assert.equal(r.installs.length, 0);
  } finally { clearTimeout(timer); r.controller.close(); }
});
