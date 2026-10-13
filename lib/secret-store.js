import path from 'node:path';
import { mkdir, readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const NAMES = new Set(['router-credentials', 'peer-auth']);
const MAX_BYTES = 64 * 1024;
const MAX_PROTECTED_BYTES = MAX_BYTES + 8192;
function storeError(code, message) { return Object.assign(new Error(message), { code }); }

export function createWindowsProtector({ platform = process.platform, spawnProcess = spawn } = {}) {
  let availability = null;
  function transform(operation, input) {
    if (platform !== 'win32') return Promise.reject(storeError('SECRET_UNAVAILABLE', 'Windows-Benutzerschutz ist nicht verfügbar.'));
    return new Promise((resolve, reject) => {
      let child, timer, bytes = 0, output = '', settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { try { child?.kill(); } catch {} reject(error); } else resolve(value);
      };
      try {
        const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        child = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../scripts/secret-store.ps1', import.meta.url)), operation], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        timer = setTimeout(() => finish(storeError('SECRET_UNAVAILABLE', 'Windows-Benutzerschutz antwortet nicht.')), 10000);
        child.once('error', () => finish(storeError('SECRET_UNAVAILABLE', 'Windows-Benutzerschutz konnte nicht gestartet werden.')));
        child.stdin.on('error', () => finish(storeError('SECRET_UNAVAILABLE', 'Windows-Benutzerschutz ist nicht erreichbar.')));
        child.stdout.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 100000) finish(storeError('SECRET_CORRUPT', 'Ungültige geschützte Daten.'));
          else output += chunk.toString('ascii');
        });
        // Never echo helper diagnostics or data into application logs.
        child.stderr.resume();
        child.once('close', code => {
          if (code !== 0) return finish(storeError(operation === 'unprotect' ? 'SECRET_CORRUPT' : 'SECRET_UNAVAILABLE', 'Windows-Benutzerschutz konnte die Daten nicht verarbeiten.'));
          const encoded = output.trim();
          if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return finish(storeError('SECRET_CORRUPT', 'Ungültige geschützte Daten.'));
          finish(null, Buffer.from(encoded, 'base64'));
        });
        child.stdin.end(input.toString('base64'));
      } catch { finish(storeError('SECRET_UNAVAILABLE', 'Windows-Benutzerschutz konnte nicht gestartet werden.')); }
    });
  }
  return {
    available: () => {
      if (!availability) availability = platform !== 'win32' ? Promise.resolve(false) : transform('protect', Buffer.from('Netzwerk-Kompass protection probe')).then(() => true, () => false);
      return availability;
    },
    protect: bytes => transform('protect', bytes), unprotect: bytes => transform('unprotect', bytes)
  };
}

export function createSecretStore({ dataDir, protector = createWindowsProtector() } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('Secret-Store benötigt einen absoluten Datenpfad.');
  const directory = path.join(dataDir, '.secrets');
  let pending = Promise.resolve();
  let lastError = null;
  const target = name => {
    if (!NAMES.has(name)) throw storeError('SECRET_NAME', 'Unzulässiger Secret-Name.');
    return path.join(directory, `${name}.dpapi`);
  };
  async function available() { return typeof protector.available === 'function' ? await protector.available() : protector.available !== false; }
  async function requireAvailable() { if (!await available()) throw storeError('SECRET_UNAVAILABLE', 'Windows-Benutzerschutz ist nicht verfügbar.'); }
  function serialize(action) {
    const result = pending.then(action).then(value => { lastError = null; return value; }, error => { lastError = error.code || 'SECRET_IO'; throw error; });
    pending = result.catch(() => {});
    return result;
  }
  return {
    async read(name) {
      const file = target(name);
      return serialize(async () => {
        let info;
        try { info = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!info.isFile() || info.size < 1 || info.size > MAX_PROTECTED_BYTES) throw storeError('SECRET_CORRUPT', 'Ungültige geschützte Datei.');
        await requireAvailable();
        try {
          const plaintext = Buffer.from(await protector.unprotect(await readFile(file)));
          try {
            if (plaintext.length > MAX_BYTES) throw new Error('size');
            return JSON.parse(plaintext.toString('utf8'));
          } finally { plaintext.fill(0); }
        } catch (error) {
          if (error.code === 'SECRET_UNAVAILABLE') throw error;
          throw storeError('SECRET_CORRUPT', 'Gespeicherte Zugangsdaten sind beschädigt oder für diesen Windows-Benutzer nicht entschlüsselbar.');
        }
      });
    },
    async write(name, value) {
      const file = target(name);
      return serialize(async () => {
        await requireAvailable();
        const json = JSON.stringify(value);
        if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_BYTES) throw storeError('SECRET_SIZE', 'Secret ist ungültig oder zu groß.');
        const plaintext = Buffer.from(json);
        let protectedBytes;
        try { protectedBytes = Buffer.from(await protector.protect(plaintext)); } finally { plaintext.fill(0); }
        if (!protectedBytes.length || protectedBytes.length > MAX_PROTECTED_BYTES) throw storeError('SECRET_SIZE', 'Geschützte Daten sind ungültig oder zu groß.');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, protectedBytes, { flag: 'wx', mode: 0o600 });
          await rename(temporary, file);
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      });
    },
    async remove(name) {
      const file = target(name);
      return serialize(async () => { try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
    },
    async status() { await pending; return { available: await available(), protection: 'Windows DPAPI CurrentUser', portable: false, error: lastError }; }
  };
}
