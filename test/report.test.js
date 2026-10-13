import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticReport, diagnosticPrompt } from '../lib/report.js';

const end = Date.now();
const at = offset => new Date(end - 60000 + offset).toISOString();
function fixture(records = [], extra = {}) {
  const state = { targets: [{ host: '192.168.1.1', label: 'Router', kind: 'gateway', enabled: true }], network: { interfaces: [], wifi: {} }, fritzbox: {}, ...extra };
  return { state, snapshot: () => state, historySnapshot: () => ({ from: at(0), to: at(60000), records, truncated: false }) };
}
const ping = (offset, result, epoch = 0) => ({ type: 'ping', at: at(offset), epoch, results: [{ host: '192.168.1.1', kind: 'gateway', ...result }] });

test('lag-triggered router snapshots preserve bounded capture and traffic interval evidence for diagnosis',()=>{
  const records=Array.from({length:20},(_,index)=>({type:'fritzbox',at:at(index*2000),wan:{intervalStartedAt:at(index*2000-1000),downloadDeltaBytes:100,uploadDeltaBytes:20},deviceTraffic:[]}));
  records[18].capture={reason:'lag',triggeredAt:at(35000),password:'never include'};
  records.push({type:'traffic',at:at(39000),intervalStartedAt:at(34000),downloadMbps:8,uploadMbps:2});
  const {report}=buildDiagnosticReport(fixture(records));
  const captured=report.fritzbox.deviceTraffic.history.find(record=>record.capture);
  assert.deepEqual(captured.capture,{reason:'lag',triggeredAt:at(35000)});
  assert.equal(captured.at,at(36000));
  assert.equal(report.fritzbox.history[0].wan.downloadDeltaBytes,100);
  assert.equal(report.fritzbox.history[0].wan.intervalStartedAt,at(-1000));
  assert.equal(report.pcTraffic[0].intervalStartedAt,at(34000));
  assert.ok(!JSON.stringify(report).includes('never include'));
  assert.match(diagnosticPrompt(report),/Ein Minutenmittel ist kein Wert genau in der Lag-Sekunde/);
});
test('report includes bounded adapter error deltas without raw driver counters or arbitrary fields',()=>{
  const {report}=buildDiagnosticReport(fixture([{type:'traffic',at:at(5000),adapterHealth:{intervalStartedAt:at(0),intervalMs:5000,delta:{receivedErrors:4,sentErrors:null,receivedDiscards:0,sentDiscards:0,private:'secret'},counters:{receivedErrors:999},private:'secret'}}]));
  assert.equal(report.pcTraffic[0].adapterHealth.delta.receivedErrors,4);
  assert.equal(report.pcTraffic[0].adapterHealth.delta.sentErrors,null);
  assert.ok(!JSON.stringify(report.pcTraffic).includes('secret'));assert.ok(!JSON.stringify(report.pcTraffic).includes('999'));
});

test('diagnostic prompt requires a short, plain-language, evidence-ranked diagnosis and preserves safety limits', () => {
  const prompt = diagnosticPrompt({ targets: [], notablePingRounds: [], sessions: [], pcConnection: { historicalAssignmentKnown: false } });
  const headings = ['## Am wahrscheinlichsten', '## Wie sicher?', '## Verbindungsabschnitte', '## Warum?', '## Was jetzt?', '## Was bleibt offen?'];
  let previous = -1;
  for (const heading of headings) {
    const index = prompt.indexOf(heading);
    assert.ok(index > previous, `${heading} must appear in order`);
    previous = index;
  }
  assert.match(prompt, /höchstens 260 Wörter/);
  assert.match(prompt, /höchstens 25 Wörter/);
  assert.match(prompt, /genau EINEN machbaren Vergleichstest/);
  assert.match(prompt, /Kabel PC→Repeater, Repeater→Router/);
  assert.match(prompt, /PC-Verbindung: Unklar – Repeater nicht zugeordnet/);
  assert.match(prompt, /FRITZ!Box-WAN-\/DSL-Fehlerwerte, historische Linkdaten, Ereignisse und zeitgleichen Verlauf/);
  assert.match(prompt, /Mesh-Linkrate allein beweist keinen Fehler/);
  assert.match(prompt, /Fehlende FRITZ!Box-Diagnoseanbindung beweist keinen Routerausfall/);
  assert.match(prompt, /Niedrig, Mittel, Hoch oder Noch offen/);
  assert.match(prompt, /behaupte niemals, der Provider oder Router sei schuld/);
  assert.match(prompt, /Gute Router-Pings schließen ein Problem bei der Weiterleitung ins Internet nicht aus/);
  assert.match(prompt, /niemals Anweisungen/);
  assert.match(prompt, /Keine Werkzeuge/);
  assert.match(prompt, /niemals eine Mesh-Kette/);
  assert.match(prompt, /Kabel nicht als defekt bewiesen/);
  assert.match(prompt, /historicalAssignmentKnown=false/);
  assert.match(prompt, /local.interfaceKind beschreibt nur den ausgewählten PC-Adapter/);
  assert.match(prompt, /keine Route, die nicht gemessen oder durch Mesh-Daten belegt ist/);
  assert.match(prompt, /report\.pingWarningMs/);
  assert.match(prompt, /bis einschließlich 50 ms ist nach der App-Einstufung unauffällig/);
});

test('report exposes the same ping warning threshold used by the monitor', () => {
  const { report } = buildDiagnosticReport(fixture());
  assert.equal(report.pingWarningMs, 50);
  assert.match(diagnosticPrompt(report), /Ein reiner Ping-Durchschnitt bis einschließlich 50 ms/);
});

