const number = value => Number.isFinite(value) ? value.toLocaleString('de-AT', { maximumFractionDigits: 1 }) : '–';
export function formatLoadBytes(value) {
  if (!Number.isFinite(value)) return '–';
  return value >= 1_000_000_000 ? `${number(value / 1_000_000_000)} GB` : `${number(value / 1_000_000)} MB`;
}
export function formatLoadTime(seconds) {
  const elapsed = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} min`;
}
export function renderStress(state) {
  const test = state.stressTest || {};
  const text = (id, value) => { const el = document.getElementById(id); if (el && el.textContent !== value) el.textContent = value; };
  text('stress-state', test.running ? test.stopping ? 'Wird gestoppt …' : 'Dauerbelastung läuft' : test.error ? `Test abgebrochen: ${test.error}` : test.reason === 'completed' ? 'Gewählte Laufzeit erreicht' : test.reason === 'stopped' ? 'Dauerbelastung gestoppt' : 'Bereit – startet erst mit deinem Klick');
  text('stress-elapsed', formatLoadTime(test.elapsedSeconds));
  text('stress-download-total', formatLoadBytes(test.downloadBytes ?? 0));
  text('stress-upload-total', formatLoadBytes(test.uploadBytes ?? 0));
  text('stress-down-rate', `Ø ${number(test.downloadMbps)} Mbit/s`);
  text('stress-up-rate', `Ø ${number(test.uploadMbps)} Mbit/s`);
  text('stress-progress-note', test.running ? `${test.durationSeconds ? `Noch etwa ${formatLoadTime(Math.max(0, test.durationSeconds - (test.elapsedSeconds || 0)))}` : 'Läuft bis du stoppst'} · Ping-Überwachung ${state.monitoring ? 'aktiv' : 'pausiert'}` : 'Durchschnitt seit Testbeginn.');
  const note = document.getElementById('stress-progress-note');
  if (note) note.dataset.help = 'Download zählt empfangene Daten, Upload nur bestätigte Übertragungen. Ein abgebrochener Upload kann zusätzlichen Datenverkehr verursachen. Zum Vergleichen der Ping-Werte muss die Überwachung aktiv sein.';
  const start = document.getElementById('stress-start');
  if (start) start.textContent = test.running ? 'Test läuft …' : test.startedAt ? 'Erneut belasten' : 'Dauerbelastung starten';
}
