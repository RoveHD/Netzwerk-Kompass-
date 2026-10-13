const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { HELP_URL, HELP_CHANNEL, configuration, isAppNavigation, isAppResource, isExportDownload, isHelpUrl, controlPipePath, attachLauncher } = require('./policy.cjs');
const { GET_CHANNEL, SET_CHANNEL, CAPTURE_CHANNEL, MARK_EVENT, SELECT_EVENT, STATUS_EVENT, createLagHotkey } = require('./lag-hotkey.cjs');
const backgroundApi = require('./background.cjs');

function configurePersistence(desktopDir) {
  app.setName('Netzwerk-Kompass');
  for (const [name, folder] of Object.entries({ userData: 'profile', sessionData: 'session', logs: 'logs', crashDumps: 'crashes' })) {
    const location = path.join(desktopDir, folder);
    fs.mkdirSync(location, { recursive: true });
    app.setPath(name, location);
  }
  app.commandLine.appendSwitch('disk-cache-dir', path.join(desktopDir, 'session', 'Cache'));
}

function startDesktop({ managed = false, persistenceConfigured = false, backgroundMonitoring = null, onShutdown = () => app.quit(), onFatal = error => app.exit(1), onReady = () => {} } = {}) {
let window = null;
let stopping = false;
let failed = false;
let ready = false;
let control = null;
let controlConnected = false;
let detachLauncher = () => {};
let lagHotkey = null;
let background = backgroundMonitoring;
let desktopConfig = null;

function fail(error) {
  if (stopping || failed) return;
  failed = true;
  lagHotkey?.close();
  if (managed) { onFatal(error); return; }
  const message = `DESKTOP_ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`;
  process.stderr.write(message);
  detachLauncher();
  if (controlConnected && !control.destroyed) control.write(message, () => app.exit(1));
  else app.exit(1);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  background?.stop();
  if (managed) onShutdown();
  else app.quit();
}

function showWindow() {
  if (!window || window.isDestroyed() || stopping) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  background?.onShow();
}

app.on('before-quit', () => { stopping = true; background?.stop(); detachLauncher(); lagHotkey?.close(); });
app.on('window-all-closed', shutdown);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);

