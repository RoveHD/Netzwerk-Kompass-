const FEED = Object.freeze({ provider: 'github', owner: 'RoveHD', repo: 'Netzwerk-Kompass-', private: false });

function createBackgroundUpdater({ updater, isPackaged, installed, platform = process.platform, intervalMs = 4 * 60 * 60 * 1000,
  log = () => {}, onStatus = () => {} }) {
  const enabled = Boolean(isPackaged && installed && platform === 'win32');
  let closed = false, checking = null, interval = null, status = 'idle', downloaded = false, startup = null;
  function setStatus(value) {
    if (closed) return;
    status = value;
    onStatus({ status, downloaded });
  }
  const fail = error => { log(`Update: ${error?.message || error}`); status = 'error'; setStatus('error'); startup?.finish(false); };
  if (enabled) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.setFeedURL({ ...FEED });
    // Keep tokens out of the provider and retain the installer's SHA-512 checks.
    updater.logger = { info: log, warn: log, error: log, debug: () => {} };
    for (const [name, callback] of [
      ['checking-for-update', () => setStatus('checking')],
      ['update-available', () => setStatus('downloading')],
      ['download-progress', () => setStatus('downloading')],
      ['update-not-available', () => { setStatus('current'); startup?.finish(false); }],
      ['update-downloaded', () => { downloaded = true; setStatus('ready'); startup?.finish(true); }],
      ['error', fail]
    ]) {
      updater.on(name, callback);
    }
  }
  async function check() {
    if (!enabled || closed || downloaded) return null;
    if (checking) return checking;
    checking = Promise.resolve().then(() => updater.checkForUpdates()).catch(error => { fail(error); return null; }).finally(() => { checking = null; });
    return checking;
  }
  function schedule() {
    if (!enabled || closed || interval) return;
    interval = setInterval(check, intervalMs);
    interval.unref?.();
  }
  function checkBeforeStart(deadlineMs = 5000) {
    if (!enabled || closed) return Promise.resolve(false);
    if (startup) return startup.promise;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    let finished = false;
    const timer = setTimeout(() => startup.finish(false), deadlineMs);
    startup = { promise, finish(ready) { if (finished) return; finished = true; clearTimeout(timer); resolve(ready); } };
    schedule();
    check();
    return promise;
  }
  function close(skipInstall = false) {
    if (skipInstall && enabled) updater.autoInstallOnAppQuit = false;
    if (closed) return;
    startup?.finish(false);
    closed = true;
    clearInterval(interval);
    // A download may finish during the server's durable flush. Keep listeners
    // until process exit so a late updater error cannot become unhandled.
  }
  return {
    enabled, check, checkBeforeStart, close,
    get downloaded() { return downloaded; },
    get status() { return status; },
    installAndRestart() {
      if (!enabled || !downloaded) return false;
      // BaseUpdater emits an error synchronously if the cached installer cannot
      // be started. Continue the current app instead of stranding startup.
      status = 'ready';
      try { updater.quitAndInstall(true, true); } catch (error) { fail(error); return false; }
      return status !== 'error';
    }
  };
}

module.exports = { FEED, createBackgroundUpdater };
