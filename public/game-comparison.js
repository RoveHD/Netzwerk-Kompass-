const list = value => Array.isArray(value) ? value : [];
const time = value => typeof value === 'string' ? Date.parse(value) : NaN;
const finiteTime = value => Number.isFinite(time(value));
const validSession = item => item && typeof item.sessionId === 'string' && item.sessionId && finiteTime(item.startedAt);
const percentile95 = values => values.length ? values.slice().sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1] : null;
const uniqueRecords = records => {
  const seen=new Set();
  return list(records).filter(record=>{
    if(!record||typeof record!=='object')return false;
    let key=typeof record.recordId==='string'&&record.recordId?`id:${record.recordId}`:null;
    if(!key){try{key=`json:${JSON.stringify(record)}`;}catch{return true;}}
    if(seen.has(key))return false;seen.add(key);return true;
  });
};

export function collectGameSessions(records, gameDetection = {}, { from = null, to = null, now = Date.now() } = {}) {
  const byId = new Map();
  const merge = (game, fallbackAt, action) => {
    if (!validSession(game)) return;
    const previous = byId.get(game.sessionId) || {};
    const startedAt = previous.startedAt || game.startedAt || (action === 'started' ? fallbackAt : null);
    const endedAt = action && action !== 'started' ? game.endedAt || fallbackAt : game.endedAt || previous.endedAt || null;
    byId.set(game.sessionId, { ...previous, ...game, startedAt, endedAt });
  };
  for (const record of uniqueRecords(records)) {
    if (record?.type !== 'event' || record.kind !== 'game' || !['started','ended','observation-ended'].includes(record.action)) continue;
    merge(record.game, record.at, record.action);
  }
  const activeIds=new Set();
  for (const game of list(gameDetection.active)) { activeIds.add(game?.sessionId); merge(game, null, null); }
  for (const game of list(gameDetection.recent)) merge(game, null, null);
  const detectionFresh=['ready','partial'].includes(gameDetection.status)&&finiteTime(gameDetection.checkedAt)&&now-time(gameDetection.checkedAt)<15000;
  for(const [id,game] of byId){
    if(game.endedAt)game.observationState='ended';
    else if(activeIds.has(id)&&detectionFresh&&finiteTime(game.lastSeenAt)&&now-time(game.lastSeenAt)<15000)game.observationState='running';
    else {game.observationState='unconfirmed';if(!finiteTime(game.lastSeenAt))game.lastSeenAt=game.startedAt;}
  }
  const low = finiteTime(from) ? time(from) : -Infinity;
  const high = finiteTime(to) ? time(to) : now;
  return [...byId.values()].filter(game => {
    const start = time(game.startedAt), end = finiteTime(game.endedAt) ? time(game.endedAt) : now;
    return start <= high && end >= low;
  }).sort((a,b) => time(b.startedAt)-time(a.startedAt));
}

function targetStats(records, start, end, from, to) {
  const targets = new Map();
  for (const record of uniqueRecords(records)) {
    if (record?.type !== 'ping' || !finiteTime(record.at)) continue;
    const at = time(record.at);
    if (at < start || at > end || at < from || at > to) continue;
    for (const result of list(record.results)) {
      if (typeof result?.host !== 'string' || !result.host) continue;
      const key = result.host.toLowerCase();
      let target = targets.get(key);
      if (!target) { target = { host: result.host, label: result.label || result.host, kind: result.kind || 'custom', values: [], losses: 0, errors: 0, observations: [] }; targets.set(key,target); }
      target.observations.push({at,epoch:record.epoch,interfaceId:record.interfaceId,appSessionId:record.appSessionId,measurementStartedAt:record.measurementStartedAt});
      target.firstAt = target.firstAt===undefined?at:Math.min(target.firstAt,at); target.lastAt = target.lastAt===undefined?at:Math.max(target.lastAt,at);
      if (result.status === 'measurement_error') target.errors++;
      else if (result.ok === true && Number.isFinite(result.ms) && result.ms >= 0) target.values.push(result.ms);
      else if (result.ok === false) target.losses++;
      // Unknown or malformed rows are excluded from both attempts and errors.
    }
  }
  for(const target of targets.values()){
    target.observations.sort((a,b)=>a.at-b.at);
    let gaps=0,breaks=0,span=0;
    for(let index=1;index<target.observations.length;index++){
      const before=target.observations[index-1],after=target.observations[index];
      const switched=['epoch','interfaceId','appSessionId','measurementStartedAt'].some(key=>before[key]!==after[key]);
      if(switched){breaks++;continue;}
      const delta=after.at-before.at;
      if(delta>10000)gaps++;
      span+=delta;
    }
    target.coverage={points:target.observations.length,gaps,breaks,span};
  }
  return targets;
}

