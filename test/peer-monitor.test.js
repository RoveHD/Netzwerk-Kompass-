import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { createPeerMonitor, projectPeerRecord } from '../lib/peer-monitor.js';
import { createPeerCertificate, pinnedRequest } from '../lib/peer-tls.js';

const nonce = () => randomBytes(32).toString('base64url');
function fakeSecrets() {
  const values = new Map();
  return { async read(key) { return structuredClone(values.get(key) ?? null); }, async write(key, value) { values.set(key, structuredClone(value)); }, async remove(key) { values.delete(key); } };
}
async function setup(t, { skew = 0 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kompass-peer-'));
  const centralSecrets = fakeSecrets(), agentSecrets = fakeSecrets();
  let central = createPeerMonitor({ dataDir: path.join(dir, 'central'), secretStore: centralSecrets, autoFlush: false });
  let agent = createPeerMonitor({ dataDir: path.join(dir, 'agent'), secretStore: agentSecrets, autoFlush: false, now: () => Date.now() + skew });
  t.after(async () => { await agent.close(); await central.close(); await rm(dir, { recursive: true, force: true }); });
  await central.initialize(); await agent.initialize();
  await central.configure({ enabled: true, role: 'central', listenHost: '127.0.0.1', port: 0, name: 'Zentrale' });
  await agent.configure({ enabled: true, role: 'agent', name: 'Mess-PC' });
  const invite = await central.createPairing();
  await agent.pair({ ...invite, address: '127.0.0.1' });
  const endpoint = { address: '127.0.0.1', port: invite.port, pin: invite.pin };
  const credentials = { deviceId: agent.snapshot().deviceId, token: (await agentSecrets.read('peer-auth')).tokens[central.snapshot().deviceId] };
  return { get central() { return central; }, get agent() { return agent; }, dir, endpoint, credentials, centralSecrets, agentSecrets,
    async restartCentral() {
      const port = central.snapshot().port; await central.configure({ ...central.snapshot().config, port }); await central.close();
      central = createPeerMonitor({ dataDir: path.join(dir, 'central'), secretStore: centralSecrets, autoFlush: false }); await central.initialize();
    },
    async restartAgent() { await agent.close(); agent = createPeerMonitor({ dataDir: path.join(dir, 'agent'), secretStore: agentSecrets, autoFlush: false, now: () => Date.now() + skew }); await agent.initialize(); },
  };
}
async function batch(f, records, supplied = {}) {
  const t0 = Date.now();
  const hello = await pinnedRequest(f.endpoint, '/v1/hello', { ...f.credentials, t0, nonce: nonce() });
  const body = { ...f.credentials, challenge: hello.challenge, t3: Date.now(), records, ...supplied };
  return { body, result: await pinnedRequest(f.endpoint, '/v1/records', body) };
}
const ping = at => ({ type: 'ping', at: new Date(at ?? Date.now()).toISOString(), pcMac: 'AA:BB:CC:DD:EE:01', routingConfirmed: false, results: [{ host: '192.168.1.1', ok: true, ms: 3 }] });

test('fixed self-signed TLS profile has an independently verifiable signature', () => {
  const identity = createPeerCertificate(randomUUID());
  const certificate = new X509Certificate(identity.cert);
  assert.ok(certificate.verify(certificate.publicKey));
  assert.equal(certificate.fingerprint256.replaceAll(':', '').toLowerCase(), identity.pin);
});

test('encrypted pairing, strict projection, corrected time and no credentials in snapshot', async t => {
  const f = await setup(t, { skew: 120000 });
  const records = []; f.central.onRecord(record => records.push(record));
  await f.agent.enqueue({ ...ping(Date.now() + 120000), password: 'NEVER-TRANSFER', credentials: { password: 'NEVER-TRANSFER' }, payload: 'NEVER-TRANSFER', results: [{ host: '192.168.1.1', ok: true, ms: 0, password: 'NEVER-TRANSFER' }] });
  await f.agent.flush();
  assert.equal(f.agent.snapshot().outboxCount, 0); assert.equal(records.length, 1);
  assert.ok(Math.abs(records[0].clockOffsetMs + 120000) < 1000);
  assert.ok(Math.abs(Date.parse(records[0].at) - Date.now()) < 1000);
  assert.equal(records[0].results[0].ms, 0); assert.equal(records[0].routingConfirmed, false);
  assert.equal(records[0].sourceDeviceId, f.agent.snapshot().deviceId);
  assert.ok(records[0].clockUncertaintyMs >= 0);
  assert.ok(!JSON.stringify(f.central.snapshot()).includes('NEVER-TRANSFER'));
  assert.ok(!JSON.stringify(f.central.snapshot()).includes(f.credentials.token));
  assert.ok(!JSON.stringify(f.agent.snapshot()).includes('PRIVATE KEY'));
});

test('wrong pin, token, one-use grant, replay and management paths are rejected', async t => {
  const f = await setup(t);
  await assert.rejects(pinnedRequest({ ...f.endpoint, pin: '0'.repeat(64) }, '/v1/hello', {}), /Fingerabdruck/);
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/hello', { ...f.credentials, token: nonce(), t0: Date.now(), nonce: nonce() }), /widerrufen/);
  const grant = await f.central.createPairing();
  const id = randomUUID();
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/pair', { deviceId: id, secret: nonce() }), /Kopplungscode/);
  await pinnedRequest(f.endpoint, '/v1/pair', { deviceId: id, secret: grant.secret });
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/pair', { deviceId: randomUUID(), secret: grant.secret }), /Kopplungscode/);
  await assert.rejects(pinnedRequest(f.endpoint, '/api/state', {}), /Messendpunkt/);
  const helloBody = { ...f.credentials, t0: Date.now(), nonce: nonce() };
  await pinnedRequest(f.endpoint, '/v1/hello', helloBody);
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/hello', helloBody), /Wiederholter/);
  const { body } = await batch(f, [{ sequence: 1, record: ping() }]);
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/records', body), /bereits verwendet/);
});

test('durable high-water dedup survives lost acknowledgement, restart and late records', async t => {
  const f = await setup(t);
  const received = []; f.central.onRecord(record => received.push(record));
  const record = ping(); await f.agent.enqueue(record);
  // Simulate lost ack: central accepted the exact buffered envelope but the
  // agent never sees that response and therefore keeps its durable outbox.
  await batch(f, [{ sequence: 1, record }]);
  assert.equal(f.agent.snapshot().outboxCount, 1);
  await f.restartCentral(); await f.restartAgent();
  await f.agent.flush();
  assert.equal(f.central.snapshot().records.length, 1); assert.equal(f.agent.snapshot().outboxCount, 0);
  await f.agent.enqueue(ping(Date.now() - 60000)); await f.agent.flush();
  assert.equal(f.central.snapshot().records.length, 2);
  assert.equal(f.central.snapshot().records[1].late, true);
  assert.equal(f.central.snapshot().records[1].clockReliable, false);
  assert.ok(f.central.snapshot().records[1].clockUncertaintyMs >= 5);
  const onDisk = JSON.parse(await readFile(path.join(f.dir, 'agent', 'peer-state.json'), 'utf8'));
  assert.equal(onDisk.nextSequence, 3); assert.equal(onDisk.outbox.length, 0);
});

test('revoke persists and peer disconnect never reports WiFi failure', async t => {
  const f = await setup(t); await f.agent.enqueue(ping()); await f.agent.flush();
  await f.central.revoke({ peerId: f.credentials.deviceId }); await f.restartCentral();
  await f.agent.enqueue(ping()); await assert.rejects(f.agent.flush(), /widerrufen/);
  assert.equal(f.agent.snapshot().outboxCount, 1);
  assert.match(f.agent.snapshot().peers[0].connectionMeaning, /kein Nachweis/);
});

test('request size, batch count, rate and clock-jump bounds', async t => {
  const f = await setup(t);
  const status = await new Promise((resolve, reject) => {
    const request = https.request({ hostname: f.endpoint.address, port: f.endpoint.port, rejectUnauthorized: false, method: 'POST', path: '/v1/hello', headers: { 'content-type': 'application/json', 'content-length': '100000' } }, res => { res.resume(); resolve(res.statusCode); });
    request.on('error', reject); request.end('{}');
  });
  assert.equal(status, 413);
  await assert.rejects(batch(f, Array.from({ length: 9 }, (_, i) => ({ sequence: i + 1, record: ping() }))), /Zu viele/);
  await assert.rejects(batch(f, [], { t3: 0 }), /PC-Uhr/);
  f.central.window.count = 2400;
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/hello', { ...f.credentials, t0: Date.now(), nonce: nonce() }), /Zu viele Peer/);
});

test('bounded offline outbox persists sequence and explicitly counts evictions', async t => {
  const f = await setup(t);
  // Prepare a full persisted buffer, then exercise the real enqueue boundary.
  f.agent.state.outbox = Array.from({ length: 2000 }, (_, i) => ({ sequence: i + 1, record: ping() }));
  f.agent.state.nextSequence = 2001;
  await f.agent.enqueue(ping());
  assert.equal(f.agent.snapshot().outboxCount, 2000); assert.equal(f.agent.snapshot().dropped, 1);
  await f.restartAgent();
  assert.equal(f.agent.state.outbox[0].sequence, 2); assert.equal(f.agent.state.nextSequence, 2002);
});

test('disabled fresh service has no listener; corrupt durable state fails closed', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kompass-peer-disabled-'));
  const peer = createPeerMonitor({ dataDir: dir, secretStore: fakeSecrets(), autoFlush: false });
  t.after(async () => { await peer.close(); await rm(dir, { recursive: true, force: true }); });
  await peer.initialize(); assert.equal(peer.snapshot().config.enabled, false); assert.equal(peer.snapshot().listening, false);
  assert.equal(await peer.enqueue(ping()), false); await peer.close();
  await writeFile(path.join(dir, 'peer-state.json'), '{broken');
  const corrupt = createPeerMonitor({ dataDir: dir, secretStore: fakeSecrets() });
  await assert.rejects(corrupt.initialize()); await corrupt.close();
});

