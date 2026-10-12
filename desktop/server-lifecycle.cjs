const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function serverEnvironment({ dataDir, exePath, env = process.env, noAutostart = false }) {
  if (!path.isAbsolute(dataDir) || !path.isAbsolute(exePath)) throw new Error('Laufzeitpfade müssen absolut sein.');
  const result = { ...env };
  // A bundled Node runtime must not load caller-provided modules or debugger flags.
  for (const key of Object.keys(result)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NETZWERK_KOMPASS_URL|NETZWERK_KOMPASS_CONTROL_PIPE)$/i.test(key)) delete result[key];
  }
  result.NETZWERK_KOMPASS_DATA_DIR = dataDir;
  result.NETZWERK_KOMPASS_EXE_PATH = exePath;
  if (noAutostart) result.NETZWERK_KOMPASS_NO_AUTOSTART_REGISTRATION = '1';
  return result;
}

function createServerLifecycle({ appDir, nodePath, dataDir, exePath, env, noAutostart, spawnProcess = spawn,
  startupTimeoutMs = 60000, shutdownTimeoutMs = 13000, killTimeoutMs = 5000, onUnexpectedExit = () => {}, log = () => {} }) {
  let child = null, closed = false, stopping = false, startPromise = null, stopPromise = null, closePromise;
  let closeResult;
  function start() {
    if (startPromise) return startPromise;
    startPromise = new Promise((resolve, reject) => {
      let settled = false, lines;
      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(url);
      };
      const timer = setTimeout(() => finish(new Error('Der lokale Server hat nicht rechtzeitig gestartet.')), startupTimeoutMs);
      try {
        child = spawnProcess(nodePath, [path.join(appDir, 'server.js'), '--launcher', '--no-browser'], {
          cwd: appDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
          env: serverEnvironment({ dataDir, exePath, env, noAutostart })
        });
        closePromise = new Promise(closeResolve => {
          child.once('close', (code, signal) => {
            closed = true;
            closeResult = { code, signal };
            lines?.close();
            closeResolve(closeResult);
            const error = new Error(`Der lokale Server wurde beendet (${code ?? signal ?? 'unbekannt'}).`);
            if (!settled) finish(error);
            else if (!stopping) onUnexpectedExit(error, closeResult);
          });
        });
        child.once('error', error => finish(error));
        // Broken pipes during shutdown are normal; never leave an unhandled stream error.
        child.stdin.on('error', error => { if (!stopping) { log(error.message); finish(error); } });
        lines = createInterface({ input: child.stdout, terminal: false });
        lines.on('line', line => {
          if (/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(line)) {
            try { const url = new URL(line); if (url.port) finish(null, url.origin); } catch {}
          }
          log(line);
        });
        // readline bounds normal records; discard a runaway record rather than retaining it.
        let outputBytes = 0;
        child.stdout.on('data', chunk => {
          outputBytes += chunk.length;
          if (!settled && outputBytes > 1024 * 1024) finish(new Error('Ungültige Startausgabe des lokalen Servers.'));
        });
        child.stderr.on('data', chunk => log(String(chunk).slice(0, 8192)));
      } catch (error) { finish(error); }
    });
    return startPromise;
  }
  function stop(windowsShutdown = false) {
    if (stopPromise) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const requireCleanExit = result => {
        if (result && (result.code !== 0 || result.signal)) throw new Error(`Der lokale Server wurde nicht sauber beendet (${result.code ?? result.signal ?? 'unbekannt'}); Updateinstallation bleibt aus.`);
        return result;
      };
      if (!child || closed) return requireCleanExit(closeResult);
      try { child.stdin.end(windowsShutdown ? 'shutdown:windows_shutdown\n' : 'shutdown\n'); } catch {}
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), shutdownTimeoutMs); });
      const result = await Promise.race([closePromise, timeout]);
      clearTimeout(timer);
      if (result) return requireCleanExit(result);
      log('Der lokale Server reagiert nicht auf Beenden; Prozess wird beendet.');
      try { child.kill(); } catch {}
      const killTimeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Der lokale Server konnte nicht beendet werden.')), killTimeoutMs); });
      try {
        await Promise.race([closePromise, killTimeout]);
        throw new Error('Der lokale Server musste erzwungen beendet werden; Updateinstallation bleibt aus.');
      } finally { clearTimeout(timer); }
    })();
    return stopPromise;
  }
  return { start, stop, get running() { return Boolean(child && !closed); } };
}

// Both regular app.quit and an explicit update restart use this same barrier.
function createQuitCoordinator({ stopServer, closeDesktop = () => {}, stopUpdater = () => {}, quit, installUpdate, log = () => {} }) {
  let pending = null;
  return function requestQuit({ update = false, windowsShutdown = false } = {}) {
    if (pending) return pending;
    pending = (async () => {
      stopUpdater(windowsShutdown);
      closeDesktop();
      await stopServer(windowsShutdown);
      if (update && !windowsShutdown) installUpdate();
      else quit();
    })().catch(error => { log(error.message); throw error; });
    return pending;
  };
}

module.exports = { serverEnvironment, createServerLifecycle, createQuitCoordinator };
