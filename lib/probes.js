import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = fileURLToPath(new URL('../scripts/probe.ps1', import.meta.url));
const MAX_OUTPUT = 1024 * 1024;

export function validateHost(host) {
  if (typeof host !== 'string' || host.length > 253 || !host.length) throw new TypeError('Ungültiges Netzwerkziel.');
  if (isIP(host) === 4) return host;
  // IPv6 and numeric-looking invalid IPv4 are deliberately excluded from this IPv4 tool.
  if (/^[\d.]+$/.test(host) || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
    throw new TypeError('Ungültiges Netzwerkziel: nur IPv4 oder ein sicherer Hostname ist erlaubt.');
  }
  return host;
}

export function runProcess(command, args, { input = '', timeoutMs = 15000, signal, maxOutput = MAX_OUTPUT } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(abortError());
    const timer = setTimeout(() => finish(Object.assign(new Error('Die Netzwerkmessung hat ihr Zeitlimit überschritten.'), { code: 'PROBE_TIMEOUT' })), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, key] of [[child.stdout, 'out'], [child.stderr, 'err']]) {
      stream.setEncoding('utf8');
      stream.on('data', data => {
        if (done) return;
        bytes += Buffer.byteLength(data);
        if (bytes > maxOutput) return finish(Object.assign(new Error('Zu große Ausgabe der Netzwerkmessung.'), { code: 'OUTPUT_LIMIT' }));
        if (key === 'out') stdout += data; else stderr += data;
      });
    }
    child.on('error', error => finish(error));
    child.on('close', code => finish(null, { stdout, stderr, code }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
    child.stdin.end(input);
  });
}

function abortError() { return Object.assign(new Error('Messung abgebrochen.'), { name: 'AbortError', code: 'ABORT_ERR' }); }

async function powershell(mode, payload = {}, options = {}) {
  if (process.platform !== 'win32') throw new Error('Diese Messung benötigt Windows.');
  const { executable, args } = powershellCommand(mode);
  const result = await runProcess(executable, args, {
    ...options, input: JSON.stringify(payload)
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `Windows-Messung fehlgeschlagen (${result.code}).`);
  try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()); }
  catch { throw new Error('Windows-Messung lieferte keine gültigen JSON-Daten.'); }
}

function powershellCommand(mode) {
  return {
    executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode]
  };
}

export async function discoverNetwork() {
  const result = await powershell('discover', {}, { timeoutMs: 25000 });
  const wifi = parseWifi(result.wifiInterfaces || '', result.wifiNetworks || '', result.wifiError || null);
  const interfaces = result.interfaces || [];
  const activeIds = new Set(interfaces.map(entry => entry.id));
  const neighbors = result.neighborFallback
    ? parseArpOutput(result.neighborFallback).filter(entry => activeIds.has(entry.interfaceId))
    : result.neighbors || [];
  return { interfaces, defaultInterfaceId: result.defaultInterfaceId ?? null,
    neighbors, wifi, warnings: result.warnings || [] };
}

export async function getTrafficCounters() {
  return powershell('traffic', {}, { timeoutMs: 12000 });
}

// Game-process data stays internal to the detector, never in API/log payloads.
export async function getGameProcesses({ signal } = {}) {
  if (process.platform !== 'win32') throw Object.assign(new Error('Spieleerkennung benötigt Windows.'), { code: 'GAMES_UNSUPPORTED' });
  const result = await runProcess(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/games.ps1', import.meta.url))],
    { signal, timeoutMs: 15000, maxOutput: 2 * 1024 * 1024 });
  // Do not forward stderr: native errors can contain process/user paths.
  if (result.code !== 0) throw new Error('Windows-Prozessbeobachtung fehlgeschlagen.');
  try {
    const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
    if (!snapshot || !Array.isArray(snapshot.processes) || snapshot.processes.length > 4096 || !Array.isArray(snapshot.steamRoots) || !Array.isArray(snapshot.epicRoots)) throw new Error();
    return snapshot;
  } catch { throw new Error('Ungültige Windows-Prozessbeobachtung.'); }
}

