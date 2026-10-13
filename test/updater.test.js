import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { FEED, createBackgroundUpdater } from '../desktop/updater.cjs';
import { createQuitCoordinator } from '../desktop/server-lifecycle.cjs';

function fixture(extra = {}) {
  const native = new EventEmitter(); let checks = 0, downloads = 0, installs = [];
  native.setFeedURL = value => { native.feed = value; };
  native.checkForUpdates = async () => { checks++; return {}; };
  native.downloadUpdate = async () => { downloads++; native.emit('update-downloaded'); return ['installer.exe']; };
  native.quitAndInstall = (...args) => installs.push(args);
  const logs = [], status = [];
  const controller = createBackgroundUpdater({ updater: native, isPackaged: true, installed: true, platform: 'win32', log: value => logs.push(value), onStatus: value => status.push(value), ...extra });
  return { native, controller, logs, status, installs, get checks() { return checks; }, get downloads() { return downloads; } };
}

test('updates use only the public GitHub feed with manual downloads and stable versions', () => {
  const r = fixture();
  assert.deepEqual(r.native.feed, FEED);
  assert.equal(r.native.feed.token, undefined); assert.equal(r.native.feed.url, undefined);
  assert.equal(r.native.autoDownload, false); assert.equal(r.native.autoInstallOnAppQuit, true);
  assert.equal(r.native.autoRunAppAfterInstall, false); assert.equal(r.native.allowPrerelease, false); assert.equal(r.native.allowDowngrade, false);
  r.controller.close();
});

test('portable, development and other platforms never configure or call the updater', async () => {
  for (const extra of [{ installed: false }, { isPackaged: false }, { platform: 'linux' }]) {
    const r = fixture(extra); await r.controller.check(); assert.equal(await r.controller.checkBeforeStart(5), false);
    r.native.emit('update-available'); assert.equal(await r.controller.download(), false); assert.equal(r.downloads, 0);
    assert.equal(r.native.feed, undefined); assert.equal(r.checks, 0); assert.equal(r.controller.installAndRestart(), false);
  }
});

test('an already downloaded update can install before monitoring exists', async () => {
  const r = fixture(); const gate = r.controller.checkBeforeStart(1000);
  r.native.emit('update-downloaded');
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

test('startup deadline releases UI, and later update availability never starts a download', async () => {
  const r = fixture(); let complete;
  r.native.checkForUpdates = () => new Promise(resolve => { complete = resolve; });
  assert.equal(await r.controller.checkBeforeStart(5), false);
  r.native.emit('update-available'); complete({}); await r.controller.check();
  assert.equal(r.controller.available, true); assert.equal(r.downloads, 0); assert.equal(r.installs.length, 0);
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
  r.native.checkForUpdates = async () => { calls++; r.native.emit('update-available'); if (calls === 2) next(); return {}; };
  assert.equal(await r.controller.checkBeforeStart(1000), false);
  let timer;
  try {
    await Promise.race([nextCheck, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('No scheduled check')), 1000); })]);
    assert.ok(calls >= 2); assert.equal(r.installs.length, 0); assert.equal(r.downloads, 0); assert.equal(r.controller.available, true);
  } finally { clearTimeout(timer); r.controller.close(); }
});

test('available metadata releases startup immediately without waiting for the deadline', async () => {
  const r = fixture();
  r.native.checkForUpdates = async () => { r.native.emit('update-available'); return {}; };
  let settled = false;
  const gate = r.controller.checkBeforeStart(1000).then(value => { settled = true; return value; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, true); assert.equal(await gate, false);
    assert.equal(r.controller.status, 'available'); assert.equal(r.downloads, 0);
  } finally { r.controller.close(); }
});

