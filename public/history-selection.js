export function initialPingSelection(targets) {
  const router = targets.find(target => ['gateway', 'router'].includes(target.kind));
  const internet = targets.find(target => target.kind === 'internet');
  return new Set([router?.host, internet?.host].filter(Boolean).length ? [router?.host, internet?.host].filter(Boolean) : targets.slice(0, 1).map(target => target.host));
}

export function togglePingSelection(selection, host, checked) {
  const next = new Set(selection);
  if (checked) next.add(host); else next.delete(host);
  return next;
}

export function resolvePingSelection(selection, targets) {
  return selection === null && targets.length ? initialPingSelection(targets) : selection;
}

export function selectPingTarget(host) {
  return new Set(host ? [host] : []);
}

export function pingTargetColor(host, index = 0) {
  let hash = 0;
  for (const char of String(host)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b) >>> 0;
  hash ^= hash >>> 16;
  // Keep the primary series on the turquoise accent; use neutral grays for comparisons.
  return index === 0 ? 'var(--turquoise, var(--accent, #3FC1B0))' : ['#8A9096', '#B8BDC2', '#676D73'][(hash >>> 0) % 3];
}

export function pingTargetDash(host) {
  let hash = 0;
  for (const char of String(host)) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return ['none', '6 4', '2 3', '9 3 2 3'][hash % 4];
}

export function createHistoryRequestGate() {
  let current = null;
  let sequence = 0;
  return {
    begin(key, force = false) {
      if (!force && current?.key === key) return null;
      current = { key, sequence: ++sequence };
      return current;
    },
    isCurrent(request) { return current === request; },
    finish(request) { if (current === request) current = null; },
    get pending() { return current !== null; },
  };
}

// IDs identify appended records, including measurements with identical timestamps.
export function mergeHistoryRecords(previous, payload) {
  const incoming = Array.isArray(payload.records) ? payload.records : [];
  const ids = Array.isArray(payload.recordIds) ? payload.recordIds : [];
  if (!payload.incremental) return { records: incoming, recordIds: ids, cursor: payload.cursor || null, changed: true };
  if (ids.length !== incoming.length || previous.recordIds?.length !== previous.records.length) throw new Error('Verlauf muss neu synchronisiert werden.');
  const removed = new Set(payload.removedRecordIds || []);
  const from = Date.parse(payload.from), to = Date.parse(payload.to);
  const entries = new Map();
  let changed = incoming.length > 0;
  previous.records.forEach((record, index) => {
    const at = Date.parse(record.at), id = previous.recordIds[index];
    if (removed.has(id) || at < from || at > to) changed = true;
    else entries.set(id, record);
  });
  incoming.forEach((record, index) => {
    const at = Date.parse(record.at);
    if (!removed.has(ids[index]) && at >= from && at <= to) entries.set(ids[index], record);
  });
  // The server owns retention/pruning; never keep records that it evicted.
  if (Number.isSafeInteger(payload.total) && entries.size !== payload.total) throw new Error('Verlauf muss neu synchronisiert werden.');
  return { records: changed ? [...entries.values()] : previous.records, recordIds: changed ? [...entries.keys()] : previous.recordIds, cursor: payload.cursor || null, changed };
}