export function parsePingResults(value, hosts) {
  if (!Array.isArray(value)) throw new Error('Ungültige Ping-Antwort.');
  if (value.length !== hosts.length) throw new Error('Unvollständige Ping-Antwort.');
  return hosts.map((host, i) => {
    const entry = value[i];
    if (!entry || entry.host !== host || typeof entry.status !== 'string') throw new Error('Unvollständige Ping-Antwort.');
    const ok = entry.status === 'Success' && entry.ok === true;
    if (entry.status === 'Success' && (!ok || !Number.isFinite(entry.ms) || entry.ms < 0)) throw new Error('Ungültige Ping-Latenz.');
    return { host, ok, ms: ok ? entry.ms : null,
      ...(typeof entry.routeInterfaceId==='string'&&/^\d{1,10}$/.test(entry.routeInterfaceId)?{routeInterfaceId:entry.routeInterfaceId}:{}),
      status: entry.status === 'Error' ? 'measurement_error' : entry.status,
      ...(typeof entry.error === 'string' ? { error: entry.error } : {}) };
  });
}

export async function pingMany(hosts, { timeoutMs = 1000, signal } = {}) {
  validatePingBatch(hosts, timeoutMs);
  if (!hosts.length) return [];
  const result = await powershell('ping', { hosts, timeoutMs }, { signal, timeoutMs: timeoutMs + 15000 });
  return parsePingResults(result, hosts);
}

function validatePingBatch(hosts, timeoutMs) {
  if (!Array.isArray(hosts) || hosts.length > 64) throw new TypeError('Ein Ping-Batch darf höchstens 64 Ziele enthalten.');
  hosts.forEach(validateHost);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new TypeError('Ping-Zeitlimit muss zwischen 100 und 10000 ms liegen.');
}

