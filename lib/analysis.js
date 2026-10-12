import { isIP } from 'node:net';

export const PING_WARNING_MS = 30;

export function validateHost(value) {
  if (typeof value !== 'string') throw new Error('Bitte eine IPv4-Adresse oder einen Hostnamen eingeben.');
  const host = value.trim().toLowerCase();
  if (host.length > 253 || !host || (isIP(host) !== 4 && !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) || (/^[\d.]+$/.test(host) && isIP(host) !== 4)) {
    throw new Error('Nur IPv4-Adressen oder Hostnamen ohne URL, Port und Leerzeichen sind erlaubt.');
  }
  return host;
}

export function privateIPv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

const ipNumber = ip => ip.split('.').reduce((v, n) => ((v << 8) | Number(n)) >>> 0, 0);
const numberIp = n => [24, 16, 8, 0].map(s => (n >>> s) & 255).join('.');

export function subnetHosts(address, prefixLength) {
  if (!privateIPv4(address) || !Number.isInteger(prefixLength) || prefixLength < 1 || prefixLength > 32) throw new Error('Für den Scan wird eine lokale private IPv4-Adresse mit gültiger Netzmaske benötigt.');
  // Large corporate/VPN networks are deliberately not swept accidentally.
  const limited = prefixLength < 22;
  const prefix = limited ? 24 : prefixLength;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const start = (ipNumber(address) & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  const hosts = [];
  const first = prefix >= 31 ? 0 : 1;
  const end = prefix >= 31 ? size : size - 1;
  for (let i = first; i < end; i++) {
    const ip = numberIp(start + i);
    if (ip !== address && privateIPv4(ip)) hosts.push(ip);
  }
  return { hosts, limited, cidr: `${numberIp(start)}/${prefix}`, originalPrefix: prefixLength };
}

export function summarize(samples, kind = 'custom') {
  const valid = samples.filter(s => s.status !== 'measurement_error');
  const values = valid.filter(s => s.ok && Number.isFinite(s.ms)).map(s => s.ms);
  const sent = valid.length;
  const received = values.length;
  let consecutiveLoss = 0;
  for (let i = valid.length - 1; i >= 0 && !valid[i].ok; i--) consecutiveLoss++;
  const recent = valid.slice(-30);
  const recentOk = recent.filter(s => s.ok);
  const recentLoss = recent.length ? 100 * (recent.length - recentOk.length) / recent.length : 0;
  const last = valid.at(-1);
  const local = ['gateway','device','repeater'].includes(kind);
  const criticalLatency = local ? 100 : 300;
  let diffs = [];
  for (let i = 1; i < samples.length; i++) if (samples[i].ok && samples[i-1].ok && Number.isFinite(samples[i].ms) && Number.isFinite(samples[i-1].ms)) diffs.push(Math.abs(samples[i].ms - samples[i-1].ms));
  const avg = list => list.length ? list.reduce((a,b) => a+b, 0) / list.length : null;
  const recentAvg = avg(recentOk.map(s => s.ms));
  const measurementError = samples.at(-1)?.status === 'measurement_error';
  const critical = (recent.length >= 5 && recentLoss >= 10) || recentAvg >= criticalLatency;
  const status = measurementError || !sent ? 'pending' : consecutiveLoss >= 3 ? 'down' : critical ? 'critical' : (consecutiveLoss > 0 || (recent.length >= 5 && recentLoss > 2) || recentAvg > PING_WARNING_MS) ? 'warning' : 'ok';
  return { sent, received, lossPercent: sent ? 100 * (sent-received) / sent : null, avgMs: avg(values), minMs: values.length ? Math.min(...values) : null, maxMs: values.length ? Math.max(...values) : null, jitterMs: avg(diffs), lastMs: last?.ok ? last.ms : null, consecutiveLoss, status, recentLossPercent: recentLoss, recentAvgMs: recentAvg };
}

export function diagnose(state) {
  const result = [];
  const active = state.targets.filter(t => t.enabled && t.stats.sent >= 5 && t.stats.status!=='pending');
  const router = active.find(t => t.kind === 'gateway');
  const repeaters=state.targets.filter(t=>t.kind==='repeater');
  const repeater = active.find(t=>t.kind==='repeater'&&t.host===state.repeaterHost);
  const internet = active.filter(t => t.kind === 'internet');
  const bad = t => ['warning', 'critical', 'down'].includes(t.stats.status);
  const formatNumber = value => new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value);
  const values = target => [
    Number.isFinite(target.stats.recentAvgMs) ? `Ø ${formatNumber(target.stats.recentAvgMs)} ms` : null,
    Number.isFinite(target.stats.recentLossPercent) ? `${formatNumber(target.stats.recentLossPercent)} % Verlust` : null,
  ].filter(Boolean);
  const issue = (target, label) => {
    const avg=target.stats.recentAvgMs,loss=target.stats.recentLossPercent;
    const elevated=Number.isFinite(avg)&&avg>PING_WARNING_MS;
    const missing=Number.isFinite(loss)&&loss>0;
    const consecutive=target.stats.consecutiveLoss||0;
    const measured=values(target);
    const reason=elevated?'Ping erhöht':missing?'Antworten fehlen':consecutive>0?`${consecutive} Antworten in Folge fehlen`:'Messwerte auffällig';
    return `${label}: ${reason}${measured.length?` (${measured.join(', ')})`:''}.`;
  };
  if (!state.monitoring) result.push({level:'info',title:'Überwachung pausiert',detail:'Die angezeigten Ping-Werte stammen aus der letzten Messung.'});
  if (state.lastError) result.push({level:'warning',title:'Messung eingeschränkt',detail:state.lastError});
  for(const target of state.targets.filter(t=>t.enabled&&t.lastError)) result.push({level:'warning',title:`Messfehler: ${target.label}`,detail:target.lastError});
  if(repeaters.length&&!state.repeaterHost)result.push({level:'info',title:'Repeater am PC nicht zugeordnet',detail:'Wähle den Repeater, an dem dieser PC angeschlossen ist. Die übrigen Repeater werden unabhängig gemessen; Ping allein zeigt keine Mesh-Verbindung zwischen ihnen.'});
  else if(state.repeaterHost&&!repeater)result.push({level:'info',title:'PC-Repeater noch nicht auswertbar',detail:'Der ausgewählte Repeater ist pausiert, entfernt oder hat noch keine fünf gültigen Messungen. Andere Repeater ersetzen ihn im Diagnosepfad nicht.'});
  if (router && bad(router)) result.push({level:'warning',title:'Weg zum Router auffällig',detail:`${issue(router,'Router')} WLAN, Mesh-Uplink, Kabel oder Router-Auslastung kommen infrage. ICMP kann auch gedrosselt werden. Zum Eingrenzen diesen PC direkt per LAN an der FRITZ!Box vergleichen.`});
  if(repeater?.stats.status==='ok'&&router&&bad(router))result.unshift({level:'warning',title:'Repeater antwortet, Weg zur FRITZ!Box auffällig',detail:`${issue(router,'Router')} Der PC erreicht den Repeater; der Uplink oder Router kommt infrage, bei Funk-Uplink auch die Mesh-Funkstrecke. ICMP-Priorisierung und Routerlast bleiben mögliche Ursachen.`});
  if(repeater&&bad(repeater)&&router&&bad(router))result.unshift({level:'warning',title:'Schon Repeater und Router gleichzeitig auffällig',detail:`${issue(repeater,'Repeater')} ${issue(router,'Router')} PC-Netzwerkkarte, LAN-Kabel, Repeater-Port und Repeater-Auslastung gegeneinander prüfen.`});
  if (router?.stats.status === 'ok' && internet.length >= 2 && internet.every(bad)) result.push({level:'warning',title:'Internetweg auffällig, Router erreichbar',detail:`Beide externen Ping-Ziele sind auffällig, während der Router gut antwortet. Anschluss, WAN-Auslastung oder Routing prüfen. Das ist ein Hinweis, kein Beweis für einen Anbieterfehler. ${internet.map(target=>issue(target,target.label)).join(' ')}`});
  if (internet.length >= 2 && internet.some(bad) && internet.some(t => !bad(t))) result.push({level:'info',title:'Einzelnes Internetziel auffällig',detail:`Die anderen externen Ziele antworten. Das betroffene Ziel oder sein Weg kann Ping drosseln; ein vollständiger Internetausfall ist damit nicht belegt. ${internet.filter(bad).map(target=>issue(target,target.label)).join(' ')}`});
  const wifi = state.network?.wifi;
  const health=state.traffic?.adapterHealth;
  if(health?.at&&Date.now()-Date.parse(health.at)<15000&&Object.values(health.delta||{}).some(value=>typeof value==='number'&&value>0))result.push({level:'warning',title:'PC-Adapter meldet neue Fehler oder verworfene Pakete',detail:'Windows-Zähler sind im letzten Messintervall gestiegen. Unter Geräte & Repeater ansehen und mit den Lag-Zeiten vergleichen. Das ist ein lokaler Hinweis, aber kein Beweis für ein defektes Kabel oder einen entfernten Repeater.'});
  if (wifi?.connected && Number.isFinite(wifi.signalPercent) && wifi.signalPercent < 55) result.push({level:'warning',title:'Schwaches WLAN-Signal am PC',detail:`Windows meldet ${wifi.signalPercent} % Signal. Abstand, Wände und den verbundenen Access Point prüfen; dies misst nicht die Funkverbindung zwischen Repeatern.`});
  if (wifi?.connected && wifi.channel && (wifi.networks || []).filter(n => n.channel === wifi.channel && n.bssid !== wifi.bssid).length >= 2) result.push({level:'info',title:'Mehrere WLANs auf demselben Kanal sichtbar',detail:'Gemeinsame Kanalnutzung kann Wartezeiten verursachen. Die Liste misst weder tatsächliche Auslastung noch Störungen; Kanalbreite und überlappende Kanäle sind hier nicht erfasst.'});
  if (state.dns?.ok === false) result.push({level:'warning',title:'DNS-Auflösung fehlgeschlagen',detail:`Die Namensauflösung von example.com über Windows ist fehlgeschlagen: ${state.dns.error}. IP-Pings können trotzdem funktionieren.`});
  const fritz=state.fritzbox;
  if(fritz?.error)result.push({level:'info',title:'FRITZ!Box-Abfrage eingeschränkt',detail:fritz.error+' Das belegt keinen Internetausfall; gegebenenfalls angezeigte Routerdaten stammen aus der letzten erfolgreichen Abfrage.'});
  else if(fritz?.connected&&Date.now()-Date.parse(fritz.updatedAt)<90000&&fritz.wan?.status&&fritz.wan.status!=='Connected')result.push({level:'warning',title:'FRITZ!Box meldet abweichenden WAN-Status',detail:`Die Box meldet „${fritz.wan.status}“. Mit dem Ping-Verlauf und dem Router-Ereignisprotokoll zum selben Zeitpunkt vergleichen; der Status allein lokalisiert die Ursache nicht.`});
  if (state.speedTest.running) result.push({level:'info',title:'Speedtest belastet die Verbindung',detail:'Erhöhte Ping-Werte während des Tests können durch die Testlast entstehen. Für einen Vergleich die Werte vor und nach dem Test betrachten.'});
  if (state.stressTest?.running) result.push({level:'info',title:'Dauerbelastungstest läuft',detail:'Fortlaufende Testübertragungen belasten die Verbindung. Erhöhte Ping-Werte unter Last mit den Werten nach dem Stoppen vergleichen.'});
  if (!result.length) result.push({level:'info',title:active.length ? 'Bisher keine eindeutige Auffälligkeit' : 'Messung läuft an',detail:active.length ? 'Die aktuell überwachten Ziele zeigen keine eindeutige Störung. Nicht überwachte Geräte und interne Mesh-Verbindungen sind damit nicht geprüft.' : 'Für eine erste Einschätzung werden mindestens fünf Ping-Messungen pro Ziel gesammelt.'});
  return result;
}

export function trafficRate(previous, current, elapsedMs) {
  if (!previous || elapsedMs <= 0 || current.receivedBytes < previous.receivedBytes || current.sentBytes < previous.sentBytes) return null;
  return { downloadMbps: (current.receivedBytes-previous.receivedBytes)*8/(elapsedMs*1000), uploadMbps: (current.sentBytes-previous.sentBytes)*8/(elapsedMs*1000) };
}
