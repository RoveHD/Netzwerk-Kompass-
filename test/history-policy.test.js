import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistoryPolicy, pruneArchives, RollupStore } from '../lib/history-policy.js';
import { HistoryStore } from '../lib/history.js';

async function temp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'history-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('policy configures ping and long event retention and pruned rows invalidate cursors', t => {
  const now = Date.now();
  let currentNow = now;
  t.mock.method(Date, 'now', () => currentNow);
  const store = new HistoryStore({ retentionDays: 7 }).setPolicy(createHistoryPolicy({ pingHours: 24, eventDays: 60 }));
  store.record({ type: 'ping', at: new Date(now - 25 * 3600000).toISOString(), results: [] });
  store.record({ type: 'incident', at: new Date(now - 45 * 86400000).toISOString() });
  store.record({ type: 'event', at: new Date(now - 2 * 86400000).toISOString(), title: 'ordinary' });
  assert.deepEqual(store.snapshot(168).records.map(row => row.type), ['event']);
  assert.deepEqual(store.entries.map(entry => entry.type), ['incident', 'event']);
  const cursor = store.snapshot(168).cursor;
  currentNow = now + 61 * 86400000;
  const after = store.snapshot(168, { cursor });
  assert.equal(after.incremental, true);
  assert.equal(after.total, 0);
  assert.equal(after.removedRecordIds.length, 2);
});

test('record-cap pruning prefers ping samples and keeps older diagnoses and incident evidence', t => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const store = new HistoryStore({ retentionDays: 7, maxRecords: 12 }).setPolicy(createHistoryPolicy({ pingHours: 24, eventDays: 90 }));
  store.record({ type: 'diagnosis', at: new Date(now - 50 * 86400000).toISOString(), id: 'older-diagnosis' });
  store.record({ type: 'incident', at: new Date(now - 40 * 86400000).toISOString(), id: 'older-incident' });
  store.record({ type: 'mesh_change', at: new Date(now - 35 * 86400000).toISOString(), id: 'mesh-evidence' });
  const cursor = store.snapshot(1).cursor;
  for (let i = 0; i < 40; i++) store.record({ type: 'ping', at: new Date(now - 1000 + i).toISOString(), results: [], id: i });
  const rows = store.entries.map(entry => JSON.parse(entry.json));
  assert.equal(rows.length, 12);
  assert.deepEqual(rows.filter(row => ['diagnosis', 'incident', 'mesh_change'].includes(row.type)).map(row => row.id), ['older-diagnosis', 'older-incident', 'mesh-evidence']);
  assert.ok(rows.every(row => row.type !== 'ping' || row.id >= 31));
  const delta = store.snapshot(1, { cursor });
  assert.equal(delta.incremental, true);
  assert.ok(delta.removedRecordIds.length > 0);
  assert.equal(delta.truncated, true);
});

test('incident updates replace the prior version and remain deduplicated after reload', async t => {
  const dataDir = await temp(t), policy = createHistoryPolicy({ eventDays: 90 });
  const store = new HistoryStore({ dataDir, maxRecords: 20 }).setPolicy(policy);
  await store.start();
  store.record({ type: 'incident', id: 'incident-1', at: new Date(Date.now() - 1000).toISOString(), status: 'open', detail: 'first' });
  const cursor = store.snapshot(1).cursor;
  store.record({ type: 'incident', id: 'incident-1', at: new Date().toISOString(), status: 'resolved', detail: 'final' });
  assert.equal(store.entries.filter(entry => entry.incidentId === 'incident-1').length, 1);
  assert.equal(store.snapshot(1, { cursor }).removedRecordIds.length, 1);
  await store.close();
  const restored = new HistoryStore({ dataDir, maxRecords: 20 }).setPolicy(policy);
  await restored.start();
  const incidents = restored.snapshot(1).records.filter(record => record.type === 'incident' && record.id === 'incident-1');
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].status, 'resolved');
  await restored.close();
});

test('minute rollups preserve unknown/error/loss semantics and deduplicate persisted records', async t => {
  const dataDir = await temp(t);
  const at = new Date().toISOString();
  const records = [
    { type: 'ping', at, appSessionId: 's1', epoch: 4, recordId: 'r1', results: [{ host: 'router', ok: true, ms: 12 }] },
    { type: 'ping', at, appSessionId: 's1', epoch: 4, recordId: 'r2', results: [{ host: 'router', ok: false, ms: null, status: 'timeout' }] },
    { type: 'ping', at, appSessionId: 's1', epoch: 4, recordId: 'r3', results: [{ host: 'router', ok: false, ms: null, status: 'measurement_error', error: 'probe unavailable' }] },
    { type: 'ping', at, appSessionId: 's1', epoch: 4, recordId: 'r4', results: [{ host: 'router', ok: null, ms: null, status: 'unknown', quality: { gap: true } }] },
    { type: 'ping', at, sourceDeviceId: 'other-pc', appSessionId: 's1', epoch: 4, recordId: 'r5', results: [{ host: 'router', ok: true, ms: 20 }] },
  ];
  const rollups = new RollupStore({ dataDir });
  for (const record of records) assert.equal(rollups.recordPing({ record }), true);
  assert.equal(rollups.recordPing({ record: records[0] }), false);
  const [minute, separateSource] = rollups.snapshot();
  assert.deepEqual([minute.count, minute.lossCount, minute.errorCount, minute.gapCount, minute.validCount, minute.min, minute.max, minute.sum], [4, 1, 1, 1, 1, 12, 12, 12]);
  assert.equal(separateSource.sourceDeviceId, 'other-pc');
  assert.equal(separateSource.sum, 20);
  assert.equal('p95' in minute, false);
  await rollups.flush();
  const restored = new RollupStore({ dataDir });
  await restored.start();
  assert.equal(restored.recordPing({ record: records[0] }), false);
  assert.equal(restored.snapshot()[0].count, 4);
});

