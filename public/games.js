import { initGameComparison } from './game-comparison.js';

const list = value => Array.isArray(value) ? value : [];
const count = value => Number.isFinite(value) && value >= 0 ? value.toLocaleString('de-DE') : '–';
const clock = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleTimeString('de-DE', {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '–';
const bytes = value => !Number.isFinite(value) || value < 0 ? '–' : value >= 1048576 ? `${(value/1048576).toLocaleString('de-DE',{maximumFractionDigits:2})} MB` : value >= 1024 ? `${(value/1024).toLocaleString('de-DE',{maximumFractionDigits:1})} KB` : `${value} B`;
const duration = (start,end) => {
  const seconds = Math.max(0, Math.floor((Date.parse(end || new Date().toISOString())-Date.parse(start))/1000));
  return Number.isFinite(seconds) ? `${Math.floor(seconds/60)} min ${seconds%60} s` : '–';
};
const sources = {steam:'Steam-Bibliothek',epic:'Epic-Bibliothek',known:'Bekanntes Spiel',custom:'Eigene Zuordnung'};

export function gameNetworkSummary(targets, startedAt, endedAt=null) {
  const since=Date.parse(startedAt),until=endedAt?Date.parse(endedAt):Infinity;
  return list(targets).filter(target=>target.enabled&&['gateway','repeater','internet'].includes(target.kind)).map(target=>{
    const samples=Number.isFinite(since)?list(target.samples).filter(sample=>Date.parse(sample.at)>=since&&Date.parse(sample.at)<=until):[];
    const replies=samples.filter(sample=>sample.ok===true&&Number.isFinite(sample.ms));
    const missing=samples.filter(sample=>sample.ok===false&&sample.status!=='measurement_error');
    return {label:target.label,kind:target.kind,replies:replies.length,missing:missing.length,errors:samples.length-replies.length-missing.length,mean:replies.length?replies.reduce((sum,sample)=>sum+sample.ms,0)/replies.length:null,from:samples[0]?.at||null,to:samples.at(-1)?.at||null};
  });
}

export function packetView(snapshot={}) {
  const measured = ['observed','incomplete'].includes(snapshot.quality) && snapshot.startedAt;
  const labels={idle:'Bereit für eine Messung',starting:'Windows-Erfassung wird gestartet …',recording:'Erfassung läuft',stopping:'Erfassung wird beendet …',stopped:'Erfassung abgeschlossen',error:'Erfassung fehlgeschlagen','needs-admin':'Windows-Administratorfreigabe benötigt'};
  return {label:labels[snapshot.status]||'Noch keine Erfassung',measured:!!measured,busy:['starting','recording','stopping'].includes(snapshot.status),counts:measured?[snapshot.sentPackets,snapshot.receivedPackets,snapshot.sentBytes,snapshot.receivedBytes]:[null,null,null,null]};
}

export function initGames({post,refresh,notify=()=>{},document:doc=document}={}) {
  const $=selector=>doc.querySelector(selector);
  const el=(tag,className,text)=>{const node=doc.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=String(text);return node;};
  const setHelp=(element,help)=>{element.title=help;element.dataset.help=help;};
  const text=(id,value)=>{$(id).textContent=value;};
  let current=null,selected='',busy=false,activeSignature='',customSignature='',sessionSignature='';
  const gameComparison=initGameComparison({document:doc});
  const select=$('#game-select');
  const game=()=>list(current?.gameDetection?.active).find(item=>item.sessionId===selected);
  const fresh=item=>['ready','partial'].includes(current?.gameDetection?.status)&&Number.isFinite(Date.parse(item?.lastSeenAt))&&Date.now()-Date.parse(item.lastSeenAt)<15000;

  async function action(path,body,success) {
    if(busy)return false;
    busy=true;if(current)render(current);
    try { await post(path,body);await refresh();if(success)notify(success);return true; }
    catch(error){notify(error.message,true);return false;}
    finally{busy=false;if(current)render(current);}
  }
  select.addEventListener('change',()=>{selected=select.value;if(current)render(current);});
  $('#game-capture-start').addEventListener('click',()=>{
    if(!game())return;
    void action('/api/games/capture/start',{sessionId:selected},'Paket-Tracking angefordert.');
  });
  $('#game-capture-stop').addEventListener('click',()=>void action('/api/games/capture/stop',{},'Erfassung gestoppt.'));
  $('#game-detection-enabled').addEventListener('change',event=>{
    void action('/api/games/settings',{enabled:event.target.checked,customGames:list(current?.gameDetection?.customGames)},'Spieleerkennung gespeichert.');
  });
  $('#game-custom-form').addEventListener('submit',async event=>{
    event.preventDefault();
    const name=$('#game-custom-name').value.trim(),executable=$('#game-custom-exe').value.trim();
    if(!name||!executable)return;
    const existing=list(current?.gameDetection?.customGames);
    if(await action('/api/games/settings',{enabled:current?.gameDetection?.enabled!==false,customGames:[...existing,{name,executable}]},'Spielzuordnung gespeichert.'))event.target.reset();
  });

  function renderActive(detection) {
    const active=list(detection.active);
    const signature=JSON.stringify(active.map(item=>[item.sessionId,item.name]));
    if(signature!==activeSignature){
      activeSignature=signature;
      if(!active.some(item=>item.sessionId===selected))selected=active[0]?.sessionId||'';
      const placeholder=el('option','',active.length?'Spiel auswählen':'Noch kein Spiel erkannt');placeholder.value='';
      select.replaceChildren(placeholder,...active.map(item=>{const option=el('option','',item.name);option.value=item.sessionId;return option;}));
      select.value=selected;
    }
    const labels={checking:'Installierte Spiele und laufende Prozesse werden geprüft …',ready:active.length?`${active.length} laufende ${active.length===1?'Spielsitzung':'Spielsitzungen'} erkannt`:'Kein laufendes Spiel erkannt',partial:'Erkennung teilweise eingeschränkt',error:'Spieleerkennung derzeit nicht verfügbar',disabled:'Spieleerkennung ausgeschaltet',unsupported:'Spieleerkennung benötigt Windows'};
    text('#game-detection-status',detection.error||labels[detection.status]||'Spieleerkennung wird geladen …');
    const detectionNote=$('#game-detection-note');
    detectionNote.textContent=`${count(detection.libraryCount)} Bibliothekseinträge · zuletzt geprüft ${clock(detection.checkedAt)}`;
    setHelp(detectionNote,[detection.warning,'Die Erkennung prüft installierte Spiele und laufende Prozesse ungefähr alle fünf Sekunden.'].filter(Boolean).join(' '));
    $('#game-detection-enabled').checked=detection.enabled!==false;
    $('#game-detection-enabled').disabled=busy||!current?.gameDetection;
    const chosen=game();
    const selectedDetail=$('#game-selected-detail');
    selectedDetail.textContent=chosen?`${sources[chosen.source]||'Automatisch erkannt'} · seit ${clock(chosen.startedAt)} · ${duration(chosen.startedAt,fresh(chosen)?null:chosen.lastSeenAt)}${fresh(chosen)?'':' · zuletzt '+clock(chosen.lastSeenAt)}`:'Starte ein Spiel und wähle es aus.';
    setHelp(selectedDetail,chosen&&!fresh(chosen)?'Der aktuelle Zustand ist unbestätigt. Nicht gefundene Spiele kannst du unten anhand ihrer EXE zuordnen.':'Nicht gefundene Spiele kannst du unten anhand ihrer EXE zuordnen.');
    const shortcut=$('#game-overview');
    shortcut.hidden=false;
    shortcut.querySelector('strong').textContent=active.length?active.map(item=>item.name).join(' · '):'Spiele & Paket-Tracking';
    shortcut.querySelector('span').textContent=active.length?(active.some(fresh)?'Spiel erkannt · Netzwerkverkehr ansehen':'Zuletzt erkannte Spiele · Zustand unbestätigt'):'Spiel auswählen und Netzwerkverkehr ansehen';
  }

  function renderCapture(snapshot) {
    const view=packetView(snapshot);
    text('#game-capture-status',view.label);
    text('#game-capture-game',snapshot.game?.name?`${snapshot.game.name} · ${clock(snapshot.startedAt)}${snapshot.endedAt?' bis '+clock(snapshot.endedAt):''}${snapshot.startedAt?' · '+duration(snapshot.startedAt,snapshot.endedAt):''}`:'Noch keine Spielmessung gestartet');
    text('#game-sent-packets',count(view.counts[0]));text('#game-received-packets',count(view.counts[1]));
    text('#game-sent-bytes',bytes(view.counts[2]));text('#game-received-bytes',bytes(view.counts[3]));
    text('#game-retransmits',view.measured?count(snapshot.retransmits):'–');
    const incomplete=snapshot.quality==='incomplete';
    const loss=snapshot.losses;
    const captureNote=$('#game-capture-note');
    const captureDetails=[snapshot.reason,view.measured&&snapshot.receivedPackets>0?'Rückverkehr zum Spiel wurde am PC beobachtet.':'',incomplete?'Erfassung unvollständig; Zähler sind nur die beobachteten Ereignisse.':'',snapshot.quality==='unknown'&&snapshot.startedAt?'Bisher keine verlässlich auswertbaren Ereignisse; unbekannte Werte sind keine gemessenen Nullen.':'',loss?.events>0?`${count(loss.events)} Erfassungsereignisse verloren.`:'',snapshot.omittedEndpoints>0?'Weitere Zielverbindungen wurden wegen der Erfassungsgrenze nicht einzeln gespeichert.':'',list(snapshot.endpoints).length>50?'Die 50 datenstärksten erfassten Zielverbindungen werden angezeigt.':''].filter(Boolean);
    captureNote.textContent=incomplete?'Erfassung unvollständig.':captureDetails.length?captureDetails[0]:'Die Erfassung startet mit Windows-Freigabe.';
    setHelp(captureNote,[...captureDetails,captureDetails.length?'':'Der Start kann eine Windows-Administratorfreigabe für den Erfassungshelfer anfordern. Es gibt keine feste Zeitbegrenzung für das Match.'].filter(Boolean).join(' '));
    const resolution=$('#game-chart-resolution');
    resolution.textContent='Die Zähler erfassen das ganze Match.';
    setHelp(resolution,`${snapshot.sampleIntervalMs>1000?'Der Verlauf wird bei dieser Dauer zeitlich zusammengefasst; die Datenraten zeigen Mittelwerte zwischen den Messpunkten.':'Lange Verläufe werden für die Anzeige zeitlich zusammengefasst.'}`);
    $('#game-capture-note').classList.toggle('is-warning',incomplete||['error','needs-admin'].includes(snapshot.status));
    $('#game-capture-start').disabled=busy||view.busy||!fresh(game());
    $('#game-capture-stop').disabled=busy||!view.busy||snapshot.status==='stopping';
    select.disabled=busy||view.busy||!list(current?.gameDetection?.active).length;
    const endpoints=list(snapshot.endpoints).slice().sort((a,b)=>(b.sentBytes+b.receivedBytes)-(a.sentBytes+a.receivedBytes)).slice(0,50);
    const body=$('#game-endpoints');
    if(!endpoints.length){const row=el('tr'),cell=el('td','table-empty',view.busy?'Warte auf Netzwerkereignisse des gewählten Spiels …':'Noch keine Zielverbindungen erfasst.');cell.colSpan=4;row.append(cell);body.replaceChildren(row);}
    else body.replaceChildren(...endpoints.map(endpoint=>{
      const row=el('tr');
      for(const value of [endpoint.protocol,`${endpoint.address.includes(':')?'['+endpoint.address+']':endpoint.address}:${endpoint.port}`,`${count(endpoint.sentPackets)} / ${bytes(endpoint.sentBytes)}`,`${count(endpoint.receivedPackets)} / ${bytes(endpoint.receivedBytes)}`])row.append(el('td','',value));
      return row;
    }));
    drawTimeline(list(snapshot.samples),view.measured);
  }

  function drawTimeline(samples,measured) {
    const svg=$('#game-packet-chart');
    const width=Math.max(240,Math.round(svg.getBoundingClientRect().width)||800);
    svg.setAttribute('viewBox',`0 0 ${width} 130`);
    const make=(name,attributes)=>{const node=doc.createElementNS('http://www.w3.org/2000/svg',name);for(const[key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;};
    const valid=samples.filter(sample=>Number.isFinite(Date.parse(sample.at))&&Number.isFinite(sample.sentBytes)&&Number.isFinite(sample.receivedBytes));
    if(!measured||valid.length<2){const note=make('text',{x:width/2,y:70,'text-anchor':'middle',class:'chart-empty'});note.textContent='Warte auf Verlaufsdaten …';svg.replaceChildren(note);return;}
    const rates=valid.slice(1).map((sample,index)=>{const previous=valid[index],seconds=(Date.parse(sample.at)-Date.parse(previous.at))/1000;return {at:Date.parse(sample.at),sent:seconds>0?Math.max(0,sample.sentBytes-previous.sentBytes)/seconds:0,received:seconds>0?Math.max(0,sample.receivedBytes-previous.receivedBytes)/seconds:0};});
    const max=Math.max(1,...rates.flatMap(point=>[point.sent,point.received]));
    const start=Date.parse(valid[0].at),range=Math.max(1,rates.at(-1).at-start);
    const paths=['received','sent'].map((key,index)=>make('polyline',{points:[`20,${110-rates[0][key]/max*90}`,...rates.map(point=>`${20+(point.at-start)/range*(width-40)},${110-point[key]/max*90}`)].join(' '),fill:'none',stroke:index?'var(--series-secondary)':'var(--series-primary)','stroke-width':2,'vector-effect':'non-scaling-stroke'}));
    const label=make('text',{x:20,y:14,class:'chart-label'});label.textContent=width<500?`Bis ${bytes(max)}/s · ${clock(valid.at(-1).at)}`:`Skala bis ${bytes(max)}/s · ${clock(valid[0].at)} – ${clock(valid.at(-1).at)}`;
    svg.replaceChildren(label,...paths);
  }

  function renderNetwork() {
    const chosen=game();
    const start=chosen?.startedAt;
    const rows=gameNetworkSummary(current?.targets,start,chosen&&!fresh(chosen)?chosen.lastSeenAt:null);
    const times=rows.flatMap(row=>[row.from,row.to]).filter(Boolean).map(Date.parse);
    const networkNote=$('#game-network-note');
    networkNote.textContent=chosen?(times.length?'Zeitgleiche Ping-Messungen verfügbar.':'Noch keine zeitgleichen Ping-Messungen.'):'Wähle ein laufendes Spiel zum Vergleich.';
    setHelp(networkNote,chosen?`${times.length?'Ping-Messungen von '+clock(new Date(Math.min(...times)).toISOString())+' bis '+clock(new Date(Math.max(...times)).toISOString())+' während der Beobachtung von '+chosen.name+'. ':'Diese Pings verfolgen nicht die Pakete des Spiels. '}${current.monitoring?'':'Die Netzwerküberwachung ist pausiert.'}`:'Verglichen werden zeitgleiche Netzwerkmessungen.');
    const container=$('#game-network-comparison');
    if(!rows.length){container.replaceChildren(el('p','game-muted','Noch keine Messziele verfügbar.'));return;}
    container.replaceChildren(...rows.map(row=>{const card=el('article','game-network-card');card.append(el('strong','',row.label),el('span','',row.mean===null?'Keine Ping-Antwort gemessen':`${row.mean.toLocaleString('de-DE',{maximumFractionDigits:1})} ms im Mittel`),el('small','',`${row.replies} Antworten · ${row.missing} unbeantwortet${row.errors?' · '+row.errors+' Messfehler':''}`));return card;}));
  }

  function renderCustom(detection) {
    const rules=list(detection.customGames),signature=JSON.stringify(rules);
    if(signature!==customSignature){
      customSignature=signature;
      $('#game-custom-list').replaceChildren(...rules.map(rule=>{
        const row=el('div','game-custom-row'),copy=el('div');copy.append(el('strong','',rule.name),el('code','',rule.executable));
        const remove=el('button','button button-quiet','Entfernen');remove.type='button';remove.setAttribute('aria-label',`${rule.name} entfernen`);
        remove.addEventListener('click',()=>void action('/api/games/settings',{enabled:current?.gameDetection?.enabled!==false,customGames:list(current?.gameDetection?.customGames).filter(item=>item.executable.toLowerCase()!==rule.executable.toLowerCase())},'Spielzuordnung entfernt.'));
        row.append(copy,remove);return row;
      }));
    }
    for(const button of doc.querySelectorAll('#game-custom-list button, #game-custom-form button'))button.disabled=busy||!current?.gameDetection;
  }

  function renderSessions(detection) {
    const sessions=[...list(detection.active),...list(detection.recent)].slice(0,20),signature=JSON.stringify(sessions.map(item=>[item.sessionId,item.startedAt,item.endedAt,item.reason,fresh(item)]));
    if(signature===sessionSignature)return;sessionSignature=signature;
    const body=$('#game-sessions');
    if(!sessions.length){const row=el('tr'),cell=el('td','table-empty','Noch keine Spielsitzung beobachtet.');cell.colSpan=4;row.append(cell);body.replaceChildren(row);return;}
    body.replaceChildren(...sessions.map(item=>{const row=el('tr');for(const value of [item.name,clock(item.startedAt),item.endedAt?clock(item.endedAt):fresh(item)?'Läuft':'Zuletzt '+clock(item.lastSeenAt),item.endedAt?(item.reason==='process-exited'?'Prozess nicht mehr beobachtet':'Beobachtung beendet'):fresh(item)?'Prozess erkannt':'Aktuell unbestätigt'])row.append(el('td','',value));return row;}));
  }

  function render(state) {
    current=state;
    const detection=state.gameDetection||{};
    renderActive(detection);renderCapture(state.gamePackets||{});renderNetwork();renderCustom(detection);renderSessions(detection);gameComparison.renderState(state);
  }
  function connectionLost() { $('#game-capture-start').disabled=true;$('#game-capture-stop').disabled=true;text('#game-capture-status','Verbindung zur App unterbrochen – Werte können veraltet sein'); }
  doc.defaultView?.addEventListener('resize',()=>{if(current)drawTimeline(list(current.gamePackets?.samples),packetView(current.gamePackets).measured);});
  return {render,connectionLost};
}