test('real electron-updater checks metadata only and downloads once after an explicit request', async () => {
  const require = createRequire(import.meta.url);
  const { AppUpdater } = require('electron-updater/out/AppUpdater.js');
  const native = new AppUpdater(null, { version: '1.1.1', isPackaged: true });
  const info = { version: '1.1.2', files: [{ url: 'installer.exe', sha512: 'not-used-by-isolated-test' }] };
  let metadata = 0, downloads = 0;
  native.getUpdateInfoAndProvider = async () => { metadata++; return { info, provider: { resolveFiles: () => [] } }; };
  native.isUpdateAvailable = async () => true;
  native.doDownloadUpdate = async options => {
    downloads++; assert.equal(options.updateInfoAndProvider.info, info);
    assert.equal(options.cancellationToken.cancelled, false);
    native.dispatchUpdateDownloaded(info); return ['installer.exe'];
  };
  const controller = createBackgroundUpdater({ updater: native, isPackaged: true, installed: true, platform: 'win32' });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await controller.check()).downloadPromise, null);
    assert.equal(metadata, 3); assert.equal(downloads, 0); assert.equal(controller.status, 'available');
    const first = controller.download(); assert.equal(first, controller.download());
    assert.equal(await first, true); assert.equal(downloads, 1); assert.equal(controller.status, 'ready');
    assert.equal(await controller.download(), false); assert.equal(downloads, 1);
  } finally { controller.close(); }
});

test('a click from update-available waits for metadata and excludes check/download races', async () => {
  const r = fixture(); let finishCheck, finishDownload, clicked, calls = 0;
  const token = { cancel() {} };
  r.native.checkForUpdates = () => {
    calls++; r.native.emit('update-available'); clicked = r.controller.download();
    return new Promise(resolve => { finishCheck = resolve; });
  };
  let downloads = 0;
  r.native.downloadUpdate = cancellation => {
    downloads++; assert.equal(cancellation, token);
    return new Promise(resolve => { finishDownload = () => { r.native.emit('update-downloaded'); resolve([]); }; });
  };
  const check = r.controller.check();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(downloads, 0); assert.equal(clicked, r.controller.download());
    assert.equal(await r.controller.check(), null); assert.equal(calls, 1);
    finishCheck({ cancellationToken: token }); await check;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(downloads, 1); assert.equal(await r.controller.check(), null); assert.equal(calls, 1);
    finishDownload(); assert.equal(await clicked, true); assert.equal(r.controller.busy, false);
  } finally { r.controller.close(); }
});

test('download errors remain retryable and notify the tray after leaving the busy state', async () => {
  const r = fixture();
  r.native.checkForUpdates = async () => { r.native.emit('update-available'); return {}; };
  await r.controller.check();
  r.native.downloadUpdate = async () => { throw new Error('download offline'); };
  assert.equal(await r.controller.download(), false);
  assert.equal(r.controller.status, 'error'); assert.equal(r.controller.available, true); assert.equal(r.controller.busy, false);
  r.native.downloadUpdate = async () => { r.native.emit('update-downloaded'); return []; };
  assert.equal(await r.controller.download(), true); assert.equal(r.controller.status, 'ready');
  assert.ok(r.logs.some(value => value.includes('download offline'))); r.controller.close();
});

test('a failed refresh invalidates older metadata until another successful check', async () => {
  const r = fixture();
  r.native.checkForUpdates = async () => { r.native.emit('update-available'); return {}; };
  await r.controller.check();
  r.native.checkForUpdates = async () => { throw new Error('metadata offline'); };
  await r.controller.check(); assert.equal(r.controller.available, false);
  assert.equal(await r.controller.download(), false); assert.equal(r.downloads, 0);
  r.native.checkForUpdates = async () => { r.native.emit('update-available'); return {}; };
  await r.controller.check(); assert.equal(await r.controller.download(), true); r.controller.close();
});

test('shutdown cancels an active download and retains handlers for late updater events', async () => {
  const r = fixture(); let cancelled = 0, rejectDownload;
  const token = { cancel() { cancelled++; rejectDownload(new Error('cancelled')); } };
  r.native.checkForUpdates = async () => { r.native.emit('update-available'); return { cancellationToken: token }; };
  r.native.downloadUpdate = () => new Promise((_, reject) => { rejectDownload = reject; });
  await r.controller.check(); const pending = r.controller.download();
  await new Promise(resolve => setImmediate(resolve));
  const statuses = r.status.length;
  r.controller.close(true); r.controller.close(true);
  assert.equal(cancelled, 1); assert.equal(await pending, false);
  r.native.emit('update-downloaded'); r.native.emit('error', new Error('late error'));
  assert.equal(r.controller.downloaded, true); assert.equal(r.status.length, statuses);
  assert.equal(r.native.autoInstallOnAppQuit, false); assert.equal(r.installs.length, 0);
  assert.equal(await r.controller.download(), false);
});

