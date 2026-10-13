import { createReadStream } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, durableAppend, safeStoredData } from './session-store.js';

const TYPES = new Set(['ping', 'traffic', 'dns', 'wifi', 'network', 'scan', 'speedtest', 'stress', 'event', 'fritzbox', 'diagnosis', 'incident', 'mesh_change', 'router_event']);
const HOURS = new Set([1, 6, 24, 168]);
const MAX_LINE_BYTES = 64 * 1024;
const MAX_MEMORY_BYTES = 16 * 1024 * 1024;
const MAX_DISK_BYTES = 32 * 1024 * 1024;
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_REMOVALS = 4096;

function encodeRecord(record) {
  if (!record || Array.isArray(record) || typeof record !== 'object') throw new TypeError('Historieneintrag muss ein JSON-Objekt sein.');
  let nodes = 0, textBytes = 0;
  const stack = [{ value: record, depth: 0 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (++nodes > 10000 || depth > 32) throw new TypeError('Historieneintrag ist zu komplex.');
    if (typeof value === 'string') textBytes += Buffer.byteLength(value);
    else if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Ungültige Zahl im Historieneintrag.');
    else if (value !== null && typeof value === 'object') {
      const prototype = Object.getPrototypeOf(value);
      if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new TypeError('Nur einfache JSON-Daten sind erlaubt.');
      const keys = Object.keys(value);
      if (keys.length > 10000) throw new TypeError('Historieneintrag ist zu komplex.');
      for (const key of keys) {
        textBytes += Buffer.byteLength(key);
        stack.push({ value: value[key], depth: depth + 1 });
      }
    } else if (!['undefined', 'boolean', 'number'].includes(typeof value) && value !== null) throw new TypeError('Nur einfache JSON-Daten sind erlaubt.');
    if (textBytes > MAX_LINE_BYTES) throw new TypeError('Historieneintrag ist zu groß.');
  }
  if (!TYPES.has(record.type)) throw new TypeError('Unbekannter Historientyp.');
  const timestamp = typeof record.at === 'string' ? Date.parse(record.at) : NaN;
  if (!Number.isFinite(timestamp)) throw new TypeError('Ungültiges Datum im Historieneintrag.');
  const data = safeStoredData(record);
  data.at = new Date(timestamp).toISOString();
  const json = JSON.stringify(data);
  const bytes = Buffer.byteLength(json) + 1;
  if (bytes > MAX_LINE_BYTES) throw new TypeError('Historieneintrag ist zu groß.');
  return { timestamp, json, bytes, remote: data.remote===true, type: data.type, title: data.title, detail: data.detail, incidentId: data.type === 'incident' ? (data.incidentId ?? data.id ?? data.incident?.id ?? null) : null, measurementStartedAt: data.measurementStartedAt };
}

export class HistoryStore {
  constructor({ dataDir, retentionDays = 7, maxRecords = 12000 } = {}) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) throw new TypeError('Ungültige Historienaufbewahrung.');
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200000) throw new TypeError('Ungültige Historiengrenze.');
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.file = this.dataDir ? path.join(this.dataDir, 'history.jsonl') : null;
    this.retentionDays = retentionDays;
    this.policy = null;
    this.maxRecords = maxRecords;
    this.entries = [];
    this.memoryBytes = 0;
    this.droppedThrough = null;
    this.warnings = [];
    this.lastError = null;
    this.pending = [];
    this.pendingBytes = 0;
    this.diskRecords = 0;
    this.diskBytes = 0;
    this.started = false;
    this.closed = false;
    this.needCompaction = false;
    this.resetCursor();
  }

  setPolicy(policy) {
    if (!policy || !Number.isInteger(policy.pingHours) || !Number.isInteger(policy.eventDays) || !Number.isInteger(policy.rollupDays)) throw new TypeError('Ungültige HistoryPolicy.');
    this.policy = policy;
    this.prune();
    this.needCompaction = true;
    this.scheduleFlush();
    return this;
  }

  retentionCutoff(entry, now = Date.now()) {
    if (!this.policy) return now - this.retentionDays * 86400000;
    if (entry.type === 'ping') return now - this.policy.pingHours * 3600000;
    if (this.isProtected(entry)) return now - this.policy.eventDays * 86400000;
    return now - Math.min(this.retentionDays, 30) * 86400000;
  }

  isProtected(entry) {
    return entry.type === 'incident' || entry.type === 'mesh_change' || entry.type === 'router_event' || entry.type === 'diagnosis' ||
      entry.type === 'event' && /incident|mesh|router|gateway/i.test(`${entry.title || ''} ${entry.detail || ''}`);
  }

  resetCursor() {
    this.cursorKey = randomBytes(32);
    this.revision = 0;
    this.removals = [];
    this.removalsThrough = 0;
  }

  cursor(hours, period, now) {
    const payload = Buffer.from(JSON.stringify([hours, period, this.revision, now])).toString('base64url');
    return payload + '.' + createHmac('sha256', this.cursorKey).update(payload).digest('base64url');
  }

  readCursor(cursor, hours, period, now) {
    if (typeof cursor !== 'string' || cursor.length > 1024) return null;
    try {
      const [payload, signature, extra] = cursor.split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const expected = createHmac('sha256', this.cursorKey).update(payload).digest();
      const supplied = Buffer.from(signature, 'base64url');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!Array.isArray(value) || value.length !== 4 || value[0] !== hours || value[1] !== period ||
          !Number.isSafeInteger(value[2]) || value[2] < this.removalsThrough || value[2] > this.revision ||
          !Number.isSafeInteger(value[3]) || value[3] > now) return null;
      return { revision: value[2], to: value[3] };
    } catch { return null; }
  }

  warning(message) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
    if (this.warnings.length > 20) this.warnings.shift();
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.closed) throw new Error('Historie ist geschlossen.');
    this.startPromise = this.load();
    return this.startPromise;
  }

  async load() {
    if (!this.file) { this.started = true; return; }
    try { await mkdir(this.dataDir, { recursive: true }); }
    catch (error) {
      this.lastError = `Historie kann nicht gespeichert werden: ${error.message}`;
      this.warning(this.lastError);
      this.ioDisabled = true;
      this.started = true;
      return;
    }
    // Keep records made before start; they belong after the persisted data.
    const beforeStart = this.entries;
    this.entries = [];
    this.memoryBytes = 0;
    // Loading/recovery may reorder existing rows; old live cursors must resync.
    this.resetCursor();
    let invalid = 0;
    const acceptLine = line => {
      if (!line.trim()) return;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.type === '_meta') {
          if (parsed.version !== 1 || (parsed.droppedThrough !== null && !Number.isFinite(Date.parse(parsed.droppedThrough)))) throw new Error('Invalid metadata');
          if (parsed.droppedThrough) this.droppedThrough = Math.max(this.droppedThrough || 0, Date.parse(parsed.droppedThrough));
          return;
        }
        const entry = encodeRecord(parsed);
        this.diskRecords++;
        this.insert(entry);
      } catch { invalid++; }
    };
    try {
      const info = await stat(this.file);
      this.diskBytes = info.size;
      const offset = Math.max(0, info.size - MAX_DISK_BYTES);
      if (offset) {
        this.warning('Historiedatei überschreitet die Lesegrenze; nur ihr Ende wurde geladen.');
        this.droppedThrough = Math.max(this.droppedThrough || 0, Date.now());
        this.needCompaction = true;
      }
      let line = '', lineBytes = 0, skip = offset > 0;
      for await (const chunk of createReadStream(this.file, { encoding: 'utf8', start: offset, highWaterMark: 64 * 1024 })) {
        const pieces = chunk.split('\n');
        for (let i = 0; i < pieces.length; i++) {
          if (!skip) {
            lineBytes += Buffer.byteLength(pieces[i]);
            if (lineBytes > MAX_LINE_BYTES) { skip = true; line = ''; invalid++; }
            else line += pieces[i];
          }
          if (i < pieces.length - 1) {
            if (!skip) acceptLine(line);
            line = ''; lineBytes = 0; skip = false;
          }
        }
      }
      if (line.trim() && !skip) {
        acceptLine(line);
        this.needCompaction = true; // A following append must not join the final line.
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.lastError = `Historie konnte nicht gelesen werden: ${error.message}`;
        this.warning(this.lastError);
        // Never overwrite an unreadable existing file with an empty history.
        this.ioDisabled = true;
      }
    }
    if (invalid) {
      this.warning(`${invalid} beschädigte oder zu große Historienzeilen wurden übersprungen.`);
      this.droppedThrough = Math.max(this.droppedThrough || 0, Date.now());
      this.needCompaction = true;
    }
    for (const entry of beforeStart) this.insert(entry);
    if (beforeStart.length || this.diskRecords > this.entries.length || this.diskBytes > MAX_DISK_BYTES) this.needCompaction = true;
    this.started = true;
    this.scheduleFlush();
    if (this.flushPromise) await this.flushPromise;
  }

  insert(entry) {
    if (entry.timestamp < this.retentionCutoff(entry)) { this.needCompaction = true; return false; }
    if (entry.incidentId) {
      const previousIndex = this.entries.findIndex(item => item.type === 'incident' && item.incidentId === entry.incidentId);
      if (previousIndex !== -1) {
        const [previous] = this.entries.splice(previousIndex, 1);
        this.removeEntry(previous);
        this.needCompaction = true;
      }
    }
    // Identity follows insertion, not timestamps or caller-supplied record IDs.
    entry.sequence = ++this.revision;
    if (!this.entries.length || this.entries.at(-1).timestamp <= entry.timestamp) this.entries.push(entry);
    else {
      let low = 0, high = this.entries.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (this.entries[middle].timestamp <= entry.timestamp) low = middle + 1; else high = middle;
      }
      this.entries.splice(low, 0, entry);
    }
    this.memoryBytes += entry.bytes;
    this.prune();
    return true;
  }

  // Raw daily archives are the write-ahead source if a crash interrupted the
  // bounded history cache. Read only a bounded recent tail; archives themselves
  // remain intact. Exact JSON/record IDs avoid duplicating an already saved row.
  async recoverArchives() {
    if(!this.dataDir||this.ioDisabled)return;
    const names=(await readdir(this.dataDir)).filter(name=>/^messungen-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse();
    const cutoff=Date.now()-this.retentionDays*86400000;
    const seen=new Set(this.entries.map(entry=>entry.json));
    let budget=MAX_DISK_BYTES,recovered=0;
    for(const name of names) {
      if(budget<=0||Date.parse(name.slice(10,20))<cutoff-86400000)break;
      try {
      const file=path.join(this.dataDir,name),info=await stat(file);
      if(!info.isFile())throw new Error('Rohprotokoll ist keine Datei.');
      const size=info.size;
      const offset=Math.max(0,size-budget);budget-=Math.min(size,budget);
      let line='',skip=offset>0;
      for await(const chunk of createReadStream(file,{encoding:'utf8',start:offset,highWaterMark:65536})) {
        const pieces=chunk.split('\n');
        for(let i=0;i<pieces.length;i++) {
          if(!skip){line+=pieces[i];if(Buffer.byteLength(line)>MAX_LINE_BYTES){line='';skip=true;}}
          if(i===pieces.length-1)continue;
          if(!skip&&line.trim()) {
            try {
              const entry=encodeRecord(JSON.parse(line));
              if(!seen.has(entry.json)){seen.add(entry.json);if(this.insert(entry))recovered++;}
            } catch { this.warning('Beschädigte Zeile im Rohprotokoll wurde bei der Wiederherstellung übersprungen.'); }
          }
          line='';skip=false;
        }
      }
      } catch(error) {
        this.warning(`Rohprotokoll ${name} konnte nicht wiederhergestellt werden: ${error.message}`);
      }
    }
    if(recovered){this.needCompaction=true;this.scheduleFlush();if(this.flushPromise)await this.flushPromise;}
  }

  prune() {
    let expired = 0;
    const now = Date.now();
    const retained = [];
    for (const entry of this.entries) {
      if (entry.timestamp < this.retentionCutoff(entry, now)) { this.removeEntry(entry); expired++; }
      else retained.push(entry);
    }
    if (expired) {
      this.entries = retained;
      this.needCompaction = true;
    }
    while (this.entries.length > this.maxRecords || this.memoryBytes > MAX_MEMORY_BYTES) {
      let index = this.entries.findIndex(entry => !this.isProtected(entry));
      if (index === -1) index = this.entries.findIndex(entry => this.isProtected(entry));
      const [removed] = this.entries.splice(index, 1);
      this.removeEntry(removed);
      this.droppedThrough = Math.max(this.droppedThrough || 0, removed.timestamp);
    }
    if (this.removals.length > MAX_REMOVALS) {
      const discarded = this.removals.length - MAX_REMOVALS;
      this.removalsThrough = this.removals[discarded - 1].revision;
      this.removals.splice(0, discarded);
    }
  }

  removeEntry(entry) {
    this.memoryBytes -= entry.bytes;
    this.removals.push({ revision: ++this.revision, sequence: entry.sequence });
  }

  record(record) {
    if (this.closed) throw new Error('Historie ist geschlossen.');
    const entry = encodeRecord(record);
    if (!this.insert(entry)) return false;
    if (this.file && !this.ioDisabled && !this.needCompaction) {
      this.pending.push(entry.json);
      this.pendingBytes += entry.bytes;
      if (this.pendingBytes > MAX_PENDING_BYTES) {
        this.pending = []; this.pendingBytes = 0; this.needCompaction = true;
      }
    }
    this.scheduleFlush();
    return true;
  }

  scheduleFlush() {
    if (!this.file || !this.started || this.ioDisabled || this.flushPromise || (!this.pending.length && !this.needCompaction)) return;
    let failed=false;
    this.flushPromise = Promise.resolve().then(() => this.flush()).catch(error => {
      failed=true;
      this.lastError = `Historie konnte nicht gespeichert werden: ${error.message}`;
      this.warning(this.lastError);
      this.needCompaction = true; // Retained memory is the recovery source for the next write.
    }).finally(() => { this.flushPromise = null; if(!failed)this.scheduleFlush(); });
  }

  async flush() {
    while (this.pending.length || this.needCompaction) {
      if (this.needCompaction) {
        this.prune();
        const entries = this.entries.slice();
        const meta = JSON.stringify({ type: '_meta', version: 1, droppedThrough: this.droppedThrough === null ? null : new Date(this.droppedThrough).toISOString() });
        const text = meta + '\n' + entries.map(entry => entry.json + '\n').join('');
        // This snapshot already includes pending records. New arrivals are appended after it.
        this.pending = []; this.pendingBytes = 0; this.needCompaction = false;
        await atomicWrite(this.file, text);
        this.diskRecords = entries.length;
        this.diskBytes = Buffer.byteLength(text);
      } else {
        const batch = this.pending;
        this.pending = []; this.pendingBytes = 0;
        const text = batch.join('\n') + '\n';
        await durableAppend(this.file, text);
        this.diskRecords += batch.length;
        this.diskBytes += Buffer.byteLength(text);
        if (this.diskRecords > 2 * this.maxRecords || this.diskBytes > MAX_DISK_BYTES) this.needCompaction = true;
      }
      this.lastError = null;
    }
  }

  snapshot(hours = 1, { cursor, measurementStartedAt = null, localOnly = false } = {}) {
    if (!HOURS.has(hours)) throw new TypeError('Historienfenster muss 1, 6, 24 oder 168 Stunden sein.');
    this.prune();
    this.scheduleFlush();
    const now = Date.now();
    const period = measurementStartedAt || null;
    const cutoff = period ? Date.parse(period) : null;
    const from = Math.max(now - hours * 3600000, cutoff ?? -Infinity);
    const previous = this.readCursor(cursor, hours, period, now);
    const records = [], recordIds = [];
    let total = 0;
    for (const entry of this.entries) {
      if (entry.timestamp < from || entry.timestamp > now || localOnly && entry.remote) continue;
      // Period tags disambiguate rows recorded in the same millisecond as reset.
      if (period && entry.measurementStartedAt !== period && (entry.measurementStartedAt || entry.timestamp <= cutoff)) continue;
      total++;
      if (previous && entry.sequence <= previous.revision && entry.timestamp <= previous.to) continue;
      records.push(JSON.parse(entry.json));
      recordIds.push(entry.sequence);
    }
    return { from: new Date(from).toISOString(), to: new Date(now).toISOString(), hours, records, total,
      cursor: this.cursor(hours, period, now), incremental: Boolean(previous), recordIds,
      removedRecordIds: previous ? this.removals.filter(removed => removed.revision > previous.revision).map(removed => removed.sequence) : [],
      maxRecords: this.maxRecords, ...(period ? { measurementStartedAt: period } : {}),
      retentionDays: this.retentionDays, truncated: this.droppedThrough !== null && this.droppedThrough >= from,
      warnings: [...this.warnings], lastError: this.lastError };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (!this.started) await this.start();
      this.closed = true;
      this.scheduleFlush();
      while(this.flushPromise){await this.flushPromise;if(this.lastError)break;}
    })();
    return this.closePromise;
  }
}