try {
  const config = configuration();
  desktopConfig = config;
  if (!background) background = backgroundApi.createBackgroundMonitoring({ desktopDir: config.desktopDir,
    available: !managed && Boolean(process.env.NETZWERK_KOMPASS_CONTROL_PIPE),
    restartSupported: !managed && process.env.NETZWERK_KOMPASS_BACKGROUND_RESTART === '1',
    runtimeStatus: () => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(config.desktopDir, 'background-runtime.json'), 'utf8'));
        if (['starting', 'running', 'restarting', 'failed'].includes(value.state) && Number.isInteger(value.restarts) && value.restarts >= 0 && value.restarts <= 3) {
          const timestamp = item => typeof item === 'string' && item.length <= 40 && Number.isFinite(Date.parse(item)) ? item : null;
          return { running: value.running === true, state: value.state, restarts: value.restarts, maxRestarts: 3,
            lastGap: value.lastGap && timestamp(value.lastGap.startedAt) ? {
              startedAt: timestamp(value.lastGap.startedAt), resumedAt: timestamp(value.lastGap.resumedAt), reason: 'node_exit'
            } : null };
        }
      } catch {}
      return { running: ready && !stopping, state: ready ? 'running' : 'starting' };
    } });
  // Set every Chromium persistence path before Electron creates a session.
  if (!persistenceConfigured) configurePersistence(config.desktopDir);
  // Windows GUI processes can lose redirected standard handles while attaching
  // a console. The packaged launcher supplies a private duplex named pipe.
  if (!managed && process.env.NETZWERK_KOMPASS_CONTROL_PIPE !== undefined) {
    control = net.createConnection(controlPipePath(process.env.NETZWERK_KOMPASS_CONTROL_PIPE));
    control.once('connect', () => { controlConnected = true; });
    control.on('error', fail);
    detachLauncher = attachLauncher(control, { show: showWindow, shutdown });
  } else if (!managed) {
    detachLauncher = attachLauncher(process.stdin, { show: showWindow, shutdown });
  }

  app.whenReady().then(async () => {
    if (stopping) return;
    lagHotkey = createLagHotkey({
      filePath: path.join(config.desktopDir, 'lag-hotkey.json'),
      onSelected: accelerator => { if (!stopping && window && !window.isDestroyed()) window.webContents.send(SELECT_EVENT, accelerator); },
      onStatus: status => { if (!stopping && window && !window.isDestroyed()) window.webContents.send(STATUS_EVENT, status); },
      onMark: () => {
        if (stopping || !ready || !window || window.isDestroyed()) return;
        const contents = window.webContents;
        if (!contents.isDestroyed() && !contents.isLoadingMainFrame() && isAppNavigation(contents.mainFrame.url, config.origin)) contents.send(MARK_EVENT);
      }
    });
    await lagHotkey.initialize();
    if (stopping) return;
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
      width: 1280, height: 900, title: 'Netzwerk-Kompass',
      icon: path.join(__dirname, '..', 'public', 'brand', 'compass.ico'),
      show: !process.argv.includes('--hidden-window'),
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        webSecurity: true, devTools: false, webviewTag: false,
        preload: path.join(__dirname, 'preload.cjs'),
        backgroundThrottling: !background.enabled
      }
    });
    window.removeMenu();
    const contents = window.webContents;
    const session = contents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      const allowed = isAppResource(details.url, config.origin) ||
        // Blob exports stay local; data images are allowed by the existing CSP.
        details.url.startsWith(`blob:${config.origin}/`) ||
        (details.resourceType === 'image' && details.url.startsWith('data:'));
      callback({ cancel: !allowed });
    });
    session.on('will-download', (event, item, source) => {
      if (source !== contents || !isExportDownload(item.getURL(), config.origin, item.getMimeType(), item.getFilename())) {
        event.preventDefault();
        return;
      }
      // Keep Chromium's native save dialog: never choose a save path silently.
      item.setSaveDialogOptions({ title: 'Diagnosebericht speichern', defaultPath: item.getFilename(), filters: [{ name: 'JSON-Bericht', extensions: ['json'] }] });
    });
    const guardNavigation = (event, legacyUrl) => {
      if (!isAppNavigation(event.url || legacyUrl, config.origin)) event.preventDefault();
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-frame-navigate', event => {
      if (!event.isMainFrame || !isAppNavigation(event.url, config.origin)) event.preventDefault();
    });
    contents.on('will-redirect', guardNavigation);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.on('page-title-updated', event => event.preventDefault());
    // devTools:false prevents developer tools while letting the hotkey editor
    // receive function keys and combinations such as Control+Shift+I.
    contents.on('render-process-gone', (_event, details) => fail(new Error(`Fensterprozess beendet: ${details.reason}`)));
    contents.on('preload-error', (_event, _file, error) => fail(error));
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && (code !== -3 || !ready)) fail(new Error(`App konnte nicht geladen werden: ${description} (${code})`));
    });
    contents.on('did-finish-load', () => {
      if (!stopping && !failed) {
        ready = true;
        process.stdout.write('DESKTOP_READY\n');
        onReady();
        if (control && !control.destroyed) control.write('DESKTOP_READY\n');
      }
    });
    ipcMain.on(HELP_CHANNEL, (event, destination) => {
      if (stopping || !window || window.isDestroyed() || event.sender !== contents || event.senderFrame !== contents.mainFrame ||
        !isAppNavigation(event.senderFrame.url, config.origin) || !isHelpUrl(destination)) return;
      shell.openExternal(HELP_URL).catch(error => process.stderr.write(`Hilfelink konnte nicht geöffnet werden: ${error.message}\n`));
    });
    const trustedMainFrame = event => !stopping && window && !window.isDestroyed() && event.sender === contents &&
      event.senderFrame === contents.mainFrame && isAppNavigation(event.senderFrame.url, config.origin);
    const sendBackgroundStatus = () => {
      if (trustedMainFrame({ sender: contents, senderFrame: contents.mainFrame })) contents.send(backgroundApi.STATUS_EVENT, background.status());
    };
    window.on('show', sendBackgroundStatus);
    window.on('hide', sendBackgroundStatus);
    ipcMain.handle(backgroundApi.GET_CHANNEL, event => trustedMainFrame(event) ? background.status() : { available: false, error: 'Anfrage nicht erlaubt.' });
    ipcMain.handle(backgroundApi.SET_CHANNEL, async (event, value) => {
      if (!trustedMainFrame(event)) return { available: false, error: 'Anfrage nicht erlaubt.' };
      const result = await background.set(value);
      if (!stopping && !contents.isDestroyed()) contents.setBackgroundThrottling(!result.enabled);
      return result;
    });
    ipcMain.handle(backgroundApi.QUIT_CHANNEL, event => { if (trustedMainFrame(event)) shutdown(); });
    ipcMain.handle(GET_CHANNEL, event => trustedMainFrame(event) ? lagHotkey.get() : { accelerator: '', registered: false, error: 'Anfrage nicht erlaubt.' });
    ipcMain.handle(SET_CHANNEL, (event, accelerator) => {
      if (!trustedMainFrame(event)) return { accelerator: '', registered: false, error: 'Anfrage nicht erlaubt.' };
      return lagHotkey.set(accelerator);
    });
    ipcMain.handle(CAPTURE_CHANNEL, (event, active) => {
      if (!trustedMainFrame(event)) return { capturing: false, error: 'Anfrage nicht erlaubt.' };
      return lagHotkey.capture(active);
    });
    window.on('close', event => {
      if (stopping) return;
      if (background.onClose(event, window)) { sendBackgroundStatus(); return; }
      if (managed) { event.preventDefault(); shutdown(); }
    });
    window.on('query-session-end', () => { background.stop(); if (managed) onShutdown(true); else shutdown(); });
    window.on('closed', () => { window = null; shutdown(); });
    await window.loadURL(config.startUrl);
  }).catch(fail);
} catch (error) { fail(error); }

  return {
    show: showWindow,
    stop() { stopping = true; background?.stop(); detachLauncher(); lagHotkey?.close(); },
    notifyBackground() {
      if (window && !window.isDestroyed() && ready) window.webContents.send(backgroundApi.STATUS_EVENT, background.status());
    },
    async reconnect(url) {
      if (stopping || !window || window.isDestroyed()) return;
      const config = configuration({ ...process.env, NETZWERK_KOMPASS_URL: url });
      Object.assign(desktopConfig, config);
      ready = false;
      await window.loadURL(config.startUrl);
    },
    get window() { return window; }
  };
}

module.exports = { startDesktop, configurePersistence };
// Electron's default_app imports a CLI script, so require.main is not set.
// A packaged installed.cjs import must not start a second desktop window.
const directElectronScript = process.defaultApp === true && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (require.main === module || directElectronScript) startDesktop();