test('shutdown prevents a queued check or a download waiting for metadata from starting', async () => {
  const queued = fixture(); const skipped = queued.controller.check(); queued.controller.close();
  await skipped; assert.equal(queued.checks, 0);
  const r = fixture(); let finishCheck;
  r.native.checkForUpdates = () => { r.native.emit('update-available'); return new Promise(resolve => { finishCheck = resolve; }); };
  const check = r.controller.check(); await new Promise(resolve => setImmediate(resolve));
  const download = r.controller.download(); r.controller.close();
  finishCheck({}); await check; assert.equal(await download, false); assert.equal(r.downloads, 0);
});

test('installed tray offers an explicit download, retry, and clean update installation', async () => {
  const native = new EventEmitter(); const app = new EventEmitter(); const events = [];
  let checks = 0, downloads = 0, tray, controller, failDownload = true;
  native.setFeedURL = () => {};
  native.checkForUpdates = async () => { checks++; native.emit('update-available'); return {}; };
  native.downloadUpdate = async () => {
    downloads++;
    if (failDownload) throw new Error('offline');
    native.emit('update-downloaded'); return [];
  };
  native.quitAndInstall = () => events.push('install');
  Object.assign(app, { isPackaged: true, getPath: () => path.resolve('isolated-tray'), requestSingleInstanceLock: () => true,
    whenReady: async () => {}, quit: () => events.push('quit'), exit: () => events.push('exit') });
  class Tray extends EventEmitter {
    constructor() { super(); tray = this; }
    isDestroyed() { return false; }
    setContextMenu(menu) { this.menu = menu; }
    setToolTip() {}
    destroy() { events.push('tray'); }
  }
  const modules = {
    electron: { app, Tray, Menu: { buildFromTemplate: menu => menu }, dialog: { showErrorBox: () => assert.fail('unexpected desktop error') } },
    'node:fs': { mkdirSync() {}, existsSync: () => false, appendFileSync() {} }, 'node:path': path,
    './main.cjs': { configurePersistence() {}, startDesktop: () => ({ stop: () => events.push('desktop') }) },
    './server-lifecycle.cjs': { createQuitCoordinator, createServerLifecycle: () => ({ start: async () => 'http://127.0.0.1:44001', stop: async () => events.push('saved') }) },
    './updater.cjs': { createBackgroundUpdater: options => { controller = createBackgroundUpdater({ ...options, platform: 'win32' }); return controller; } },
    './background.cjs': { createBackgroundMonitoring: () => ({ enabled: false, status: () => ({}), notify() {} }) },
    './background-server.cjs': { createBackgroundServer: options => options.createLifecycle(options) },
    'electron-updater': { autoUpdater: native }
  };
  runInNewContext(readFileSync(new URL('../desktop/installed.cjs', import.meta.url), 'utf8'), {
    require: name => { assert.ok(modules[name], name); return modules[name]; }, __dirname: path.resolve('desktop'),
    process: { argv: [], env: {}, resourcesPath: path.resolve('resources'), execPath: path.resolve('app.exe'), on() {}, stdout: { write() {} }, stderr: { write() {} } }
  });
  const menuItem = label => tray.menu.find(item => item.label === label);
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(tray); assert.equal(checks, 1); assert.equal(downloads, 0);
    assert.equal(menuItem('Update herunterladen').enabled, true);
    await menuItem('Updates prüfen').click(); assert.equal(checks, 2); assert.equal(downloads, 0);
    const first = menuItem('Update herunterladen').click();
    assert.equal(first, menuItem('Update herunterladen').click()); await first;
    assert.equal(downloads, 1); assert.equal(menuItem('Update herunterladen').enabled, true);
    failDownload = false; await menuItem('Update herunterladen').click(); assert.equal(downloads, 2);
    assert.equal(menuItem('Update herunterladen'), undefined);
    assert.ok(menuItem('Update installieren und neu starten'));
    menuItem('Update installieren und neu starten').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['desktop', 'saved', 'tray', 'install']);
  } finally { controller?.close(); }
});