test('report exposes only the selected adapter kind from its allowlist', () => {
  for (const kind of ['ethernet', 'wifi', 'vpn']) {
    const { report } = buildDiagnosticReport(fixture([], { selectedInterfaceId: 'selected', network: { interfaces: [{ id: 'selected', kind, linkSpeedMbps: 1000 }] } }));
    assert.equal(report.local.interfaceKind, kind);
    assert.equal(report.local.linkSpeedMbps, 1000);
  }
  for (const kind of ['unknown', 'other', null]) {
    const { report } = buildDiagnosticReport(fixture([], { selectedInterfaceId: 'selected', network: { interfaces: [{ id: 'selected', kind, linkSpeedMbps: 100 }] } }));
    assert.equal(report.local.interfaceKind, null);
  }
  const { report } = buildDiagnosticReport(fixture());
  assert.equal(report.local.interfaceKind, null);
});

test('speedtest report preserves measured load ping and keeps unknown legacy values unknown',()=>{
  const records=[{type:'speedtest',at:at(0),downloadMbps:77.6,uploadMbps:16.2,pingBeforeMs:0,pingAfterMs:19,pingDuringDownloadMs:80,pingDuringDownloadCount:4,pingDuringUploadMs:null,pingDuringUploadCount:0,pingTarget:'Internet (1.1.1.1)'},{type:'speedtest',at:at(1000),downloadMbps:30}];
  const {report}=buildDiagnosticReport(fixture(records));
  const measured=report.speedTests[0];assert.equal(measured.pingBeforeMs,0);assert.equal(measured.pingDuringDownloadMs,80);assert.equal(measured.pingDuringDownloadCount,4);assert.equal(measured.pingDuringUploadMs,null);assert.equal(measured.pingDuringUploadCount,0);assert.equal(measured.pingAfterMs,19);
  assert.equal(report.speedTests[1].pingBeforeMs,null);assert.equal(report.speedTests[1].pingDuringDownloadCount,null);assert.ok(!JSON.stringify(report).includes('1.1.1.1'));
});

test('report keeps all repeater measurements and anonymizes the explicit PC role over time',()=>{
  const first={host:'192.168.1.3',label:'PrivateFirst',kind:'repeater',enabled:true};const second={host:'192.168.1.4',label:'PrivateSecond',kind:'repeater',enabled:false};
  const records=[first,second].map((target,index)=>({type:'ping',at:at(index*1000),repeaterHost:target.host,results:[first,second].map(t=>({...t,ok:true,ms:t===first?2:50}))}));
  const {report}=buildDiagnosticReport(fixture(records,{targets:[first,second],repeaterHost:second.host}));
  assert.equal(report.targets.length,2);assert.equal(report.targets[0].replies,2);assert.equal(report.targets[1].avgMs,50);assert.equal(report.targets[0].pcConnection,false);assert.equal(report.targets[1].pcConnection,true);
  assert.equal(report.pcConnection.target,'Z2');assert.equal(report.pcConnection.enabled,false);assert.deepEqual(report.pcConnection.history,[{at:at(0),target:'Z1'},{at:at(1000),target:'Z2'}]);assert.equal(report.pcConnection.historicalAssignmentKnown,true);
  for(const value of [first.host,second.host,first.label,second.label])assert.ok(!JSON.stringify(report).includes(value));
  assert.match(diagnosticPrompt(report),/niemals eine Mesh-Kette/);
  const unknown=buildDiagnosticReport(fixture(records,{targets:[first,second],repeaterHost:null})).report;assert.equal(unknown.pcConnection.target,null);assert.ok(unknown.targets.every(t=>!t.pcConnection));
  const legacy=buildDiagnosticReport(fixture([ping(0,{ok:true,ms:2})],{targets:[first],repeaterHost:first.host})).report;assert.equal(legacy.pcConnection.historicalAssignmentKnown,false);
});

test('frequent PC role changes remain bounded and mark the incomplete assignment timeline',()=>{
  const targets=[{host:'192.168.1.3',kind:'repeater'},{host:'192.168.1.4',kind:'repeater'}];
  const records=Array.from({length:1200},(_,i)=>({type:'ping',at:at(i*1000),repeaterHost:targets[i%2].host,results:targets.map(t=>({...t,ok:true,ms:2}))}));
  const {report,summary}=buildDiagnosticReport(fixture(records,{targets,repeaterHost:targets[0].host}));
  assert.equal(report.pcConnection.history.length,200);assert.equal(report.pcConnection.historyTruncated,true);assert.equal(report.pcConnection.historicalAssignmentKnown,false);
  assert.equal(report.targets[0].replies,1200);assert.ok(summary.bytes<80000);assert.ok(report.warnings.some(w=>w.includes('200 Zuordnungen')));
});

test('report distinguishes loss, measurement errors and actual latency without bridging jitter gaps', () => {
  const records = [ping(0, { ok: true, ms: 10 }), ping(1000, { ok: false }), ping(2000, { ok: false, status: 'measurement_error' }), ping(3000, { ok: true, ms: 20 }), ping(4000, { ok: true, ms: 500 }, 1)];
  const { report } = buildDiagnosticReport(fixture(records));
  assert.equal(report.targets[0].replies, 3); assert.equal(report.targets[0].missedReplies, 1); assert.equal(report.targets[0].measurementErrors, 1);
  assert.equal(report.targets[0].lossPercent, 25); assert.equal(report.targets[0].jitterMs, null); assert.equal(report.targets[0].maxMs, 500);
  assert.equal(report.longestPingLossStreaks[0].missedReplies, 1);
  assert.deepEqual(report.pingTimeline.buckets[0].pings.Z1, [3, 176.67, 500, 1, 1]);
});

test('outage streaks stop at measurement gaps, local errors and changed epochs', () => {
  const records = [ping(0, { ok: false }), ping(1000, { ok: false }), ping(30000, { ok: false }), ping(31000, { ok: false }, 1), ping(32000, { ok: false, status: 'measurement_error' }, 1)];
  const { report } = buildDiagnosticReport(fixture(records));
  assert.deepEqual(report.longestPingLossStreaks.map(x => x.missedReplies), [2, 1, 1]);
  assert.equal(report.longestPingLossStreaks[0].observedSpanSeconds, 1);
});

