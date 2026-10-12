import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { createServerLifecycle, createQuitCoordinator, serverEnvironment } from '../desktop/server-lifecycle.cjs';

const absolute = name => path.resolve('isolated installed test', name);
function rig(extra = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.emit('close', null, 'SIGTERM'); return true; };
  let call; const unexpected = [];
  const lifecycle = createServerLifecycle({ appDir: absolute('app'), nodePath: absolute('runtime/node.exe'), dataDir: absolute('data'), exePath: absolute('Netzwerk-Kompass.exe'), noAutostart: true,
    spawnProcess: (...args) => { call = args; return child; }, onUnexpectedExit: error => unexpected.push(error), ...extra });
  return { child, lifecycle, unexpected, get call() { return call; } };
}

test('installed server uses the bundled runtime and strips injected runtime flags', async () => {
  const r = rig({ env: { NODE_OPTIONS: '--require secret.js', node_path: 'x', ELECTRON_RUN_AS_NODE: '1', NETZWERK_KOMPASS_CONTROL_PIPE: 'x', KEEP: 'yes' } });
  const started = r.lifecycle.start();
  r.child.stdout.write('http://localhost:44001\nhttp://127.0.0.1:65536\nhttp://127.0.0.1:44001\n');
  assert.equal(await started, 'http://127.0.0.1:44001');
  assert.equal(r.call[0], absolute('runtime/node.exe'));
  assert.deepEqual(r.call[1], [absolute('app/server.js'), '--launcher', '--no-browser']);
  const env = r.call[2].env;
  for (const key of ['NODE_OPTIONS', 'node_path', 'ELECTRON_RUN_AS_NODE', 'NETZWERK_KOMPASS_CONTROL_PIPE']) assert.equal(env[key], undefined);
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.NETZWERK_KOMPASS_NO_AUTOSTART_REGISTRATION, '1');
  assert.equal(env.NETZWERK_KOMPASS_DATA_DIR, absolute('data'));
  assert.throws(() => serverEnvironment({ dataDir: 'relative', exePath: absolute('exe') }), /absolut/);
  r.child.emit('close', 0);
});

test('installed server rejects spawn error and premature exit', async () => {
  const r = rig(); const started = r.lifecycle.start();
  r.child.emit('error', new Error('missing node')); r.child.emit('close', -1);
  await assert.rejects(started, /missing node/);
  const second = rig(); const pending = second.lifecycle.start();
  second.child.emit('close', 1);
  await assert.rejects(pending, /beendet/);
});

test('installed startup has a deadline and shutdown is shared and durable', async () => {
  const r = rig({ startupTimeoutMs: 5 });
  await assert.rejects(r.lifecycle.start(), /rechtzeitig/);
  let input = ''; r.child.stdin.on('data', chunk => { input += chunk; });
  let done = false; const stopping = r.lifecycle.stop(); const again = r.lifecycle.stop(true);
  stopping.then(() => { done = true; });
  assert.equal(stopping, again); assert.equal(input, 'shutdown\n');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  r.child.emit('close', 0);
  await stopping; assert.equal(done, true); assert.equal(r.unexpected.length, 0);
});

test('confirmed Windows shutdown is passed to the server, and hung servers are killed before exit', async () => {
  const r = rig({ shutdownTimeoutMs: 5 }); const started = r.lifecycle.start();
  r.child.stdout.write('http://127.0.0.1:44001\n'); await started;
  let input = ''; r.child.stdin.on('data', chunk => { input += chunk; });
  await assert.rejects(r.lifecycle.stop(true), /erzwungen/);
  assert.equal(input, 'shutdown:windows_shutdown\n'); assert.equal(r.lifecycle.running, false);
});

test('unexpected runtime exit is reported once', async () => {
  const r = rig(); const started = r.lifecycle.start(); r.child.stdout.write('http://127.0.0.1:44001\n'); await started;
  r.child.emit('close', 1); r.child.emit('close', 1); assert.equal(r.unexpected.length, 1);
});

test('quit and update cannot run before the server has flushed and exited', async () => {
  const events = []; let flushed;
  const barrier = new Promise(resolve => { flushed = resolve; });
  const quit = createQuitCoordinator({ stopServer: async () => { events.push('shutdown'); await barrier; events.push('saved'); }, closeDesktop: () => events.push('desktop'), stopUpdater: () => events.push('updater'), quit: () => events.push('quit'), installUpdate: () => events.push('install') });
  const pending = quit({ update: true }); assert.equal(pending, quit());
  assert.deepEqual(events, ['updater', 'desktop', 'shutdown']);
  flushed(); await pending; assert.deepEqual(events, ['updater', 'desktop', 'shutdown', 'saved', 'install']);
});

test('shutdown errors and OS shutdown never launch an installer', async () => {
  let installs = 0, quits = 0, suppressed;
  const broken = createQuitCoordinator({ stopServer: async () => { throw new Error('still running'); }, quit: () => quits++, installUpdate: () => installs++ });
  await assert.rejects(broken({ update: true }), /still running/); assert.equal(installs, 0); assert.equal(quits, 0);
  const windows = createQuitCoordinator({ stopServer: async () => {}, stopUpdater: value => { suppressed = value; }, quit: () => quits++, installUpdate: () => installs++ });
  await windows({ update: true, windowsShutdown: true }); assert.equal(installs, 0); assert.equal(quits, 1); assert.equal(suppressed, true);
});

test('a nonzero or signalled server exit blocks an update, including an already closed server', async () => {
  for (const [code, signal, alreadyClosed] of [[1, null, false], [null, 'SIGTERM', false], [1, null, true]]) {
    const r = rig(); const started = r.lifecycle.start(); r.child.stdout.write('http://127.0.0.1:44001\n'); await started;
    let installs = 0;
    if (alreadyClosed) r.child.emit('close', code, signal);
    const quit = createQuitCoordinator({ stopServer: () => r.lifecycle.stop(), quit: () => {}, installUpdate: () => installs++ });
    const pending = quit({ update: true });
    if (!alreadyClosed) r.child.emit('close', code, signal);
    await assert.rejects(pending, /nicht sauber/); assert.equal(installs, 0);
  }
});

test('the real server shutdown deadline exits with failure when durable flush hangs', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'network-installed-hard-timeout-'));
  // Accelerate only the real shutdown deadline inside the isolated child. The
  // real main() and callback still run; a blocked flush must never report exit 0.
  const script = `
    const nativeTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => nativeTimeout(fn, ms === 12000 ? 25 : ms, ...args);
    const { Monitor } = await import(${JSON.stringify(new URL('../lib/monitor.js', import.meta.url).href)});
    Monitor.prototype.start = async function () {};
    Monitor.prototype.prepareClose = async function () { await new Promise(() => {}); };
    setInterval(() => {}, 1000);
    const { main } = await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});
    await main();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', '--launcher', '--no-browser'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NETZWERK_KOMPASS_DATA_DIR: folder, NETZWERK_KOMPASS_NO_AUTOSTART_REGISTRATION: '1' }
  });
  let timer, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { if (/^http:\/\/127\.0\.0\.1:\d+$/.test(line)) child.stdin.write('shutdown\n'); });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
      timer = setTimeout(() => reject(new Error(`Shutdown fixture timed out: ${stderr}`)), 5000);
    });
    assert.equal(code, 1, stderr);
  } finally { clearTimeout(timer); lines.close(); child.kill(); child.stdin.destroy(); await rm(folder, { recursive: true, force: true }); }
});
