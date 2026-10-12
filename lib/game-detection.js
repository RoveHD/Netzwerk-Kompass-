import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const cleanName = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\\/]/g, ' ').trim().slice(0, 80) : '';
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24);
const normalize = value => typeof value === 'string' && value.length <= 2048 && !/[\x00-\x1f]/.test(value) && path.win32.isAbsolute(value) ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase() : null;
const executable = value => typeof value === 'string' ? value.toLowerCase().replace(/\.exe$/i, '') + '.exe' : '';
const excluded = /(?:launcher|updater|update(?:r|service)?|patcher|crash(?:handler|report|pad)|anti[-_]?cheat|easyanticheat|battleye|unins\d*|redist|vc_red|cefsubprocess|webhelper|(?:_BE|_EAC|_EOS)\.exe$)/i;
const excludedExact = new Set(['steam.exe', 'epicgames.exe', 'epicgameslauncher.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'node.exe', 'python.exe', 'conhost.exe', 'UnityCrashHandler64.exe'.toLowerCase(), 'wallpaper32.exe', 'wallpaper64.exe']);
export const KNOWN_GAMES = [
  ['marvel-rivals', 'Marvel Rivals', ['Marvel-Win64-Shipping.exe']],
  ['fortnite', 'Fortnite', ['FortniteClient-Win64-Shipping.exe']],
  ['valorant', 'VALORANT', ['VALORANT-Win64-Shipping.exe']],
  ['league-of-legends', 'League of Legends', ['League of Legends.exe']],
  ['counter-strike-2', 'Counter-Strike 2', ['cs2.exe']],
  ['dota-2', 'Dota 2', ['dota2.exe']],
  ['apex-legends', 'Apex Legends', ['r5apex.exe']],
  ['overwatch', 'Overwatch', ['Overwatch.exe']],
  ['rocket-league', 'Rocket League', ['RocketLeague.exe']],
  ['pubg', 'PUBG', ['TslGame.exe']],
  ['elden-ring', 'ELDEN RING', ['eldenring.exe']],
  ['gta-v', 'Grand Theft Auto V', ['GTA5.exe', 'GTA5_Enhanced.exe']]
];

export function validateGameSettings(value) {
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean' || !Array.isArray(value.customGames) || value.customGames.length > 32) throw new TypeError('Spieleerkennung benötigt enabled und höchstens 32 eigene Spiele.');
  const seen = new Set();
  const customGames = value.customGames.map(item => {
    if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80 || /[\x00-\x1f\x7f\\/]/.test(item.name)) throw new TypeError('Spielname muss 1 bis 80 Zeichen lang sein.');
    if (typeof item.executable !== 'string' || item.executable.length > 160 || !/^[^\\/:*?"<>|\x00-\x1f\x7f]+\.exe$/i.test(item.executable) || item.executable.trim() !== item.executable || /^[.]/.test(item.executable) || /[;&`$]/.test(item.executable)) throw new TypeError('Nur ein EXE-Basisname ohne Pfad, Platzhalter oder Shell-Zeichen ist erlaubt.');
    const name = item.executable.toLowerCase();
    if (seen.has(name)) throw new TypeError('Eine EXE darf nur einem eigenen Spiel zugeordnet werden.');
    if (excluded.test(name) || excludedExact.has(name)) throw new TypeError('Launcher und Hilfsprozesse sind keine Spiele.');
    seen.add(name);
    return { name: item.name.trim(), executable: item.executable };
  });
  return { enabled: value.enabled, customGames };
}

// Valve KeyValues (quoted strings, escapes, comments and nested objects).
export function parseValveKeyValues(text) {
  if (typeof text !== 'string' || text.length > 2 * 1024 * 1024) throw new Error('Ungültiges Manifest.');
  const tokens = []; const expression = /\s+|\/\/[^\r\n]*|"((?:\\.|[^"\\])*)"|([{}])|([^\s{}"]+)/g;
  let match;
  while ((match = expression.exec(text))) {
    if (match[1] !== undefined) tokens.push({ value: match[1].replace(/\\([\\"])/g, '$1') });
    else if (match[2]) tokens.push(match[2]);
    else if (match[3]) tokens.push({ value: match[3] });
    if (tokens.length > 50000) throw new Error('Manifest zu groß.');
  }
  let index = 0;
  function object(depth = 0) {
    if (depth > 12) throw new Error('Manifest zu tief verschachtelt.');
    const result = Object.create(null);
    while (index < tokens.length && tokens[index] !== '}') {
      const key = tokens[index++]; const value = tokens[index++];
      if (!key || typeof key !== 'object' || value === undefined || value === '}') throw new Error('Ungültiges Manifest.');
      if (value === '{') { result[key.value.toLowerCase()] = object(depth + 1); if (tokens[index++] !== '}') throw new Error('Ungültiges Manifest.'); }
      else if (typeof value === 'object') result[key.value.toLowerCase()] = value.value;
      else throw new Error('Ungültiges Manifest.');
    }
    return result;
  }
  const result = object();
  if (index !== tokens.length) throw new Error('Ungültiges Manifest.');
  return result;
}

export function steamManifest(text, root) {
  const app = parseValveKeyValues(text).appstate;
  if (!app || !/^\d+$/.test(app.appid) || !cleanName(app.name) || typeof app.installdir !== 'string' || !/^[^\\/:*?"<>|\x00-\x1f]+$/.test(app.installdir) || ['.', '..'].includes(app.installdir) || !normalize(root)) return null;
  return { id: `steam:${app.appid}`, name: cleanName(app.name), source: 'steam', installPath: path.win32.join(root, 'steamapps', 'common', app.installdir) };
}
export function epicManifest(text) {
  const app = JSON.parse(text);
  if (!cleanName(app.DisplayName) || !normalize(app.InstallLocation) || typeof app.AppName !== 'string' || !app.AppName || app.AppName.length > 200) return null;
  return { id: `epic:${hash(app.AppName)}`, name: cleanName(app.DisplayName), source: 'epic', installPath: app.InstallLocation };
}
export function insideInstallPath(file, directory) {
  const normalizedFile = normalize(file), normalizedDirectory = normalize(directory);
  return !!normalizedFile && !!normalizedDirectory && normalizedFile.startsWith(normalizedDirectory + '\\');
}

export function matchGameProcess(process, library = [], customGames = []) {
  if (!process || !Number.isInteger(process.id) || process.id < 1 || typeof process.name !== 'string' || /[\\/\x00-\x1f]/.test(process.name)) return null;
  const exe = executable(process.name);
  if (excluded.test(exe) || excludedExact.has(exe)) return null;
  const custom = customGames.find(game => game.executable.toLowerCase() === exe);
  if (custom) return { id: `custom:${hash(exe)}`, name: custom.name, source: 'custom' };
  const known = KNOWN_GAMES.find(([, , names]) => names.some(name => name.toLowerCase() === exe));
  // Stable known identity survives unreadable paths and launcher/library changes.
  if (known) return { id: `known:${known[0]}`, name: known[1], source: 'known' };
  if (!process.path || path.win32.basename(process.path).toLowerCase() !== exe) return null;
  const game = library.filter(game => insideInstallPath(process.path, game.installPath)).sort((a, b) => b.installPath.length - a.installPath.length)[0];
  return game ? { id: game.id, name: game.name, source: game.source } : null;
}

export function createGameLibrary({ read = readFile, list = readdir, fileStat = stat, ttlMs = 60000, now = Date.now } = {}) {
  let cached = null, cachedAt = 0, cachedKey = null;
  async function text(file) {
    if ((await fileStat(file)).size > 2 * 1024 * 1024) throw new Error('Manifest zu groß.');
    return read(file, 'utf8');
  }
  return {
    async load({ steamRoots = [], epicRoots = [] } = {}) {
      const steam = [...new Set(steamRoots.filter(root => normalize(root)))].slice(0, 16);
      const epic = [...new Set(epicRoots.filter(root => normalize(root)))].slice(0, 4);
      const key = JSON.stringify([steam, epic]);
      if (cached && cachedKey === key && now() - cachedAt < ttlMs) return cached;
      let partial = false, scanned = 0; const games = new Map(); const libraries = new Set(steam);
      for (const root of steam) {
        try {
          const entries = parseValveKeyValues(await text(path.win32.join(root, 'steamapps', 'libraryfolders.vdf'))).libraryfolders;
          for (const entry of Object.values(entries || {})) {
            const library = typeof entry === 'string' ? entry : entry.path;
            if (normalize(library) && libraries.size < 32) libraries.add(library);
          }
        } catch (error) { if (error.code !== 'ENOENT') partial = true; }
      }
      for (const root of libraries) {
        try {
          const names = (await list(path.win32.join(root, 'steamapps'))).filter(name => /^appmanifest_\d+\.acf$/i.test(name));
          const remaining = Math.min(2048, 4096 - scanned);
          if (names.length > remaining) partial = true;
          for (const name of names.slice(0, remaining)) {
            scanned++;
            try { const game = steamManifest(await text(path.win32.join(root, 'steamapps', name)), root); if (game) games.set(game.id, game); else partial = true; }
            catch { partial = true; }
          }
        } catch (error) { if (error.code !== 'ENOENT') partial = true; }
      }
      for (const root of epic) {
        try {
          const names = (await list(root)).filter(name => /^[^\\/]+\.item$/i.test(name));
          const remaining = Math.min(2048, 4096 - scanned);
          if (names.length > remaining) partial = true;
          for (const name of names.slice(0, remaining)) {
            scanned++;
            try { const game = epicManifest(await text(path.win32.join(root, name))); if (game) games.set(game.id, game); else partial = true; }
            catch { partial = true; }
          }
        } catch (error) { if (error.code !== 'ENOENT') partial = true; }
      }
      cachedAt = now(); cachedKey = key; cached = { games: [...games.values()].slice(0, 4096), partial: partial || games.size > 4096 };
      return cached;
    }
  };
}

export function initialGameDetection() {
  return { enabled: true, status: 'checking', checkedAt: null, error: null, warning: null, libraryCount: 0, customGames: [], active: [], recent: [] };
}
const identity = process => `${process.id}:${typeof process.startedAt === 'string' ? process.startedAt : ''}`;
export class GameDetector {
  constructor(state, emit) { this.state = state; this.emit = emit; this.sessions = new Map(); this.fresh = false; }
  processIds(sessionId) {
    if (!this.fresh || !this.state.enabled || Date.now() - Date.parse(this.state.checkedAt) > 15000) return [];
    return [...new Set([...(this.sessions.get(sessionId)?.processes.values() || [])].map(process => process.id))];
  }
  fail() { this.fresh = false; this.state.status = 'error'; this.state.error = 'Spieleerkennung fehlgeschlagen. Vorherige Beobachtungen bleiben erhalten; ein Spielende ist nicht bestätigt.'; }
  end(sessionId, reason, at, action = 'observation-ended') {
    const session = this.sessions.get(sessionId); if (!session) return;
    this.sessions.delete(sessionId);
    const game = { ...session.game, endedAt: at, reason };
    this.state.recent.unshift(game); this.state.recent.length = Math.min(20, this.state.recent.length);
    this.emit({ type: 'event', kind: 'game', action, game, gameSessionIds: [game.sessionId], at, level: 'info', title: action === 'ended' ? `${game.name}: Prozess nicht mehr beobachtet` : `${game.name}: Beobachtung beendet`, detail: `Beobachtung seit ${game.startedAt}; ${reason}. Dies ist kein Nachweis des exakten Spielendes.` });
  }
  stop(reason, at = new Date().toISOString()) {
    this.fresh = false;
    for (const sessionId of [...this.sessions.keys()]) this.end(sessionId, reason, at);
    this.state.active = [];
  }
  apply(snapshot, library, at = new Date().toISOString()) {
    if (!snapshot || !Array.isArray(snapshot.processes) || snapshot.processes.length > 4096 || snapshot.processes.some(process => !process || !Number.isInteger(process.id) || process.id < 0 || typeof process.name !== 'string')) throw new Error('Ungültige Prozessbeobachtung.');
    // Get-Process includes the Windows Idle pseudo-process (PID 0). It must
    // neither match a game nor invalidate an otherwise successful snapshot.
    const runningProcesses = snapshot.processes.filter(process => process.id > 0);
    const previous = new Map();
    for (const session of this.sessions.values()) for (const [key, process] of session.processes) previous.set(process.id, { key, process });
    const processKey = process => {
      const old = previous.get(process.id);
      // Missing StartTime is an uncertainty, not evidence of a restart/exit.
      return !process.startedAt && old?.process.name.toLowerCase() === process.name.toLowerCase() ? old.key : identity(process);
    };
    const groups = new Map(); const processes = new Map(runningProcesses.map(process => [processKey(process), process]));
    for (const process of runningProcesses) {
      const game = matchGameProcess(process, library.games, this.state.customGames); if (!game) continue;
      if (!groups.has(game.id)) groups.set(game.id, { game, processes: new Map() });
      groups.get(game.id).processes.set(processKey(process), process);
    }
    for (const [sessionId, session] of this.sessions) {
      const group = groups.get(session.game.id);
      const continuing = [...session.processes.keys()].some(key => group?.processes.has(key));
      // A still-observed process retains its verified assignment even when a
      // library/path becomes unreadable. StartTime loss disables capture below.
      const retained = [...session.processes.keys()].filter(key => processes.has(key));
      if (continuing || retained.length) {
        session.processes = new Map([...(group?.processes || []), ...retained.map(key => [key, processes.get(key)])]);
        session.game.lastSeenAt = at; groups.delete(session.game.id);
      } else if (!snapshot.truncated) this.end(sessionId, 'process-exited', at, 'ended');
      else groups.delete(session.game.id);
    }
    let limited = false;
    for (const { game, processes: running } of groups.values()) {
      if (this.sessions.size >= 32) { limited = true; continue; }
      const sessionId = randomUUID(); const observed = { ...game, sessionId, startedAt: at, lastSeenAt: at };
      this.sessions.set(sessionId, { game: observed, processes: running });
      this.emit({ type: 'event', kind: 'game', action: 'started', game: { ...observed }, gameSessionIds: [sessionId], at, level: 'info', title: `${game.name}: Spielprozess erkannt`, detail: 'Beginn der lokalen Beobachtung; der tatsächliche Spielstart kann früher liegen.' });
    }
    this.state.active = [...this.sessions.values()].map(session => ({ ...session.game }));
    this.state.checkedAt = at; this.state.error = null; this.state.libraryCount = library.games.length;
    this.state.status = snapshot.partial || snapshot.truncated || library.partial || limited || runningProcesses.some(process => !process.path || !process.startedAt) ? 'partial' : 'ready';
    this.state.warning = this.state.status === 'partial' ? 'Einige Prozesspfade oder Bibliotheken sind nicht lesbar. Bekannte und eigene EXE-Zuordnungen funktionieren weiterhin. Steam-Bibliotheken können auch Programme enthalten.' : 'Erkennung über Installationspfad oder EXE-Zuordnung. Steam-Bibliotheken können auch Programme enthalten; nicht jedes Spiel oder jeder Launcher wird erkannt.';
    this.fresh = !snapshot.truncated;
  }
}
