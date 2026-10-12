export const pages = Object.freeze([
  { id: 'overview', title: 'Übersicht', intro: 'Status, Verbindungsqualität und aktuelle Auffälligkeiten.' },
  { id: 'devices', title: 'Geräte & Repeater', intro: 'Messziele verwalten, Geräte finden und den Repeater am PC zuordnen.' },
  { id: 'games', title: 'Spiele & Pakete', intro: 'Ein Spiel auswählen, seinen Netzwerkverkehr beobachten und zeitgleiche Messwerte vergleichen.' },
  { id: 'history', title: 'Verlauf', intro: 'Gespeicherte Messungen im gewählten Zeitraum vergleichen.' },
  { id: 'router', title: 'FRITZ!Box & Mesh', intro: 'Routerdaten und verfügbare Mesh-Verbindungen direkt auslesen.' },
  { id: 'tests', title: 'Tests & WLAN', intro: 'WLAN, DNS-Auflösung und Übertragungsrate prüfen.' },
  { id: 'ai', title: 'KI-Auswertung', intro: 'Messwerte bewusst zur Auswertung an Codex übergeben.' },
  { id: 'settings', title: 'Einstellungen & Speicherung', intro: 'Autostart, gespeicherte Diagnosen und Messsitzungen verwalten.' },
]);

// Only exact, known hashes route a page. Anchors such as #main stay ordinary anchors.
export function pageFromHash(hash) {
  return typeof hash === 'string' ? pages.find(page => hash === `#${page.id}`)?.id || null : null;
}

export function initNavigation({ document: doc = document, window: win = window, onChange = () => {} } = {}) {
  const containers = [...doc.querySelectorAll('[data-page]')];
  const links = [...doc.querySelectorAll('[data-nav-page]')];
  let remembered;
  try { remembered = win.sessionStorage?.getItem('network-compass-page'); } catch { /* Navigation also works without storage. */ }
  let active = pageFromHash(win.location.hash) || pages.find(page => page.id === remembered)?.id || 'overview';
  const apply = (id, { focus = false } = {}) => {
    const page = pages.find(item => item.id === id);
    if (!page) return false;
    active = id;
    containers.forEach(container => { container.hidden = container.dataset.page !== id; });
    links.forEach(link => {
      const selected = link.dataset.navPage === id;
      link.classList.toggle('is-active', selected);
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    try { win.sessionStorage?.setItem('network-compass-page', id); } catch { /* Optional reload convenience. */ }
    onChange(page);
    if (focus) doc.querySelector('#page-title')?.focus({ preventScroll: true });
    return true;
  };
  const navigate = (id, { focus = false } = {}) => {
    if (!pages.some(page => page.id === id)) return false;
    if (win.location.hash !== `#${id}`) win.history.pushState(null, '', `#${id}`);
    return apply(id, { focus });
  };
  links.forEach(link => link.addEventListener('click', event => {
    if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (navigate(link.dataset.navPage, { focus: true })) win.scrollTo?.(0, 0);
  }));
  win.addEventListener('hashchange', () => {
    const id = pageFromHash(win.location.hash);
    if (id) apply(id);
  });
  apply(active);
  return { navigate, get activePage() { return active; } };
}