test('report allowlists fields and removes credentials, identities and private addresses from free text', () => {
  const m = fixture([], {
    password: 'top-secret', username: 'owner-account', devices: [{ name: 'PrivateGamingPC', ip: '192.168.1.90', mac: 'AA:BB:CC:DD:EE:FF' }],
    network: { interfaces: [], wifi: { ssid: 'PrivateWLAN' } },
    fritzbox: { connected: true, password: 'router-secret', credentials: { token: 'private-token' }, device: { model: '6690 Cable', firmware: '8.20' }, log: 'PrivateGamingPC PrivateWLAN 192.168.1.90 AA:BB:CC:DD:EE:FF name@example.com password="router-secret" username=owner-account token=private-token Internetverbindung getrennt', wan: { password: 'wan-secret', status: 'Connected', downloadMbps: 20 }, mesh: { nodes: [{ id: 'private-uid', name: 'Privater Repeater', ip: '192.168.1.7', role: 'repeater' }] } },
  });
  const encoded = JSON.stringify(buildDiagnosticReport(m).report);
  for (const sensitive of ['top-secret', 'router-secret', 'wan-secret', 'owner-account', 'private-token', '192.168.1.90', 'AA:BB:CC:DD:EE:FF', 'name@example.com', 'PrivateGamingPC', 'PrivateWLAN', 'private-uid', '192.168.1.7']) assert.ok(!encoded.includes(sensitive), sensitive);
  assert.ok(encoded.includes('Internetverbindung getrennt'));
  assert.ok(encoded.includes('6690 Cable'));
});

test('mesh report preserves link direction, connection type and rate without device identifiers', () => {
  const { report } = buildDiagnosticReport(fixture([], { fritzbox: { mesh: { nodes: [{ id: 'secret-router', role: 'master' }, { id: 'secret-repeater', role: 'repeater' }], links: [{ from: 'secret-router', to: 'secret-repeater', type: 'WLAN', state: 'DISCONNECTED', receiveRateMbps: 42, transmitRateMbps: 20 }] } } }));
  assert.deepEqual(report.fritzbox.mesh.links[0], { from: 'M1', to: 'M2', type: 'WLAN', state: 'DISCONNECTED', rateMbps: null, receiveRateMbps: 42, transmitRateMbps: 20, signalPercent: null });
});

test('historical mesh snapshots preserve link changes with snapshot-local IDs and anonymous ping targets', () => {
  const targets = [
    { host: '192.168.1.1', label: 'Router', kind: 'gateway', enabled: true },
    { host: '192.168.1.2', label: 'Repeater', kind: 'repeater', enabled: true },
  ];
  const nodes = [
    { id: 'private-router-uid', name: 'Private Router Name', ip: targets[0].host, mac: 'AA:BB:CC:DD:EE:01', role: 'MASTER' },
    { id: 'private-repeater-uid', name: 'Private Repeater Name', ip: targets[1].host, mac: 'AA:BB:CC:DD:EE:02', role: 'SLAVE' },
  ];
  const records = [
    { type: 'fritzbox', at: at(1000), mesh: { nodes, links: [{ from: nodes[0].id, to: nodes[1].id, type: 'WLAN', state: 'CONNECTED', receiveRateMbps: 300 }] } },
    { type: 'fritzbox', at: at(2000), mesh: { nodes, links: [{ from: nodes[0].id, to: nodes[1].id, type: 'LAN', state: 'CONNECTED', receiveRateMbps: 1000 }] } },
  ];
  const { report } = buildDiagnosticReport(fixture(records, { targets, fritzbox: { mesh: { nodes: [], links: [] } } }));
  const [wireless, wired] = report.fritzbox.history.map(item => item.mesh);
  assert.equal(wireless.observedAt, at(1000));
  assert.deepEqual(wireless.nodes.map(node => [node.id, node.pingTarget]), [['N1', 'Z1'], ['N2', 'Z2']]);
  assert.deepEqual(wireless.links[0], { from: 'N1', to: 'N2', type: 'WLAN', state: 'CONNECTED', rateMbps: null, receiveRateMbps: 300, transmitRateMbps: null, signalPercent: null });
  assert.equal(wired.links[0].type, 'LAN');
  assert.ok(!JSON.stringify(report).includes('private-router-uid'));
  assert.ok(!JSON.stringify(report).includes('private-repeater-uid'));
  assert.ok(!JSON.stringify(report).includes('Private Router Name'));
  assert.ok(!JSON.stringify(report).includes('AA:BB:CC:DD:EE:01'));
  assert.equal(report.fritzbox.mesh.totalLinks, 0, 'current mesh state remains separately available');
});

test('historical mesh distinguishes an empty snapshot from a missing snapshot', () => {
  const records = [
    { type: 'fritzbox', at: at(1000), mesh: { nodes: [], links: [], totalNodes: 0, totalLinks: 0 } },
    { type: 'fritzbox', at: at(2000) },
  ];
  const { report } = buildDiagnosticReport(fixture(records));
  assert.deepEqual(report.fritzbox.history[0].mesh.nodes, []);
  assert.deepEqual(report.fritzbox.history[0].mesh.links, []);
  assert.equal(report.fritzbox.history[1].mesh, null);
});

