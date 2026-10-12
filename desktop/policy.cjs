const path = require('node:path');
const { createInterface } = require('node:readline');

const HELP_URL = 'https://learn.chatgpt.com/docs/codex-cli';
const HELP_CHANNEL = 'netzwerk-kompass:open-help';

function parseUrl(value) {
  try { return new URL(value); } catch { return null; }
}

function configuration(env = process.env) {
  const address = env.NETZWERK_KOMPASS_URL;
  // Reject alternate loopback spellings, credentials and URL normalization tricks.
  if (typeof address !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/?$/.test(address)) {
    throw new Error('Die Desktop-Adresse muss die lokale App auf 127.0.0.1 sein.');
  }
  const url = parseUrl(address);
  if (!url || !url.port) throw new Error('Ungültiger lokaler App-Port.');
  const dataDir = env.NETZWERK_KOMPASS_DATA_DIR;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new Error('Der portable Datenordner muss ein absoluter Pfad sein.');
  }
  return { startUrl: url.href, origin: url.origin, desktopDir: path.join(path.resolve(dataDir), '.desktop') };
}

function isAppNavigation(value, origin) {
  const url = parseUrl(value);
  return Boolean(url && url.origin === origin && !url.username && !url.password &&
    (url.pathname === '/' || url.pathname === '/index.html') && !url.search);
}

function isAppResource(value, origin) {
  const url = parseUrl(value);
  return Boolean(url && url.origin === origin && url.protocol === 'http:' && !url.username && !url.password);
}

function isExportDownload(value, origin, mime, filename) {
  const prefix = `blob:${origin}/`;
  return typeof value === 'string' && value.startsWith(prefix) &&
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value.slice(prefix.length)) &&
    mime === 'application/json' && /^netzwerk-kompass-\d{4}-\d{2}-\d{2}\.json$/.test(filename);
}

function isHelpUrl(value) { return value === HELP_URL; }

function controlPipePath(name) {
  if (typeof name !== 'string' || !/^netzwerk-kompass-desktop-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(name)) {
    throw new Error('Ungültiger Desktop-Steuerkanal.');
  }
  return `\\\\.\\pipe\\${name}`;
}

// The launcher owns the lifetime; a lost pipe is also a shutdown request.
function attachLauncher(input, { show, shutdown }) {
  const lines = createInterface({ input, terminal: false });
  let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; shutdown(); } };
  lines.on('line', line => {
    if (stopped) return;
    if (line === 'show') show();
    else if (line === 'shutdown') stop();
  });
  lines.once('close', stop);
  lines.on('error', stop);
  input.once('error', stop);
  return () => { stopped = true; input.removeListener('error', stop); lines.close(); };
}

module.exports = { HELP_URL, HELP_CHANNEL, configuration, isAppNavigation, isAppResource, isExportDownload, isHelpUrl, controlPipePath, attachLauncher };
