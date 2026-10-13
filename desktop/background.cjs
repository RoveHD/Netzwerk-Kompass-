const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const GET_CHANNEL = 'netzwerk-kompass:background:get';
const SET_CHANNEL = 'netzwerk-kompass:background:set';
const QUIT_CHANNEL = 'netzwerk-kompass:background:quit';
const STATUS_EVENT = 'netzwerk-kompass:background:status';

function createBackgroundMonitoring({ desktopDir, available = true, restartSupported = false, runtimeStatus = () => ({}), onStatus = () => {} }) {
  const file = path.join(desktopDir, 'background.json');
  let enabled = false, hidden = false, error = '', stopped = false, pending = Promise.resolve();
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof value.enabled !== 'boolean') throw new Error('Ungültige Einstellung.');
    enabled = available && value.enabled;
  } catch (cause) { if (cause.code !== 'ENOENT') error = 'Hintergrundeinstellung konnte nicht gelesen werden.'; }
  const status = () => ({ available, enabled, hidden, restartSupported, ...runtimeStatus(), error });
  function notify() { onStatus(status()); }
  return {
    status,
    notify,
    get enabled() { return enabled; },
    set(value) {
      if (typeof value !== 'boolean') return Promise.reject(new TypeError('Hintergrundmodus muss als Ja/Nein gesetzt werden.'));
      const result = pending.then(async () => {
        if (stopped || !available) throw new Error('Hintergrundmodus ist nicht verfügbar.');
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.promises.mkdir(desktopDir, { recursive: true });
          await fs.promises.writeFile(temporary, `${JSON.stringify({ enabled: value })}\n`, { flag: 'wx' });
          await fs.promises.rename(temporary, file);
          enabled = value; error = ''; notify(); return status();
        } catch (cause) { error = 'Hintergrundeinstellung konnte nicht gespeichert werden.'; notify(); throw cause; }
        finally { await fs.promises.unlink(temporary).catch(() => {}); }
      });
      pending = result.catch(() => {}); return result;
    },
    onClose(event, window) {
      if (stopped || !enabled || !available) return false;
      event.preventDefault(); window.hide(); hidden = true; notify(); return true;
    },
    onShow() { hidden = false; notify(); },
    stop() { stopped = true; }
  };
}
module.exports = { GET_CHANNEL, SET_CHANNEL, QUIT_CHANNEL, STATUS_EVENT, createBackgroundMonitoring };
