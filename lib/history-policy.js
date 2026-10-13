import { mkdir, readdir, stat, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './session-store.js';

const DAY = 86400000;
const MAX_ROLLUP_BYTES = 96 * 1024 * 1024;
const MAX_ROLLUP_MINUTES = 200000;
const DEFAULTS = Object.freeze({ pingHours: 24, rollupDays: 30, eventDays: 365, archiveMaxBytes: 256 * 1024 * 1024, archiveMaxDays: 30 });

function boundedInteger(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new TypeError(`Ungültige ${name}-Grenze.`);
  return value;
}

export function createHistoryPolicy(options = {}) {
  return Object.freeze({
    pingHours: boundedInteger(options.pingHours, DEFAULTS.pingHours, 1, 168, 'Ping-Aufbewahrung'),
    rollupDays: boundedInteger(options.rollupDays, DEFAULTS.rollupDays, 1, 3650, 'Minutenstatistik-Aufbewahrung'),
    eventDays: boundedInteger(options.eventDays, DEFAULTS.eventDays, 31, 3650, 'Ereignis-Aufbewahrung'),
    archiveMaxBytes: boundedInteger(options.archiveMaxBytes, DEFAULTS.archiveMaxBytes, 1024 * 1024, 8 * 1024 * 1024 * 1024, 'Roharchivgrößen'),
    archiveMaxDays: boundedInteger(options.archiveMaxDays, DEFAULTS.archiveMaxDays, 1, 3650, 'Roharchiv-Aufbewahrung'),
  });
}

function parsePing(record) {
  if (!record || record.type !== 'ping' || !Array.isArray(record.results)) return [];
  return record.results.filter(row => row && typeof row.host === 'string').map(row => ({
    host: row.host,
    value: row.ok === true && row.status !== 'measurement_error' && Number.isFinite(row.ms) && row.ms >= 0 ? row.ms : null,
    loss: row.ok === false && row.status !== 'measurement_error' ? 1 : 0,
    error: row.status === 'measurement_error' || typeof row.error === 'string',
    gap: row.quality?.gap === true || row.status === 'gap' || row.status === 'missing' || row.status === 'unknown',
  }));
}

// Minute aggregates retain exact sum/min/max and outcome counts. Percentiles are
// intentionally omitted: without retained samples they cannot be exact.
export class RollupStore {
  constructor({ dataDir, retentionDays = 30 } = {}) {
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.file = this.dataDir ? path.join(this.dataDir, 'history-rollups.jsonl') : null;
    this.retentionDays = boundedInteger(retentionDays, 30, 1, 3650, 'Rollup-Aufbewahrung');
    this.minutes = new Map();
    this.seen = new Set();
    // Peer sequences are persisted together with the aggregates. Unlike the
    // recent signature cache, these watermarks must never age out silently.
    this.peerSequences = new Map();
    this.flushQueue = Promise.resolve();
    this.loaded = false;
    this.lastPrunedMinute = null;
  }
  minuteKey(record, host, minute) {
    return JSON.stringify([record.sourceDeviceId ?? record.source ?? 'ping', record.appSessionId ?? record.sessionId ?? null, record.epoch ?? null, host, minute]);
  }
  peerIdentity(record) {
    if (record?.type !== 'ping' || record.remote !== true) return null;
    if (typeof record.sourceDeviceId !== 'string' || !record.sourceDeviceId || record.sourceDeviceId.length > 256 || !Number.isSafeInteger(record.sequence) || record.sequence < 1) throw new TypeError('Ungültige Peer-Ping-Sequenz.');
    return record.sourceDeviceId;
  }
  hasPeerPing(record) {
    const source = this.peerIdentity(record);
    return source !== null && record.sequence <= (this.peerSequences.get(source) ?? 0);
  }
  recordPing({ record } = {}) {
    if (!record || !Number.isFinite(Date.parse(record.at))) throw new TypeError('Ungültiger Ping-Rollup-Eintrag.');
    const source = this.peerIdentity(record);
    if (this.hasPeerPing(record)) return false;
    if (source !== null && !this.peerSequences.has(source) && this.peerSequences.size >= 256) throw new Error('Langzeitstatistik: Grenze von 256 gespeicherten Peer-Identitäten erreicht.');
    const minute = Math.floor(Date.parse(record.at) / 60000) * 60000;
    if (this.lastPrunedMinute === null || minute > this.lastPrunedMinute) {
      this.prune();
      this.lastPrunedMinute = minute;
    }
    let changed = false;
    for (const sample of parsePing(record)) {
      const key = this.minuteKey(record, sample.host, minute);
      const signature = `${key}|${source === null ? record.recordId ?? record.at : `peer:${record.sequence}`}`;
      if (this.seen.has(signature) || source !== null && this.seen.has(`${key}|${record.recordId ?? record.at}`)) continue;
      let item = this.minutes.get(key);
      if (!item) {
        item = { type: 'ping-minute', sourceDeviceId: record.sourceDeviceId ?? record.source ?? 'ping', sessionId: record.appSessionId ?? record.sessionId ?? null,
          epoch: record.epoch ?? null, target: sample.host, minute: new Date(minute).toISOString(), count: 0,
          lossCount: 0, errorCount: 0, gapCount: 0, validCount: 0, min: null, max: null, sum: 0 };
        this.minutes.set(key, item);
      }
      this.seen.add(signature);
      changed = true;
      item.count++;
      if (sample.loss !== null) item.lossCount += sample.loss;
      if (sample.error) item.errorCount++;
      if (sample.gap) item.gapCount++;
      if (sample.value !== null) {
        item.validCount++; item.sum += sample.value;
        item.min = item.min === null ? sample.value : Math.min(item.min, sample.value);
        item.max = item.max === null ? sample.value : Math.max(item.max, sample.value);
      }
    }
    if (source !== null) this.peerSequences.set(source, record.sequence);
    return changed;
  }
  snapshot() { return [...this.minutes.values()].map(item => ({ ...item })).sort((a, b) => a.minute.localeCompare(b.minute)); }
  async start() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    await mkdir(this.dataDir, { recursive: true });
    let text;
    try { const info = await stat(this.file); if (!info.isFile() || info.size > MAX_ROLLUP_BYTES) throw new Error('Rollup-Datei überschreitet die Lesegrenze.'); text = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of text.split('\n')) {
      let item;
      try { item = JSON.parse(line); } catch { continue; }
      if (!item || typeof item !== 'object') continue;
      if (item.type === '_meta') {
        if (item.peerSequences !== undefined) {
          if (!Array.isArray(item.peerSequences) || item.peerSequences.length > 256) throw new Error('Beschädigte Peer-Sequenzen in der Langzeitstatistik.');
          for (const entry of item.peerSequences) {
            if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 256 || !Number.isSafeInteger(entry[1]) || entry[1] < 1 || this.peerSequences.has(entry[0])) throw new Error('Beschädigte Peer-Sequenz in der Langzeitstatistik.');
            this.peerSequences.set(entry[0], entry[1]);
          }
        }
        if (Array.isArray(item.seen)) for (const id of item.seen.slice(-200000)) if (typeof id === 'string') this.seen.add(id);
        continue;
      }
      try {
        if (item.type !== 'ping-minute' || !Number.isFinite(Date.parse(item.minute)) || typeof item.target !== 'string') continue;
        this.minutes.set(this.minuteKey({ sourceDeviceId: item.sourceDeviceId ?? item.source, appSessionId: item.sessionId, epoch: item.epoch }, item.target, Date.parse(item.minute)), item);
      } catch { /* tolerate a damaged rollup line and preserve other minutes */ }
    }
    this.prune();
  }
  async flush() {
    if (!this.file) return;
    this.flushQueue = this.flushQueue.catch(() => {}).then(async () => {
    await mkdir(this.dataDir, { recursive: true });
    const seen = [...this.seen].slice(-200000);
    const metadata = JSON.stringify({ type: '_meta', seen, peerSequences: [...this.peerSequences] });
    let items = [...this.minutes.values()].sort((a, b) => a.minute.localeCompare(b.minute));
    let lines = [metadata, ...items.map(item => JSON.stringify(item))];
    let text = lines.join('\n') + '\n';
    while (Buffer.byteLength(text) > MAX_ROLLUP_BYTES && items.length) {
      const removed = items.shift();
      this.minutes.delete(this.minuteKey({ sourceDeviceId: removed.sourceDeviceId ?? removed.source, appSessionId: removed.sessionId, epoch: removed.epoch }, removed.target, Date.parse(removed.minute)));
      lines = [metadata, ...items.map(item => JSON.stringify(item))];
      text = lines.join('\n') + '\n';
    }
    await atomicWrite(this.file, text);
    });
    return this.flushQueue;
  }
  prune(now = Date.now()) {
    const cutoff = now - this.retentionDays * DAY;
    for (const [key, item] of this.minutes) if (Date.parse(item.minute) < cutoff) this.minutes.delete(key);
    if (this.minutes.size > MAX_ROLLUP_MINUTES) {
      const oldest = [...this.minutes.entries()].sort((a, b) => a[1].minute.localeCompare(b[1].minute));
      for (const [key] of oldest.slice(0, this.minutes.size - MAX_ROLLUP_MINUTES)) this.minutes.delete(key);
    }
    if (this.seen.size > 200000) this.seen = new Set([...this.seen].slice(-100000));
  }
}

export async function pruneArchives({ dataDir, policy = createHistoryPolicy(), now = Date.now() } = {}) {
  if (!dataDir) return { removed: 0, bytes: 0 };
  const root = path.resolve(dataDir);
  await mkdir(root, { recursive: true });
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const names = (await readdir(root)).filter(name => /^messungen-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  const files = [];
  for (const name of names) {
    const file = path.resolve(root, name);
    if (!file.startsWith(prefix) || path.dirname(file) !== root) continue;
    try { const info = await stat(file); if (info.isFile()) files.push({ file, at: Date.parse(name.slice(10, 20)), size: info.size }); } catch { /* vanished during scan */ }
  }
  let bytes = files.reduce((sum, file) => sum + file.size, 0), removed = 0;
  const cutoff = now - policy.archiveMaxDays * DAY;
  for (const item of files) {
    if (item.at < cutoff || bytes > policy.archiveMaxBytes) {
      await unlink(item.file); bytes -= item.size; removed++;
    }
  }
  return { removed, bytes };
}
