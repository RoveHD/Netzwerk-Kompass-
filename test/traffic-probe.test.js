import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createTrafficMonitor, parseTrafficCounters } from '../lib/probes.js';

const counter = (overrides = {}) => ({ id: '12', name: 'Ethernet', receivedBytes: 100, sentBytes: 0,
  receivedErrors: 0, sentErrors: 0, receivedDiscards: 0, sentDiscards: 0, status: 'Up', linkSpeedMbps: 1000, ...overrides });

function fakeWorkers() {
  const children = [];
  return { children, spawnImpl(_command, args, options) {
    assert.equal(args.at(-1), 'traffic-worker');
    assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new EventEmitter();
    child.requests = []; child.callbacks = [];
    child.stdin.write = (line, callback) => { child.requests.push(JSON.parse(line)); child.callbacks.push(callback); return true; };
    child.kill = () => { child.killed = true; return true; };
    child.reply = (counters = [counter()], requestId = child.requests.at(-1).requestId) => child.stdout.write(JSON.stringify({ requestId, counters }) + '\n');
    children.push(child); return child;
  } };
}

test('traffic response preserves true zero and down adapters, rejects malformed or unbounded counters', () => {
  assert.deepEqual(parseTrafficCounters([]), []);
  assert.deepEqual(parseTrafficCounters([counter({ status: 'Down', linkSpeedMbps: null })]), [counter({ status: 'Down', linkSpeedMbps: null })]);
  for (const value of [[counter(), counter()], [counter({ receivedBytes: -1 })], [counter({ sentBytes: Number.MAX_SAFE_INTEGER + 1 })],
    [counter({ sentErrors: null })], [counter({ id: 'x' })], [counter({ status: 'invented' })], [counter({ linkSpeedMbps: 0 })], Array(257).fill(counter())]) {
    assert.throws(() => parseTrafficCounters(value));
  }
});

test('traffic worker is lazy, reuses one process and rejects concurrent requests', async t => {
  const fake = fakeWorkers(), monitor = createTrafficMonitor(fake); t.after(() => monitor.close());
  await assert.rejects(monitor.getTrafficCounters({ timeoutMs: 0 }), TypeError);
  const before = new AbortController(); before.abort();
  await assert.rejects(monitor.getTrafficCounters({ signal: before.signal }), { name: 'AbortError' });
  assert.equal(fake.children.length, 0);
  const first = monitor.getTrafficCounters();
  await assert.rejects(monitor.getTrafficCounters(), { code: 'TRAFFIC_MONITOR_BUSY' });
  fake.children[0].reply(); assert.equal((await first)[0].sentBytes, 0);
  const second = monitor.getTrafficCounters(); fake.children[0].reply([counter({ receivedBytes: 200 })]);
  assert.equal((await second)[0].receivedBytes, 200); assert.equal(fake.children.length, 1);
  assert.notEqual(fake.children[0].requests[0].requestId, fake.children[0].requests[1].requestId);
});

test('late write callbacks cannot cancel a newer request in the same traffic process', async t => {
  const fake = fakeWorkers(), monitor = createTrafficMonitor(fake); t.after(() => monitor.close());
  const first = monitor.getTrafficCounters(); fake.children[0].reply(); await first;
  const second = monitor.getTrafficCounters();
  fake.children[0].callbacks[0](new Error('late write failure'));
  fake.children[0].reply([counter({ sentBytes: 50 })]);
  assert.equal((await second)[0].sentBytes, 50); assert.equal(fake.children[0].killed, undefined);
});

test('traffic abort isolates replaced process, and close rejects pending and future measurements', async () => {
  const fake = fakeWorkers(), monitor = createTrafficMonitor(fake);
  const controller = new AbortController();
  const first = monitor.getTrafficCounters({ signal: controller.signal }); controller.abort();
  await assert.rejects(first, { name: 'AbortError' }); assert.equal(fake.children[0].killed, true);
  const second = monitor.getTrafficCounters();
  fake.children[0].reply([counter({ sentBytes: 999 })]);
  fake.children[0].emit('error', new Error('old error')); fake.children[0].emit('close');
  fake.children[1].reply(); await second;
  const third = monitor.getTrafficCounters(); monitor.close(); monitor.close();
  await assert.rejects(third, { code: 'TRAFFIC_MONITOR_CLOSED' });
  await assert.rejects(monitor.getTrafficCounters(), { code: 'TRAFFIC_MONITOR_CLOSED' });
  assert.equal(fake.children[1].killed, true);
});

test('traffic protocol, output and exit failures allow replacement without inventing measurements', async t => {
  const fake = fakeWorkers(), monitor = createTrafficMonitor(fake); t.after(() => monitor.close());
  let pending = monitor.getTrafficCounters(); fake.children[0].reply([counter()], 'wrong');
  await assert.rejects(pending, { code: 'TRAFFIC_WORKER_PROTOCOL' });
  pending = monitor.getTrafficCounters(); fake.children[1].stdout.write('x'.repeat(256 * 1024 + 1));
  await assert.rejects(pending, { code: 'OUTPUT_LIMIT' });
  pending = monitor.getTrafficCounters(); fake.children[2].emit('close', 1);
  await assert.rejects(pending, { code: 'TRAFFIC_WORKER_EXIT' });
  pending = monitor.getTrafficCounters(); fake.children[3].reply([]); assert.deepEqual(await pending, []);
  assert.ok(fake.children.slice(0, 3).every(child => child.killed));
});

test('traffic timeout kills the stalled process and stale timeout cannot reach its replacement', async t => {
  const fake = fakeWorkers(), monitor = createTrafficMonitor(fake); t.after(() => monitor.close());
  await assert.rejects(monitor.getTrafficCounters({ timeoutMs: 100 }), { code: 'PROBE_TIMEOUT' });
  assert.equal(fake.children[0].killed, true);
  const next = monitor.getTrafficCounters(); fake.children[1].reply(); await next;
});

test('Windows traffic worker returns real adapter counters twice with one PID', { skip: process.platform !== 'win32' }, async t => {
  const children = [];
  const monitor = createTrafficMonitor({ spawnImpl: (...args) => { const child = spawn(...args); children.push(child); return child; } });
  t.after(() => monitor.close());
  const first = await monitor.getTrafficCounters({ timeoutMs: 12000 });
  const second = await monitor.getTrafficCounters();
  assert.ok(Array.isArray(first)); assert.ok(Array.isArray(second));
  assert.equal(children.length, 1); assert.ok(children[0].pid > 0);
  for (const entry of second) {
    assert.match(entry.id, /^\d+$/); assert.ok(Number.isSafeInteger(entry.receivedBytes));
    assert.ok(Number.isSafeInteger(entry.sentBytes)); assert.equal(typeof entry.status, 'string');
  }
  monitor.close(); assert.equal(children[0].killed, true);
});
