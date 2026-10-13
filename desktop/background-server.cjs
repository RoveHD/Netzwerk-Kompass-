const { createServerLifecycle } = require('./server-lifecycle.cjs');

// A replacement is created only after the previous child emits close. The
// restart budget is per application session and never resets after a success.
function createBackgroundServer({ createLifecycle = createServerLifecycle, shouldRestart = () => false,
  maxRestarts = 3, onStatus = () => {}, onRestart = async () => {}, onUnexpectedExit = () => {}, log = () => {}, ...options }) {
  let lifecycle = null, stopping = false, starting = null, stopPromise = null;
  let restarts = 0, state = 'starting', lastGap = null;
  const status = () => ({ running: Boolean(lifecycle?.running), state, restarts, maxRestarts, lastGap: lastGap ? { ...lastGap } : null });
  function notify() { onStatus(status()); }
  function unexpected(error, result) {
    if (stopping) return;
    if (!lastGap || lastGap.resumedAt) lastGap = { startedAt: new Date().toISOString(), resumedAt: null, reason: 'node_exit' };
    log(`MONITOR_GAP ${JSON.stringify(lastGap)} exit=${result.code ?? result.signal ?? 'unknown'}`);
    if (result.code === 0 || !shouldRestart() || restarts >= maxRestarts) {
      state = 'failed'; notify(); onUnexpectedExit(error, result); return;
    }
    state = 'restarting'; restarts++; notify();
    // Defer until the previous lifecycle's close callback has completed.
    let replacement = null;
    starting = Promise.resolve().then(async () => {
      if (stopping) return;
      replacement = makeLifecycle(); lifecycle = replacement;
      const url = await replacement.start();
      if (stopping || lifecycle !== replacement) return;
      await onRestart(url);
      if (stopping || lifecycle !== replacement) return;
      lastGap = { ...lastGap, resumedAt: new Date().toISOString() };
      log(`MONITOR_RESUMED ${JSON.stringify(lastGap)} restart=${restarts}`);
      state = 'running'; notify();
    }).catch(async cause => {
      if (lifecycle !== replacement) return;
      // A startup timeout may leave a child alive. Reap it before reporting
      // failure; never create another child while ownership is uncertain.
      if (replacement?.running) { try { await replacement.stop(); } catch {} }
      if (!stopping) { state = 'failed'; notify(); onUnexpectedExit(cause, { code: 1 }); }
    });
  }
  function makeLifecycle() { return createLifecycle({ ...options, log, onUnexpectedExit: unexpected }); }
  return {
    status,
    get running() { return Boolean(lifecycle?.running); },
    start() {
      if (!starting) {
        lifecycle = makeLifecycle();
        starting = lifecycle.start().then(url => { if (!stopping) { state = 'running'; notify(); } return url; });
      }
      return starting;
    },
    stop(windowsShutdown = false) {
      if (stopPromise) return stopPromise;
      stopping = true; state = 'stopping'; notify();
      stopPromise = (async () => {
        // stop synchronously fences the current lifecycle's exit callback.
        const result = lifecycle ? await lifecycle.stop(windowsShutdown) : undefined;
        state = 'stopped'; notify(); return result;
      })();
      return stopPromise;
    }
  };
}
module.exports = { createBackgroundServer };
