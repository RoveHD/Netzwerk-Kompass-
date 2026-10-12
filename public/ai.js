import { renderDiagnosisResult } from './diagnosis-result.js';

const $ = (selector) => document.querySelector(selector);
const ui = {
  generation: 0,
  state: null,
  actionBusy: false,
  previewBusy: false,
  timer: null,
  pollBusy: false,
};
let postRequest = async () => { throw new Error('Codex-Auswertung ist noch nicht bereit.'); };
let getRequest = async () => { throw new Error('Codex-Auswertung ist noch nicht bereit.'); };
let actionError = '';
let archiveOffset=0,archiveBusy=false,archiveSignature='';

function text(selector, value) { const item = $(selector); if (item) item.textContent = value == null || value === '' ? '–' : String(value); }
function setError(message) { const box = $('#ai-error'); box.hidden = !message; box.textContent = message || ''; }
function renderTargetMap(summary) {
  const targets = Array.isArray(summary?.targetLabels) ? summary.targetLabels : [];
  const el = $('#ai-target-map'); el.hidden = !targets.length;
  el.textContent = targets.length ? `Zuordnung nur auf diesem PC: ${targets.map(target => `${target.id} = ${target.label} (${target.host})`).join(' · ')}` : '';
}
function pretty(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) || ''; }
function date(value) { if (!value) return ''; const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString('de-DE'); }
function setPill(label, level = 'muted') { const pill = $('#ai-status'); pill.textContent = label; pill.className = `pill pill-${level}`; }
function render(current) {
  if (!current) return;
  ui.state = current;
  const saveError=$('#ai-storage-error');saveError.hidden=!current.persistenceError;saveError.textContent=current.persistenceError?`Speichern fehlgeschlagen: ${current.persistenceError}`:'';
  const signature=(current.savedAnalyses||[]).map(item=>`${item.id}:${item.status}`).join('|');
  if(signature!==archiveSignature&&!archiveBusy&&archiveOffset===0){archiveSignature=signature;loadArchive();}
  if (current.reportSummary) renderTargetMap(current.reportSummary);
  const connection = current.connection || {};
  const busy = ui.actionBusy || !!current.running || !!current.loginRunning || !!connection.checking;
  const ready = !!connection.available && !!connection.authenticated;
  $('#ai-check').disabled = ui.actionBusy || !!connection.checking;
  $('#ai-login').hidden = !connection.available || !!connection.authenticated;
  $('#ai-login').disabled = busy;
  $('#ai-cancel').hidden = !current.running && !current.loginRunning;
  $('#ai-cancel').disabled = ui.actionBusy;
  $('#ai-start').disabled = !ready || busy || current.status === 'running';
  $('#ai-report-load').disabled = ui.previewBusy;
  $('#ai-hours').disabled = ui.actionBusy || current.running === true;
  $('#ai-login-help').hidden = !!connection.authenticated || !!connection.checking || !!current.loginRunning;

  const status = current.running ? 'Analyse läuft' : current.loginRunning ? 'Anmeldung läuft' : current.status === 'completed' ? 'Auswertung fertig' : current.status === 'error' ? 'Auswertung fehlgeschlagen' : current.status === 'cancelled' ? 'Abgebrochen' : connection.checking ? 'Verbindung wird geprüft' : connection.authenticated ? 'Codex bereit' : connection.available ? 'Anmeldung erforderlich' : 'Codex nicht verfügbar';
  const level = current.running || current.loginRunning || connection.checking ? 'warn' : current.status === 'error' || (!connection.available && !connection.checking) ? 'bad' : connection.authenticated ? 'good' : 'muted';
  setPill(status, level);
  const message = current.message || connection.message || (connection.authenticated ? 'Codex ist angemeldet. Eine Übertragung startet erst mit deiner ausdrücklichen Auswahl.' : connection.available ? 'Codex CLI ist verfügbar, aber noch nicht angemeldet.' : 'Codex CLI wurde nicht gefunden. Installiere sie und melde dich an, um die Auswertung zu nutzen.');
  text('#ai-connection-message', message);
  const failure = current.error || actionError;
  if (failure) setError(failure);
  else setError('');
  if (current.status === 'completed' && current.result != null) {
    $('#ai-result-wrap').hidden = false;
    renderDiagnosisResult($('#ai-result'), current.result);
    text('#ai-result-time', date(current.finishedAt));
  } else if (current.status !== 'completed') {
    $('#ai-result-wrap').hidden = true;
    $('#ai-result').textContent = '';
    text('#ai-result-time', '');
  }
}
async function refresh() {
  if (ui.pollBusy) return;
  ui.pollBusy = true;
  const generation = ui.generation;
  try {
    const current = await getRequest('/api/analysis');
    if (generation !== ui.generation) return;
    actionError = '';
    render(current);
  } catch (error) {
    if (generation !== ui.generation) return;
    actionError = error.message;
    setPill('API nicht erreichbar', 'bad'); text('#ai-connection-message', error.message); setError(error.message);
  } finally { ui.pollBusy = false; }
}
async function act(path, body = {}) {
  if (ui.actionBusy) return;
  ui.actionBusy = true; actionError = ''; render(ui.state || {}); setError('');
  try { await postRequest(path, body); await refresh(); }
  catch (error) { actionError = error.message; setError(error.message); }
  finally { ui.actionBusy = false; render(ui.state || {}); }
}
async function loadReport() {
  if (ui.previewBusy) return;
  ui.previewBusy = true; $('#ai-report-load').disabled = true; text('#ai-report-summary', 'Vorschau wird erstellt …');
  const generation = ui.generation; const hours = Number($('#ai-hours').value) || 24;
  try {
    const payload = await getRequest(`/api/analysis/report?hours=${encodeURIComponent(hours)}`);
    if (generation !== ui.generation) return;
    const summary = payload.summary || {};
    renderTargetMap(summary);
    const facts = [`Zeitraum: ${date(summary.from) || summary.from || '–'} bis ${date(summary.to) || summary.to || '–'}`, `${summary.records ?? 0} Mess-/Ereigniseinträge`, `${summary.targets ?? 0} Ziele`, `FRITZ!Box-Daten: ${summary.hasFritz ? 'enthalten' : 'nicht vorhanden'}`, `Bericht: ${summary.bytes ?? '–'} Bytes`];
    if (Array.isArray(summary.warnings) && summary.warnings.length) facts.push(`Hinweise: ${summary.warnings.join(' · ')}`);
    text('#ai-report-summary', facts.join(' · '));
    $('#ai-report-preview').textContent = pretty(payload.report ?? {}); $('#ai-report-preview').hidden = false;
    $('#ai-report-details').open = true;
  } catch (error) { if (generation === ui.generation) { text('#ai-report-summary', `Vorschau fehlgeschlagen: ${error.message}`); $('#ai-report-preview').hidden = true; } }
  finally { ui.previewBusy = false; $('#ai-report-load').disabled = false; }
}
function clearForReset() {
  ui.generation += 1; ui.state = { connection: {}, status: 'idle' };
  actionError = '';
  renderTargetMap(null);
  $('#ai-result-wrap').hidden = true; $('#ai-result').textContent = ''; text('#ai-result-time', '');
  $('#ai-report-preview').textContent = ''; $('#ai-report-preview').hidden = true; text('#ai-report-summary', 'Nach dem Reset kannst du eine neue Vorschau laden.');
  $('#ai-report-details').open = false; setError(''); text('#ai-connection-message', 'Neue Messung gestartet. Codex-Verbindung wird aktualisiert.'); setPill('Neue Messung', 'muted');
  refresh();
}
async function loadArchive() {
  if(archiveBusy)return;archiveBusy=true;
  try {
    const page=await getRequest(`/api/analysis/archive?offset=${archiveOffset}`);const select=$('#ai-archive-select');const selected=select.value;select.replaceChildren();
    for(const item of page.analyses||[]){const option=document.createElement('option');option.value=item.id;option.textContent=`${date(item.startedAt)} · ${item.status==='completed'?'Auswertung fertig':item.status==='interrupted'?'Unterbrochen':item.status==='cancelled'?'Abgebrochen':item.status==='error'?'Fehlgeschlagen':'Gestartet'}`;select.append(option);}
    if([...select.options].some(option=>option.value===selected))select.value=selected;
    const count=page.analyses?.length||0;$('#ai-archive-open').disabled=!count;$('#ai-archive-prev').disabled=archiveOffset===0;$('#ai-archive-next').disabled=archiveOffset+count>=page.total;
    text('#ai-archive-status',count?`${archiveOffset+1}–${archiveOffset+count} von ${page.total} gespeicherten Diagnosen`:'Noch keine Diagnosen gespeichert.');
  }catch(error){text('#ai-archive-status',`Archiv konnte nicht geladen werden: ${error.message}`);}
  finally{archiveBusy=false;}
}
async function openArchive() {
  const id=$('#ai-archive-select').value;if(!id)return;
  $('#ai-archive-open').disabled=true;
  try {
    const item=await getRequest(`/api/analysis/archive?id=${encodeURIComponent(id)}`);
    const summary=item.reportSummary||{},result=$('#ai-archive-result');
    result.replaceChildren();
    const metadata=document.createElement('p');metadata.className='ai-archive-meta';
    const legend=(summary.targetLabels||[]).map(target=>`${target.id} = ${target.label} (${target.host})`).join(' · ');
    metadata.textContent=[`Gespeichert: ${date(item.finishedAt||item.startedAt)}`,`Messzeitraum: ${date(summary.from)} bis ${date(summary.to)}`,legend].filter(Boolean).join('\n');result.append(metadata);
    const answer=document.createElement('div');result.append(answer);
    if(item.result)renderDiagnosisResult(answer,item.result);
    else answer.textContent=item.error||'Diese Auswertung wurde nicht fertiggestellt.';
    result.hidden=false;
  }catch(error){text('#ai-archive-status',error.message);}finally{$('#ai-archive-open').disabled=false;}
}
export function initAi({ post, request }) {
  postRequest = post; getRequest = request;
  $('#ai-check').addEventListener('click', () => act('/api/analysis/check'));
  $('#ai-login').addEventListener('click', () => act('/api/analysis/login'));
  $('#ai-start').addEventListener('click', () => act('/api/analysis/start', { hours: Number($('#ai-hours').value) || 24 }));
  $('#ai-cancel').addEventListener('click', () => act('/api/analysis/cancel'));
  $('#ai-report-load').addEventListener('click', loadReport);
  $('#ai-archive-open').addEventListener('click',openArchive);
  $('#ai-archive-prev').addEventListener('click',()=>{archiveOffset=Math.max(0,archiveOffset-20);loadArchive();});
  $('#ai-archive-next').addEventListener('click',()=>{archiveOffset+=20;loadArchive();});
  loadArchive();
  window.addEventListener('measurement-reset', clearForReset);
  refresh(); ui.timer = setInterval(refresh, 3000);
}
