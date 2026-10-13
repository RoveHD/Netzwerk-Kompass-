import { initPeerMonitoring } from './peer-monitor.js';
import { initBackgroundMonitoring } from './background-monitor.js';

const el = (tag, cls, text) => { const item = document.createElement(tag); if (cls) item.className = cls; if (text != null) item.textContent = String(text); return item; };
const field = (labelText, name, type = 'number', attrs = {}) => {
  const label = el('label', 'diagnostic-setting-field', labelText), input = el('input'); input.name = name; input.type = type;
  for (const [key, value] of Object.entries(attrs)) input.setAttribute(key, String(value));
  label.append(input); return { label, input };
};

export function initDiagnosticSettings(parent, { api, post, onChange = () => {} }) {
  const panel = el('section', 'panel diagnostic-settings-panel'); panel.setAttribute('aria-labelledby', 'diagnostic-settings-title');
  const panelTitle = el('h2', '', 'Messqualität, Verlauf und Mitschnitt'); panelTitle.id = 'diagnostic-settings-title'; panel.append(panelTitle);

  const measurement = el('section', 'diagnostic-setting-section'); measurement.append(el('h3', '', 'Messmodus'));
  const modeLabel = el('label', 'diagnostic-setting-field', 'Messintervall '), mode = el('select'); mode.name = 'mode';
  for (const [value, label] of [['standard', 'Standard · etwa 1 Sekunde'], ['precision', 'Präzision · 250 ms']]) { const option = el('option', '', label); option.value = value; mode.append(option); }
  modeLabel.append(mode);
  const quality = el('p', 'diagnostic-setting-note', 'Messqualität wird geladen …'); quality.setAttribute('role', 'status');
  const modeNote = el('p', 'diagnostic-setting-note', 'Präzisionsmodus misst alle 250 ms nur das Gateway und den eigenen Repeater. Andere Ziele bleiben im Standardintervall. Häufige Messungen erhöhen die lokale Hintergrundlast.');
  const modeStatus = el('p', 'diagnostic-setting-status', ''); modeStatus.setAttribute('role', 'status');
  measurement.append(modeLabel, modeNote, quality, modeStatus); panel.append(measurement);
  mode.addEventListener('change', async () => {
    mode.disabled = true; modeStatus.textContent = 'Messmodus wird gespeichert …';
    try { await post('/api/measurement', { mode: mode.value }); modeStatus.textContent = 'Messmodus gespeichert.'; await onChange(); }
    catch (error) { modeStatus.textContent = error.message; }
    finally { mode.disabled = false; }
  });

  const history = el('section', 'diagnostic-setting-section'); history.append(el('h3', '', 'Aufbewahrung'));
  history.append(el('p', 'diagnostic-setting-note', 'Hochaufgelöste Pingdaten, Minutenstatistiken und wichtige Vorfälle haben getrennte Aufbewahrungsgrenzen. Roharchive bleiben zusätzlich durch Alter und Datenträgergröße begrenzt.'));
  const form = el('form', 'diagnostic-history-policy');
  const definitions = [
    ['Ping-Stunden', 'pingHours', 24, 1, 168],
    ['Minutenstatistik-Tage', 'rollupDays', 30, 1, 3650],
    ['Vorfälle-Tage', 'eventDays', 365, 31, 3650],
    ['Roharchiv-Maximum (MB)', 'archiveMaxBytes', 256, 1, 8192],
    ['Roharchiv-Tage', 'archiveMaxDays', 30, 1, 3650],
  ];
  const controls = new Map();
  for (const [label, name, initial, min, max] of definitions) {
    const { label: wrapper, input } = field(label, name, 'number', { min, max, step: 1 }); input.value = String(initial); controls.set(name, input); form.append(wrapper);
  }
  const policyStatus = el('p', 'diagnostic-setting-status', ''); policyStatus.setAttribute('role', 'status');
  const savePolicy = el('button', 'button button-secondary', 'Aufbewahrung speichern'); savePolicy.type = 'submit'; form.append(savePolicy, policyStatus); history.append(form); panel.append(history);
  form.addEventListener('submit', async event => {
    event.preventDefault(); savePolicy.disabled = true; policyStatus.textContent = 'Grenzen werden gespeichert …';
    const values = Object.fromEntries([...controls].map(([key, input]) => [key, Number(input.value)]));
    values.archiveMaxBytes *= 1024 * 1024;
    if (Object.values(values).some(value => !Number.isFinite(value))) { policyStatus.textContent = 'Alle Grenzen müssen gültige Zahlen sein.'; savePolicy.disabled = false; return; }
    try { await post('/api/history-policy', values); policyStatus.textContent = 'Aufbewahrung gespeichert.'; await onChange(); }
    catch (error) { policyStatus.textContent = error.message; }
    finally { savePolicy.disabled = false; }
  });

  const capture = el('section', 'diagnostic-setting-section'); capture.append(el('h3', '', 'Einmaliger Spielmitschnitt'));
  capture.append(el('p', 'diagnostic-setting-note', 'Ein ausdrückliches Einschalten startet höchstens einen automatischen Windows-Freigabeversuch für einen 15-Sekunden-Mitschnitt. Bei mehreren aktiven Spielen muss eines ausgewählt werden. Der Mitschnitt enthält Verbindungsmetadaten, keine Nutzlast; danach ist die Option wieder aus.'));
  const gameLabel = el('label', 'diagnostic-setting-field', 'Spiel '), game = el('select'); game.name = 'sessionId';
  game.append(el('option', '', 'Aktives Spiel auswählen'));
  gameLabel.append(game);
  const captureLabel = el('label', 'diagnostic-setting-toggle'), captureToggle = el('input'); captureToggle.type = 'checkbox';
  captureLabel.append(captureToggle, document.createTextNode(' Einmaligen Mitschnitt jetzt freigeben'));
  const captureStatus = el('p', 'diagnostic-setting-status', ''); captureStatus.setAttribute('role', 'status');
  capture.append(gameLabel, captureLabel, captureStatus); panel.append(capture);
  captureToggle.addEventListener('change', async () => {
    if (!captureToggle.checked) return;
    const games = [...game.options].slice(1);
    if (games.length !== 1 && !game.value) {
      captureToggle.checked = false;
      captureStatus.textContent = games.length > 1 ? 'Wähle zuerst das Spiel für diesen einmaligen Versuch.' : 'Es ist kein aktives Spiel zum Mitschnitt ausgewählt.';
      return;
    }
    const sessionId = game.value || games[0]?.value;
    captureToggle.disabled = true; captureStatus.textContent = 'Windows-Freigabe wird angefordert …';
    try { const result = await post('/api/incident-capture', { enabled: true, ...(sessionId ? { sessionId } : {}) }); captureStatus.textContent = result.status || result.message || 'Einmaliger Freigabeversuch abgeschlossen; weitere Aufnahmen sind ausgeschaltet.'; await onChange(); }
    catch (error) { captureStatus.textContent = error.message; }
    finally { captureToggle.checked = false; captureToggle.disabled = false; }
  });

  const router = el('section', 'diagnostic-setting-section'); router.append(el('h3', '', 'FRITZ!Box-Anmeldung'));
  const credentialStatus = el('p', 'diagnostic-setting-note', 'Gespeicherte Anmeldung wird geprüft.'); credentialStatus.setAttribute('role', 'status');
  const forget = el('button', 'button button-quiet', 'Gespeicherte Anmeldung entfernen'); forget.type = 'button'; forget.disabled = true;
  const forgetStatus = el('p', 'diagnostic-setting-status', ''); forgetStatus.setAttribute('role', 'status');
  forget.addEventListener('click', async () => { forget.disabled = true; try { await post('/api/fritzbox/forget', {}); credentialStatus.textContent = 'Gespeicherte Anmeldung entfernt.'; forgetStatus.textContent = ''; await onChange(); } catch (error) { forgetStatus.textContent = error.message; forget.disabled = false; } });
  router.append(credentialStatus, forget, forgetStatus); panel.append(router);

  const peersRoot = el('section', 'panel diagnostic-integrated-panel'); peersRoot.append(el('h2', '', 'PCs vergleichen')); panel.append(peersRoot);
  const backgroundRoot = el('section', 'panel diagnostic-integrated-panel'); backgroundRoot.append(el('h2', '', 'Hintergrundbetrieb')); panel.append(backgroundRoot);
  parent.append(panel);
  const peer = initPeerMonitoring(peersRoot, { api });
  const closeBackground = initBackgroundMonitoring(backgroundRoot);

  function update(state) {
    const activeMode = state?.measurement?.mode === 'precision' ? 'precision' : 'standard';
    if (document.activeElement !== mode) mode.value = activeMode;
    const measurementState = state?.measurement || {};
    const qualityValue = measurementState.quality;
    quality.textContent = `${qualityValue?.label || qualityValue?.status || (typeof qualityValue === 'string' ? qualityValue : 'Messqualität nicht verfügbar')}${qualityValue?.detail ? ` · ${qualityValue.detail}` : ''}`;
    const analysis = state?.analysisStatus;
    if (analysis) quality.textContent += ` · Vorfallsauswertung: ${analysis.message || analysis.status || analysis.error || (typeof analysis === 'string' ? analysis : 'Status gemeldet')}`;
    const policy = state?.historyPolicy;
    if (policy) for (const [key, input] of controls) if (document.activeElement !== input && Number.isFinite(policy[key])) input.value = key === 'archiveMaxBytes' ? String(Math.round(policy[key] / (1024 * 1024))) : String(policy[key]);
    const activeGames = Array.isArray(state?.gameDetection?.active) ? state.gameDetection.active : [];
    const selected = game.value; game.replaceChildren(el('option', '', 'Aktives Spiel auswählen'));
    activeGames.slice(0, 16).forEach(item => { const option = el('option', '', `${item.name || item.title || 'Spiel'} · ${item.sessionId || 'Sitzung'}`); option.value = item.sessionId || ''; game.append(option); });
    if ([...game.options].some(option => option.value === selected)) game.value = selected;
    const captureState = state?.incidentCapture || {};
    captureStatus.textContent = captureState.message || captureState.error || captureState.status || (captureState.enabled ? 'Freigabe für den einmaligen Versuch ist aktiv.' : 'Kein Mitschnitt angefordert.');
    const credentials = state?.routerCredentialStorage || {};
    const remembered = credentials.remembered === true || credentials.stored === true || credentials.enabled === true;
    credentialStatus.textContent = credentials.error || (remembered ? 'Eine Anmeldung liegt geschützt im Windows-Speicher.' : credentials.available === false ? 'Geschützte Anmeldung ist auf diesem System nicht verfügbar.' : 'Keine gespeicherte Anmeldung.');
    forget.disabled = !remembered;
    peer.update(state?.peers || null);
  }
  return { update, close() { peer.close(); closeBackground(); panel.remove(); } };
}
