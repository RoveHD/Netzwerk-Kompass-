import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createSecretStore, createWindowsProtector } from '../lib/secret-store.js';

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'network-secrets-'));
  const key = randomBytes(32);
  const protector = {
    available: () => true,
    async protect(input) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const encrypted = Buffer.concat([cipher.update(input), cipher.final()]); return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]); },
    async unprotect(input) { const cipher = createDecipheriv('aes-256-gcm', key, input.subarray(0, 12)); cipher.setAuthTag(input.subarray(12, 28)); return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]); }
  };
  return { dataDir, protector, store: createSecretStore({ dataDir, protector }), close: () => rm(dataDir, { recursive: true, force: true }) };
}
test('protected JSON roundtrip writes only encrypted bytes and revocation is idempotent', async () => {
  const f = await fixture();
  try {
    const value = { username: 'local-account', password: 'secret-unique-123-ö' };
    assert.equal(await f.store.read('router-credentials'), null);
    await f.store.write('router-credentials', value);
    assert.deepEqual(await f.store.read('router-credentials'), value);
    const encrypted = await readFile(path.join(f.dataDir, '.secrets/router-credentials.dpapi'));
    assert.equal(encrypted.includes(Buffer.from(value.password)), false);
    assert.deepEqual(await readdir(path.join(f.dataDir, '.secrets')), ['router-credentials.dpapi']);
    await f.store.remove('router-credentials'); await f.store.remove('router-credentials');
    assert.equal(await f.store.read('router-credentials'), null);
    assert.equal((await f.store.status()).available, true);
  } finally { await f.close(); }
});
test('allowlist rejects path traversal, corruption is explicit, and failed reads can be revoked', async () => {
  const f = await fixture();
  try {
    for (const name of ['../router-credentials', 'anything', 'peer-auth.dpapi', '__proto__']) await assert.rejects(f.store.write(name, 'x'), { code: 'SECRET_NAME' });
    await f.store.write('peer-auth', { key: 'secret' });
    await writeFile(path.join(f.dataDir, '.secrets/peer-auth.dpapi'), Buffer.from('broken'));
    await assert.rejects(f.store.read('peer-auth'), { code: 'SECRET_CORRUPT' });
    assert.equal((await f.store.status()).error, 'SECRET_CORRUPT');
    await f.store.remove('peer-auth'); assert.equal(await f.store.read('peer-auth'), null);
  } finally { await f.close(); }
});
test('unavailable protection fails closed and revocation still works', async () => {
  const f = await fixture();
  try {
    await f.store.write('peer-auth', 'already-protected');
    const unavailable = createSecretStore({ dataDir: f.dataDir, protector: { available: () => false } });
    await assert.rejects(unavailable.read('peer-auth'), { code: 'SECRET_UNAVAILABLE' });
    await assert.rejects(unavailable.write('router-credentials', 'plaintext'), { code: 'SECRET_UNAVAILABLE' });
    assert.equal((await unavailable.status()).available, false);
    await unavailable.remove('peer-auth');
    assert.equal(await unavailable.read('peer-auth'), null);
    assert.deepEqual(await readdir(path.join(f.dataDir, '.secrets')), []);
  } finally { await f.close(); }
});
test('writes are bounded, serialized with revocation, and failed protection cannot overwrite existing bytes', async () => {
  const f = await fixture();
  try {
    const write = f.store.write('peer-auth', { secret: 'a' }); const remove = f.store.remove('peer-auth');
    await Promise.all([write, remove]); assert.equal(await f.store.read('peer-auth'), null);
    await assert.rejects(f.store.write('peer-auth', 'x'.repeat(65536)), { code: 'SECRET_SIZE' });
    await f.store.write('peer-auth', 'preserved');
    const old = await readFile(path.join(f.dataDir, '.secrets/peer-auth.dpapi'));
    const broken = createSecretStore({ dataDir: f.dataDir, protector: { ...f.protector, protect() { throw new Error('failed'); } } });
    await assert.rejects(broken.write('peer-auth', 'new'), /failed/);
    assert.deepEqual(await readFile(path.join(f.dataDir, '.secrets/peer-auth.dpapi')), old);
  } finally { await f.close(); }
});
test('real Windows DPAPI CurrentUser roundtrip through pipes and corrupt blob rejection', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'network-dpapi-'));
  try {
    const store = createSecretStore({ dataDir: folder });
    await store.write('router-credentials', { password: 'DPAPI-roundtrip-ö-123' });
    assert.deepEqual(await store.read('router-credentials'), { password: 'DPAPI-roundtrip-ö-123' });
    const bytes = await readFile(path.join(folder, '.secrets/router-credentials.dpapi'));
    assert.equal(bytes.includes(Buffer.from('DPAPI-roundtrip')), false);
    await writeFile(path.join(folder, '.secrets/router-credentials.dpapi'), Buffer.from('corrupt'));
    await assert.rejects(store.read('router-credentials'), { code: 'SECRET_CORRUPT' });
    await store.remove('router-credentials');
    assert.equal(await store.read('router-credentials'), null);
    await assert.rejects(createWindowsProtector({ platform: 'linux' }).protect(Buffer.from('x')), { code: 'SECRET_UNAVAILABLE' });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
