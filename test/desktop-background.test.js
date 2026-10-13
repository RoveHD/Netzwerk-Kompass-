import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import * as background from '../desktop/background.cjs';
import policy from '../desktop/policy.cjs';

test('actual desktop lifecycle guards background IPC, keeps hidden renderer hotkey route, quits explicitly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-background-'));
  let window, hotkey, resourceGuard, quits = 0;
  const messages = [], handles = new Map(), app = new EventEmitter();
  Object.assign(app, { whenReady: async () => {}, quit: () => quits++, exit: code => assert.fail(`Unexpected exit ${code}`) });
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super(); window = this; this.options = options; this.visible = true;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: 'http://127.0.0.1:44001/' },
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, webRequest: { onBeforeRequest(_filter, callback) { resourceGuard = callback; } }, on() {} },
        isDestroyed: () => false, isLoadingMainFrame: () => false, setWindowOpenHandler() {},
        send: (...args) => messages.push(args), setBackgroundThrottling: value => { this.throttling = value; }
      });
    }
    isDestroyed() { return false; } isMinimized() { return false; } removeMenu() {} focus() {}
    show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; this.emit('hide'); }
    async loadURL(url) { this.webContents.mainFrame.url = url; this.webContents.emit('did-finish-load'); }
  }
  const hotkeyModule = { GET_CHANNEL: 'hotkey:get', SET_CHANNEL: 'hotkey:set', CAPTURE_CHANNEL: 'hotkey:capture', MARK_EVENT: 'hotkey:mark', SELECT_EVENT: 'hotkey:select', STATUS_EVENT: 'hotkey:status',
    createLagHotkey: options => { hotkey = options; return { initialize: async () => {}, close() {}, get() {}, set() {}, capture() {} }; } };
  const backgroundMonitoring = background.createBackgroundMonitoring({ desktopDir: directory, restartSupported: true });
  const modules = { electron: { app, BrowserWindow, Menu: { setApplicationMenu() {} }, ipcMain: { on() {}, handle: (name, callback) => handles.set(name, callback) }, shell: {} },
    'node:fs': {}, 'node:path': path, 'node:net': {}, './policy.cjs': { ...policy, configuration: env => policy.configuration(env || { NETZWERK_KOMPASS_URL: 'http://127.0.0.1:44001', NETZWERK_KOMPASS_DATA_DIR: directory }) },
    './lag-hotkey.cjs': hotkeyModule, './background.cjs': background };
  const sandbox = { require: name => { assert.ok(modules[name], name); return modules[name]; }, module: { exports: {} }, __dirname: path.resolve('desktop'),
    process: { argv: [], env: { NETZWERK_KOMPASS_DATA_DIR: directory }, on() {}, stdout: { write() {} }, stderr: { write() {} } } };
  try {
    runInNewContext(readFileSync(new URL('../desktop/main.cjs', import.meta.url), 'utf8'), sandbox);
    const controller = sandbox.module.exports.startDesktop({ managed: true, persistenceConfigured: true, backgroundMonitoring, onShutdown: () => quits++, onFatal: error => assert.fail(error.message) });
    await new Promise(resolve => setImmediate(resolve));
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    assert.equal((await handles.get(background.GET_CHANNEL)({ sender: {}, senderFrame: {} })).available, false);
    await handles.get(background.SET_CHANNEL)({ sender: {}, senderFrame: {} }, true); assert.equal(backgroundMonitoring.enabled, false);
    await handles.get(background.SET_CHANNEL)(event, true); assert.equal(window.throttling, false);
    let prevented = false; window.emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(window.visible, false); assert.equal(quits, 0);
    hotkey.onMark(); assert.ok(messages.some(args => args[0] === 'hotkey:mark'));
    await controller.reconnect('http://127.0.0.1:44002');
    assert.equal(window.visible, false); assert.equal(window.webContents.mainFrame.url, 'http://127.0.0.1:44002/');
    assert.equal(handles.get(background.GET_CHANNEL)(event).enabled, true);
    resourceGuard({ url: 'http://127.0.0.1:44001/api/state' }, value => assert.equal(value.cancel, true));
    resourceGuard({ url: 'http://127.0.0.1:44002/api/state' }, value => assert.equal(value.cancel, false));
    controller.show(); assert.equal(window.visible, true); assert.equal(backgroundMonitoring.status().hidden, false);
    await handles.get(background.QUIT_CHANNEL)(event); assert.equal(quits, 1);
    hotkey.onMark(); assert.equal(messages.filter(args => args[0] === 'hotkey:mark').length, 1);
    window.emit('close', { preventDefault() { assert.fail('Quit must not hide'); } });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
