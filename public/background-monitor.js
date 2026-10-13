export function initBackgroundMonitoring(parent) {
  const bridge = window.desktopBackgroundMonitoring;
  const root = document.createElement('div'); root.className = 'setting-row';
  const label = document.createElement('label');
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
  label.append(checkbox, ' Beim Schließen im Hintergrund weiter überwachen');
  const status = document.createElement('p'); status.className = 'muted'; status.setAttribute('role', 'status');
  const details = document.createElement('p'); details.className = 'muted';
  details.textContent = 'Das Fenster wird ausgeblendet; Messungen und Lag-Hotkey bleiben aktiv. „Vollständig beenden“ stoppt die App. Windows-Autostart startet nach der Anmeldung. Im Standby und vor der Anmeldung wird nicht gemessen.';
  const quit = document.createElement('button'); quit.type = 'button'; quit.textContent = 'Vollständig beenden';
  root.append(label, status, details, quit); parent.append(root);
  let busy = false, current = null;
  function render(value) {
    current = value;
    checkbox.checked = value.enabled === true; checkbox.disabled = busy || !value.available;
    quit.disabled = !value.available || busy;
    const labels = { restarting: 'Messprozess wird wiederhergestellt – Messlücke wird protokolliert.', failed: 'Messprozess beendet.', stopping: 'Messungen werden beendet und gespeichert.', stopped: 'Messprozess beendet.', starting: 'Messprozess startet.' };
    status.textContent = value.error || (!value.available ? 'Hintergrundbetrieb ist in der Windows-Desktop-App verfügbar.' :
      labels[value.state] || (value.enabled ? 'Hintergrundbetrieb ist eingeschaltet.' : 'Schließen beendet die App.'));
    if (value.lastGap) status.textContent += ` Letzte Messlücke: ${new Date(value.lastGap.startedAt).toLocaleString('de-DE')} bis ${value.lastGap.resumedAt ? new Date(value.lastGap.resumedAt).toLocaleString('de-DE') : 'Wiederherstellung'}.`;
    if (value.enabled && value.restartSupported) status.textContent += ` Maximal ${value.maxRestarts || 3} automatische Neustarts je Sitzung.`;
  }
  checkbox.addEventListener('change', async () => {
    if (busy) return;
    busy = true; checkbox.disabled = true; quit.disabled = true;
    try { render(await bridge.set(checkbox.checked)); }
    catch (error) { if (current) render(current); status.textContent = error.message; }
    finally { busy = false; if (current) { checkbox.disabled = !current.available; quit.disabled = !current.available; } }
  });
  quit.addEventListener('click', () => { quit.disabled = true; bridge.quit().catch(error => { status.textContent = error.message; quit.disabled = false; }); });
  render({ available: Boolean(bridge), enabled: false });
  if (bridge) {
    const refresh = () => { if (!busy) bridge.get().then(render).catch(error => { status.textContent = error.message; }); };
    refresh();
    const unsubscribe = bridge.onStatus(render);
    // The portable process supervisor lives outside Electron and publishes its
    // state in a local file; refresh that narrow bridge without a second service.
    const timer = setInterval(refresh, 3000);
    return () => { clearInterval(timer); unsubscribe(); };
  }
  return () => {};
}
