import https from 'node:https';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './session-store.js';
import { createSecretStore } from './secret-store.js';
import { createPeerCertificate, isPrivateAddress, pinnedRequest } from './peer-tls.js';
import { projectPeerRecord } from './peer-telemetry.js';

export { projectPeerRecord } from './peer-telemetry.js';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const clone = value => structuredClone(value);
const nameOf = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : 'Dieser PC';
const MAX_OUTBOX = 2000, MAX_OUTBOX_BYTES = 4 * 1024 * 1024, MAX_RECORDS = 1000, MAX_PEERS = 16;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export function createPeerMonitor(options) { return new PeerMonitor(options); }

export class PeerMonitor {
  constructor({ dataDir, secretStore, now = Date.now, autoFlush = true } = {}) {
    if (!dataDir) throw new Error('PC-Kopplung benötigt einen dauerhaften Datenordner.');
    this.dataDir = path.resolve(dataDir); this.file = path.join(this.dataDir, 'peer-state.json');
    this.secrets = secretStore || createSecretStore({ dataDir: this.dataDir });
    this.now = now; this.autoFlush = autoFlush; this.queue = Promise.resolve(); this.listeners = new Set();
    this.challenges = new Map(); this.helloNonces = new Map(); this.sockets = new Set(); this.closed = false;
    this.generation = 0; this.attempt = 0; this.lastError = null; this.abort = new AbortController();
  }
  initialize() {
    if (!this.initializing) this.initializing = this.load();
    return this.initializing;
  }
  async load() {
    await mkdir(this.dataDir, { recursive: true });
    let state;
    try {
      if ((await stat(this.file)).size > 16 * 1024 * 1024) throw new Error('Peer-Speicher überschreitet das Größenlimit.');
      state = JSON.parse(await readFile(this.file, 'utf8'));
      if (state.version !== 1 || !UUID.test(state.deviceId) || !Number.isSafeInteger(state.nextSequence) || state.nextSequence < 1 || !Array.isArray(state.outbox) || state.outbox.length > MAX_OUTBOX || !Array.isArray(state.records) || state.records.length > MAX_RECORDS || !Array.isArray(state.peers) || state.peers.length > MAX_PEERS) throw new Error('Ungültiger Peer-Speicher; keine automatische Rücksetzung.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { version: 1, deviceId: randomUUID(), nextSequence: 1, config: { enabled: false, role: 'agent', listenHost: '0.0.0.0', port: 47831, name: 'Dieser PC' }, peers: [], outbox: [], records: [], dropped: 0 };
      await atomicWrite(this.file, JSON.stringify(state));
    }
    this.state = state;
    // DPAPI is only needed after the user enables pairing, so optional LAN
    // features do not stop local monitoring on unsupported operating systems.
    if (state.config.enabled || state.peers.length) this.auth = await this.secrets.read('peer-auth');
    if (state.peers.length && !this.auth) throw new Error('Geschützte Peer-Schlüssel fehlen. Kopplung kann nicht fortgesetzt werden.');
    if (state.config.enabled && !this.closed) {
      await this.ensureAuth();
      if (state.config.role === 'central') await this.listen(); else this.schedule(0);
    }
    return this.snapshot();
  }
  serial(action) {
    const task = this.queue.then(async () => { await this.initialize(); if (this.closed) throw new Error('PC-Kopplung ist beendet.'); return action(); });
    this.queue = task.catch(error => { this.lastError = error.message; });
    return task;
  }
  async save() { await atomicWrite(this.file, JSON.stringify(this.state)); }
  async ensureAuth() {
    if (!this.auth) this.auth = await this.secrets.read('peer-auth');
    if (!this.auth) {
      const auth = { version: 1, deviceId: this.state.deviceId, identity: createPeerCertificate(this.state.deviceId), tokens: {}, grants: [] };
      await this.secrets.write('peer-auth', auth); this.auth = auth;
    }
    if (this.auth.version !== 1 || this.auth.deviceId !== this.state.deviceId || !this.auth.identity?.key || !this.auth.identity?.cert || !/^[a-f0-9]{64}$/.test(this.auth.identity?.pin) || !this.auth.tokens || typeof this.auth.tokens !== 'object' || !Array.isArray(this.auth.grants)) throw new Error('Geschützte PC-Identität passt nicht zum Messspeicher.');
  }
  snapshot({ includeRecords = true } = {}) {
    if (!this.state) return { available: false, lastError: this.lastError, peers: [], records: [], outboxCount: 0 };
    return { available: true, deviceId: this.state.deviceId, config: clone(this.state.config),
      listening: !!this.server?.listening, port: this.server?.address()?.port || this.state.config.port,
      pin: this.auth?.identity.pin || null, outboxCount: this.state.outbox.length, dropped: this.state.dropped,
      peers: this.state.peers.map(peer => ({ ...clone(peer), connected: this.state.config.enabled && Number.isFinite(peer.lastSeenAt) && this.now() - peer.lastSeenAt < 45000,
        connectionMeaning: 'Nur Verbindung zum Mess-PC; kein Nachweis eines WLAN-Ausfalls.' })),
      ...(includeRecords ? { records: clone(this.state.records) } : {}), lastError: this.lastError };
  }
  configure(input) {
    return this.serial(async () => {
      if (typeof input.enabled !== 'boolean' || !['central', 'agent'].includes(input.role)) throw new Error('Rolle und Aktivierungsstatus erforderlich.');
      const port = input.port ?? this.state.config.port;
      const listenHost = input.listenHost ?? this.state.config.listenHost;
      if (!Number.isInteger(port) || port < 0 || port > 65535 || (listenHost !== '0.0.0.0' && !isPrivateAddress(listenHost))) throw new Error('Nur eine lokale IPv4-Adresse und ein gültiger Port sind erlaubt.');
      if (input.role !== this.state.config.role && this.state.peers.length) throw new Error('Vor einem Rollenwechsel bestehende Kopplungen widerrufen.');
      this.generation++; this.abort.abort(); this.abort = new AbortController(); clearTimeout(this.timer); this.timer = null;
      await this.stopServer();
      this.state.config = { enabled: input.enabled, role: input.role, listenHost, port, name: nameOf(input.name ?? this.state.config.name) };
      // First persist disabled: failed key protection or a bind error must never
      // turn into an unexpected listening endpoint after a restart.
      this.state.config.enabled = false; await this.save();
      if (input.enabled) {
        await this.ensureAuth();
        this.state.config.enabled = true;
        try { if (input.role === 'central') await this.listen(); await this.save(); }
        catch (error) { this.state.config.enabled = false; await this.stopServer(); await this.save(); throw error; }
        if (input.role === 'agent') this.schedule(0);
      }
      this.lastError = null;
      return this.snapshot();
    });
  }
  createPairing() {
    return this.serial(async () => {
      if (!this.state.config.enabled || this.state.config.role !== 'central' || !this.server?.listening) throw new Error('Zuerst die Zentrale einschalten.');
      if (this.state.peers.length >= MAX_PEERS) throw new Error('Höchstens 16 PCs können gekoppelt werden.');
      const grant = { secret: secret(), expiresAt: this.now() + 5 * 60000 };
      // One pending invitation. Reissuing explicitly invalidates the old code.
      this.auth.grants = [grant]; await this.secrets.write('peer-auth', this.auth);
      return { version: 1, centralId: this.state.deviceId, port: this.server.address().port, pin: this.auth.identity.pin, ...grant };
    });
  }
  pair(input) {
    return this.serial(async () => {
      if (!this.state.config.enabled || this.state.config.role !== 'agent') throw new Error('Zuerst diesen PC als Mess-PC einschalten.');
      if (this.state.peers.length) throw new Error('Vor einer neuen Kopplung die bisherige Kopplung widerrufen.');
      if (!UUID.test(input.centralId) || input.centralId === this.state.deviceId || typeof input.secret !== 'string' || input.secret.length !== 43) throw new Error('Ungültiger Kopplungscode.');
      const result = await pinnedRequest(input, '/v1/pair', { deviceId: this.state.deviceId, name: this.state.config.name, secret: input.secret }, { signal: this.abort.signal });
      if (result.centralId !== input.centralId || typeof result.token !== 'string' || result.token.length !== 43) throw new Error('Kopplungsantwort gehört nicht zur gewählten Zentrale.');
      this.auth.tokens[input.centralId] = result.token; await this.secrets.write('peer-auth', this.auth);
      this.state.peers = [{ id: input.centralId, name: nameOf(result.name), address: input.address, port: input.port, pin: input.pin.toLowerCase(), lastSeenAt: null }];
      await this.save(); this.lastError = null; this.schedule(0); return this.snapshot();
    });
  }
  revoke({ peerId }) {
    return this.serial(async () => {
      if (!UUID.test(peerId)) throw new Error('Ungültige PC-ID.');
      this.generation++; this.abort.abort(); this.abort = new AbortController();
      this.state.peers = this.state.peers.filter(peer => peer.id !== peerId);
      // Removing the durable allowlist is the security boundary. Even when key
      // cleanup fails, the old token no longer authenticates after restart.
      if (this.state.config.role === 'agent') this.state.outbox = [];
      await this.save();
      if (this.auth) { delete this.auth.tokens[peerId]; await this.secrets.write('peer-auth', this.auth); }
      this.challenges.clear(); this.helloNonces.clear(); return this.snapshot();
    });
  }
  enqueue(input) {
    const record = projectPeerRecord(input);
    if (!record) return Promise.resolve(false);
    return this.serial(async () => {
      if (!this.state.config.enabled || this.state.config.role !== 'agent' || !this.state.peers.length) return false;
      if (this.state.nextSequence >= Number.MAX_SAFE_INTEGER) throw new Error('Messfolgenummer ist ausgeschöpft.');
      this.state.outbox.push({ sequence: this.state.nextSequence++, record });
      let bytes = Buffer.byteLength(JSON.stringify(this.state.outbox));
      while (this.state.outbox.length > MAX_OUTBOX || bytes > MAX_OUTBOX_BYTES) {
        const removed = this.state.outbox.shift(); bytes -= Buffer.byteLength(JSON.stringify(removed)) + 1; this.state.dropped++;
      }
      await this.save(); this.schedule(1000); return true;
    });
  }
  onRecord(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  schedule(delay) {
    if (!this.autoFlush || this.closed || !this.state?.config.enabled || this.state.config.role !== 'agent' || !this.state.peers.length || this.timer || this.flushing) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, delay); this.timer.unref?.();
  }
  flush() {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
      this.schedule(this.attempt ? Math.min(60000, 1000 * 2 ** Math.min(this.attempt, 6)) + Math.floor(Math.random() * 500) : this.state?.outbox.length ? 200 : 10000);
    });
    return this.flushing;
  }
  async flushOnce() {
    await this.initialize(); await this.queue;
    if (this.closed || !this.state.config.enabled || this.state.config.role !== 'agent') return;
    const peer = this.state.peers[0]; if (!peer) return;
    const generation = this.generation, token = this.auth.tokens[peer.id], signal = this.abort.signal;
    const records = clone(this.state.outbox.slice(0, 8));
    try {
      const t0 = this.now();
      const hello = await pinnedRequest(peer, '/v1/hello', { deviceId: this.state.deviceId, token, t0, nonce: secret() }, { signal });
      const t3 = this.now();
      const result = await pinnedRequest(peer, '/v1/records', { deviceId: this.state.deviceId, token, challenge: hello.challenge, t3, records }, { signal });
      await this.serial(async () => {
        if (generation !== this.generation || this.state.peers[0]?.id !== peer.id) return;
        if (!Number.isSafeInteger(result.ack) || result.ack < 0 || result.ack >= this.state.nextSequence) throw new Error('Ungültige Messbestätigung.');
        this.state.outbox = this.state.outbox.filter(item => item.sequence > result.ack);
        peer.lastSeenAt = this.now(); peer.clockOffsetMs = result.clockOffsetMs; peer.clockUncertaintyMs = result.clockUncertaintyMs;
        await this.save(); this.lastError = null; this.attempt = 0;
      });
    } catch (error) {
      if (generation === this.generation && !this.closed) { this.attempt++; this.lastError = error.message; }
      throw error;
    }
  }
  async listen() {
    if(this.closed)throw new Error('PC-Kopplung ist beendet.');
    const server = https.createServer({ key: this.auth.identity.key, cert: this.auth.identity.cert, minVersion: 'TLSv1.2', maxHeaderSize: 4096 }, (req, res) => this.handle(req, res));
    this.server = server; this.window = { at: this.now(), count: 0 }; this.activeRequests = 0;
    server.maxConnections = 24; server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
    server.on('connection', socket => { this.sockets.add(socket); socket.setTimeout(10000, () => socket.destroy()); socket.once('close', () => this.sockets.delete(socket)); });
    server.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.state.config.port, this.state.config.listenHost, () => { server.removeListener('error', reject); resolve(); }); });
    server.on('error', error => { this.lastError = `Peer-Dienst: ${error.code || 'Verbindungsfehler'}`; });
  }
  async handle(req, res) {
    // Let the pinned client close after it has read the complete reply. An
    // immediate Connection:close/destroySoon can reset unread TLS data on Windows.
    const respond = (status, data) => { if (!res.destroyed && !res.headersSent) { const body=JSON.stringify(data);res.writeHead(status, { 'content-type': 'application/json', 'content-length':Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body); } };
    if (this.closed || !this.state.config.enabled || !isPrivateAddress(req.socket.remoteAddress)) return respond(403, { error: 'LAN-Verbindung nicht freigegeben.' });
    if (req.method !== 'POST' || !['/v1/pair', '/v1/hello', '/v1/records'].includes(req.url)) return respond(404, { error: 'Unbekannter Messendpunkt.' });
    if (this.now() - this.window.at > 60000) this.window = { at: this.now(), count: 0 };
    if (++this.window.count > 2400 || this.activeRequests >= 8) return respond(429, { error: 'Zu viele Peer-Anfragen.' });
    if (req.headers['content-type'] !== 'application/json') return respond(415, { error: 'JSON erforderlich.' });
    if (Number(req.headers['content-length']) > 98304) return respond(413, { error: 'Peer-Anfrage ist zu groß.' });
    this.activeRequests++;
    try {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 98304) { respond(413, { error: 'Peer-Anfrage ist zu groß.' }); req.destroy(); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('Ungültige Messanfrage.');
      const receivedAt = this.now();
      const result = await this.serial(() => this.receive(req.url, body, receivedAt));
      respond(200, result);
    } catch (error) { respond(error.status || 400, { error: error.status ? error.message : 'Messanfrage konnte nicht verarbeitet werden.' }); }
    finally { this.activeRequests--; }
  }
  async receive(route, body, receivedAt) {
    if (!this.state.config.enabled || this.state.config.role !== 'central') throw fail('Zentrale ist ausgeschaltet.', 403);
    if (!UUID.test(body.deviceId) || body.deviceId === this.state.deviceId) throw fail('Ungültige PC-ID.', 403);
    if (route === '/v1/pair') {
      const grant = this.auth.grants.find(item => item.expiresAt > this.now() && equal(item.secret, body.secret));
      if (!grant || this.state.peers.some(peer => peer.id === body.deviceId)) throw fail('Kopplungscode ungültig, verbraucht oder abgelaufen.', 403);
      if (this.state.peers.length >= MAX_PEERS) throw fail('PC-Limit erreicht.', 409);
      const token = secret();
      this.auth.grants = []; this.auth.tokens[body.deviceId] = token;
      await this.secrets.write('peer-auth', this.auth);
      this.state.peers.push({ id: body.deviceId, name: nameOf(body.name), highestSequence: 0, lastSeenAt: null, newestAt: null });
      await this.save();
      return { centralId: this.state.deviceId, name: this.state.config.name, token };
    }
    const peer = this.state.peers.find(item => item.id === body.deviceId);
    if (!peer || !equal(this.auth.tokens[body.deviceId], body.token)) throw fail('PC-Kopplung wurde nicht bestätigt oder widerrufen.', 403);
    if (route === '/v1/hello') {
      if (!Number.isSafeInteger(body.t0) || typeof body.nonce !== 'string' || !/^[\w-]{43}$/.test(body.nonce)) throw fail('Ungültiger Zeitabgleich.');
      for (const [key, expires] of this.helloNonces) if (expires < this.now()) this.helloNonces.delete(key);
      const nonceKey = `${peer.id}:${body.nonce}`;
      if (this.helloNonces.has(nonceKey)) throw fail('Wiederholter Zeitabgleich.', 409);
      if (this.helloNonces.size >= 8192) throw fail('Zeitabgleich-Limit erreicht.', 429);
      this.helloNonces.set(nonceKey, this.now() + 5 * 60000);
      const challenge = secret();
      // One live challenge per paired PC bounds memory and invalidates stale
      // parallel batches. Socket encryption additionally prevents wire replay.
      const item = { challenge, t0: body.t0, t1: receivedAt, t2: this.now(), expiresAt: this.now() + 30000 };
      this.challenges.set(peer.id, item);
      return { challenge, t1: item.t1, t2: item.t2 };
    }
    const clock = this.challenges.get(peer.id);
    if (!clock || clock.expiresAt < this.now() || !equal(clock.challenge, body.challenge)) throw fail('Zeitabgleich fehlt oder wurde bereits verwendet.', 409);
    this.challenges.delete(peer.id);
    const elapsed = body.t3 - clock.t0, processing = clock.t2 - clock.t1;
    if (!Number.isSafeInteger(body.t3) || elapsed < processing || elapsed > 30000 || elapsed < 0) throw fail('PC-Uhr wurde während des Zeitabgleichs verändert.');
    if (!Array.isArray(body.records) || body.records.length > 8) throw fail('Zu viele Messungen in einer Anfrage.');
    const offset = ((clock.t1 - clock.t0) + (clock.t2 - body.t3)) / 2, uncertainty = (elapsed - processing) / 2;
    let highest = peer.highestSequence, newest = peer.newestAt ?? -Infinity;
    const accepted = [];
    for (const envelope of body.records) {
      if (!Number.isSafeInteger(envelope?.sequence) || envelope.sequence < 1) throw fail('Ungültige Messfolgenummer.');
      if (envelope.sequence <= highest) continue;
      const record = projectPeerRecord(envelope.record); if (!record) throw fail('Nicht freigegebene Messdaten.');
      const sourceTime = Date.parse(record.at), corrected = sourceTime + offset;
      if (!Number.isFinite(corrected) || Math.abs(corrected) > 8640000000000000) throw fail('Ungültige Messzeit.');
      const correctedIntervals = {};
      if (record.intervalStartedAt) { correctedIntervals.sourceIntervalStartedAt = record.intervalStartedAt; correctedIntervals.intervalStartedAt = new Date(Date.parse(record.intervalStartedAt) + offset).toISOString(); }
      if (record.adapterHealth?.intervalStartedAt) correctedIntervals.adapterHealth = { ...record.adapterHealth, sourceIntervalStartedAt: record.adapterHealth.intervalStartedAt, intervalStartedAt: new Date(Date.parse(record.adapterHealth.intervalStartedAt) + offset).toISOString() };
      accepted.push({ ...record, ...correctedIntervals, remote: true, sourceDeviceId: peer.id, sequence: envelope.sequence, sequenceGap: envelope.sequence - highest - 1, sourceAt: record.at, at: new Date(corrected).toISOString(),
        // 100 ppm drift allowance: old buffered measurements cannot inherit the
        // apparent precision of a freshly performed clock exchange.
        clockOffsetMs: offset, clockUncertaintyMs: uncertainty + Math.abs(sourceTime - body.t3) * 0.0001,
        // A new handshake cannot prove the historical clock offset before an
        // offline period or a wall-clock jump. Retain those records, but exclude
        // them from causal cross-PC alignment (rather than invent precision).
        clockReliable: Math.abs(sourceTime - body.t3) <= 30000 && uncertainty <= 1000,
        late: corrected < newest - 5000 });
      highest = envelope.sequence; newest = Math.max(newest, corrected);
    }
    const previous = clone(this.state);
    peer.highestSequence = highest; peer.newestAt = Number.isFinite(newest) ? newest : null; peer.lastSeenAt = this.now(); peer.clockOffsetMs = offset; peer.clockUncertaintyMs = uncertainty;
    this.state.records.push(...accepted); this.state.records = this.state.records.slice(-MAX_RECORDS);
    try { await this.save(); } catch (error) { this.state = previous; throw error; }
    // Durable inbox and high-water mark precede both acknowledgement and
    // callbacks, so a lost acknowledgement cannot duplicate accepted records.
    for (const record of accepted) for (const listener of this.listeners) {
      try { const pending = listener(clone(record)); pending?.catch?.(() => { this.lastError = 'Empfangene Messung konnte nicht weitergegeben werden.'; }); }
      catch { this.lastError = 'Empfangene Messung konnte nicht weitergegeben werden.'; }
    }
    return { ack: highest, clockOffsetMs: offset, clockUncertaintyMs: uncertainty };
  }
  async stopServer() {
    const server = this.server; this.server = null;
    if (server) { const closing = new Promise(resolve => server.close(resolve)); for (const socket of this.sockets) socket.destroy(); await closing; }
    this.challenges.clear(); this.helloNonces.clear();
  }
  async close() {
    this.closed = true; this.generation++; clearTimeout(this.timer); this.timer = null; this.abort.abort();
    await this.stopServer(); await this.flushing?.catch(() => {}); await this.queue;
  }
}
