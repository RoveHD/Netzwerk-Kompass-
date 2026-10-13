const FEED = Object.freeze({ provider: 'github', owner: 'RoveHD', repo: 'Netzwerk-Kompass-', private: false });

function createBackgroundUpdater({ updater, isPackaged, installed, platform = process.platform, intervalMs = 4 * 60 * 60 * 1000,
  log = () => {}, onStatus = () => {} }) {
  const enabled = Boolean(isPackaged && installed && platform === 'win32');
  let closed = false, checking = null, downloading = null, cancellationToken = null, interval = null;
  let status = 'idle', available = false, downloaded = false, startup = null, checkResult = null;
  function setStatus(value) {
    if (closed) return;
    status = value;
    onStatus({ status, available, downloaded });
  }
  const fail = error => { log(`Update: ${error?.message || error}`); status = 'error'; setStatus('error'); startup?.finish(false); };
  if (enabled) {
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.autoRunAppAfterInstall = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.setFeedURL({ ...FEED });
    // Keep tokens out of the provider and retain the installer's SHA-512 checks.
    updater.logger = { info: log, warn: log, error: log, debug: () => {} };
    for (const [name, callback] of [
      ['checking-for-update', () => { if (!closed) { available = false; setStatus('checking'); } }],
      ['update-available', () => { if (!closed) { available = true; setStatus('available'); startup?.finish(false); } }],
      ['download-progress', () => { if (!downloaded) setStatus('downloading'); }],
      ['update-not-available', () => { if (!closed) { available = false; setStatus('current'); startup?.finish(false); } }],
      ['update-downloaded', () => { available = false; downloaded = true; setStatus('ready'); startup?.finish(true); }],
      ['error', fail]
    ]) {
      updater.on(name, callback);
    }
  }
  async function check() {
    if (!enabled || closed || downloaded || downloading) return null;
    if (checking) return checking;
    checking = Promise.resolve().then(() => {
      if (closed) return null;
      available = false;
      checkResult = null;
      return updater.checkForUpdates();
    }).then(result => { checkResult = result; return result; }).catch(error => { available = false; fail(error); return null; }).finally(() => { checking = null; setStatus(status); });
    return checking;
  }
  function download() {
    if (!enabled || closed || downloaded) return Promise.resolve(false);
    if (downloading) return downloading;
    if (!available) return Promise.resolve(false);
    // update-available fires before checkForUpdates resolves. Wait for its
    // provider/token before downloading, and keep checks away from that provider.
    const pendingCheck = checking;
    downloading = Promise.resolve().then(async () => {
      if (pendingCheck) await pendingCheck;
      if (closed || !available || downloaded) return false;
      cancellationToken = checkResult?.cancellationToken;
      setStatus('downloading');
      await updater.downloadUpdate(cancellationToken);
      return downloaded;
    }).catch(error => { fail(error); return false; }).finally(() => { downloading = null; cancellationToken = null; setStatus(status); });
    return downloading;
  }
  function schedule() {
    if (!enabled || closed || interval) return;
    interval = setInterval(check, intervalMs);
    interval.unref?.();
  }
  function checkBeforeStart(deadlineMs = 5000) {
    if (!enabled || closed) return Promise.resolve(false);
    if (downloaded) return Promise.resolve(true);
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
    cancellationToken?.cancel();
    // A download may finish during the server's durable flush. Keep listeners
    // until process exit so a late updater error cannot become unhandled.
  }
  return {
    enabled, check, download, checkBeforeStart, close,
    get available() { return available; },
    get busy() { return Boolean(checking || downloading); },
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