// The optional spawn implementation lets lifecycle tests exercise process races without networking.
export function createPingMonitor({ spawnImpl = spawn } = {}) {
  let worker = null, pending = null, closed = false;
  const failure = (message, code) => Object.assign(new Error(message), { code });
  const finish = (owner, error, results) => {
    if (owner !== worker) return; // An old process must never affect its replacement.
    if (error) {
      worker = null;
      try { owner.child.kill(); } catch { /* Process may already have exited. */ }
    }
    if (pending?.owner !== owner) return;
    const request = pending;
    pending = null;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    if (error) request.reject(error); else request.resolve(results);
  };
  const startWorker = () => {
    if (process.platform !== 'win32' && spawnImpl === spawn) throw new Error('Diese Messung benötigt Windows.');
    const { executable, args } = powershellCommand('worker');
    const owner = { child: spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }), buffer: '', stderr: '', bytes: 0 };
    worker = owner;
    owner.child.stdout.setEncoding('utf8');
    owner.child.stderr.setEncoding('utf8');
    owner.child.stdout.on('data', data => {
      if (owner !== worker) return;
      owner.bytes += Buffer.byteLength(data);
      if (owner.bytes > MAX_OUTPUT || Buffer.byteLength(owner.buffer) + Buffer.byteLength(data) > MAX_OUTPUT) return finish(owner, failure('Zu große Ausgabe des Ping-Messprozesses.', 'OUTPUT_LIMIT'));
      owner.buffer += data;
      let newline;
      while ((newline = owner.buffer.indexOf('\n')) !== -1) {
        const line = owner.buffer.slice(0, newline).replace(/^\uFEFF/, '').trim();
        owner.buffer = owner.buffer.slice(newline + 1);
        if (!line) continue;
        if (pending?.owner !== owner) return finish(owner, failure('Unerwartete Antwort des Ping-Messprozesses.', 'PING_WORKER_PROTOCOL'));
        try { finish(owner, null, parsePingResults(JSON.parse(line), pending.hosts)); }
        catch (error) { finish(owner, failure(`Ungültige Ping-Messantwort: ${error.message}`, 'PING_WORKER_PROTOCOL')); return; }
      }
    });
    owner.child.stderr.on('data', data => {
      if (owner !== worker) return;
      owner.bytes += Buffer.byteLength(data);
      if (owner.bytes > MAX_OUTPUT) return finish(owner, failure('Zu große Ausgabe des Ping-Messprozesses.', 'OUTPUT_LIMIT'));
      owner.stderr += data;
    });
    owner.child.on('error', error => finish(owner, error));
    owner.child.stdin.on('error', error => finish(owner, error));
    owner.child.stdout.on('error', error => finish(owner, error));
    owner.child.stderr.on('error', error => finish(owner, error));
    owner.child.on('close', (code, signal) => finish(owner, failure(owner.stderr.trim().slice(0, 2000) || `Ping-Messprozess beendet (${code ?? signal}).`, 'PING_WORKER_EXIT')));
    return owner;
  };
  return {
    async pingMany(hosts, { timeoutMs = 800, signal } = {}) {
      if (closed) throw failure('Ping-Überwachung ist geschlossen.', 'PING_MONITOR_CLOSED');
      if (pending) throw failure('Eine Ping-Messrunde läuft bereits.', 'PING_MONITOR_BUSY');
      validatePingBatch(hosts, timeoutMs);
      if (signal?.aborted) throw abortError();
      if (!hosts.length) return [];
      const owner = worker || startWorker();
      owner.bytes = 0;
      owner.stderr = '';
      return new Promise((resolve, reject) => {
        const abort = () => finish(owner, abortError());
        const timer = setTimeout(() => finish(owner, failure('Ping-Messprozess hat sein Zeitlimit überschritten.', 'PROBE_TIMEOUT')), timeoutMs + 5000);
        pending = { owner, hosts: [...hosts], signal, abort, timer, resolve, reject };
        signal?.addEventListener('abort', abort, { once: true });
        try { owner.child.stdin.write(JSON.stringify({ hosts, timeoutMs }) + '\n', error => { if (error) finish(owner, error); }); }
        catch (error) { finish(owner, error); }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (worker) finish(worker, failure('Ping-Überwachung ist geschlossen.', 'PING_MONITOR_CLOSED'));
    }
  };
}

const TRAFFIC_OUTPUT_LIMIT = 256 * 1024;
const TRAFFIC_COUNTER_KEYS = ['receivedBytes', 'sentBytes', 'receivedErrors', 'sentErrors', 'receivedDiscards', 'sentDiscards'];

export function parseTrafficCounters(value) {
  if (!Array.isArray(value) || value.length > 256) throw new Error('Ungültige Verkehrsmessantwort.');
  const ids = new Set();
  return value.map(entry => {
    if (!entry || typeof entry.id !== 'string' || !/^\d{1,10}$/.test(entry.id) || ids.has(entry.id) || typeof entry.name !== 'string' || entry.name.length > 512) throw new Error('Ungültige Netzwerkschnittstelle.');
    ids.add(entry.id);
    const counters = {};
    for (const key of TRAFFIC_COUNTER_KEYS) {
      const number = entry[key];
      if (!Number.isSafeInteger(number) || number < 0) throw new Error('Ungültiger Netzwerkzähler.');
      counters[key] = number;
    }
    if (typeof entry.status !== 'string' || !['Up', 'Down', 'Testing', 'Unknown', 'Dormant', 'NotPresent', 'LowerLayerDown'].includes(entry.status)) throw new Error('Ungültiger Schnittstellenstatus.');
    if (entry.linkSpeedMbps !== null && (!Number.isFinite(entry.linkSpeedMbps) || entry.linkSpeedMbps <= 0)) throw new Error('Ungültige Linkrate.');
    return { id: entry.id, name: entry.name, ...counters, status: entry.status, linkSpeedMbps: entry.linkSpeedMbps };
  });
}

// A separate process keeps slow counter reads out of the time-critical Ping
// pipeline. Request ownership protects subsequent samples from late callbacks.
export function createTrafficMonitor({ spawnImpl = spawn } = {}) {
  let worker = null, pending = null, closed = false, sequence = 0;
  const failure = (message, code) => Object.assign(new Error(message), { code });
  const finish = (owner, error, results, request = pending) => {
    if (owner !== worker || (request && request !== pending)) return;
    if (error) {
      worker = null;
      try { owner.child.kill(); } catch { /* Already exited. */ }
    }
    if (!request || request.owner !== owner) return;
    pending = null;
    clearTimeout(request.timer);
    request.signal?.removeEventListener('abort', request.abort);
    if (error) request.reject(error); else request.resolve(results);
  };
  const startWorker = () => {
    if (process.platform !== 'win32' && spawnImpl === spawn) throw new Error('Diese Messung benötigt Windows.');
    const { executable, args } = powershellCommand('traffic-worker');
    const owner = { child: spawnImpl(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] }), buffer: '', bytes: 0 };
    worker = owner;
    for (const stream of [owner.child.stdout, owner.child.stderr]) stream.setEncoding('utf8');
    owner.child.stdout.on('data', data => {
      if (owner !== worker) return;
      owner.bytes += Buffer.byteLength(data);
      if (owner.bytes > TRAFFIC_OUTPUT_LIMIT || Buffer.byteLength(owner.buffer) + Buffer.byteLength(data) > TRAFFIC_OUTPUT_LIMIT) return finish(owner, failure('Zu große Ausgabe der Verkehrsmessung.', 'OUTPUT_LIMIT'));
      owner.buffer += data;
      let newline;
      while ((newline = owner.buffer.indexOf('\n')) !== -1) {
        const line = owner.buffer.slice(0, newline).replace(/^\uFEFF/, '').trim();
        owner.buffer = owner.buffer.slice(newline + 1);
        if (!line) continue;
        const request = pending;
        try {
          const response = JSON.parse(line);
          if (!request || request.owner !== owner || response.requestId !== request.id) throw new Error('Unerwartete Messantwort.');
          finish(owner, null, parseTrafficCounters(response.counters), request);
        } catch (error) {
          finish(owner, failure(`Ungültige Verkehrsmessantwort: ${error.message}`, 'TRAFFIC_WORKER_PROTOCOL'));
          return;
        }
      }
    });
    owner.child.stderr.on('data', data => {
      if (owner !== worker) return;
      owner.bytes += Buffer.byteLength(data);
      if (owner.bytes > TRAFFIC_OUTPUT_LIMIT) finish(owner, failure('Zu große Ausgabe der Verkehrsmessung.', 'OUTPUT_LIMIT'));
    });
    for (const stream of [owner.child, owner.child.stdin, owner.child.stdout, owner.child.stderr]) stream.on('error', error => finish(owner, error));
    owner.child.on('close', () => finish(owner, failure('Verkehrsmessprozess wurde beendet.', 'TRAFFIC_WORKER_EXIT')));
    return owner;
  };
  return {
    async getTrafficCounters({ signal, timeoutMs = 4000 } = {}) {
      if (closed) throw failure('Verkehrsüberwachung ist geschlossen.', 'TRAFFIC_MONITOR_CLOSED');
      if (pending) throw failure('Eine Verkehrsmessung läuft bereits.', 'TRAFFIC_MONITOR_BUSY');
      if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 12000) throw new TypeError('Verkehrsmesszeitlimit muss zwischen 100 und 12000 ms liegen.');
      if (signal?.aborted) throw abortError();
      const owner = worker || startWorker();
      owner.bytes = 0;
      return new Promise((resolve, reject) => {
        const request = { owner, id: String(++sequence), signal, resolve, reject };
        request.abort = () => finish(owner, abortError(), undefined, request);
        request.timer = setTimeout(() => finish(owner, failure('Verkehrsmessprozess hat sein Zeitlimit überschritten.', 'PROBE_TIMEOUT'), undefined, request), timeoutMs);
        pending = request;
        signal?.addEventListener('abort', request.abort, { once: true });
        try { owner.child.stdin.write(JSON.stringify({ requestId: request.id }) + '\n', error => { if (error) finish(owner, error, undefined, request); }); }
        catch (error) { finish(owner, error, undefined, request); }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      if (worker) finish(worker, failure('Verkehrsüberwachung ist geschlossen.', 'TRAFFIC_MONITOR_CLOSED'));
    }
  };
}