export function compareGameSessions(records, first, second, history = {}, { minimumAttempts = 5, now = Date.now() } = {}) {
  if (!validSession(first) || !validSession(second)) return { comparable: false, reason: 'Wähle zwei Sitzungen mit bekanntem Beobachtungsstart.' };
  if (first.sessionId === second.sessionId) return { comparable: false, reason: 'Wähle zwei verschiedene Spielsitzungen.' };
  const aStart=time(first.startedAt), bStart=time(second.startedAt);
  const effectiveEnd=session=>finiteTime(session.endedAt)?time(session.endedAt):session.observationState==='running'?now:finiteTime(session.lastSeenAt)?time(session.lastSeenAt):time(session.startedAt);
  const aEnd=effectiveEnd(first), bEnd=effectiveEnd(second);
  const from=finiteTime(history.from)?time(history.from):-Infinity, to=finiteTime(history.to)?time(history.to):now;
  const a=targetStats(records,aStart,aEnd,from,to), b=targetStats(records,bStart,bEnd,from,to);
  const targets=[];
  for (const [key,left] of a) {
    const right=b.get(key); if(!right) continue;
    const leftAttempts=left.values.length+left.losses,rightAttempts=right.values.length+right.losses;
    const enough=leftAttempts>=minimumAttempts&&rightAttempts>=minimumAttempts&&left.values.length>0&&right.values.length>0;
    targets.push({host:left.host,label:left.label||right.label,kind:left.kind,a:stats(left),b:stats(right),enough});
  }
  const missingHistory=!!history.truncated || (finiteTime(history.from) && (aStart<from || bStart<from)) || first.observationState==='unconfirmed' || second.observationState==='unconfirmed';
  if(!targets.length)return {comparable:false,reason:'Für diese beiden Sitzungen gibt es keine gemeinsamen Ping-Ziele.',targets:[],missingHistory};
  if(!targets.some(target=>target.enough))return {comparable:false,reason:`Gemeinsame Ziele gefunden, aber für einen Vergleich sind mindestens ${minimumAttempts} gültige Versuche je Sitzung nötig.`,targets,missingHistory};
  return {comparable:true,reason:null,targets,missingHistory};
}

function stats(target) {
  const values=target.values,attempts=values.length+target.losses;
  return {average:values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null,p95:percentile95(values),max:values.length?values.reduce((max,value)=>Math.max(max,value),-Infinity):null,replies:values.length,losses:target.losses,attempts,errors:target.errors,firstAt:target.firstAt,lastAt:target.lastAt,coverage:target.coverage};
}

