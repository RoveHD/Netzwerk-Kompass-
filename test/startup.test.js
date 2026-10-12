import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createStartupManager } from '../lib/startup.js';

function fakeRegistry(initial = null) {
  let value = initial;
  const calls = [];
  return {
    calls,
    async getValue(name) { calls.push(['get', name]); return value; },
    async setValue(name, next) { calls.push(['set', name, next]); value = next; },
    async deleteValue(name) { calls.push(['delete', name]); value = null; },
    value: () => value
  };
}

test('portable Windows autostart defaults on, persists intent atomically, and owns only its named value', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'network-startup-'));
  const registry = fakeRegistry('"C:\\Other\\app.exe"');
  try {
    const manager = createStartupManager({ dataDir, platform: 'win32', exePath: 'C:\\Program Files\\Netzwerk Kompass.exe', registry });
    assert.deepEqual(await manager.init(), { available: true, enabled: true, registered: true, error: null });
    assert.equal(registry.value(), '"C:\\Program Files\\Netzwerk Kompass.exe"');
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'startup.json'), 'utf8')), { enabled: true });
    assert.deepEqual(await manager.setEnabled(false), { available: true, enabled: false, registered: false, error: null });
    assert.equal(registry.value(), null);
    assert.deepEqual(await manager.setEnabled(true), { available: true, enabled: true, registered: true, error: null });
    assert.equal(registry.calls.filter(([operation]) => operation === 'delete').length, 1);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('source mode, hidden window, no-registration flag, and missing stable exe never touch registry', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'network-startup-'));
  try {
    for (const options of [
      { platform: 'linux', exePath: 'C:\\app.exe' },
      { platform: 'win32', exePath: 'C:\\app.exe', argv: ['--hidden-window'] },
      { platform: 'win32', exePath: 'C:\\app.exe', argv: ['--no-autostart-registration'] },
      { platform: 'win32', exePath: null }
    ]) {
      const registry = fakeRegistry();
      const manager = createStartupManager({ dataDir, registry, ...options });
      const state = await manager.init();
      assert.equal(state.available, false);
      assert.equal(state.enabled, true);
      assert.equal(state.registered, null);
      assert.deepEqual(registry.calls, []);
    }
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('registry errors stay visible while desired setting remains saved', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'network-startup-'));
  const registry = { async getValue() { throw new Error('Zugriff verweigert'); } };
  try {
    const manager = createStartupManager({ dataDir, platform: 'win32', exePath: 'C:\\app.exe', registry });
    const state = await manager.init();
    assert.equal(state.enabled, true);
    assert.equal(state.registered, false);
    assert.match(state.error, /Zugriff verweigert/);
    assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'startup.json'), 'utf8')), { enabled: true });
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('first portable start handles a missing Run value without localized error parsing', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'network-startup-'));
  const commands = [];
  try {
    const manager = createStartupManager({
      dataDir,
      platform: 'win32',
      exePath: 'C:\\Netzwerk-Kompass.exe',
      executor: async (file, args) => {
        commands.push([file, args]);
        if (file === 'powershell.exe') return { stdout: 'null\n' }; // Registry value is absent; OS language is irrelevant.
        return { stdout: '' };
      }
    });
    const state = await manager.init();
    assert.deepEqual(state, { available: true, enabled: true, registered: true, error: null });
    assert.equal(commands[0][0], 'powershell.exe');
    assert.equal(commands[1][0], 'reg.exe');
    assert.equal(commands[1][1][0], 'add');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test('failed settings persistence does not mutate the Run registration', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'network-startup-'));
  const registry = fakeRegistry();
  try {
    const manager = createStartupManager({ dataDir, platform: 'win32', exePath: 'C:\\app.exe', registry });
    assert.equal((await manager.init()).registered, true);
    const callCount = registry.calls.length;
    await rm(dataDir, { recursive: true, force: true });
    await writeFile(dataDir, 'block directory creation');
    const state = await manager.setEnabled(false);
    assert.equal(state.enabled, false);
    assert.equal(state.registered, true);
    assert.match(state.error, /konnte nicht gespeichert werden/);
    assert.equal(registry.calls.length, callCount);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