test('historical mesh snapshot and report bounds document omitted topology', () => {
  const targets = Array.from({ length: 24 }, (_, index) => ({ host: `10.0.0.${index + 1}`, kind: 'device', label: `Device ${index}`, enabled: true }));
  const nodes = Array.from({ length: 20 }, (_, index) => ({ id: `private-node-${index}`, ip: targets[index % targets.length].host, mac: `AA:BB:CC:DD:EE:${String(index).padStart(2, '0')}`, name: `Private node ${index}`, role: 'SLAVE' }));
  const links = nodes.slice(1).map((node, index) => ({ from: nodes[index].id, to: node.id, type: index % 2 ? 'LAN' : 'WLAN', state: 'CONNECTED', receiveRateMbps: 300 }));
  const records = Array.from({ length: 35 }, (_, index) => ({ type: 'fritzbox', at: at(index * 1000), mesh: { nodes, links, totalNodes: nodes.length, totalLinks: links.length } }));
  const { report, summary } = buildDiagnosticReport(fixture(records, { targets }));
  assert.ok(summary.bytes <= 80000);
  assert.ok(report.fritzbox.history.length <= 30);
  assert.equal(report.fritzbox.meshHistoryTruncated, true);
  assert.ok(report.fritzbox.history.every(item => item.mesh.nodes.length <= 12 && item.mesh.links.length <= 18));
  assert.ok(report.fritzbox.history.every(item => {
    const ids=new Set(item.mesh.nodes.map(node=>node.id));
    return item.mesh.links.every(link=>ids.has(link.from)&&ids.has(link.to));
  }));
  assert.ok(report.fritzbox.history.every(item => item.mesh.truncated));
  assert.ok(!JSON.stringify(report).includes('private-node-'));
  assert.ok(!JSON.stringify(report).includes('AA:BB:CC:DD:EE:'));
  assert.ok(report.limits.some(item => item.includes('Mesh-Verlauf')));
});

test('late PC repeater and gateway nodes plus their direct neighbor survive mesh bounds', () => {
  const gateway = { host: '192.168.1.1', label: 'Router', kind: 'gateway', enabled: true };
  const repeater = { host: '192.168.1.2', label: 'PC Repeater', kind: 'repeater', enabled: true };
  const targets = [gateway, repeater, ...Array.from({ length: 10 }, (_, index) => ({ host: `10.0.0.${index + 1}`, kind: 'device', enabled: true }))];
  const nodes = [null, {}, ...Array.from({ length: 15 }, (_, index) => ({ id: `unrelated-${index}`, ip: `172.16.0.${index + 1}`, role: 'SLAVE' }))];
  nodes.push(
    { id: 'late-pc-repeater', ip: repeater.host, role: 'SLAVE' },
    { id: 'late-gateway', ip: gateway.host, role: 'MASTER' },
    { id: 'direct-neighbor', ip: '172.20.0.1', role: 'SLAVE' },
  );
  const links = Array.from({ length: 14 }, (_, index) => ({ from: nodes[index + 2].id, to: nodes[index + 3].id, type: 'WLAN', state: 'CONNECTED' }));
  links.push({ from: 'late-pc-repeater', to: 'direct-neighbor', type: 'WLAN', state: 'CONNECTED', receiveRateMbps: 144 });
  const record = { type: 'fritzbox', at: at(1000), mesh: { nodes, links, totalNodes: nodes.length, totalLinks: links.length } };
  const { report } = buildDiagnosticReport(fixture([record], { targets, repeaterHost: repeater.host }));
  const mesh = report.fritzbox.history[0].mesh;
  assert.deepEqual(mesh.nodes.slice(0, 3).map(node => node.pingTarget), ['Z2', 'Z1', null]);
  assert.equal(mesh.links[0].from, mesh.nodes[0].id);
  assert.equal(mesh.links[0].to, mesh.nodes[2].id);
  assert.equal(mesh.links[0].type, 'WLAN');
  assert.ok(mesh.truncated);
});

test('router radios and capabilities retain diagnostic fields and redact current and historical identities', () => {
  const records = [{ type: 'fritzbox', at: at(0), wlan: [{ id: 'private-old-radio', ssid: 'PreviousHomeWifi', channel: 36, associatedDevices: 3 }], mesh: { nodes: [{ name: 'PreviousBedroomRepeater' }] } }];
  const { report } = buildDiagnosticReport(fixture(records, { fritzbox: {
    wlan: [{ id: 'private-radio', ssid: 'CurrentHomeWifi', password: 'radio-secret', enabled: true, status: 'Up', channel: 44, frequencyBand: '5 GHz', associatedDevices: 2 }],
    capabilities: [{ service: 'WLANConfiguration', action: 'GetInfo', available: true, reason: 'CurrentHomeWifi', token: 'cap-secret' }],
    log: 'CurrentHomeWifi PreviousHomeWifi PreviousBedroomRepeater Verbindung wiederhergestellt'
  } }));
  assert.equal(report.fritzbox.current.wlan[0].channel, 44);
  assert.equal(report.fritzbox.history[0].wlan[0].channel, 36);
  assert.equal(report.fritzbox.capabilities[0].available, true);
  assert.match(report.fritzbox.routerLog, /Verbindung wiederhergestellt/);
  const encoded = JSON.stringify(report);
  for (const sensitive of ['private-old-radio', 'private-radio', 'radio-secret', 'cap-secret', 'CurrentHomeWifi', 'PreviousHomeWifi', 'PreviousBedroomRepeater']) assert.ok(!encoded.includes(sensitive), sensitive);
});

test('long measurements stay bounded with statistics and worst ping-loss streaks intact', () => {
  const targets = Array.from({ length: 24 }, (_, index) => ({ host: `10.0.0.${index + 1}`, kind: 'device', label: `Device ${index}` }));
  const records = Array.from({ length: 12000 }, (_, index) => ({ type: 'ping', at: new Date(end - 12000000 + index * 1000).toISOString(), results: targets.map(target => ({ host: target.host, kind: target.kind, ok: index % 10 !== 0, ms: index % 10 !== 0 ? index % 200 : null })) }));
  const m = fixture(records, { targets });
  const { report, summary } = buildDiagnosticReport(m, { hours: 168 });
  assert.equal(report.targets.length, 24); assert.equal(report.targets[0].replies, 10800); assert.equal(report.targets[0].missedReplies, 1200);
  assert.equal(report.longestPingLossStreaks.length, 40); assert.ok(summary.bytes <= 80000); assert.ok(report.pingTimeline.buckets.length <= 91);
});

