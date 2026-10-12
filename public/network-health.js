const keys=['receivedErrors','sentErrors','receivedDiscards','sentDiscards'];
const labels=['Empfangsfehler','Sendefehler','Empfangen verworfen','Senden verworfen'];
const valid=value=>Number.isSafeInteger(value)&&value>=0;
const number=value=>valid(value)?value.toLocaleString('de-DE'):'–';
const stamp=value=>new Date(value).toLocaleString('de-DE');
const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;};
const array=value=>Array.isArray(value)?value:[];

export function healthSummary(records) {
  const totals=Object.fromEntries(keys.map(key=>[key,null]));let intervals=0,durationMs=0,missing=0;
  const seen=new Set();
  for(const record of records){
    if(record.type!=='traffic')continue;
    const health=record.adapterHealth;
    const start=Date.parse(health?.intervalStartedAt),end=Date.parse(record.at);
    const identity=JSON.stringify([record.appSessionId,record.epoch,record.interfaceId,start,end]);
    if(seen.has(identity))continue;seen.add(identity);
    if(!Number.isFinite(start)||end<=start||end-start>15000||!keys.some(key=>valid(health?.delta?.[key]))){missing++;continue;}
    intervals++;durationMs+=end-start;
    keys.forEach(key=>{if(valid(health.delta[key]))totals[key]=(totals[key]??0)+health.delta[key];});
  }
  return {totals,intervals,durationMs,missing};
}

export function networkChanges(records) {
  const changes=[],previous=new Map();
  const sorted=records.filter(record=>['network','wifi'].includes(record.type)&&Number.isFinite(Date.parse(record.at))).slice().sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const fields={network:[['interfaceId','Adapter'],['gateway','Gateway'],['ipv4','IP-Adresse'],['dns','DNS-Server'],['status','Verbindung'],['linkSpeedMbps','Linkrate']],wifi:[['connected','WLAN-Verbindung'],['ssid','WLAN-Name'],['bssid','Access Point'],['channel','WLAN-Kanal']]};
  const value=(record,key)=>key==='ipv4'?array(record[key]).map(item=>`${item.address}/${item.prefixLength}`).sort().join(', '):key==='dns'?array(record[key]).slice().sort().join(', '):record[key];
  const display=(value,key)=>value==null||value===''?'unbekannt':key==='connected'?(value?'verbunden':'nicht verbunden'):key==='linkSpeedMbps'?`${value} Mbit/s`:String(value);
  for(const record of sorted){
    const old=previous.get(record.type),sameSession=old?.appSessionId===record.appSessionId;
    const gap=old?Date.parse(record.at)-Date.parse(old.at):Infinity;
    // Failed WLAN queries are not evidence of a disconnect.
    if(record.type==='wifi'&&record.error){changes.push({at:record.at,title:'WLAN-Abfrage fehlgeschlagen',detail:'Verbindungszustand unbekannt; kein bestätigter WLAN-Abbruch.'});previous.delete('wifi');continue;}
    if(old&&sameSession&&gap<=150000){
      for(const [key,label] of fields[record.type]){
        if(!Object.hasOwn(old,key)||!Object.hasOwn(record,key))continue;
        const before=value(old,key),after=value(record,key);
        if(before===after)continue;
        changes.push({at:record.at,title:`${label} geändert`,detail:`${display(before,key)} → ${display(after,key)}. Zwischen ${stamp(old.at)} und ${stamp(record.at)} beobachtet.`});
      }
    } else changes.push({at:record.at,title:old?'Neue Beobachtung nach Messpause / Neustart':record.type==='network'?'PC-Anschluss: erste Beobachtung':'WLAN: erste Beobachtung',detail:record.type==='network'?`${record.name||'Kein aktiver Adapter'} · Gateway ${record.gateway||'unbekannt'} · Link ${display(record.linkSpeedMbps,'linkSpeedMbps')}`:record.connected?`${record.ssid||'WLAN'} · Access Point ${record.bssid||'unbekannt'}`:'WLAN nicht verbunden.'});
    previous.set(record.type,record);
  }
  return changes.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
}

