import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dir = path.join(root, 'release');
const installer = `Netzwerk-Kompass-Setup-${version}-x64.exe`;
const portable = `Netzwerk-Kompass-Portable-${version}-x64.exe`;
const metadata = await readFile(path.join(dir, 'latest.yml'), 'utf8');
// The builder emits this deliberately simple stable-channel manifest.
assert.match(metadata, new RegExp(`^version: ${version.replaceAll('.', '\\.')}$`, 'm'));
assert.match(metadata, new RegExp(`^path: ${installer.replaceAll('.', '\\.')}$`, 'm'));
assert.match(metadata, new RegExp(`^\\s+- url: ${installer.replaceAll('.', '\\.')}$`, 'm'));
const setupBytes = await readFile(path.join(dir, installer));
const digest = createHash('sha512').update(setupBytes).digest('base64');
const checksums = [...metadata.matchAll(/^\s*sha512: (\S+)$/gm)].map(match => match[1]);
assert.equal(checksums.length, 2);
assert.ok(checksums.every(value => value === digest), 'updater SHA512 matches installer');
assert.match(metadata, new RegExp(`^\\s+size: ${setupBytes.length}$`, 'm'));
const sums = await readFile(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
for (const file of [portable, installer, `${installer}.blockmap`, 'latest.yml']) {
  const bytes = await readFile(path.join(dir, file));
  const sum = createHash('sha256').update(bytes).digest('hex');
  assert.ok(sums.split(/\r?\n/).includes(`${sum}  ${file}`), `SHA256: ${file}`);
}
const unpacked = path.join(dir, 'win-unpacked', 'resources');
const feed = await readFile(path.join(unpacked, 'app-update.yml'), 'utf8');
assert.match(feed, /^provider: github$/m);
assert.match(feed, /^owner: RoveHD$/m);
assert.match(feed, /^repo: Netzwerk-Kompass-$/m);
assert.doesNotMatch(feed, /token:|password:|authorization:/i);
const app = path.join(unpacked, 'app');
for (const privateFolder of ['data', 'Netzwerk-Kompass-Daten', 'test-artifacts', 'theme-backups', '.git', '.env']) {
  await assert.rejects(stat(path.join(app, privateFolder)), { code: 'ENOENT' });
}
for (const file of ['desktop/installed.cjs', 'server.js', 'scripts/game-packets.cs', 'scripts/lag-hotkey.ps1', 'public/fonts/geist-variable.woff2']) {
  assert.ok((await stat(path.join(app, file))).size > 0, `packaged: ${file}`);
}
assert.ok((await stat(path.join(unpacked, 'runtime', 'node.exe'))).size > 1_000_000);
console.log(`Release ${version}: Portable, Installer, SHA256/SHA512, Update-Feed und Paketinhalt geprüft.`);