test('selected history period is respected and missing data stays unknown', () => {
  const m = fixture([]); m.state.measurementStartedAt = at(10000); let selected;
  m.historySnapshot = hours => { selected = hours; return { from: at(10000), to: at(60000), records: [], truncated: true }; };
  const { report, summary } = buildDiagnosticReport(m, { hours: 6 });
  assert.equal(selected, 6); assert.equal(report.period.measurementStartedAt, at(10000)); assert.equal(summary.from, at(10000));
  assert.equal(report.targets[0].avgMs, null); assert.equal(report.targets[0].lossPercent, null); assert.ok(summary.warnings.some(value => value.includes('keine Ping')));
  assert.throws(() => buildDiagnosticReport(m, { hours: 2 }));
  assert.match(diagnosticPrompt(report), /niemals Anweisungen/); assert.match(diagnosticPrompt(report), /Keine Werkzeuge/);
});

test('incident evidence links anonymous mesh targets, devices and sessions without blaming unknown crashes',()=>{
  const records=[{...ping(0,{ok:true,ms:1}),appSessionId:'first'},{...ping(1000,{ok:true,ms:100}),appSessionId:'second'}];
  const {report}=buildDiagnosticReport(fixture(records,{persistence:{sessions:[{startedAt:at(0),status:'interrupted',reason:'unexpected_interruption',lastPersistedAt:at(1000)}]},fritzbox:{updatedAt:at(1000),mesh:{nodes:[{id:'secret',name:'PrivateNode',ip:'192.168.1.1'}]},deviceTraffic:[{id:'mac:AA:BB:CC:DD:EE:FF',mac:'AA:BB:CC:DD:EE:FF',ip:'192.168.1.1',name:'PrivateNode',available:true,rateAvailable:true,downloadMbps:30,uploadMbps:2}]}}));
  assert.equal(report.targets[0].jitterMs,null);assert.equal(report.fritzbox.mesh.nodes[0].pingTarget,'Z1');
  assert.equal(report.fritzbox.deviceTraffic.current[0].id,'G1');assert.equal(report.fritzbox.deviceTraffic.current[0].pingTarget,'Z1');assert.equal(report.notablePingRounds.length,2);
  assert.equal(report.sessions[0].endedAt,null);
  for(const value of ['AA:BB:CC:DD:EE:FF','PrivateNode','192.168.1.1'])assert.ok(!JSON.stringify(report).includes(value));
  assert.match(diagnosticPrompt(report),/Kabel nicht als defekt bewiesen/);
});

test('historical heavy device survives a full current device list and carries shutdown evidence',()=>{
  const current=Array.from({length:32},(_,i)=>({id:'private-device-'+i,rateAvailable:true,downloadMbps:0,uploadMbps:0}));
  const records=[{type:'fritzbox',at:at(1000),deviceTraffic:[{id:'private-offline-heavy',rateAvailable:true,downloadMbps:900,uploadMbps:80}]}];
  const {report}=buildDiagnosticReport(fixture(records,{fritzbox:{deviceTraffic:current},persistence:{sessions:[{startedAt:at(0),status:'interrupted',reason:'shutdown_incomplete',shutdownReason:'windows_shutdown',shutdownRequestedAt:at(2000)}]}}));
  assert.equal(report.fritzbox.deviceTraffic.history[0].devices[0].downloadMbps,900);
  assert.equal(report.sessions[0].shutdownReason,'windows_shutdown');assert.equal(report.sessions[0].endedAt,null);
  assert.ok(!JSON.stringify(report).includes('private-offline-heavy'));
});

test('combined large mesh and ping evidence fits transmission cap after explicit condensation',()=>{
  const targets=Array.from({length:24},(_,i)=>({host:`10.0.0.${i+1}`,kind:'repeater'}));
  const deviceTraffic=Array.from({length:32},(_,i)=>({id:`device-${i}`,available:true,rateAvailable:true,downloadMbps:987.65+i,uploadMbps:123.45,downloadDeltaBytes:987654321,uploadDeltaBytes:123456789,measurementReason:'Testhinweis '.repeat(20),at:at(1000),intervalStartedAt:at(0)}));
  const wlan=Array.from({length:8},()=>({enabled:true,status:'Up',frequencyBand:'5 GHz',standard:'ax',channel:36,associatedDevices:20}));
  const capabilities=Array.from({length:40},()=>({service:'WLANConfiguration',action:'GetInfo',available:false,reason:'Dienst nicht verfügbar '.repeat(15)}));
  const diagnostics={ethernet:Array.from({length:16},(_,i)=>({id:`private-port-${i}`,mac:'AA:BB:CC:DD:EE:FF',available:true,enabled:true,status:'Up',maxBitRateMbps:2500,duplexMode:'Full',totalBytesReceived:9007199254740991,totalBytesSent:9007199254740991,totalPacketsReceived:9007199254740991,totalPacketsSent:9007199254740991,reason:'Langer Schnittstellenhinweis '.repeat(20)})),lan:{available:true,dhcpEnabled:true},internet:{available:true,natEnabled:true,portMappingCount:30,ipv6Status:'Connected',lastConnectionError:'ERROR_NONE'}};
  const hosts=Array.from({length:128},(_,i)=>({name:`PrivateHost${i}`,ip:`192.168.1.${i+1}`,guest:i%2===0,wanAccess:i%3?'granted':'denied',priority:i%4===0}));
  const records=Array.from({length:1200},(_,i)=>({type:'ping',at:at(i*40),repeaterHost:targets[i%24].host,results:targets.map(t=>({...t,ok:i%10!==0,ms:i%10?i:null}))}));
  records.push(...Array.from({length:30},(_,i)=>({type:'fritzbox',at:at(i*2000),capture:{reason:'lag',triggeredAt:at(i*2000-500)},wan:{intervalStartedAt:at(i*2000-1000),downloadDeltaBytes:90000000,uploadDeltaBytes:20000000,downstreamMbps:1000,upstreamMbps:250},deviceTraffic,wlan,diagnostics,hosts,hostCount:128})),...Array.from({length:35},(_,i)=>({type:'event',at:at(i*1000),title:'Auffällig',detail:'Langer Diagnosehinweis '.repeat(30)})));
  const {report,summary}=buildDiagnosticReport(fixture(records,{targets,fritzbox:{deviceTraffic,wlan,capabilities,diagnostics,hosts,log:'Routerereignis\n'.repeat(600)}}));
  assert.ok(summary.bytes<=80000);assert.equal(report.targets.length,24);assert.equal(report.targets[0].replies,1080);
  assert.ok(report.warnings.some(value=>/verdichtet|Großer Bericht/.test(value)));
  assert.equal(report.fritzbox.current.hostSummary.total,128);assert.equal(report.fritzbox.current.diagnostics.ethernet.length,16);
  assert.ok(report.fritzbox.history.every(record=>record.diagnostics.ethernet.length<=4&&record.diagnostics.ethernetTruncated));
  assert.ok(!JSON.stringify(report).includes('PrivateHost'));assert.ok(!JSON.stringify(report).includes('private-port'));
});