export async function traceRoute(host, { signal } = {}) {
  validateHost(host);
  const result = await powershell('trace', { host }, { signal, timeoutMs: 26000 });
  return { host, output: result.output || '' };
}

function numeric(value) {
  const match = String(value || '').match(/\d+(?:[.,]\d+)?/);
  return match ? Number(match[0].replace(',', '.')) : null;
}

export function parseArpOutput(output = '') {
  let interfaceId = null;
  const neighbors = [];
  for (const line of output.split(/\r?\n/)) {
    const header = line.match(/---\s*0x([\da-f]+)\s*$/i);
    if (header) { interfaceId = String(parseInt(header[1], 16)); continue; }
    const entry = line.match(/^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+((?:[\da-f]{2}-){5}[\da-f]{2})\s+\S+\s*$/i);
    if (!entry || interfaceId === null || isIP(entry[1]) !== 4) continue;
    const mac = entry[2].toLowerCase();
    // Multicast and broadcast entries are groups, not individual devices.
    if ((parseInt(mac.slice(0, 2), 16) & 1) || mac === '00-00-00-00-00-00') continue;
    neighbors.push({ ip: entry[1], mac, state: 'Cached', interfaceId });
  }
  return neighbors;
}

function wifiError(text) {
  if (/(?:error\s+\d+|fehler\s+\d+|access (?:is )?denied|zugriff.*verweigert|requires elevation|administrator|location permission|location access|standort|positionsdaten|wlan service.*not running|wlan.*dienst.*nicht|no wireless interface|keine.*drahtlos|keine.*wlan)/i.test(text)) return text.trim().slice(0, 2000);
  return null;
}

