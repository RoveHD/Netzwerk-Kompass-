import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const iso = () => new Date().toISOString();
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const ARCHIVE = /^\d{13}-[a-f\d-]{36}\.json$/i;
const REASONS = new Set(['normal', 'windows_shutdown', 'launcher_lost', 'signal', 'startup_error']);

export function safeStoredData(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (/^(?:password|passwd|passwort|kennwort|username|benutzername|authorization|secret|token|accessToken|refreshToken|sid|credentials)$/i.test(key)) return undefined;
    if (typeof item !== 'string') return item;
    return item.replace(/\b(password|passwd|passwort|kennwort|username|benutzername|authorization|access[_ -]?token|api[_ -]?key|sid)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;&<>"']+)/gi, '$1=[entfernt]')
      .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [entfernt]');
  }));
}

// Flush file contents before replacement. Directory fsync is supported on Unix;
// Windows does not expose it through Node. Never suppress file/rename failures.
export async function atomicWrite(file, text) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      const directory = await open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function durableAppend(file, text) {
  const handle = await open(file, 'a');
  try {
    // A crash may have left a partial JSON line. Separate it from new records.
    await handle.writeFile('\n' + text, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
}

function summary(analysis) {
  const { report, result, ...metadata } = analysis;
  return { ...metadata, hasResult: typeof result === 'string' && !!result };
}

export class SessionStore {
  constructor({ dataDir } = {}) {
    this.dataDir = dataDir ? path.resolve(dataDir) : null;
    this.sessions = []; this.analyses = []; this.currentSession = null;
    this.queue = Promise.resolve(); this.lastError = null;
  }
  start() {
    if (!this.startPromise) this.startPromise = this.load().catch(error => {
      this.lastError = `Sitzungen/Diagnosen konnten nicht geladen werden: ${error.message}`;
      this.disabled = true;
    });
    return this.startPromise;
  }
  async recent(kind, limit, maxBytes) {
    const directory = path.join(this.dataDir, kind);
    await mkdir(directory, { recursive: true });
    const names = (await readdir(directory)).filter(name => ARCHIVE.test(name)).sort().reverse().slice(0, limit);
    const records = [];
    for (const name of names) {
      try {
        const handle = await open(path.join(directory, name), 'r'); let text;
        try { if ((await handle.stat()).size > maxBytes) throw new Error('Archivdatei zu groß'); text = await handle.readFile('utf8'); }
        finally { await handle.close(); }
        const item = JSON.parse(text);
        if (!UUID.test(item.id) || name !== this.filename(item) || !Number.isFinite(Date.parse(item.startedAt))) throw new Error('Ungültiges Archivformat');
        records.push(item);
      } catch (error) { this.lastError = `Beschädigte ${kind}-Archivdatei übersprungen: ${error.message}`; }
    }
    return records;
  }
  async load() {
    if (!this.dataDir) return;
    this.sessions = await this.recent('sessions', 100, 16384);
    this.analyses = await this.recent('diagnoses', 20, 2 * 1024 * 1024);
    for (const session of this.sessions) if (session.status === 'running' || session.status === 'closing') {
      Object.assign(session, { status: 'interrupted', reason: session.shutdownReason ? 'shutdown_incomplete' : 'unexpected_interruption', endedAt: null, detectedAt: iso() });
      await this.write('sessions', session);
    }
    for (const analysis of this.analyses) if (analysis.status === 'running') {
      Object.assign(analysis, { status: 'interrupted', error: 'Auswertung wurde unerwartet unterbrochen.', finishedAt: null, detectedAt: iso() });
      await this.write('diagnoses', analysis);
    }
  }
  filename(item) { return `${String(Date.parse(item.startedAt)).padStart(13, '0')}-${item.id}.json`; }
  async write(kind, item) {
    if (!this.dataDir || this.disabled) return;
    await atomicWrite(path.join(this.dataDir, kind, this.filename(item)), JSON.stringify(item, null, 2) + '\n');
  }
  enqueue(action) {
    const task = this.queue.then(async () => { await this.start(); if (!this.disabled) await action(); });
    this.queue = task.catch(error => { this.lastError = `Sitzung/Diagnose konnte nicht gespeichert werden: ${error.message}`; });
    return task;
  }
  beginSession() {
    if (this.beginPromise) return this.beginPromise;
    this.beginPromise = this.enqueue(async () => {
      const session = { id: randomUUID(), startedAt: iso(), status: 'running', reason: null, endedAt: null, lastPersistedAt: null };
      await this.write('sessions', session);
      this.currentSession = session;
      this.sessions.unshift(session); this.sessions.length = Math.min(this.sessions.length, 100);
    });
    return this.beginPromise;
  }
  notePersisted(at) {
    return this.enqueue(async () => {
      if (!this.currentSession || !['running','closing'].includes(this.currentSession.status)) return;
      this.currentSession.lastPersistedAt = iso();
      this.currentSession.lastRecordAt = at;
      await this.write('sessions', this.currentSession);
    });
  }
  saveAnalysis(item) {
    if (!UUID.test(item.id) || !Number.isFinite(Date.parse(item.startedAt))) throw new TypeError('Ungültige Diagnose-ID oder Startzeit.');
    // Copy at enqueue time, so cancellation/reset cannot change a queued save.
    const copy = safeStoredData(item);
    if (Buffer.byteLength(JSON.stringify(copy,null,2)+'\n') > 2 * 1024 * 1024) throw new TypeError('Diagnose ist zu groß.');
    return this.enqueue(async () => {
      await this.write('diagnoses', copy);
      this.analyses = [copy, ...this.analyses.filter(value => value.id !== copy.id)].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 20);
    });
  }
  async getAnalysis(id) {
    if (!UUID.test(id)) throw new TypeError('Ungültige Diagnose-ID.');
    await this.start(); await this.queue;
    const cached = this.analyses.find(item => item.id === id);
    if (cached) return JSON.parse(JSON.stringify(cached));
    if (!this.dataDir || this.disabled) return null;
    const directory = path.join(this.dataDir, 'diagnoses');
    const filename = (await readdir(directory)).find(name => ARCHIVE.test(name) && name.endsWith(`-${id}.json`));
    if (!filename) return null;
    return this.readAnalysis(filename,id);
  }
  async readAnalysis(filename,id) {
    if(!ARCHIVE.test(filename)||!UUID.test(id)||!filename.endsWith(`-${id}.json`))throw new TypeError('Ungültige Diagnose-ID.');
    const handle = await open(path.join(this.dataDir,'diagnoses',filename), 'r');
    try {
      if ((await handle.stat()).size > 2 * 1024 * 1024) throw new Error('Diagnose ist zu groß.');
      const item = JSON.parse(await handle.readFile('utf8'));
      if (item.id !== id || this.filename(item) !== filename) throw new Error('Ungültige Diagnose.');
      return item;
    } finally { await handle.close(); }
  }
  async listAnalyses({offset=0,limit=20}={}) {
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw new TypeError('Ungültige Archivseite.');
    await this.start();await this.queue;
    if(!this.dataDir||this.disabled)return {analyses:this.analyses.slice(offset,offset+limit).map(summary),total:this.analyses.length,offset,limit};
    const directory=path.join(this.dataDir,'diagnoses');
    const files=(await readdir(directory)).filter(name=>ARCHIVE.test(name)).sort().reverse();
    const analyses=[];
    for(const name of files.slice(offset,offset+limit)) {
      const id=name.slice(14,-5);
      try {
        const item=this.analyses.find(value=>value.id===id)||await this.readAnalysis(name,id);
        analyses.push(summary(item));
      } catch(error) { this.lastError=`Beschädigte diagnoses-Archivdatei übersprungen: ${error.message}`; }
    }
    return {analyses,total:files.length,offset,limit};
  }
  snapshot() {
    return { enabled: !!this.dataDir && !this.disabled, currentSession: this.currentSession ? { ...this.currentSession } : null,
      sessions: this.sessions.map(item => ({ ...item })), analyses: this.analyses.map(summary), lastError: this.lastError };
  }
  requestClose({reason='normal'}={}) {
    if(this.closeIntentPromise)return this.closeIntentPromise;
    if(!REASONS.has(reason))throw new TypeError('Ungültiger Sitzungsabschlussgrund.');
    this.closeIntentPromise=this.enqueue(async()=>{
      if(!this.currentSession)return;
      const closing={...this.currentSession,status:'closing',shutdownReason:reason,shutdownRequestedAt:iso()};
      await this.write('sessions',closing);Object.assign(this.currentSession,closing);
    });
    return this.closeIntentPromise;
  }
  close({ reason = 'normal' } = {}) {
    if (this.closePromise) return this.closePromise;
    if (!REASONS.has(reason)) throw new TypeError('Ungültiger Sitzungsabschlussgrund.');
    this.closePromise = this.enqueue(async () => {
      if (!this.currentSession) return;
      const closed = { ...this.currentSession, status: reason === 'launcher_lost' || reason === 'startup_error' ? 'interrupted' : 'completed', reason, endedAt: iso() };
      await this.write('sessions', closed); Object.assign(this.currentSession, closed);
    });
    return this.closePromise;
  }
}