test('router diagnostics export only anonymous measurements and aggregated host flags for current and history',()=>{
  const hosts=[{name:'OldPrivateDevice',mac:'AA:BB:CC:DD:EE:FF',ip:'192.168.10.20',filterProfileId:'private-filter',guest:true,wanAccess:'denied',priority:false},{guest:false,wanAccess:'granted',priority:true},{guest:null,wanAccess:'unknown',priority:null}];
  const diagnostics={ethernet:[{id:'private-ethernet-id',mac:'AA:BB:CC:DD:EE:12',name:'UnexportedPortName',available:true,enabled:true,status:'Up 192.168.10.21 token=port-secret',reason:'sid="session-secret" passwd=quoted-secret',maxBitRateMbps:1000,duplexMode:'Full',totalBytesReceived:0,totalBytesSent:222,totalPacketsReceived:11,totalPacketsSent:22,password:'ethernet-password'}],lan:{available:true,dhcpEnabled:false,minAddress:'192.168.10.20',maxAddress:'192.168.10.200',subnetMask:'255.255.255.0',dnsServers:['8.8.8.8'],routers:['192.168.10.1'],domainName:'private.domain',password:'lan-password'},internet:{available:true,natEnabled:true,portMappingCount:3,ipv6Status:'Connected 2001:db8::1',lastConnectionError:'ERROR_NONE private.domain private-filter password=wan-secret',externalIp:'203.0.113.10',dnsServers:['1.1.1.1'],username:'isp-user'}};
  const records=[{type:'fritzbox',at:at(0),hosts,hostCount:5,hostsTruncated:true,diagnostics}];
  const {report}=buildDiagnosticReport(fixture(records,{fritzbox:{connected:true,diagnostics,hosts,hostCount:3,mesh:{nodes:[{id:'private-mesh-id',name:'PrivateNode',latency:{status:'SUCCESS',roundTripMs:2.5,measuredAtMs:1700000000000,password:'latency-secret'}}]},log:'OldPrivateDevice private-ethernet-id AA:BB:CC:DD:EE:12'}}));
  const current=report.fritzbox.current,historical=report.fritzbox.history[0];
  assert.equal(current.diagnostics.ethernet[0].id,'E1');assert.equal(current.diagnostics.ethernet[0].maxBitRateMbps,1000);assert.equal(current.diagnostics.ethernet[0].totalBytesReceived,0);assert.equal(current.diagnostics.lan.dhcpEnabled,false);assert.equal(current.diagnostics.internet.natEnabled,true);assert.equal(current.diagnostics.internet.portMappingCount,3);
  assert.deepEqual(current.hostSummary,{total:3,complete:true,guestCount:1,guestUnknownCount:1,blockedCount:1,blockedUnknownCount:1,priorityCount:1,priorityUnknownCount:1});assert.equal(historical.hostSummary.complete,false);assert.equal(historical.diagnostics.ethernet[0].id,'E1');
  assert.equal(report.fritzbox.mesh.nodes[0].id,'M1');assert.deepEqual(report.fritzbox.mesh.nodes[0].latency,{status:'SUCCESS',roundTripMs:2.5,measuredAtMs:1700000000000});
  const encoded=JSON.stringify(report);for(const secret of ['private-ethernet-id','UnexportedPortName','OldPrivateDevice','private-filter','private.domain','private-mesh-id','PrivateNode','port-secret','session-secret','quoted-secret','ethernet-password','lan-password','wan-secret','isp-user','latency-secret','AA:BB:CC:DD:EE:12','AA:BB:CC:DD:EE:FF','192.168.10.','203.0.113.10','1.1.1.1','8.8.8.8','2001:db8::1'])assert.ok(!encoded.includes(secret),secret);
  for(const section of [current.diagnostics.lan,current.diagnostics.internet])for(const key of ['dnsServers','routers','domainName','externalIp','username','password'])assert.ok(!Object.hasOwn(section,key));
});

