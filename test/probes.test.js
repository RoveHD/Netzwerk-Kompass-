import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import { createPingMonitor, validateHost, parseWifi, parseArpOutput, parsePingResults, pingMany, runProcess } from '../lib/probes.js';

test('host validation accepts IPv4 and DNS, rejects command arguments and invalid addresses', () => {
  for (const host of ['127.0.0.1', '192.168.1.1', 'example.org', 'router-1', 'localhost']) assert.equal(validateHost(host), host);
  for (const host of ['', '-d', 'localhost;whoami', 'a b', 'a\nb', '::1', '999.1.1.1', '127.1', 'a..b', 'a.', 'x'.repeat(64), null]) {
    assert.throws(() => validateHost(host), TypeError);
  }
});

test('German WLAN output includes decimals, colon in SSID and multiple BSSIDs', () => {
  const wifi = parseWifi(`
    Name : WLAN
    Status : Verbunden
    SSID : Haus: Oben
    BSSID : aa:bb:cc:dd:ee:ff
    Funktyp : 802.11ax
    Kanal : 36
    Empfangsrate (MBit/s) : 1201,5
    Übertragungsrate (MBit/s) : 866,7
    Signal : 92%
  `, `
    SSID 1 : Haus: Oben
      BSSID 1 : aa:bb:cc:dd:ee:ff
        Signal : 92%
        Funktyp : 802.11ax
        Kanal : 36
      BSSID 2 : 11:22:33:44:55:66
        Signal : 48%
        Funktyp : 802.11ac
        Kanal : 44
    SSID 2 :
      BSSID 1 : 22:33:44:55:66:77
        Signal : 20%
        Kanal : 6
  `);
  assert.equal(wifi.connected, true);
  assert.equal(wifi.ssid, 'Haus: Oben');
  assert.equal(wifi.receiveRateMbps, 1201.5);
  assert.equal(wifi.transmitRateMbps, 866.7);
  assert.equal(wifi.networks.length, 3);
  assert.equal(wifi.networks[1].channel, 44);
  assert.equal(wifi.networks[2].ssid, '');
});

test('English WLAN chooses the connected interface and detects permissions', () => {
  const wifi = parseWifi(`Name : Wi-Fi 1\nState : disconnected\nSSID : stale\nName : Wi-Fi 2\nState : connected\nSSID : Live\nAP BSSID : 01:02:03:04:05:06\nRadio type : 802.11be\nReceive rate (Mbps) : 2882\nTransmit rate (Mbps) : 1441\nSignal : 81%\nChannel : 149`);
  assert.equal(wifi.ssid, 'Live');
  assert.equal(wifi.bssid, '01:02:03:04:05:06');
  assert.equal(wifi.channel, 149);
  assert.equal(wifi.transmitRateMbps, 1441);
  assert.equal(wifi.error, null);
  assert.match(parseWifi('Function WlanQueryInterface returns error 5:\nThe requested operation requires elevation.').error, /error 5/);
  assert.match(parseWifi('', 'Zugriff auf Standortdaten erforderlich.').error, /Standort/);
  assert.equal(parseWifi('State : disconnected').connected, false);
});

test('decoded native WLAN text preserves Unicode SSIDs, German rate labels and permission messages',()=>{
  const ssid='Büro „Süd“ – Straße 東京';
  const wifi=parseWifi(`Name : Wi-Fi\nStatus : Verbunden\nSSID : ${ssid}\nÜbertragungsrate (MBit/s) : 866,7\nEmpfangsrate (MBit/s) : 1201,5`,`SSID 1 : ${ssid}\nBSSID 1 : aa:bb:cc:dd:ee:ff\nSignal : 90%\nKanal : 36`);
  assert.equal(wifi.ssid,ssid);assert.equal(wifi.networks[0].ssid,ssid);assert.equal(wifi.transmitRateMbps,866.7);
  const message='Netzwerkshellbefehle benötigen Standortberechtigungen für WLAN-Informationen. Aktivieren Sie „Positionsdienste“ unter „Datenschutz & Sicherheit“. Öffnen Sie die Einstellungen.';
  assert.equal(parseWifi(message).error,message);
  assert.equal(parseWifi('',message).error,message);
  assert.equal(parseWifi('','',message).error,message);
});

