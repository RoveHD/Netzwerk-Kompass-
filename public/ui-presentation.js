// Values update immediately; the short fade changes presentation, never data.
export function setMeasurement(element, value, unit = '') {
  if (!element) return;
  const next = value == null || value === '' ? '–' : String(value);
  const previous = element.dataset.reading;
  if (previous === next && element.dataset.unit === unit) return;
  element.dataset.reading = next;
  element.dataset.unit = unit;
  const doc = element.ownerDocument;
  const reading = doc.createElement('span');
  reading.className = 'readout-number'; reading.textContent = next;
  element.replaceChildren(reading);
  if (unit) {
    const suffix = doc.createElement('small'); suffix.className = 'readout-unit'; suffix.textContent = unit;
    element.append(doc.createTextNode(' '), suffix);
  }
  if (previous !== undefined && previous !== next && !doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.getAnimations?.().forEach(animation => animation.cancel());
    reading.animate?.([{ opacity: .4 }, { opacity: 1 }], { duration: 150, easing: 'ease-out' });
  }
}

const emptyActions = [
  ['#targets-list > .empty-state', 'Ziel hinzufügen', '#target-host', 'focus'],
  ['#devices-list .table-empty', 'Netzwerk scannen', '#scan-btn', 'click'],
  ['#events-list > .empty-state', 'Lag markieren', '#history-mark', 'click'],
  ['#history-view > .history-empty', 'Zeitraum wählen', '#history-hours', 'focus'],
  ['#fritzbox-data > .history-empty', 'Zugangsdaten eingeben', '#fritzbox-password', 'focus'],
  ['#game-endpoints .table-empty', 'Spiel ergänzen', '#game-custom-name', 'focus'],
  ['#game-sessions .table-empty', 'Spiel ergänzen', '#game-custom-name', 'focus'],
];

export function initPresentation(doc = document) {
  const refresh = () => {
    for (const [selector, label, target, action] of emptyActions) for (const node of doc.querySelectorAll(selector)) {
      if (node.querySelector('.empty-state-content')) continue;
      const text = node.textContent.trim();
      const content = doc.createElement('div'); content.className = 'empty-state-content';
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 32 32'); svg.setAttribute('class', 'empty-illustration'); svg.setAttribute('aria-hidden', 'true');
      const path = doc.createElementNS(svg.namespaceURI, 'path');
      for (const [key, value] of Object.entries({ d: 'M5 16h22v11H5zM9 16V6m14 10V6M9 22h6m5 0h3M9 27v2m14-2v2', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value);
      svg.append(path);
      const sentence = doc.createElement('p'); sentence.textContent = text;
      const button = doc.createElement('button'); button.className = 'button button-secondary'; button.type = 'button'; button.textContent = label;
      button.addEventListener('click', () => {
        const control = doc.querySelector(target);
        control?.scrollIntoView({ block: 'center', behavior: 'auto' });
        if (action === 'click' && !control?.disabled) control?.click(); else control?.focus();
      });
      content.append(svg, sentence, button); node.replaceChildren(content);
    }
  };
  refresh();
  const observer = new MutationObserver(refresh);
  observer.observe(doc.querySelector('main'), { childList: true, subtree: true });
  return () => observer.disconnect();
}