export function parseWifi(interfaceText = '', networkText = '', error = null) {
  const wifi = { connected: false, ssid: null, bssid: null, signalPercent: null, channel: null, radio: null,
    receiveRateMbps: null, transmitRateMbps: null, networks: [], error: error || wifiError(interfaceText) || wifiError(networkText) };
  let current = null;
  const interfaces = [];
  for (const line of interfaceText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2];
    if (key === 'name') { current = {}; interfaces.push(current); }
    if (!current) { current = {}; interfaces.push(current); }
    if (key === 'state' || key === 'status' || key === 'zustand') current.connected = /^(connected|verbunden)$/i.test(value);
    else if (key === 'ssid') current.ssid = value;
    else if (key === 'bssid' || key === 'ap bssid') current.bssid = value;
    else if (key === 'signal') current.signalPercent = numeric(value);
    else if (key === 'channel' || key === 'kanal') current.channel = numeric(value);
    else if (key === 'radio type' || key === 'funktyp') current.radio = value;
    else if (/^(receive rate|empfangsrate)/.test(key)) current.receiveRateMbps = numeric(value);
    else if (/^(transmit rate|übertragungsrate|senderate)/.test(key)) current.transmitRateMbps = numeric(value);
  }
  const connected = interfaces.find(entry => entry.connected);
  if (connected) Object.assign(wifi, connected);
  let ssid = null, network = null;
  for (const line of networkText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2];
    if (/^ssid\s+\d+$/.test(key)) { ssid = value; network = null; }
    else if (/^bssid\s+\d+$/.test(key) && ssid !== null) {
      network = { ssid, bssid: value, channel: null, signalPercent: null, radio: null };
      wifi.networks.push(network);
    } else if (network && key === 'signal') network.signalPercent = numeric(value);
    else if (network && (key === 'channel' || key === 'kanal')) network.channel = numeric(value);
    else if (network && (key === 'radio type' || key === 'funktyp')) network.radio = value;
  }
  return wifi;
}
