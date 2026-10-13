const integer=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
const mac=value=>typeof value==='string'&&/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(value)&&!/^00:00:00:00:00:00$|^ff:ff:ff:ff:ff:ff$/i.test(value)?value.toUpperCase():null;
const unavailable=reason=>({downloadMbps:null,uploadMbps:null,downloadBytes:null,uploadBytes:null,elapsedMs:null,reason});

// Mesh WAN counters measure IP-layer Internet bytes. Rates use the counter's
// router timestamp, never the app's poll time or the local PHY link rate.
export function deriveDeviceTraffic(previous,current,{previousSessionId,currentSessionId,previousUptimeSeconds,currentUptimeSeconds,maxGapMs=90000}={}) {
  if(previous?.available!==true||current?.available!==true)return unavailable('Keine zwei verfügbaren Geräte-Bytezähler.');
  const identity=mac(current.mac);
  if(!identity||identity!==mac(previous.mac))return unavailable('Geräteidentität hat sich geändert oder fehlt.');
  if(previous.source!=='mesh-wan-counters'||current.source!=='mesh-wan-counters'||previous.scope!=='internet'||current.scope!=='internet')return unavailable('Die Bytezähler stammen nicht aus derselben Internetmessung.');
  if(typeof currentSessionId!=='string'||!currentSessionId||previousSessionId!==currentSessionId)return unavailable('Keine durchgehende Routersitzung.');
  if(!integer(previousUptimeSeconds)||!integer(currentUptimeSeconds))return unavailable('Routerlaufzeit fehlt für eine sichere Ratenberechnung.');
  if(currentUptimeSeconds<previousUptimeSeconds)return unavailable('Router wurde zwischen den Messungen neu gestartet.');
  for(const entry of [previous,current])if(!integer(entry.totalBytesReceived)||!integer(entry.totalBytesSent)||!integer(entry.lastUpdateMs)||entry.lastUpdateMs===0||entry.lastUpdateMs>8640000000000000)return unavailable('Ungültige Geräte-Bytezähler oder Routerzeitpunkte.');
  if(current.lastUpdateMs<=previous.lastUpdateMs)return unavailable('Kein neuer Routerzeitpunkt für diese Geräte-Bytezähler.');
  const elapsedMs=current.lastUpdateMs-previous.lastUpdateMs;
  if(!integer(maxGapMs)||maxGapMs===0||elapsedMs>maxGapMs)return unavailable('Messpause überschreitet das zulässige Ratenfenster.');
  const downloadBytes=current.totalBytesReceived-previous.totalBytesReceived,uploadBytes=current.totalBytesSent-previous.totalBytesSent;
  if(downloadBytes<0||uploadBytes<0)return unavailable('Geräte-Bytezähler wurden zurückgesetzt.');
  return {downloadMbps:downloadBytes/elapsedMs*.008,uploadMbps:uploadBytes/elapsedMs*.008,downloadBytes,uploadBytes,elapsedMs,intervalStartedAt:new Date(previous.lastUpdateMs).toISOString(),intervalEndedAt:new Date(current.lastUpdateMs).toISOString(),measurementBasis:'router-counter-timestamp',reason:null};
}

// Generic WAN byte actions do not publish their counter update timestamp.
// A short request interval improves observation resolution, but cannot establish
// the router's internal sampling frequency or a per-second packet trace.
export function deriveWanTraffic(previous,current,{previousSessionId,currentSessionId,previousUptimeSeconds,currentUptimeSeconds,maxGapMs=90000}={}) {
  if(!previous||!current)return unavailable('Keine zwei WAN-Bytezähler vorhanden.');
  if(previous.source!=='tr064-wan-byte-counters'||current.source!==previous.source||previous.scope!=='internet'||current.scope!==previous.scope)return unavailable('Keine gleichartigen WAN-Internet-Bytezähler.');
  if(typeof currentSessionId!=='string'||!currentSessionId||previousSessionId!==currentSessionId)return unavailable('Keine durchgehende Routersitzung.');
  if(!integer(previousUptimeSeconds)||!integer(currentUptimeSeconds)||currentUptimeSeconds<previousUptimeSeconds)return unavailable('Routerlaufzeit fehlt oder wurde zurückgesetzt.');
  const window=entry=>{
    const from=Date.parse(entry.sampling?.from),to=Date.parse(entry.sampling?.to);
    return Number.isFinite(from)&&Number.isFinite(to)&&to>=from?{from,to,mid:from+(to-from)/2}:null;
  };
  const before=window(previous),after=window(current);
  if(!before||!after||after.from<before.to)return unavailable('WAN-Abfragefenster fehlen, überlappen sich oder liegen außerhalb der Zeitfolge.');
  const elapsedMs=after.mid-before.mid;
  if(!integer(maxGapMs)||maxGapMs===0||elapsedMs<=0||elapsedMs>maxGapMs)return unavailable('Keine gültige WAN-Messdauer innerhalb des Ratenfensters.');
  for(const entry of [previous,current])if(!integer(entry.totalBytesReceived)||!integer(entry.totalBytesSent))return unavailable('Ungültige WAN-Bytezähler.');
  const downloadBytes=current.totalBytesReceived-previous.totalBytesReceived,uploadBytes=current.totalBytesSent-previous.totalBytesSent;
  if(downloadBytes<0||uploadBytes<0)return unavailable('WAN-Bytezähler wurden zurückgesetzt.');
  return {downloadMbps:downloadBytes/elapsedMs*.008,uploadMbps:uploadBytes/elapsedMs*.008,downloadBytes,uploadBytes,elapsedMs,intervalStartedAt:new Date(before.mid).toISOString(),intervalEndedAt:new Date(after.mid).toISOString(),measurementBasis:'request-observation-window',observationWindow:{from:new Date(before.from).toISOString(),to:new Date(after.to).toISOString()},timingUncertaintyMs:(before.to-before.from+after.to-after.from)/2,counterUpdatedAtAvailable:false,counterUpdateFrequencyKnown:false,reason:null};
}