test('projection retains explicit adapter counters, IP/MAC and excludes unknown payloads', () => {
  const record = projectPeerRecord({ type: 'traffic', at: new Date().toISOString(), pcMac: 'aa-bb-cc-dd-ee-01', ipv4: ['192.168.1.5'], downloadMbps: 0, adapterHealth: { counters: { receivedErrors: 0, password: 'NO' }, delta: { sentDiscards: 2 } }, arbitrary: 'NO' });
  assert.equal(record.pcMac, 'AA:BB:CC:DD:EE:01'); assert.deepEqual(record.ipv4, ['192.168.1.5']);
  assert.deepEqual(record.adapterHealth.counters, { receivedErrors: 0 });
  assert.equal(record.downloadMbps, 0); assert.ok(!JSON.stringify(record).includes('NO'));
  assert.equal(projectPeerRecord({ type: 'fritzbox', at: new Date().toISOString(), password: 'NO' }), null);
  const measured=projectPeerRecord({...ping(),quality:{status:'limited',gap:true,durationMs:250,meaning:'NEVER'},results:[{host:'192.168.1.1',status:'gap',quality:{gap:true,actualIntervalMs:2500,password:'NEVER'}}]});
  assert.deepEqual(measured.quality,{durationMs:250,status:'limited',gap:true});
  assert.deepEqual(measured.results[0].quality,{actualIntervalMs:2500,gap:true});assert.equal(measured.results[0].status,'gap');
  assert.ok(!JSON.stringify(measured).includes('NEVER'));
});