test('unknown diagnostics, unsupported services and malformed flags or counters never become zero',()=>{
  const unknown=buildDiagnosticReport(fixture()).report.fritzbox.current;
  assert.equal(unknown.diagnostics.lan.available,null);assert.equal(unknown.diagnostics.lan.dhcpEnabled,null);assert.equal(unknown.diagnostics.internet.natEnabled,null);assert.equal(unknown.diagnostics.internet.portMappingCount,null);assert.equal(unknown.hostSummary.guestCount,null);
  const {report}=buildDiagnosticReport(fixture([],{fritzbox:{hosts:[{guest:'true',priority:1,wanAccess:'invalid'}],diagnostics:{ethernet:[{available:false,status:null,totalBytesReceived:-1,totalBytesSent:Infinity,totalPacketsReceived:9007199254740992,maxBitRateMbps:-1000}],lan:{available:false,reason:'Dienst nicht unterstützt',dhcpEnabled:'false'},internet:{available:false,natEnabled:'true',portMappingCount:-1}},mesh:{nodes:[{id:'node',latency:{status:'ERROR_TIMEOUT',roundTripMs:1,measuredAtMs:1700000000000}},{id:'other',latency:{status:'SUCCESS',roundTripMs:0,measuredAtMs:-1}}]}}}));
  const current=report.fritzbox.current;assert.equal(current.diagnostics.lan.available,false);assert.equal(current.diagnostics.lan.dhcpEnabled,null);assert.match(current.diagnostics.lan.reason,/nicht unterstützt/);assert.equal(current.diagnostics.internet.portMappingCount,null);
  for(const key of ['totalBytesReceived','totalBytesSent','totalPacketsReceived','totalPacketsSent','maxBitRateMbps'])assert.equal(current.diagnostics.ethernet[0][key],null);
  assert.equal(current.hostSummary.guestUnknownCount,1);assert.equal(current.hostSummary.blockedUnknownCount,1);assert.equal(current.hostSummary.priorityUnknownCount,1);assert.equal(current.hostSummary.complete,null);
  assert.ok(report.fritzbox.mesh.nodes.every(node=>node.latency.roundTripMs===null));
});

function reportIncident(overrides={}) {
  return {id:'private-incident-id',sourceDeviceId:'private-peer-id',appSessionId:'private-app-session',sessionId:'private-router-session',interfaceId:'private-adapter-id',
    startedAt:at(1000),endedAt:at(4000),updatedAt:at(4500),durationMs:3000,status:'finished',trigger:'ping',affectedSources:['private-peer-id','local'],
    path:{status:'confirmed',reason:'Pfad zum Router'},topology:{at:at(0)},pathNodes:[],
    diagnoses:[{category:'pc_path',title:'Auffälligkeit am PC-Pfad',section:'PC bis Router',confidence:'Plausibler Verdacht',support:['Ping-Vergleich'],contradictions:['Router bleibt erreichbar'],missing:['Direkter LAN-Vergleich'],nextTest:'Direkt am Router vergleichen'}],
    windows:{before:{from:at(0),to:at(1000),complete:true,targets:[]},during:{from:at(1000),to:at(4000),complete:true,targets:[]},after:{from:at(4000),to:at(5000),complete:false,targets:[]}},
    meshChanges:[],limitations:['Zeitlicher Vergleich belegt allein keine Ursache.'],missing:[],...overrides};
}

test('incident report removes private peer and session identifiers, network names and password text',()=>{
  const identifiers=['private-peer-id','private-app-session','private-router-session','private-adapter-id','PrivateMeshRoom','PrivateHeavyDevice','192.168.88.24','AA:BB:CC:DD:EE:19','2001:db8::abcd','password-value','session-token'];
  const incident=reportIncident({pathNodes:[{id:'private-node-id',name:'PrivateMeshRoom',ip:'192.168.88.24',mac:'AA:BB:CC:DD:EE:19'}],traffic:{devices:[{label:'PrivateHeavyDevice'}]}});
  const privateText='private-peer-id private-app-session private-router-session private-adapter-id PrivateMeshRoom PrivateHeavyDevice 192.168.88.24 AA:BB:CC:DD:EE:19 2001:db8::abcd password=password-value sid="session-token"';
  incident.diagnoses[0].support=[privateText];incident.diagnoses[0].nextTest=privateText;incident.path.reason=privateText;
  const {report}=buildDiagnosticReport(fixture([ping(1000,{ok:true,ms:3})],{incidents:[incident]}));
  assert.equal(report.incidents.length,1);assert.equal(report.incidents[0].source,'Mess-PC 1');
  assert.ok(report.incidents[0].affectedSources.includes('Dieser PC'));
  assert.equal(report.incidents[0].appSessionId,undefined);assert.equal(report.incidents[0].pathNodes,undefined);
  const encoded=JSON.stringify(report);
  for(const value of identifiers)assert.ok(!encoded.includes(value),value);
  assert.match(encoded,/\[entfernt\]/);
});

test('archived incident evidence is anonymized even when its devices no longer exist in live state',()=>{
  const incident=reportIncident({pathNodes:[{id:'old-mesh-id',name:'ArchivedPrivateRoom',mac:'AC:DE:48:12:34:56',ip:'192.168.99.50'}],traffic:{devices:[{label:'ArchivedPrivateConsole'}]}});
  incident.diagnoses[0].support=['ArchivedPrivateRoom und ArchivedPrivateConsole zeigen die Auffälligkeit.'];
  const monitor=fixture([],{incidents:[]});monitor.listIncidents=()=>[incident];
  const {report}=buildDiagnosticReport(monitor),encoded=JSON.stringify(report);
  assert.equal(report.incidents.length,1);
  for(const value of ['ArchivedPrivateRoom','ArchivedPrivateConsole','old-mesh-id','AC:DE:48:12:34:56','192.168.99.50'])assert.ok(!encoded.includes(value),value);
});

