import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, stat, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HistoryStore } from '../lib/history.js';

const entry = (id, ageHours = 0, type = 'event') => ({ type, at: new Date(Date.now() - ageHours * 3600000).toISOString(), id });

async function temp(t) {
  const base = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'netzwerk-history-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved).toLowerCase(), base.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('netzwerk-history-'));
    await rm(resolved, { recursive: true, force: true });
  });
  return directory;
}

test('in-memory records work before start, clone input and return ordered windows', async () => {
  const store = new HistoryStore();
  const original = entry('new');
  store.record(original);
  original.id = 'modified';
  store.record(entry('old', 5));
  store.record(entry('expired', 169));
  assert.deepEqual(store.snapshot(6).records.map(r => r.id), ['old', 'new']);
  assert.equal(store.snapshot(1).total, 1);
  const snapshot = store.snapshot(6); snapshot.records[0].id = 'changed';
  assert.equal(store.snapshot(6).records[0].id, 'old');
  assert.throws(() => store.snapshot(2), /1, 6, 24/);
  await store.close();
  assert.throws(() => store.record(entry('closed')), /geschlossen/);
});

test('all measurement types persist and restart, close flushes serialized writes', async t => {
  const dataDir = await temp(t);
  const store = new HistoryStore({ dataDir }); await store.start();
  const types = ['ping', 'traffic', 'dns', 'wifi', 'network', 'scan', 'speedtest', 'event'];
  for (let i = 0; i < 200; i++) store.record(entry(i, 0, types[i % types.length]));
  await store.close();
  const restart = new HistoryStore({ dataDir }); await restart.start();
  assert.equal(restart.snapshot().total, 200);
  assert.equal(restart.snapshot().truncated, false);
  assert.deepEqual(new Set(restart.snapshot().records.map(r => r.type)), new Set(types));
  assert.deepEqual(restart.snapshot().records.map(r => r.id), Array.from({ length: 200 }, (_, i) => i));
  await restart.close();
});

test('retention removes expired persisted entries without deleting unrelated files', async t => {
  const dataDir = await temp(t);
  await writeFile(path.join(dataDir, 'keep.txt'), 'original');
  await writeFile(path.join(dataDir, 'history.jsonl'), [entry('expired', 169), entry('recent', 25)].map(JSON.stringify).join('\n') + '\n');
  const store = new HistoryStore({ dataDir }); await store.start();
  assert.deepEqual(store.snapshot(168).records.map(r => r.id), ['recent']);
  assert.equal(store.snapshot(168).truncated, false);
  assert.equal(store.snapshot(24).total, 0);
  await store.close();
  assert.equal(await readFile(path.join(dataDir, 'keep.txt'), 'utf8'), 'original');
  assert.ok(!(await readFile(path.join(dataDir, 'history.jsonl'), 'utf8')).includes('expired'));
});

test('record cap survives compaction and restart with persistent truncation metadata', async t => {
  const dataDir = await temp(t);
  const store = new HistoryStore({ dataDir, maxRecords: 3 }); await store.start();
  for (let i = 0; i < 30; i++) store.record(entry(i));
  assert.deepEqual(store.snapshot().records.map(r => r.id), [27, 28, 29]);
  assert.equal(store.snapshot().truncated, true);
  await store.close();
  assert.ok((await readFile(path.join(dataDir, 'history.jsonl'), 'utf8')).split('\n').filter(Boolean).length <= 7);
  assert.ok(!(await readdir(dataDir)).includes('history.jsonl.tmp'));
  const restart = new HistoryStore({ dataDir, maxRecords: 3 }); await restart.start();
  assert.deepEqual(restart.snapshot().records.map(r => r.id), [27, 28, 29]);
  assert.equal(restart.snapshot().truncated, true);
  await restart.close();
});

test('corrupt tail, invalid types and oversized lines are skipped with visible warning', async t => {
  const dataDir = await temp(t);
  const file = path.join(dataDir, 'history.jsonl');
  await writeFile(file, JSON.stringify(entry('keep')) + '\n' + 'x'.repeat(100000) + '\n' + JSON.stringify(entry('bad-type', 0, 'unknown')) + '\n{"type":"ping","at":');
  const store = new HistoryStore({ dataDir }); await store.start();
  assert.deepEqual(store.snapshot().records.map(r => r.id), ['keep']);
  assert.ok(store.snapshot().warnings.some(w => w.includes('beschädigte')));
  assert.equal(store.snapshot().truncated, true);
  store.record(entry('after')); await store.close();
  const restart = new HistoryStore({ dataDir }); await restart.start();
  assert.deepEqual(restart.snapshot().records.map(r => r.id), ['keep', 'after']);
  await restart.close();
});

test('valid final line without newline is compacted before subsequent append', async t => {
  const dataDir = await temp(t);
  await writeFile(path.join(dataDir, 'history.jsonl'), JSON.stringify(entry('without-newline')));
  const store = new HistoryStore({ dataDir }); await store.start();store.record(entry('next'));await store.close();
  const restart = new HistoryStore({ dataDir }); await restart.start();
  assert.equal(restart.snapshot().total, 2);
  assert.equal(restart.snapshot().truncated, false);
  await restart.close();
});

test('one unreadable raw archive cannot prevent recovery of the remaining files or startup',async t=>{
  const dataDir=await temp(t),today=new Date().toISOString().slice(0,10),yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
  const blocked=path.join(dataDir,`messungen-${today}.jsonl`);await mkdir(blocked);
  await writeFile(path.join(blocked,'keep.txt'),'preserved');
  await writeFile(path.join(dataDir,`messungen-${yesterday}.jsonl`),JSON.stringify(entry('recovered',24))+'\n');
  const store=new HistoryStore({dataDir});await store.start();await store.recoverArchives();
  assert.deepEqual(store.snapshot(168).records.map(row=>row.id),['recovered']);
  assert.ok(store.snapshot(168).warnings.some(warning=>warning.includes(`messungen-${today}.jsonl`)));
  assert.equal(await readFile(path.join(blocked,'keep.txt'),'utf8'),'preserved');await store.close();
  const restart=new HistoryStore({dataDir});await restart.start();assert.equal(restart.snapshot(168).total,1);await restart.close();
});

test('validation bounds records, JSON complexity, dates and allowed types', () => {
  const store = new HistoryStore();
  for (const value of [null, [], entry('bad', 0, 'other'), {type:'event',at:'not a date'}, {...entry('large'), text:'x'.repeat(70000)}, {...entry('nan'), ms:NaN}, {...entry('date'), value:new Date()}]) assert.throws(() => store.record(value));
  const cycle = entry('cycle'); cycle.self = cycle; assert.throws(() => store.record(cycle), /komplex/);
});

test('byte and pending-write limits stay bounded during large synchronous batches', async t => {
  const dataDir = await temp(t);
  const store = new HistoryStore({ dataDir, maxRecords: 12000 }); await store.start();
  for (let i = 0; i < 450; i++) store.record({ ...entry(i), text:'x'.repeat(50000) });
  assert.ok(store.memoryBytes <= 16 * 1024 * 1024);
  assert.ok(store.pendingBytes <= 4 * 1024 * 1024);
  assert.equal(store.snapshot().truncated, true);
  const expected = store.snapshot().records.map(r => r.id);
  await store.close();
  assert.ok((await stat(path.join(dataDir, 'history.jsonl'))).size <= 32 * 1024 * 1024);
  const restart = new HistoryStore({ dataDir }); await restart.start();
  assert.deepEqual(restart.snapshot().records.map(r => r.id), expected);
  await restart.close();
});