function metrics(values) {
  const grid=node('div','history-metrics');keys.forEach((key,index)=>{const card=node('div','history-metric');card.append(node('span','',labels[index]),node('strong','',number(values?.[key])));grid.append(card);});return grid;
}
const adapterHealthViews=new WeakMap();
function updateMetrics(grid,values) {
  keys.forEach((key,index)=>{grid.children[index].lastElementChild.textContent=number(values?.[key]);});
}
export function renderAdapterHealth(parent,traffic) {
  if(!parent)return;const health=traffic?.adapterHealth;
  let view=adapterHealthViews.get(parent);
  if(!view){
    view={delta:metrics(),note:node('p','network-health-note'),detail:node('details','network-health-details'),counters:metrics()};
    view.detail.append(node('summary','','Windows-Zähler seit Adapterstart ansehen'),view.counters);
    const sourceNote=node('p','network-health-note','Zähler des ausgewählten PC-Adapters.');sourceNote.title=sourceNote.dataset.help='Sie belegen weder Fehler eines entfernten Repeaters noch einen Kabeldefekt. Treiber können Fehler unvollständig melden.';
    parent.replaceChildren(view.delta,view.note,view.detail,sourceNote);
    adapterHealthViews.set(parent,view);
  }
  const signature=JSON.stringify([traffic?.interfaceId,health]);if(view.signature===signature)return;view.signature=signature;
  // Keep the disclosure mounted so polling preserves open state, focus and scroll position.
  updateMetrics(view.delta,health?.delta);updateMetrics(view.counters,health?.counters);
  view.note.textContent=health?.available?'Neue Fehler seit der letzten Abfrage.':'Keine auswertbaren Adapterfehler.';
  const noteHelp=health?.available?`${health.intervalStartedAt?'Zeitraum: '+stamp(health.intervalStartedAt)+' bis '+stamp(health.at)+'. ':''}${health.reason||''}`:'Windows liefert derzeit keine auswertbaren Adapterfehler. Fehlende Daten werden nicht als null gezählt.';
  view.note.title=view.note.dataset.help=noteHelp;
  view.detail.hidden=!health?.available;
}
export function renderHealthHistory(parent,records) {
  const summary=healthSummary(records),section=node('section','network-health-history');
  section.append(node('h3','','PC-Netzwerkkarte: Fehler im Zeitraum'),metrics(summary.totals));
  const note=node('p','network-health-note',`${summary.intervals} Intervalle · ${Math.round(summary.durationMs/1000)} s erfasst.`);note.title=note.dataset.help=`${summary.missing} Abfragen ohne verwendbare Differenz. Nur beobachtete Zähleranstiege, keine gemessene Internet-Paketverlustrate.`;section.append(note);
  parent.append(section);
}
export function renderNetworkChanges(parent,records) {
  parent.append(node('h3','','Netzwerkwechsel & Verbindungsabbrüche'));
  const note=node('p','network-health-note','Adapter- und WLAN-Wechsel aus der Netzwerkerkennung.');note.title=note.dataset.help='Erkennung erfolgt ungefähr einmal pro Minute; sehr kurze Wechsel können fehlen.';parent.append(note);
  const changes=networkChanges(records),scroll=node('div','history-scroll-list');scroll.id='network-change-list';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label','Netzwerkwechsel, separat scrollbar');
  if(!changes.length)scroll.append(node('p','history-empty','Noch keine gespeicherten Netzwerkzustände im Zeitraum.'));
  for(const change of changes.slice(0,300)){const row=node('article','network-change-row');row.append(node('time','',stamp(change.at)),node('strong','',change.title),node('p','',change.detail));scroll.append(row);}
  parent.append(scroll);if(changes.length>300)parent.append(node('p','network-health-note',`Die neuesten 300 von ${changes.length} Beobachtungen sind hier sichtbar.`));
}
