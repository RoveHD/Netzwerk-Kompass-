import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const registryValue = 'Netzwerk-Kompass';
function createWindowsRegistry(executor) {
  return {
    async getValue(name) {
      // Fixed PowerShell code avoids localized `reg query` error text and never
      // interpolates registry data into executable code. This access is read-only.
      const script = "$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Run',$false); if($null -eq $key){[Console]::Out.WriteLine('null')} else {$value=$key.GetValue('Netzwerk-Kompass',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); if($null -eq $value){[Console]::Out.WriteLine('null')} else {ConvertTo-Json -InputObject ([string]$value) -Compress}}";
      const result = await executor('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]);
      const output = (result.stdout ?? '').trim();
      const value = JSON.parse(output || 'null');
      return typeof value === 'string' ? value : null;
    },
    async setValue(name, value) {
      await executor('reg.exe', ['add', registryKey, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']);
    },
    async deleteValue(name) {
      try { await executor('reg.exe', ['delete', registryKey, '/v', name, '/f']); }
      catch (error) {
        // `reg.exe` uses the same exit code for several conditions. Treat a
        // deletion as already complete only when its diagnostic clearly says so.
        if (error.code !== 1 || !/unable to find|cannot find|could not find/i.test(`${error.stderr || ''} ${error.message || ''}`)) throw error;
      }
    }
  };
}

export function createStartupManager({ dataDir, env = process.env, argv = process.argv, platform = process.platform, exePath = env.NETZWERK_KOMPASS_EXE_PATH, registry, executor = (file, args) => run(file, args, { windowsHide: true, encoding: 'utf8' }) } = {}) {
  const settingsPath = path.join(dataDir, 'startup.json');
  const disabledByEnvironment = env.NETZWERK_KOMPASS_NO_AUTOSTART_REGISTRATION === '1' || argv.includes('--hidden-window') || argv.includes('--no-autostart-registration');
  const absoluteExe = typeof exePath === 'string' && path.isAbsolute(exePath) ? path.normalize(exePath) : null;
  const available = platform === 'win32' && Boolean(absoluteExe) && !disabledByEnvironment;
  const osRegistry = registry ?? (platform === 'win32' ? createWindowsRegistry(executor) : null);
  let enabled = true;
  let registered = null;
  let error = null;
  let initialized = false;

  async function persist() {
    await mkdir(dataDir, { recursive: true });
    const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, settingsPath);
    } catch (cause) {
      try { await (await import('node:fs/promises')).unlink(temporary); } catch { }
      throw cause;
    }
  }

  async function syncRegistry() {
    if (!available) { registered = null; return; }
    try {
      const current = await osRegistry.getValue(registryValue);
      if (enabled) {
        const desired = `"${absoluteExe}"`;
        if (current !== desired) await osRegistry.setValue(registryValue, desired);
        registered = true;
      } else {
        if (current !== null) await osRegistry.deleteValue(registryValue);
        registered = false;
      }
    } catch (cause) {
      registered = false;
      error = `Windows-Autostart konnte nicht aktualisiert werden: ${cause.message || cause}`;
    }
  }

  function snapshot() {
    return { available, enabled, registered, error };
  }

  return {
    async init() {
      if (initialized) return snapshot();
      initialized = true;
      let canSync = false;
      try {
        const content = await readFile(settingsPath, 'utf8');
        const settings = JSON.parse(content);
        if (typeof settings.enabled !== 'boolean') throw new Error('Ungültiger Autostart-Einstellungswert.');
        enabled = settings.enabled;
        canSync = true;
      } catch (cause) {
        if (cause.code === 'ENOENT') {
          enabled = true;
          try { await persist(); canSync = true; } catch (saveError) { error = `Autostart-Einstellung konnte nicht gespeichert werden: ${saveError.message}`; }
        } else {
          error = `Autostart-Einstellung konnte nicht gelesen werden: ${cause.message || cause}`;
        }
      }
      if (canSync) await syncRegistry();
      else registered = null;
      return snapshot();
    },
    async setEnabled(value) {
      if (typeof value !== 'boolean') throw new TypeError('Autostart muss als Ja/Nein gesetzt werden.');
      enabled = value;
      error = null;
      try { await persist(); await syncRegistry(); } catch (cause) { error = `Autostart-Einstellung konnte nicht gespeichert werden: ${cause.message || cause}`; }
      return snapshot();
    },
    snapshot
  };
}