test('incident traffic phases and capture intervals retain evidence without device names or arbitrary capture fields',()=>{
  const incident=reportIncident({trafficComparison:{during:{from:at(1000),to:at(4000),pc:{download:{average:0,peak:2,count:2},coverage:{mode:'interval',complete:false,containsBoundaryIntervals:true,coveragePercent:100,observedFrom:at(0),observedTo:at(5000)}},devices:[{id:'archived-traffic-id',label:'PrivatePhaseDevice',ip:'192.168.1.99',peakMbps:50,coverage:{complete:false},peakInterval:{from:at(0),to:at(5000)}}]}},packetCaptures:[{startedAt:at(4000),endedAt:at(5000),relation:'after',status:'stopped',quality:'observed',retransmits:3,sentBytes:0,losses:{events:2},password:'capture-private-password',payload:'private-payload'}]});
  incident.diagnoses[0].support=['PrivatePhaseDevice archived-traffic-id war im Intervall aktiv.'];
  const {report}=buildDiagnosticReport(fixture([],{incidents:[incident]})),item=report.incidents[0],encoded=JSON.stringify(report);
  assert.equal(item.trafficComparison.before,null);assert.equal(item.trafficComparison.during.pc.download.average,0);
  assert.equal(item.trafficComparison.during.pc.coverage.complete,false);assert.equal(item.trafficComparison.during.devices[0].id,'G1');
  assert.deepEqual(item.trafficComparison.during.devices[0].peakInterval,{from:at(0),to:at(5000)});
  assert.equal(item.packetCaptures[0].relation,'after');assert.equal(item.packetCaptures[0].sentBytes,0);assert.equal(item.packetCaptures[0].retransmits,3);assert.equal(item.packetCaptures[0].causeEvidence,false);
  for(const value of ['PrivatePhaseDevice','archived-traffic-id','192.168.1.99','capture-private-password','private-payload'])assert.ok(!encoded.includes(value),value);
});

test('four large multilingual incident projections fit the 80000-byte transmission cap with explicit truncation',()=>{
  const text='Überlastung 網界 '.repeat(100);
  const coverage={mode:'intervals',observedFrom:at(0),observedTo:at(5000),complete:false,containsBoundaryIntervals:true,coveredMs:5000,coveragePercent:83.333,maxGapMs:1000};
  const rateStats={average:999.99,peak:1000,count:100,intervalBytes:999999999,estimatedPhaseBytes:8888888};
  const trafficComparison=Object.fromEntries(['before','during','after'].map(key=>[key,{from:at(0),to:at(5000),pc:{download:rateStats,upload:rateStats,coverage},wan:{download:rateStats,upload:rateStats,coverage},devices:Array.from({length:4},(_,i)=>({id:`private-device-${i}`,peakMbps:999.99,downloadMbps:888.88,uploadMbps:111.11,coverage,peakInterval:{from:at(0),to:at(5000)}}))}]));
  const packetCaptures=Array.from({length:4},()=>({startedAt:at(0),endedAt:at(5000),relation:'overlap',status:'stopped',quality:'observed',sentPackets:999999,receivedPackets:999999,sentBytes:99999999,receivedBytes:9999999,retransmits:222,losses:{events:10,buffers:20}}));
  const targets=Array.from({length:24},(_,index)=>({host:`10.10.0.${index+1}`,kind:'repeater',enabled:true}));
  const windows=Object.fromEntries(['before','during','after'].map(key=>[key,{from:at(0),to:at(5000),complete:true,targets:targets.map(target=>({...target,sourceDeviceId:'private-source',sent:12000,received:11998,maxMs:900.25,avgMs:40.75,p95Ms:88.88,p99Ms:222.22,lossPercent:0.02,measurementErrors:2,measurementGaps:1,actualIntervalMs:250.1}))}]));
  const incidents=Array.from({length:4},(_,index)=>reportIncident({id:`private-large-${index}`,sourceDeviceId:`private-source-${index}`,path:{status:'confirmed',reason:text},windows,trafficComparison,packetCaptures,
    diagnoses:Array.from({length:4},()=>({category:'unknown',title:text,section:text,confidence:'Unklar',support:Array(4).fill(text),contradictions:Array(3).fill(text),missing:Array(3).fill(text),nextTest:text})),limitations:Array(5).fill(text),missing:Array(4).fill(text)}));
  const records=Array.from({length:90},(_,index)=>({type:'ping',at:at(index*600),results:targets.map(target=>({...target,ok:true,ms:index+1}))}));
  const {report,summary}=buildDiagnosticReport(fixture(records,{targets,incidents}));
  assert.ok(summary.bytes<=80000);assert.equal(Buffer.byteLength(JSON.stringify(report)),summary.bytes);
  assert.ok(report.incidents.length>0);assert.ok(report.incidents.length<=4);
  assert.ok(report.incidentsTruncated||report.incidents.some(item=>item.detailsTruncated===true)||report.warnings.some(value=>/verdichtet|begrenzt|Großer Bericht/.test(value)));
  assert.equal(report.targets[0].replies,90);assert.equal(report.targets[0].avgMs,45.5);
});

test('remote ping rounds cannot change local report targets, loss, timeline or notable rounds',()=>{
  const local=[ping(1000,{ok:true,ms:4}),ping(2000,{ok:true,ms:8})];
  const remote=[{...ping(1000,{ok:false,ms:null}),remote:true,sourceDeviceId:'private-peer'},
    {...ping(1500,{ok:true,ms:99999}),remote:true,sourceDeviceId:'private-peer'},
    {type:'ping',at:at(2000),remote:true,sourceDeviceId:'private-peer',results:[{host:'192.168.77.77',kind:'gateway',ok:false,ms:null}]}];
  const baseline=buildDiagnosticReport(fixture(local)).report;
  const {report}=buildDiagnosticReport(fixture([...local,...remote],{incidents:[reportIncident()]}));
  assert.deepEqual(report.targets,baseline.targets);assert.deepEqual(report.pingTimeline,baseline.pingTimeline);
  assert.deepEqual(report.notablePingRounds,baseline.notablePingRounds);
  assert.equal(report.targets[0].lossPercent,0);assert.equal(report.targets[0].avgMs,6);assert.equal(report.targets.length,1);
  assert.equal(report.incidents.length,1);
});
