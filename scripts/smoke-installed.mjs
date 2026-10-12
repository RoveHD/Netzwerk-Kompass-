import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const executable = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'win-unpacked', 'Netzwerk-Kompass.exe');
await mkdir(path.join(root, 'test-artifacts'), { recursive: true });
const location = await mkdtemp(path.join(root, 'test-artifacts', 'Installed ä '));
const dataDir = path.join(location, 'data');
const env = { ...process.env, NETZWERK_KOMPASS_DATA_DIR: dataDir, LOCALAPPDATA: path.join(location, 'local') };
// Electron itself consumes these before JS starts, so never inherit caller flags.
for (const key of Object.keys(env)) if (/^(ELECTRON_RUN_AS_NODE|NODE_OPTIONS|NODE_PATH)$/i.test(key)) delete env[key];
await mkdir(env.LOCALAPPDATA, { recursive: true });

async function start() {
  const child = spawn(executable, ['--hidden-window', '--no-autostart-registration', '--diagnostics'], {
    cwd: location, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env
  });
  let output = '', errors = '', url, windowReady = false;
  let timer;
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // Attach before readiness so early spawn failures never reject an unobserved promise.
  exited.catch(() => {});
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Installed startup timed out\n${output}\n${errors}`)), 70000);
      child.stderr.on('data', chunk => { errors += chunk; });
      child.stdout.on('data', chunk => {
        output += chunk;
        url = output.match(/^INSTALLED (http:\/\/127\.0\.0\.1:\d+)$/m)?.[1];
        windowReady = /^DESKTOP_READY$/m.test(output);
        if (url && windowReady) resolve();
      });
      exited.then(result => reject(new Error(`Installed exited before ready: ${JSON.stringify(result)}\n${output}\n${errors}`)), reject);
    });
    const html = await (await fetch(url)).text();
    const token = html.match(/name="api-token" content="([^"]+)/)?.[1];
    assert.ok(token);
    return { child, exited, url, windowReady, output, post: async (endpoint, body = {}) => {
      const response = await fetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Token': token }, body: JSON.stringify(body) });
      assert.ok(response.ok, `${endpoint}: ${response.status}`);
      return response.json();
    } };
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
}

async function stop(app) {
  await app.post('/api/shutdown');
  let timer;
  try {
    const result = await Promise.race([app.exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Installed app did not stop')), 20000); })]);
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    await assert.rejects(fetch(app.url));
  } finally { clearTimeout(timer); if (app.child.exitCode === null) app.child.kill(); }
}

let app;
try {
  app = await start();
  const state = await (await fetch(app.url + '/api/state')).json();
  assert.equal(state.version, version);
  assert.equal(state.persistence.enabled, true);
  const sessionId = state.persistence.currentSession.id;
  const startup = await (await fetch(app.url + '/api/startup')).json();
  assert.equal(startup.available, false, 'smoke never changes user autostart');
  assert.ok(state.network.interfaces.length > 0, 'bundled native helpers see Windows adapters');
  assert.doesNotMatch(app.output, /Checking for update|Update wird geladen/, 'isolated test never auto-installs a newer public release');
  await app.post('/api/targets', { host: '127.0.0.1', label: 'Installed persistence smoke' });
  const reset = await app.post('/api/reset');
  for (const asset of ['dashboard.css', 'live-signal.js', 'overview-details.js', 'fonts/geist-variable.woff2', 'fonts/geist-mono-variable.woff2']) {
    assert.equal((await fetch(`${app.url}/${asset}`)).status, 200, `installed asset: ${asset}`);
  }
  await stop(app); app = null;
  const settings = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.ok(settings.targets.some(target => target.host === '127.0.0.1'));
  assert.equal(settings.measurementStartedAt, reset.measurementStartedAt);
  app = await start();
  const restored = await (await fetch(app.url + '/api/state')).json();
  assert.ok(restored.targets.some(target => target.label === 'Installed persistence smoke'));
  assert.equal(restored.measurementStartedAt, reset.measurementStartedAt);
  const previous = restored.persistence.sessions.find(session => session.id === sessionId);
  assert.equal(previous.status, 'completed');
  assert.equal(previous.reason, 'normal');
  assert.ok(previous.lastPersistedAt && previous.endedAt);
  await stop(app); app = null;
  const result = { version, installedDesktop: true, desktopWindowLoaded: true, isolatedData: true, realAutostartUntouched: true,
    persistence: true, sessionRestart: true, cleanShutdown: true, bundledWindowsHelpers: true, assets: true, location };
  await writeFile(path.join(location, 'verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { if (app?.child.exitCode === null) app.child.kill(); }
