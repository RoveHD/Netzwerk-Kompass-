import { captureScroll, restoreScroll } from './scroll-state.js';
const $=selector=>document.querySelector(selector);
const date=value=>value?new Date(value).toLocaleString('de-DE'):'–';
const reasonLabels={normal:'Programm normal beendet',windows_shutdown:'Windows heruntergefahren / abgemeldet',launcher_lost:'Verbindung zum Programmstarter abgebrochen',signal:'Beendigungssignal empfangen',startup_error:'Programmstart fehlgeschlagen',unexpected_interruption:'Unerwartet unterbrochen – Ursache unbekannt'};
export function sessionLabel(session) {
  if(session.status==='closing')return 'Programm wird beendet – Daten werden gesichert';
  if(session.reason==='shutdown_incomplete')return `${reasonLabels[session.shutdownReason]||'Beendigung angefordert'} · Abschluss nicht vollständig gespeichert`;
  if(session.status==='running'||session.status==='active')return 'Messung läuft';
  return reasonLabels[session.reason] || (session.status==='interrupted'?'Unerwartet unterbrochen':'Beendet');
}
export function renderStorage(persistence) {
  if(!persistence)return;
  const status=$('#storage-status');
  status.textContent=persistence.lastError?`Speicherfehler: ${persistence.lastError}`:persistence.enabled?'Daten werden lokal gespeichert.':'Dauerhafte Speicherung ist nicht verfügbar.';
  if(persistence.enabled)status.title=status.dataset.help='Das aktive Verlaufsfenster ist begrenzt. Rohprotokolle und abgeschlossene KI-Diagnosen bleiben im lokalen Archiv erhalten.';else{status.title='';delete status.dataset.help;}
  const root=$('#session-list');captureScroll(root);root.replaceChildren();
  const sessions=Array.isArray(persistence.sessions)?persistence.sessions:[];
  if(!sessions.length){root.textContent='Noch keine gespeicherten Sitzungen.';return;}
  const table=document.createElement('table');const head=document.createElement('thead');const row=document.createElement('tr');
  for(const text of ['Beginn','Letzter gespeicherter Stand','Ende','Abschluss']){const cell=document.createElement('th');cell.scope='col';cell.textContent=text;row.append(cell);}head.append(row);table.append(head);
  const body=document.createElement('tbody');
  for(const session of sessions){const tr=document.createElement('tr');for(const text of [date(session.startedAt),date(session.lastPersistedAt||session.lastSeenAt||session.updatedAt),date(session.endedAt),sessionLabel(session)]){const td=document.createElement('td');td.textContent=text;tr.append(td);}body.append(tr);}table.append(body);root.append(table);restoreScroll(root);
}
export function initStorage({request,post}) {
  const checkbox=$('#startup-enabled');let busy=false;
  const render=current=>{checkbox.checked=current.enabled!==false;checkbox.disabled=busy||!current.available;$('#startup-status').textContent=current.error||(current.available?(current.registered?'Autostart ist in Windows eingerichtet.':current.enabled?'Autostart konnte noch nicht eingerichtet werden.':'Autostart ist ausgeschaltet.'):'Autostart ist nur in der portablen Windows-App verfügbar; im Testlauf bleibt Windows unverändert.');};
  checkbox.addEventListener('change',async()=>{if(busy)return;busy=true;checkbox.disabled=true;try{render(await post('/api/startup',{enabled:checkbox.checked}));}catch(error){$('#startup-status').textContent=error.message;}finally{busy=false;try{render(await request('/api/startup'));}catch{checkbox.disabled=true;}}});
  request('/api/startup').then(render).catch(error=>{$('#startup-status').textContent=error.message;});
}
