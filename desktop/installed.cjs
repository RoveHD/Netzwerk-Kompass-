const { app, Tray, Menu, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startDesktop, configurePersistence } = require('./main.cjs');
const { createServerLifecycle, createQuitCoordinator } = require('./server-lifecycle.cjs');
const { createBackgroundUpdater } = require('./updater.cjs');

let desktop, server, updater, tray, mayQuit = false, quitting = false, fatal = false;
let exitCode = 0;
const diagnostics = process.argv.includes('--diagnostics');
const isolated = process.argv.includes('--no-autostart-registration') || process.argv.includes('--hidden-window');
const requestedData = process.env.NETZWERK_KOMPASS_DATA_DIR;
const dataDir = requestedData ? path.resolve(requestedData) : path.join(app.getPath('appData'), 'Netzwerk-Kompass');
if (requestedData && !path.isAbsolute(requestedData)) throw new Error('Der Datenordner muss ein absoluter Pfad sein.');
const desktopDir = path.join(dataDir, '.desktop');
fs.mkdirSync(desktopDir, { recursive: true });
configurePersistence(desktopDir);
const logFile = path.join(desktopDir, 'installed.log');
// A bounded log contains runtime messages, never credentials or packet contents.
try { if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.renameSync(logFile, `${logFile}.previous`); } catch {}
function log(message) {
  const text = String(message).slice(0, 8192).replace(/[\r\n]+/g, ' ');
  try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${text}\n`); } catch {}
  if (diagnostics) process.stdout.write(`INSTALLED ${text}\n`);
}
const requestQuit = createQuitCoordinator({
  stopServer: windowsShutdown => server ? server.stop(windowsShutdown) : Promise.resolve(),
  closeDesktop: () => desktop?.stop(), stopUpdater: windowsShutdown => updater?.close(windowsShutdown), log,
  quit: () => { mayQuit = true; tray?.destroy(); if (exitCode) app.exit(exitCode); else app.quit(); },
  installUpdate: () => { mayQuit = true; tray?.destroy(); if (!updater.installAndRestart()) app.quit(); }
});
function quit(options) { quitting = true; requestQuit(options).catch(error => { log(error.message); app.exit(1); }); }
function fail(error) {
  if (fatal || mayQuit || quitting) return;
  fatal = true; exitCode = 1;
  log(`DESKTOP_ERROR ${error?.message || error}`);
  process.stderr.write(`DESKTOP_ERROR ${String(error?.message || error).replace(/[\r\n]+/g, ' ')}\n`);
  if (!isolated) dialog.showErrorBox('Netzwerk-Kompass', String(error?.message || error));
  quit();
}
function updateMenu() {
  if (!tray || tray.isDestroyed()) return;
  const labels = { idle: 'Updates', checking: 'Updates werden geprüft', downloading: 'Update wird geladen', current: 'App ist aktuell', ready: 'Update bereit', error: 'Updateprüfung nicht verfügbar' };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Netzwerk-Kompass öffnen', click: () => desktop?.show() },
    { type: 'separator' },
    { label: labels[updater?.status || 'idle'], enabled: false },
    { label: 'Updates prüfen', enabled: Boolean(updater?.enabled && !updater.downloaded), click: () => updater?.check() },
    ...(updater?.downloaded ? [{ label: 'Update installieren und neu starten', click: () => quit({ update: true }) }] : []),
    { type: 'separator' },
    { label: 'Beenden', click: () => quit() }
  ]));
}
app.on('before-quit', event => {
  if (mayQuit) return;
  event.preventDefault();
  quit();
});
app.on('second-instance', () => desktop?.show());
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
// Electron locks are scoped to userData, so isolated smoke tests do not touch a running user's app.
if (!app.requestSingleInstanceLock()) { mayQuit = true; app.quit(); }
else app.whenReady().then(async () => {
  const appDir = path.join(__dirname, '..');
  const { autoUpdater } = require('electron-updater');
  updater = createBackgroundUpdater({ updater: autoUpdater, isPackaged: app.isPackaged, installed: !isolated,
    log, onStatus: updateMenu });
  // Only startup can restart automatically: no monitor or live measurement exists yet.
  const readyUpdate = await updater.checkBeforeStart();
  if (fatal || mayQuit || quitting) return;
  if (readyUpdate && updater.installAndRestart()) { mayQuit = true; return; }
  server = createServerLifecycle({ appDir, nodePath: path.join(process.resourcesPath, 'runtime', 'node.exe'),
    dataDir, exePath: process.execPath, noAutostart: isolated, log,
    onUnexpectedExit: (error, result) => { if (result.code === 0) quit(); else fail(error); }
  });
  const url = await server.start();
  if (fatal || mayQuit || quitting) return;
  process.env.NETZWERK_KOMPASS_URL = url;
  process.env.NETZWERK_KOMPASS_DATA_DIR = dataDir;
  tray = new Tray(path.join(appDir, 'public', 'brand', 'compass.ico'));
  tray.setToolTip('Netzwerk-Kompass');
  tray.on('double-click', () => desktop?.show());
  updateMenu();
  desktop = startDesktop({ managed: true, persistenceConfigured: true, onShutdown: windowsShutdown => quit({ windowsShutdown }),
    onFatal: fail, onReady: () => log('DESKTOP_READY') });
}).catch(fail);