const dateTime=value=>Number.isFinite(time(value))?new Date(time(value)).toLocaleString('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'–';
const number=value=>Number.isFinite(value)?value.toLocaleString('de-DE',{maximumFractionDigits:1}):'–';
const elapsed=(start,end,now)=>{const ms=Math.max(0,(finiteTime(end)?time(end):now)-time(start));const mins=Math.floor(ms/60000);return `${Math.floor(mins/60)} Std. ${mins%60} Min.`;};
const coverageDuration=milliseconds=>{const minutes=Math.max(0,Math.round(milliseconds/60000));return `${Math.floor(minutes/60)} Std. ${minutes%60} Min.`;};

export function initGameComparison({ document: doc = document, fetcher = fetch } = {}) {
  const $=selector=>doc.querySelector(selector), el=(tag,cls,text)=>{const node=doc.createElement(tag);if(cls)node.className=cls;if(text!=null)node.textContent=String(text);return node;};
  const hours=$('#game-comparison-hours'), refresh=$('#game-comparison-refresh'), status=$('#game-comparison-status'), selectA=$('#game-comparison-a'), selectB=$('#game-comparison-b'), output=$('#game-comparison-result');
  let payload=null,currentState={},requestId=0,selectedA='',selectedB='',sessionSignature='',historySessions=[],visibleSessions=[];
  const rangeText=()=>payload?.from&&payload?.to?`${dateTime(payload.from)} – ${dateTime(payload.to)}`:'Zeitfenster unbekannt';

  function renderResult() {
    const first=visibleSessions.find(item=>item.sessionId===selectedA);
    const second=visibleSessions.find(item=>item.sessionId===selectedB);
    output.replaceChildren();
    if(!payload){output.append(el('p','game-comparison-message','Lade den Verlauf über „Verlauf laden“; dabei werden nur gespeicherte Messungen verwendet.'));return;}
    const compared=compareGameSessions(payload.records,first,second,payload);
    if(!compared.comparable){output.append(el('p','game-comparison-message',compared.reason));return;}
    renderTargets(compared);
    const caveat=el('p','game-comparison-caveat',`Gemeinsame Ziele im Messfenster ${rangeText()}.`);
    caveat.title=caveat.dataset.help='Mittelwert, p95 und Maximum nutzen nur beantwortete Pings. Verlust zählt unbeantwortete gültige Versuche; Messfehler und Lücken werden getrennt erfasst. Bei parallelen Sitzungen können dieselben PC-Pings in beiden Vergleichen stehen. Sie sind keinem Spielpaket zugeordnet und belegen keine Ursache für Lag.';
    output.append(caveat);
    const coverage=el('p','game-comparison-caveat','Messlücken und Abdeckungswechsel werden separat gezählt.');
    coverage.title=coverage.dataset.help='Abdeckungswechsel trennen App-Sitzung, Messperiode, Mess-Epoch und Netzwerkadapter. Lücken über 10 Sekunden werden separat gezählt.';
    output.append(coverage);
    if(compared.missingHistory){const warning=el('p','game-comparison-warning','Der Vergleich kann wegen gekürzter Historie unvollständig sein.');warning.title=warning.dataset.help='Die Historie ist gekürzt oder mindestens eine Sitzung begann vor dem geladenen Fenster.';output.append(warning);}
    for(const message of [...list(payload.warnings),...(payload.lastError?[payload.lastError]:[])].slice(0,3))output.append(el('p','game-comparison-warning',message));
  }
  function renderTargets(compared) {
    const table=el('div','game-comparison-table-scroll');
    const tableEl=el('table','game-comparison-table');const head=el('thead'),row=el('tr');
    for(const title of ['Gemeinsames Ziel','Sitzung A · Ø / p95 / max','Gültige Versuche · Verlust · Messfehler','Sitzung B · Ø / p95 / max','Gültige Versuche · Verlust · Messfehler'])row.append(el('th','',title));head.append(row);tableEl.append(head);
    const body=el('tbody');
    for(const target of compared.targets.filter(item=>item.enough)){
      const tr=el('tr'),metrics=(summary)=>{const cell=el('td');cell.append(doc.createTextNode(`${number(summary.average)} / ${number(summary.p95)} / ${number(summary.max)} ms`),el('small','game-comparison-coverage',`${summary.coverage.points} Messpunkte · ${dateTime(new Date(summary.firstAt).toISOString())} bis ${dateTime(new Date(summary.lastAt).toISOString())} · ${coverageDuration(summary.coverage.span)} Spanne · ${summary.coverage.gaps} Lücken über 10 s · ${summary.coverage.breaks} Wechsel`));return cell;};
      tr.append(el('td','',`${target.label} · ${target.host}`),metrics(target.a),el('td','',`${target.a.attempts} · ${target.a.losses} · ${target.a.errors}`),metrics(target.b),el('td','',`${target.b.attempts} · ${target.b.losses} · ${target.b.errors}`));body.append(tr);
    }
    tableEl.append(body);table.append(tableEl);output.append(table);
    if(compared.targets.some(target=>!target.enough)){const warning=el('p','game-comparison-warning','Weitere gemeinsame Ziele wurden ausgelassen.');warning.title=warning.dataset.help='Für diese Ziele gab es in mindestens einer Sitzung nicht genug gültige Versuche.';output.append(warning);}
  }
  function renderSessions() {
    const liveSessions=collectGameSessions([],currentState?.gameDetection,{from:payload?.from,to:payload?.to});
    const byId=new Map(historySessions.map(item=>[item.sessionId,{...item}]));
    for(const live of liveSessions){const previous=byId.get(live.sessionId);byId.set(live.sessionId,previous?.endedAt?previous:{...previous,...live,startedAt:previous?.startedAt||live.startedAt});}
    const sessions=[...byId.values()].sort((a,b)=>time(b.startedAt)-time(a.startedAt));visibleSessions=sessions;
    const signature=JSON.stringify(sessions.map(item=>[item.sessionId,item.name,item.startedAt,item.endedAt,item.observationState]));
    if(signature===sessionSignature)return;
    sessionSignature=signature;
    const fill=(select,selected)=>{const options=sessions.map(item=>{const observedEnd=item.endedAt||item.lastSeenAt;const endLabel=item.endedAt?`Ende ${dateTime(item.endedAt)}`:item.observationState==='running'?'läuft':`zuletzt gesehen ${dateTime(item.lastSeenAt)}`;const durationLabel=item.endedAt?elapsed(item.startedAt,item.endedAt,Date.now()):item.observationState==='running'?elapsed(item.startedAt,null,Date.now()):`beobachtet ${elapsed(item.startedAt,observedEnd,Date.now())}`;const option=el('option','',`${item.name||'Spiel'} · Start ${dateTime(item.startedAt)} · ${endLabel} · ${durationLabel}`);option.value=item.sessionId;return option;});select.replaceChildren(...options);if(options.some(option=>option.value===selected))select.value=selected;else select.selectedIndex=-1;};
    fill(selectA,selectedA);fill(selectB,selectedB);
    if(!selectedA&&sessions[0]){selectedA=sessions[0].sessionId;selectA.value=selectedA;}
    if(!selectedB&&sessions.find(item=>item.sessionId!==selectedA)){selectedB=sessions.find(item=>item.sessionId!==selectedA).sessionId;selectB.value=selectedB;}
    const disabled=sessions.length<2;selectA.disabled=disabled;selectB.disabled=disabled;
    if(payload)status.textContent=`${sessions.length} Spielsitzungen aus dem Verlauf und dem aktuellen Zustand · Datenfenster ${rangeText()}${payload.truncated?' · ältere Einträge gekürzt':''}${list(payload.warnings).length||payload.lastError?' · Historie enthält Speicherhinweise':''}`;
  }
  async function load() {
    const id=++requestId;refresh.disabled=true;status.textContent='Verlauf wird geladen …';
    try{const response=await fetcher(`/api/history?hours=${encodeURIComponent(hours.value)}`,{cache:'no-store'});if(!response.ok)throw new Error(`HTTP ${response.status}`);const result=await response.json();if(id!==requestId)return;payload={...result,records:list(result.records)};historySessions=collectGameSessions(payload.records,{}, {from:payload.from,to:payload.to});sessionSignature='';renderSessions();renderResult();}
    catch(error){if(id===requestId){payload=null;historySessions=[];sessionSignature='';renderSessions();output.replaceChildren(el('p','game-comparison-message',`Verlauf konnte nicht geladen werden: ${error.message}`));status.textContent='Laden fehlgeschlagen; versuche es erneut.';}}
    finally{if(id===requestId)refresh.disabled=false;}
  }
  refresh.addEventListener('click',()=>void load());
  hours.addEventListener('change',()=>{requestId++;refresh.disabled=false;payload=null;historySessions=[];sessionSignature='';renderSessions();output.replaceChildren(el('p','game-comparison-message','Lade den Verlauf für das neue Zeitfenster.'));status.textContent='Verlauf für das neue Zeitfenster muss geladen werden.';});
  doc.defaultView?.addEventListener('measurement-reset',()=>{requestId++;refresh.disabled=false;payload=null;historySessions=[];sessionSignature='';renderSessions();output.replaceChildren(el('p','game-comparison-message','Lade den Verlauf nach dem Reset erneut.'));status.textContent='Messperiode zurückgesetzt; der Verlauf ist noch nicht neu geladen.';});
  selectA.addEventListener('change',()=>{selectedA=selectA.value;renderResult();});
  selectB.addEventListener('change',()=>{selectedB=selectB.value;renderResult();});
  function renderState(state){currentState=state||{};renderSessions();}
  return {renderState,load};
}
