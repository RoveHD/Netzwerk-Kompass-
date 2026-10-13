import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createBackgroundMonitoring } from '../desktop/background.cjs';
import { createBackgroundServer } from '../desktop/background-server.cjs';

test('close exits by default, opt-in hides with hotkey renderer alive, explicit quit overrides persisted opt-in', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'network-background-'));
  let prevented = 0, hidden = 0;
  const event = { preventDefault: () => prevented++ }, window = { hide: () => hidden++ };
  try {
    const controller = createBackgroundMonitoring({ desktopDir: directory });
    assert.equal(controller.onClose(event, window), false);
    await controller.set(true);
    assert.equal(controller.onClose(event, window), true);
    assert.equal(prevented, 1); assert.equal(hidden, 1); assert.equal(controller.status().hidden, true);
    controller.onShow(); assert.equal(controller.status().hidden, false);
    assert.equal(createBackgroundMonitoring({ desktopDir: directory }).enabled, true);
    controller.stop(); assert.equal(controller.onClose(event, window), false);
    assert.equal(createBackgroundMonitoring({ desktopDir: directory, available: false }).enabled, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function serverRig(options = {}) {
  const children = [], logs = [], fatal = [], resumed = [];
  let live = 0, peakLive = 0;
  const server = createBackgroundServer({ appDir: path.resolve('app'), nodePath: path.resolve('node'), dataDir: path.resolve('data'), exePath: path.resolve('app.exe'),
    shouldRestart: () => true, onUnexpectedExit: (error, result) => fatal.push({ error, result }), onRestart: async url => resumed.push(url), log: line => logs.push(line),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      live++; peakLive = Math.max(peakLive, live); children.push(child);
      child.once('close', () => live--);
      child.kill = () => { child.emit('close', null, 'SIGTERM'); };
      return child;
    }, ...options });
  async function settle() { await new Promise(resolve => setImmediate(resolve)); }
  return { server, children, fatal, logs, resumed, settle, get peakLive() { return peakLive; } };
}
test('Node crash restarts only after close, records gap, and never duplicates runtime; restart budget is bounded', async () => {
  const r = serverRig(); const started = r.server.start();
  r.children[0].stdout.write('http://127.0.0.1:44001\n'); await started;
  for (let i = 0; i < 3; i++) {
    r.children[i].emit('exit', 1); assert.equal(r.children.length, i + 1);
    r.children[i].emit('close', 1); r.children[i].emit('close', 1); await r.settle();
    assert.equal(r.children.length, i + 2);
    r.children[i + 1].stdout.write(`http://127.0.0.1:${44002 + i}\n`); await r.settle();
    assert.equal(r.server.status().lastGap.reason, 'node_exit'); assert.ok(r.server.status().lastGap.resumedAt);
  }
  r.children[3].emit('close', 1); await r.settle();
  assert.equal(r.children.length, 4); assert.equal(r.peakLive, 1); assert.equal(r.fatal.length, 1);
  assert.equal(r.server.status().state, 'failed'); assert.equal(r.resumed.length, 3);
  assert.equal(r.logs.filter(line => line.startsWith('MONITOR_GAP ')).length, 4);
  assert.equal(r.logs.filter(line => line.startsWith('MONITOR_RESUMED ')).length, 3);
});
test('default opt-out, clean server exit, and explicit shutdown never trigger restart', async () => {
  for (const mode of ['disabled', 'clean', 'quit']) {
    const r = serverRig({ shouldRestart: () => mode !== 'disabled' });
    const started = r.server.start(); r.children[0].stdout.write('http://127.0.0.1:44001\n'); await started;
    const stopped = mode === 'quit' ? r.server.stop() : null;
    r.children[0].emit('close', mode === 'disabled' ? 1 : 0);
    if (stopped) await stopped;
    await r.settle(); assert.equal(r.children.length, 1);
    assert.equal(r.fatal.length, mode === 'quit' ? 0 : 1);
  }
});
test('quit racing a queued restart prevents a replacement child', async () => {
  const r = serverRig(); const started = r.server.start(); r.children[0].stdout.write('http://127.0.0.1:44001\n'); await started;
  r.children[0].emit('close', 1);
  await assert.rejects(r.server.stop(), /nicht sauber/);
  await r.settle(); assert.equal(r.children.length, 1);
});
test('failed replacement startup is reaped and cannot begin a duplicate restart chain', async () => {
  const r = serverRig({ startupTimeoutMs: 5, shutdownTimeoutMs: 5 });
  const started = r.server.start(); r.children[0].stdout.write('http://127.0.0.1:44001\n'); await started;
  r.children[0].emit('close', 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(r.children.length, 2); assert.equal(r.peakLive, 1);
  assert.equal(r.server.running, false); assert.equal(r.fatal.length, 1);
});
