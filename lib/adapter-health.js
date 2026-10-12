export const ADAPTER_COUNTERS = ['receivedErrors','sentErrors','receivedDiscards','sentDiscards'];
const valid = value => Number.isSafeInteger(value) && value >= 0;

// Driver counters are cumulative. Only differences from the same adapter and
// an uninterrupted observation interval can describe this measurement period.
export function adapterHealth(previous, current, now = Date.now()) {
  const counters=Object.fromEntries(ADAPTER_COUNTERS.map(key=>[key,valid(current?.[key])?current[key]:null]));
  const intervalMs=previous ? now-previous.time : null;
  const same=previous?.id===current?.id;
  const reset=same&&ADAPTER_COUNTERS.some(key=>valid(previous[key])&&valid(counters[key])&&counters[key]<previous[key]);
  const intervalValid=same&&!reset&&intervalMs>0&&intervalMs<=15000;
  const delta=Object.fromEntries(ADAPTER_COUNTERS.map(key=>[key,intervalValid&&valid(previous[key])&&valid(counters[key])?counters[key]-previous[key]:null]));
  return {at:new Date(now).toISOString(),available:ADAPTER_COUNTERS.some(key=>valid(counters[key])),counters,delta,reset,
    intervalStartedAt:intervalValid?new Date(previous.time).toISOString():null,intervalMs:intervalValid?intervalMs:null,
    reason:reset?'Windows-Zähler wurden zurückgesetzt; neue Vergleichsbasis.':!same?'Erster Zählerstand; die nächste Messung zeigt Veränderungen.':!intervalValid?'Messlücke; Veränderungen sind diesem Zeitraum nicht sicher zuzuordnen.':null};
}