test('ping parsing preserves order, zero latency and explicit failure status', () => {
  const hosts = ['127.0.0.1', '192.168.1.2'];
  assert.deepEqual(parsePingResults([
    { host: hosts[0], status: 'Success', ok: true, ms: 0 },
    { host: hosts[1], status: 'TimedOut', ok: false, ms: null }
  ], hosts), [
    { host: hosts[0], status: 'Success', ok: true, ms: 0 },
    { host: hosts[1], status: 'TimedOut', ok: false, ms: null }
  ]);
  assert.throws(() => parsePingResults([], hosts), /Unvollständig/);
  assert.throws(() => parsePingResults([{ host: 'localhost', status: 'Success', ok: true, ms: null }], ['localhost']), /Latenz/);
  assert.equal(parsePingResults([{ host: 'localhost', status: 'Error', ok: false, error: 'Access denied' }], ['localhost'])[0].status, 'measurement_error');
});

test('ARP fallback parses locale-independent rows and excludes group entries', () => {
  const neighbors = parseArpOutput(`
Schnittstelle: 192.168.1.5 --- 0x1a
  Internetadresse Physische Adresse Typ
  192.168.1.1 58-6d-8f-48-c5-6b dynamisch
  192.168.1.255 ff-ff-ff-ff-ff-ff statisch
  224.0.0.22 01-00-5e-00-00-16 statisch
  192.168.1.2 00-00-00-00-00-00 dynamisch
Interface: 10.0.0.2 --- 0x2
  10.0.0.1 02-AA-BB-CC-DD-EE dynamic
`);
  assert.deepEqual(neighbors, [
    { ip: '192.168.1.1', mac: '58-6d-8f-48-c5-6b', state: 'Cached', interfaceId: '26' },
    { ip: '10.0.0.1', mac: '02-aa-bb-cc-dd-ee', state: 'Cached', interfaceId: '2' }
  ]);
});

test('ping batch has strict bounds without starting a process', async () => {
  assert.deepEqual(await pingMany([]), []);
  await assert.rejects(pingMany(Array(65).fill('localhost')), /64/);
  await assert.rejects(pingMany(['localhost'], { timeoutMs: 0 }), /Zeitlimit/);
  await assert.rejects(pingMany(['a;whoami']), /Ungültig/);
});

test('subprocess receives literal arguments and stdin', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdin.on("data", d => process.stdout.write(d));'], { input: 'literal $() & text', timeoutMs: 3000 });
  assert.equal(result.stdout, 'literal $() & text');
  assert.equal(result.code, 0);
});

test('subprocess is bounded by deadline and output limit', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }), { code: 'PROBE_TIMEOUT' });
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(2048))'], { maxOutput: 100, timeoutMs: 3000 }), { code: 'OUTPUT_LIMIT' });
});

test('subprocess honors cancellation before and during execution', async () => {
  const controller = new AbortController();
  const pending = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(runProcess(process.execPath, [], { signal: controller.signal }), { name: 'AbortError' });
});

function fakeWorkerFactory() {
  const children = [];
  const spawnImpl = (_command, args, options) => {
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, false);
    assert.equal(args.at(-1), 'worker');
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.requests = [];
    child.stdin = new Writable({ write(chunk, _encoding, callback) { child.requests.push(JSON.parse(chunk.toString())); callback(); } });
    child.kill = () => { child.killed = true; return true; };
    child.reply = (ms = 0) => child.stdout.write(JSON.stringify(child.requests.at(-1).hosts.map(host => ({ host, ok:true, ms, status:'Success' }))) + '\n');
    children.push(child);
    return child;
  };
  return { children, spawnImpl };
}

