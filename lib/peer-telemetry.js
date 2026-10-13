// Field-by-field projection is intentionally stricter than secret-name removal.
// No arbitrary text, events, URLs, packet payload, router objects or credentials.
const text = (value, length = 100) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, length) : undefined;
const number = value => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : undefined;
const boolean = value => typeof value === 'boolean' ? value : undefined;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const ip = value => typeof value === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(n => +n <= 255) ? value : undefined;
const host = value => typeof value === 'string' && /^[a-z\d_.:-]{1,253}$/i.test(value) ? value : undefined;
const mac = value => typeof value === 'string' && /^(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}$/i.test(value) ? value.replace(/-/g, ':').toUpperCase() : undefined;
const pick = (source, fields) => Object.fromEntries(Object.entries(fields).flatMap(([key, fn]) => { const value = fn(source?.[key]); return value === undefined ? [] : [[key, value]]; }));
const counters = value => pick(value, { receivedErrors: number, sentErrors: number, receivedDiscards: number, sentDiscards: number });
const quality = value => value && typeof value === 'object' ? pick(value, { durationMs:number, scheduledIntervalMs:number, actualIntervalMs:number, schedulerDelayMs:number, cpuFraction:number, status:item=>['normal','limited'].includes(item)?item:undefined, backoffMs:number, gap:boolean }) : undefined;

export function projectPeerRecord(input) {
  if (!input || !['ping', 'traffic', 'network', 'wifi', 'scan', 'topology'].includes(input.type)) return null;
  const at = timestamp(input.at); if (!at) return null;
  const record = { type: input.type, at, ...pick(input, { interfaceId: text, appSessionId: text, measurementStartedAt: timestamp, pcMac: mac, selectedRepeaterHost: host, routingConfirmed: boolean, ipv4: value => Array.isArray(value) ? value.slice(0, 8).map(ip).filter(Boolean) : undefined, epoch: number, quality }) };
  if (input.type === 'ping') {
    record.results = (Array.isArray(input.results) ? input.results : []).slice(0, 32).map(item => pick(item, {
      host, routeInterfaceId: text, kind: value => ['gateway', 'router', 'repeater', 'internet', 'custom', 'device'].includes(value) ? value : undefined,
      ok: boolean, ms: number, timeout: boolean, quality, status: value => ['Success', 'TimedOut', 'DestinationHostUnreachable', 'DestinationNetworkUnreachable', 'TtlExpired', 'Unknown', 'success', 'timeout', 'measurement_error', 'unreachable', 'ok', 'gap', 'missing', 'unknown'].includes(value) ? value : undefined, error: value => value ? 'Messfehler' : undefined,
    }));
    Object.assign(record, pick(input, { underLoad: boolean, loadType: value => ['download', 'upload', 'both', 'speedtest', 'stress'].includes(value) ? value : undefined, repeaterHost: host }));
  }
  if (input.type === 'traffic') {
    Object.assign(record, pick(input, { downloadMbps: number, uploadMbps: number, intervalStartedAt: timestamp }));
    if (input.adapterHealth) record.adapterHealth = { ...pick(input.adapterHealth, { available: boolean, reset: boolean, intervalMs: number, intervalStartedAt: timestamp }), counters: counters(input.adapterHealth.counters), delta: counters(input.adapterHealth.delta) };
  }
  if (input.type === 'network') Object.assign(record, pick(input, { ipv4: value => Array.isArray(value) ? value.slice(0, 8).map(ip).filter(Boolean) : undefined, gateway: ip, status: value => ['Up', 'Down', 'Disconnected'].includes(value) ? value : undefined, linkSpeedMbps: number }));
  if (input.type === 'wifi') Object.assign(record, pick(input, { connected: boolean, bssid: mac, signal: number, signalPercent: number, channel: number, receiveRateMbps: number, transmitRateMbps: number }));
  if (input.type === 'scan' || input.type === 'topology') record.devices = (Array.isArray(input.devices) ? input.devices : []).slice(0, 64).map(item => pick(item, { ip, mac, active: boolean, interfaceId: text, parentMac: mac, source: value => ['arp', 'scan', 'fritzbox', 'mesh', 'manual'].includes(value) ? value : undefined }));
  if (Buffer.byteLength(JSON.stringify(record)) > 8192) return null;
  return record;
}