test('rollup recovery skips corrupt lines and retains valid minutes', async t => {
  const dataDir = await temp(t);
  const rollup = new RollupStore({ dataDir });
  rollup.recordPing({ record: { type: 'ping', at: new Date().toISOString(), recordId: 'ok', results: [{ host: 'h', ok: true, ms: 5 }] } });
  await rollup.flush();
  await writeFile(rollup.file, 'broken json\n' + await readFile(rollup.file, 'utf8'));
  const restored = new RollupStore({ dataDir });
  await restored.start();
  assert.equal(restored.snapshot().length, 1);
  assert.equal(restored.snapshot()[0].sum, 5);
});

test('archive pruning enforces byte and age caps only for matching in-directory archives', async t => {
  const dataDir = await temp(t), today = new Date().toISOString().slice(0, 10);
  const older = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const keep = path.join(dataDir, 'keep.txt');
  await writeFile(keep, 'preserve');
  await writeFile(path.join(dataDir, `messungen-${older}.jsonl`), 'x'.repeat(700000));
  await writeFile(path.join(dataDir, `messungen-${today}.jsonl`), 'x'.repeat(700000));
  const policy = createHistoryPolicy({ archiveMaxDays: 1, archiveMaxBytes: 1024 * 1024 });
  const result = await pruneArchives({ dataDir, policy });
  assert.equal(result.removed, 1);
  assert.ok(result.bytes <= policy.archiveMaxBytes);
  assert.equal(await readFile(keep, 'utf8'), 'preserve');
  assert.deepEqual((await readdir(dataDir)).filter(name => name.startsWith('messungen-')), [`messungen-${today}.jsonl`]);
});

test('remote ping watermark survives recent-signature eviction and reload atomically with aggregates', async t => {
  const dataDir = await temp(t), at = new Date().toISOString();
  const record = { type: 'ping', at, remote: true, sourceDeviceId: 'peer-durable', sequence: 1, results: [{ host: 'router', ok: true, ms: 7 }] };
  const store = new RollupStore({ dataDir });
  store.recordPing({ record });
  for (let i = 0; i < 200001; i++) store.seen.add(`unrelated-${i}`);
  store.prune();
  assert.equal([...store.seen].some(id => id.includes('peer-durable')), false);
  await store.flush();
  const restored = new RollupStore({ dataDir });await restored.start();
  assert.equal(restored.hasPeerPing(record), true);
  assert.equal(restored.recordPing({ record }), false);
  assert.equal(restored.snapshot()[0].count, 1);
  // Source sequence, not timestamp, distinguishes two legitimate measurements.
  assert.equal(restored.recordPing({ record: { ...record, sequence: 2 } }), true);
  assert.equal(restored.snapshot()[0].count, 2);
  assert.equal(restored.hasPeerPing({ ...record, type: 'traffic' }), false);
  const firstFlush = restored.flush();
  restored.recordPing({ record: { ...record, sequence: 3 } });
  await Promise.all([firstFlush, restored.flush()]);
  const latest = new RollupStore({ dataDir });await latest.start();
  assert.equal(latest.peerSequences.get('peer-durable'), 3);
  assert.equal(latest.snapshot()[0].count, 3);
});

test('peer watermark identity cap is explicit and never evicts older deduplication state', () => {
  const store = new RollupStore(), at = new Date().toISOString();
  const row = { type: 'ping', at, remote: true, sequence: 1, results: [] };
  for (let i = 0; i < 256; i++) store.recordPing({ record: { ...row, sourceDeviceId: `peer-${i}` } });
  assert.throws(() => store.recordPing({ record: { ...row, sourceDeviceId: 'peer-over-limit' } }), /256/);
  assert.equal(store.peerSequences.size, 256);
  assert.equal(store.hasPeerPing({ ...row, sourceDeviceId: 'peer-0' }), true);
});

test('upgrade from legacy rollup signatures does not recount retained remote pings', async t => {
  const dataDir = await temp(t), at = new Date().toISOString();
  const record = { type: 'ping', at, sourceDeviceId: 'legacy-peer', recordId: 'legacy-id', results: [{ host: 'router', ok: true, ms: 9 }] };
  const original = new RollupStore({ dataDir });original.recordPing({ record });await original.flush();
  const restored = new RollupStore({ dataDir });await restored.start();
  assert.equal(restored.recordPing({ record: { ...record, remote: true, sequence: 17 } }), false);
  assert.equal(restored.peerSequences.get('legacy-peer'), 17);
  assert.equal(restored.snapshot()[0].count, 1);
});
