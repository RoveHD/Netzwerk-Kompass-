export function initPeerMonitoring(parent, { api }) {
  const panel = document.createElement('section'); panel.className = 'peer-monitor-panel';
  panel.innerHTML = `
    <h3>Messungen von mehreren PCs</h3>
    <p>Ein PC sammelt als Zentrale die Messwerte. Weitere PCs senden ihre eigenen Ping-, Adapter- und Netzwerkmessungen verschlüsselt dorthin.</p>
    <form class="peer-config-form">
      <label class="peer-toggle"><input name="enabled" type="checkbox"> PC-Kopplung aktivieren</label>
      <div class="peer-fields">
        <label>Aufgabe dieses PCs<select name="role"><option value="agent">Mess-PC · an Zentrale senden</option><option value="central">Zentrale · Messungen empfangen</option></select></label>
        <label>PC-Name<input name="name" maxlength="64" autocomplete="off" value="Dieser PC"></label>
        <label data-central>Lokale Adresse zum Empfangen<input name="listenHost" value="0.0.0.0" placeholder="192.168.178.20" autocomplete="off"><small>0.0.0.0 lauscht auf allen lokalen IPv4-Adaptern.</small></label>
        <label data-central>Port<input name="port" type="number" min="1" max="65535" value="47831"></label>
      </div>
      <button type="submit">PC-Einstellung speichern</button>
    </form>
    <p class="peer-state" role="status" aria-live="polite">PC-Kopplung wird geladen …</p>
    <div data-central class="peer-pairing-central" hidden>
      <p>Auf dem Mess-PC die LAN-IP dieser Zentrale und den folgenden einmaligen Code eintragen. Der Code bestätigt auch den Zertifikat-Fingerabdruck und gilt fünf Minuten. Nur dem gewünschten PC geben.</p>
      <button type="button" data-action="invite">Kopplungscode erstellen</button>
      <label class="peer-invitation" hidden>Kopplungscode · nach fünf Minuten ungültig<textarea readonly rows="5" aria-label="Einmaliger Kopplungscode" spellcheck="false"></textarea></label>
    </div>
    <form class="peer-pairing-agent" data-agent>
      <div class="peer-fields"><label>LAN-IP der Zentrale<input name="address" placeholder="192.168.178.20" autocomplete="off" required></label>
      <label>Kopplungscode der Zentrale<textarea name="invitation" rows="4" spellcheck="false" autocomplete="off" required></textarea></label></div>
      <button type="submit">Mit Zentrale koppeln</button>
    </form>
    <p class="peer-message" role="status" aria-live="polite"></p>
    <div class="peer-list" aria-label="Gekoppelte PCs"></div>
    <p class="peer-boundary">Die Kopplung überträgt private lokale IP- und MAC-Adressen sowie Messzeiten, aber keine Router-Anmeldedaten oder Paketinhalte. Eine getrennte PC-Verbindung beweist keinen WLAN-Ausfall. Windows-Firewall und Routerfreigaben werden nicht verändert. Die Zentrale benötigt einen erreichbaren LAN-Port; keine Internet-Portweiterleitung einrichten.</p>`;
  parent.append(panel);
  const form = panel.querySelector('.peer-config-form'), pairing = panel.querySelector('.peer-pairing-agent');
  const status = panel.querySelector('.peer-state'), message = panel.querySelector('.peer-message'), list = panel.querySelector('.peer-list');
  let current, busy = false, initialized = false, stopped = false, inviteTimer, listSignature;
  const showRole = () => {
    const central = form.elements.role.value === 'central';
    panel.querySelectorAll('[data-central]').forEach(item => { item.hidden = !central; });
    panel.querySelectorAll('[data-agent]').forEach(item => { item.hidden = central; });
  };
  const applyConfig = state => {
    if (!state?.config) return;
    for (const key of ['role', 'name', 'listenHost', 'port']) form.elements[key].value = state.config[key] ?? '';
    form.elements.enabled.checked = state.config.enabled === true; showRole(); initialized = true;
  };
  const update = state => {
    if (stopped || !state) return; current = state;
    if (!initialized) applyConfig(state);
    const config = state.config || {};
    status.textContent = state.lastError ? `PC-Kopplung: ${state.lastError}` : !config.enabled ? 'PC-Kopplung ist ausgeschaltet.' : config.role === 'central' ? `Zentrale ${state.listening ? `empfängt auf Port ${state.port}` : 'empfängt zurzeit nicht'}.` : `Mess-PC · ${state.outboxCount || 0} Messungen warten auf Übertragung.`;
    if (state.dropped) status.textContent += ` ${state.dropped} alte Messungen mussten aus dem begrenzten Offline-Puffer entfernt werden.`;
    const peers = state.peers || [], signature = JSON.stringify(peers.map(peer => [peer.id, peer.name, peer.connected, peer.clockOffsetMs, peer.clockUncertaintyMs]));
    if (signature === listSignature) return; listSignature = signature; list.replaceChildren();
    if (!peers.length) { list.textContent = 'Noch kein PC gekoppelt.'; return; }
    for (const peer of peers) {
      const row = document.createElement('div'); row.className = 'peer-list-row';
      const label = document.createElement('span'); label.textContent = `${peer.name || 'Mess-PC'} · ${peer.connected ? 'verbunden' : 'Verbindung getrennt / noch nicht gemessen'}`;
      const detail = document.createElement('small'); detail.textContent = `${peer.id}${Number.isFinite(peer.clockOffsetMs) ? ` · Uhrkorrektur ${Math.round(peer.clockOffsetMs)} ms, Unsicherheit mindestens ±${Math.ceil(peer.clockUncertaintyMs || 0)} ms` : ''}`;
      const button = document.createElement('button'); button.type = 'button'; button.dataset.peerId = peer.id; button.textContent = config.role === 'central' ? 'Zugriff widerrufen' : 'Verbindung lokal entfernen'; button.disabled = busy;
      row.append(label, detail, button); list.append(row);
    }
  };
  const run = async action => {
    if (busy || stopped) return; busy = true; message.textContent = '';
    panel.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await action(); } catch (error) { message.textContent = error.message || 'PC-Kopplung fehlgeschlagen.'; }
    finally { busy = false; if (!stopped) panel.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
  };
  form.addEventListener('submit', event => {
    event.preventDefault(); run(async () => {
      const state = await api('/api/peers/configure', { enabled: form.elements.enabled.checked, role: form.elements.role.value,
        name: form.elements.name.value, listenHost: form.elements.listenHost.value.trim(), port: Number(form.elements.port.value) });
      applyConfig(state); update(state); message.textContent = 'PC-Einstellung gespeichert.';
    });
  });
  form.elements.role.addEventListener('change', showRole);
  panel.querySelector('[data-action="invite"]').addEventListener('click', () => run(async () => {
    const invite = await api('/api/peers/pairing', {}), box = panel.querySelector('.peer-invitation');
    box.hidden = false; box.querySelector('textarea').value = JSON.stringify(invite);
    clearTimeout(inviteTimer); inviteTimer = setTimeout(() => { box.querySelector('textarea').value = ''; box.hidden = true; }, 5 * 60000);
    box.querySelector('textarea').focus(); box.querySelector('textarea').select();
    message.textContent = 'Code erstellt. Auf dem zweiten PC zusammen mit der LAN-IP dieser Zentrale eintragen.';
  }));
  pairing.addEventListener('submit', event => {
    event.preventDefault(); run(async () => {
      let invite;
      try { invite = JSON.parse(pairing.elements.invitation.value); } catch { throw new Error('Den vollständigen Kopplungscode der Zentrale einfügen.'); }
      const state = await api('/api/peers/pair', { address: pairing.elements.address.value.trim(), centralId: invite.centralId, port: invite.port, pin: invite.pin, secret: invite.secret });
      pairing.elements.invitation.value = ''; update(state); message.textContent = 'PC gekoppelt. Messungen werden bei bestehender Verbindung übertragen.';
    });
  });
  list.addEventListener('click', event => {
    const button = event.target.closest('button[data-peer-id]'); if (!button) return;
    run(async () => { const wasCentral = current?.config?.role === 'central'; update(await api('/api/peers/revoke', { peerId: button.dataset.peerId })); message.textContent = wasCentral ? 'Zugriff dieses Mess-PCs widerrufen.' : 'Verbindung lokal entfernt. Den Zugriff zusätzlich auf der Zentrale widerrufen, bevor dieser PC erneut gekoppelt wird.'; });
  });
  showRole(); run(async () => update(await api('/api/peers')));
  return { update, close() { stopped = true; clearTimeout(inviteTimer); panel.remove(); current = null; } };
}
