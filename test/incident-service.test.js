import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createIncidentService } from '../lib/incident-service.js';
import { HistoryStore } from '../lib/history.js';

function workerFixture(onUpdate = () => {}) {
  const bus = new EventEmitter(), updates = [], errors = [];
  const service = createIncidentService({ onUpdate: value => { updates.push(value); onUpdate(value); bus.emit('update', value); }, onError: error => { errors.push(error); bus.emit('failure', error); } });
  function waitFor(predicate) {
    const existing = updates.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); bus.off('update', update); bus.off('failure', failed); };
      const update = value => { if (predicate(value)) { cleanup(); resolve(value); } };
      const failed = error => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Worker update deadline (${updates.length} updates, ${JSON.stringify(service.status())})`)); }, 5000);
      bus.on('update', update); bus.on('failure', failed);
    });
  }
  return { service, updates, errors, waitFor };
}
const ping = (index, at, ms = 100) => ({ type: 'ping', at: new Date(at).toISOString(), recordId: `fixture-${index}`, appSessionId: 'worker-fixture', epoch: 1, interfaceId: 'fixture-adapter', sourceDeviceId: 'local',
  results: [{ host: '192.168.178.1', kind: 'gateway', ok: true, ms }] });

test('real worker publishes incident start and close persists its latest complete result', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'network-incident-worker-'));
  const history = new HistoryStore({ dataDir: directory });
  await history.start();
  const f = workerFixture(update => {
    if (update.persist) history.record({ type: 'incident', at: update.incident.updatedAt, incidentId: update.incident.id, incident: update.incident });
  });
  try {
    const at = Date.now() - 1000;
    f.service.ingest(ping(0, at));
    const started = await f.waitFor(update => update.kind === 'started');
    assert.equal(started.incident.status, 'active'); assert.equal(started.incident.sourceDeviceId, 'local');
    f.service.ingest(ping(1, at + 250, 120));
    const closing = f.service.close();
    assert.equal(f.service.close(), closing, 'concurrent closes share the same drain barrier');
    await closing;
    const final = f.updates.filter(update => update.kind === 'updated' && update.incident.id === started.incident.id).at(-1);
    assert.ok(final); assert.equal(final.persist, true); assert.equal(final.incident.status, 'complete');
    assert.equal(final.incident.endReason, 'monitoring_stopped');
    assert.equal(final.incident.windows.during.targets[0].maxMs, 120);
    assert.equal(final.incident.windows.during.targets[0].sent, 2);
    await history.close();
    const restored = new HistoryStore({ dataDir: directory });
    try {
      await restored.start();
      const records = restored.snapshot(1).records.filter(record => record.type === 'incident');
      assert.ok(records.length > 0);
      assert.equal(records.at(-1).incident.id, started.incident.id);
      assert.equal(records.at(-1).incident.status, 'complete');
      assert.equal(records.at(-1).incident.windows.during.targets[0].sent, 2);
    } finally { await restored.close(); }
    assert.deepEqual(f.errors, []); assert.equal(f.service.status().running, false);
  } finally { await f.service.close(); await history.close(); await rm(directory, { recursive: true, force: true }); }
});

test('close drains several real worker batches without losing queued measurements or final update', { timeout: 10000 }, async () => {
  const f = workerFixture();
  try {
    const at = Date.now() - 2000;
    for (let i = 0; i < 1200; i++) f.service.ingest(ping(i, at + i));
    assert.equal(f.service.status().queued, 1200); assert.equal(f.service.status().dropped, 0);
    await f.service.close();
    const started = f.updates.filter(update => update.kind === 'started');
    const final = f.updates.filter(update => update.kind === 'updated').at(-1);
    assert.equal(started.length, 1); assert.ok(final); assert.equal(final.incident.id, started[0].incident.id);
    assert.equal(final.incident.status, 'complete'); assert.equal(final.persist, true);
    assert.equal(final.incident.windows.during.targets[0].sent, 1200);
    assert.deepEqual(f.service.status(), { running: false, queued: 0, dropped: 0 });
    const count = f.updates.length; f.service.ingest(ping(1200, Date.now()));
    assert.equal(f.service.status().queued, 0); assert.equal(f.updates.length, count);
    assert.deepEqual(f.errors, []);
  } finally { await f.service.close(); }
});

test('empty worker close is harmless and late history cannot fabricate a live incident', { timeout: 10000 }, async () => {
  const f = workerFixture();
  try {
    f.service.ingest({ ...ping(0, Date.now() - 1000), late: true });
    f.service.ingest({ ...ping(1, Date.now() - 20000) });
    await f.service.close(); await f.service.close();
    assert.equal(f.updates.length, 0); assert.deepEqual(f.errors, []);
    assert.equal(f.service.status().running, false);
  } finally { await f.service.close(); }
});
