import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import policy from '../desktop/policy.cjs';

const origin = 'http://127.0.0.1:43123';

test('desktop only starts the exact loopback server and uses a portable profile', () => {
  const data = path.resolve('Desktop Daten ä');
  assert.deepEqual(policy.configuration({ NETZWERK_KOMPASS_URL: origin, NETZWERK_KOMPASS_DATA_DIR: data }), {
    startUrl: `${origin}/`, origin, desktopDir: path.join(data, '.desktop')
  });
  for (const url of ['http://localhost:43123', 'http://127.1:43123', 'http://2130706433:43123', 'http://0x7f000001:43123',
    'http://user@127.0.0.1:43123', 'https://127.0.0.1:43123', 'http://127.0.0.1:65536', 'http://127.0.0.1:0',
    `${origin}/api/state`, `${origin}/?x=1`, `${origin}/#main`, `${origin}/\\example.org`, undefined]) {
    assert.throws(() => policy.configuration({ NETZWERK_KOMPASS_URL: url, NETZWERK_KOMPASS_DATA_DIR: data }), undefined, String(url));
  }
  assert.throws(() => policy.configuration({ NETZWERK_KOMPASS_URL: origin, NETZWERK_KOMPASS_DATA_DIR: 'relative' }), /absoluter Pfad/);
});

test('navigation stays on the app document; resources stay on its exact origin', () => {
  for (const url of [`${origin}/`, `${origin}/#main`, `${origin}/index.html#main`]) assert.equal(policy.isAppNavigation(url, origin), true, url);
  for (const url of [`${origin}/api/export`, `${origin}/app.js`, `${origin}/?redirect=evil`, 'http://127.0.0.1:43124/',
    'http://127.0.0.1:43123.evil.test/', `${origin.replace('http:', 'https:')}/`, 'file:///C:/Windows/win.ini',
    'javascript:alert(1)', 'data:text/html,hi', 'https://example.org', 'not a URL', 'http://user@127.0.0.1:43123/']) {
    assert.equal(policy.isAppNavigation(url, origin), false, url);
  }
  assert.equal(policy.isAppResource(`${origin}/api/state`, origin), true);
  for (const url of ['https://example.org/upload', 'file:///C:/secret', 'http://localhost:43123/app.js', 'http://127.0.0.1:43124/app.js',
    'http://user:password@127.0.0.1:43123/app.js']) assert.equal(policy.isAppResource(url, origin), false, url);
});

test('external help allowlist rejects lookalikes, parameters and other protocols', () => {
  assert.equal(policy.isHelpUrl('https://learn.chatgpt.com/docs/codex-cli'), true);
  for (const url of ['https://learn.chatgpt.com/docs/codex-cli?upload=1', 'https://learn.chatgpt.com/docs/codex-cli#x',
    'https://learn.chatgpt.com.evil.test/docs/codex-cli', 'https://user@learn.chatgpt.com/docs/codex-cli',
    'https://learn.chatgpt.com/docs/codex-cli/', 'http://learn.chatgpt.com/docs/codex-cli', 'file:///C:/app.exe']) {
    assert.equal(policy.isHelpUrl(url), false, url);
  }
});

test('desktop control channel accepts only a random launcher pipe name', () => {
  const name = 'netzwerk-kompass-desktop-12345678-1234-1234-1234-123456789abc';
  assert.equal(policy.controlPipePath(name), `\\\\.\\pipe\\${name}`);
  for (const value of ['other-pipe', `${name}/suffix`, `\\\\.\\pipe\\${name}`, 'netzwerk-kompass-desktop-../file',
    'netzwerk-kompass-desktop-', undefined, '']) assert.throws(() => policy.controlPipePath(value), /Steuerkanal/);
});

test('export accepts only the local JSON blob with a safe report filename', () => {
  const blob = `blob:${origin}/12345678-1234-1234-1234-123456789abc`;
  const name = 'netzwerk-kompass-2026-10-11.json';
  assert.equal(policy.isExportDownload(blob, origin, 'application/json', name), true);
  for (const [url, mime, filename] of [[blob, 'text/html', name], [blob, 'application/json', '../report.json'],
    [blob, 'application/json', 'netzwerk-kompass-2026-10-11.exe'], ['https://example.org/report', 'application/json', name],
    [blob.replace(':43123', ':43124'), 'application/json', name], [`${blob}/../evil`, 'application/json', name],
    ['blob:null/12345678-1234-1234-1234-123456789abc', 'application/json', name]]) {
    assert.equal(policy.isExportDownload(url, origin, mime, filename), false, `${url} ${filename}`);
  }
});

test('launcher show and shutdown commands handle split chunks and stop once', async () => {
  const input = new PassThrough(); let shows = 0; let stops = 0;
  policy.attachLauncher(input, { show: () => shows++, shutdown: () => stops++ });
  input.write('sh'); input.write('ow\r\nunknown\n'); assert.equal(shows, 1);
  input.write('shut'); assert.equal(stops, 0);
  input.write('down\nshow\nshutdown\n'); assert.equal(stops, 1); assert.equal(shows, 1);
  input.end(); await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 1);
});

test('lost launcher pipe shuts down; listener disposal does not', async () => {
  const input = new PassThrough(); let stops = 0;
  policy.attachLauncher(input, { show: () => {}, shutdown: () => stops++ });
  input.end(); await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 1);
  const other = new PassThrough();
  const detach = policy.attachLauncher(other, { show: () => {}, shutdown: () => stops++ });
  detach(); other.end(); await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 1);
  const broken = new PassThrough();
  policy.attachLauncher(broken, { show: () => {}, shutdown: () => stops++ });
  broken.emit('error', new Error('pipe lost')); broken.end();
  await new Promise(resolve => setImmediate(resolve)); assert.equal(stops, 2);
});