test('measurement errors, gateway role and session boundaries survive encrypted transport', async t => {
  const f = await setup(t), at = new Date().toISOString();
  await f.agent.enqueue({ type: 'ping', at, appSessionId: 'session-1', epoch: 3, measurementStartedAt: at, results: [{ host: '192.168.1.1', kind: 'gateway', status: 'measurement_error', ok: false, ms: null, error: 'Failed process; password=NEVER' }] });
  await f.agent.flush();
  const record = f.central.snapshot().records[0];
  assert.equal(record.results[0].status, 'measurement_error'); assert.equal(record.results[0].kind, 'gateway');
  assert.equal(record.remote, true); assert.equal(record.appSessionId, 'session-1'); assert.equal(record.epoch, 3); assert.equal(record.measurementStartedAt, at);
  assert.ok(!JSON.stringify(record).includes('NEVER'));
});

test('failed secret protection stays disabled on retries and persists no plaintext keys', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kompass-peer-secretfail-'));
  let attempts = 0;
  const peer = createPeerMonitor({ dataDir: dir, secretStore: { async read() { return null; }, async write() { attempts++; throw new Error('DPAPI unavailable'); } } });
  t.after(async () => { await peer.close(); await rm(dir, { recursive: true, force: true }); });
  await peer.initialize();
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(peer.configure({ enabled: true, role: 'central', listenHost: '127.0.0.1', port: 0 }), /DPAPI/);
  assert.equal(attempts, 2); assert.equal(peer.snapshot().config.enabled, false); assert.equal(peer.snapshot().listening, false);
  assert.ok(!(await readFile(path.join(dir, 'peer-state.json'), 'utf8')).includes('PRIVATE KEY'));
});