test('persistent worker is lazy, validates batches, serializes requests and closes', async () => {
  const fake = fakeWorkerFactory();
  const monitor = createPingMonitor(fake);
  try {
    await assert.rejects(monitor.pingMany(['localhost;whoami']), /Ungültig/);
    await assert.rejects(monitor.pingMany(Array(65).fill('localhost')), /64/);
    await assert.rejects(monitor.pingMany(['localhost'], {timeoutMs:0}), /Zeitlimit/);
    assert.deepEqual(await monitor.pingMany([]), []);
    assert.equal(fake.children.length, 0);
    const first = monitor.pingMany(['localhost']);
    await assert.rejects(monitor.pingMany(['127.0.0.1']), {code:'PING_MONITOR_BUSY'});
    fake.children[0].reply(); assert.equal((await first)[0].ms, 0);
    const second = monitor.pingMany(['127.0.0.1']);
    fake.children[0].reply(2); assert.equal((await second)[0].ms, 2);
    assert.equal(fake.children.length, 1);
    assert.equal(fake.children[0].requests[1].timeoutMs, 800);
    const pending = monitor.pingMany(['localhost']); monitor.close();
    await assert.rejects(pending, {code:'PING_MONITOR_CLOSED'});
    assert.equal(fake.children[0].killed, true);
    await assert.rejects(monitor.pingMany(['localhost']), {code:'PING_MONITOR_CLOSED'});
  } finally { monitor.close(); }
});

test('aborted worker can restart and late events from old worker cannot settle new request', async () => {
  const fake = fakeWorkerFactory();const monitor = createPingMonitor(fake);
  try {
    const before = new AbortController();before.abort();
    await assert.rejects(monitor.pingMany(['localhost'], {signal:before.signal}), {name:'AbortError'});
    assert.equal(fake.children.length, 0);
    const controller = new AbortController();
    const first = monitor.pingMany(['localhost'], {signal:controller.signal});
    controller.abort(); await assert.rejects(first, {name:'AbortError'});
    assert.equal(fake.children[0].killed, true);
    const next = monitor.pingMany(['localhost']);
    fake.children[0].reply(999);
    fake.children[0].emit('error', new Error('late old failure'));
    fake.children[0].emit('close', 1);
    fake.children[1].reply(3);
    assert.equal((await next)[0].ms, 3);
  } finally { monitor.close(); }
});

test('worker protocol errors, exit and output limit reject measurements instead of false loss', async () => {
  const fake = fakeWorkerFactory();const monitor = createPingMonitor(fake);
  try {
    let pending = monitor.pingMany(['localhost']);
    fake.children[0].stdout.write('not json\n');
    await assert.rejects(pending, {code:'PING_WORKER_PROTOCOL'});
    pending = monitor.pingMany(['localhost']);
    fake.children[1].stderr.write('Access denied');fake.children[1].emit('close', 5);
    await assert.rejects(pending, /Access denied/);
    pending = monitor.pingMany(['localhost']);
    fake.children[2].stdout.write('x'.repeat(1024*1024+1));
    await assert.rejects(pending, {code:'OUTPUT_LIMIT'});
    assert.ok(fake.children.every(c => c.killed));
  } finally { monitor.close(); }
});

test('worker read deadline kills stalled process and permits a fresh measurement', async () => {
  const fake = fakeWorkerFactory();const monitor = createPingMonitor(fake);
  try {
    await assert.rejects(monitor.pingMany(['localhost'], {timeoutMs:100}), {code:'PROBE_TIMEOUT'});
    assert.equal(fake.children[0].killed, true);
    const next = monitor.pingMany(['localhost']);fake.children[1].reply();await next;
  } finally { monitor.close(); }
});

test('real Windows worker pings localhost twice with one PID', {skip:process.platform !== 'win32'}, async t => {
  const children = [];
  const monitor = createPingMonitor({spawnImpl:(...args) => { const child=spawn(...args);children.push(child);return child; }});
  t.after(() => monitor.close());
  const first = await monitor.pingMany(['127.0.0.1','localhost']);
  const pid = children[0].pid;
  const second = await monitor.pingMany(['127.0.0.1','localhost']);
  assert.ok(first.every(r => r.ok));assert.ok(second.every(r => r.ok));
  assert.equal(children.length, 1);assert.equal(children[0].pid, pid);
  monitor.close();assert.equal(children[0].killed, true);
});
