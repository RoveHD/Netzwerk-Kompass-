// Keep longer explanations accessible with pointer, keyboard and touch.
const tooltip = document.createElement('div');
tooltip.id = 'ui-help-tooltip';
tooltip.className = 'help-popover';
tooltip.setAttribute('role', 'tooltip');
tooltip.hidden = true;
document.body.append(tooltip);
let current = null;
let pinned = false;

function close() {
  current?.setAttribute('aria-expanded', 'false');
  current?.removeAttribute('aria-describedby');
  tooltip.hidden = true;
  current = null;
  pinned = false;
}
function position() {
  if (!current) return;
  const rect = current.getBoundingClientRect();
  const bounds = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(16, Math.min(rect.left, innerWidth - bounds.width - 16))}px`;
  tooltip.style.top = `${Math.max(16, Math.min(rect.bottom + 8, innerHeight - bounds.height - 16))}px`;
}
function open(button) {
  const source = button.helpSource || button;
  const copy = source.dataset.help || source.title;
  if (!copy) return;
  if (current !== button) close();
  current = button;
  (button.closest('dialog[open]') || document.body).append(tooltip);
  tooltip.textContent = copy;
  tooltip.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-describedby', tooltip.id);
  position();
}
function enhance(root) {
  const elements = [...(root.matches?.('[data-help]') ? [root] : []), ...(root.querySelectorAll?.('[data-help]') || [])];
  for (const element of elements) {
    if (element.classList.contains('info-tip') || element.helpButton?.isConnected) continue;
    if (!element.dataset.help || element.dataset.help === element.textContent.trim()) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'info-tip';
    button.textContent = 'ⓘ';
    button.setAttribute('aria-label', 'Weitere Informationen');
    button.setAttribute('aria-expanded', 'false');
    button.helpSource = element;
    element.helpButton = button;
    // Appending to the explanatory element keeps its hidden state and layout.
    if (element.matches('input, select, button')) element.after(button);
    else element.append(button);
  }
}
enhance(document);
new MutationObserver(records => {
  const replacedSource = current && !current.isConnected ? current.helpSource : null;
  const wasPinned = pinned;
  for (const record of records) {
    if (record.type === 'attributes') enhance(record.target);
    else {
      enhance(record.target);
      for (const node of record.addedNodes) if (node.nodeType === 1) enhance(node);
    }
  }
  if (replacedSource?.isConnected && replacedSource.helpButton?.isConnected) {
    open(replacedSource.helpButton);
    pinned = wasPinned;
  } else if (current && !current.isConnected) close();
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-help'] });
document.addEventListener('click', event => {
  const button = event.target.closest('.info-tip');
  if (!button) { if (!tooltip.contains(event.target)) close(); return; }
  event.preventDefault();
  if (button === current && pinned) close();
  else { open(button); pinned = true; }
});
document.addEventListener('focusin', event => { if (event.target.matches('.info-tip')) open(event.target); });
document.addEventListener('focusout', event => { if (event.target === current && !pinned) close(); });
document.addEventListener('pointerover', event => { const button = event.target.closest('.info-tip'); if (button && !pinned) open(button); });
document.addEventListener('pointerout', event => { if (event.target.closest('.info-tip') === current && !pinned) close(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && current) { close(); event.stopPropagation(); } }, true);
window.addEventListener('resize', position);
window.addEventListener('scroll', position, true);