test('disable aborts an in-flight flush and retains the offline outbox', async t => {
  const f = await setup(t); await f.agent.enqueue(ping());
  const transfer = f.agent.flush().catch(() => {});
  await f.agent.configure({ ...f.agent.snapshot().config, enabled: false }); await transfer;
  assert.equal(f.agent.snapshot().config.enabled, false); assert.equal(f.agent.snapshot().outboxCount, 1);
  await f.agent.configure({ ...f.agent.snapshot().config, enabled: true }); await f.agent.flush();
  assert.equal(f.agent.snapshot().outboxCount, 0);
});

test('automatic reconnect uses backoff and drains the durable offline buffer', async t => {
  const f = await setup(t);
  await f.agent.enqueue(ping());
  await f.central.configure({ ...f.central.snapshot().config, enabled: false, port: f.endpoint.port });
  f.agent.autoFlush = true;
  await assert.rejects(f.agent.flush());
  assert.equal(f.agent.attempt, 1);
  assert.ok(f.agent.timer._idleTimeout >= 2000); assert.ok(f.agent.timer._idleTimeout < 2500);
  const delivered = new Promise((resolve, reject) => {
    // Includes the 8 s TLS/request deadline plus the first reconnect backoff.
    const timeout = setTimeout(() => reject(new Error(`automatic reconnect timed out: ${f.agent.lastError}; attempt ${f.agent.attempt}; central port ${f.central.snapshot().port}`)), 12000);
    f.central.onRecord(record => { clearTimeout(timeout); resolve(record); });
  });
  await f.central.configure({ ...f.central.snapshot().config, enabled: true });
  assert.equal((await delivered).sourceDeviceId, f.agent.snapshot().deviceId);
  await f.agent.flushing;
  assert.equal(f.agent.snapshot().outboxCount, 0); assert.equal(f.agent.attempt, 0);
});

test('slow concurrent request bodies are bounded before authentication', async t => {
  const f = await setup(t), requests = [];
  t.after(() => { for (const request of requests) request.destroy(); });
  for (let i = 0; i < 8; i++) {
    const received = new Promise(resolve => f.central.server.once('request', resolve));
    const request = https.request({ hostname: f.endpoint.address, port: f.endpoint.port, rejectUnauthorized: false, method: 'POST', path: '/v1/hello', headers: { 'content-type': 'application/json', 'content-length': '2' } });
    request.on('error', () => {}); requests.push(request); request.write(' '); await received;
  }
  assert.equal(f.central.activeRequests, 8);
  await assert.rejects(pinnedRequest(f.endpoint, '/v1/hello', { ...f.credentials, t0: Date.now(), nonce: nonce() }), /Zu viele Peer/);
  for (const request of requests) request.destroy();
});

test('parallel TLS replies are consumed before client close, including authentication errors', async t => {
  const f=await setup(t);let requests=0;
  f.central.server.on('request',req=>{assert.equal(req.headers.connection,'keep-alive');requests++;});
  for(let wave=0;wave<16;wave++)await Promise.all(Array.from({length:4},()=>
    assert.rejects(pinnedRequest(f.endpoint,'/v1/hello',{...f.credentials,token:nonce(),t0:Date.now(),nonce:nonce()}),/widerrufen/)));
  assert.equal(requests,64);
});
