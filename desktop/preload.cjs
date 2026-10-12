const { contextBridge, ipcRenderer } = require('electron');
const GET_CHANNEL = 'netzwerk-kompass:lag-hotkey:get';
const SET_CHANNEL = 'netzwerk-kompass:lag-hotkey:set';
const MARK_EVENT = 'netzwerk-kompass:lag-hotkey:marked';
const CAPTURE_CHANNEL = 'netzwerk-kompass:lag-hotkey:capture';
const SELECT_EVENT = 'netzwerk-kompass:lag-hotkey:selected';
const STATUS_EVENT = 'netzwerk-kompass:lag-hotkey:status';

function subscribe(channel, callback, project) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(project(value));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('desktopLagHotkey', Object.freeze({
  get: () => ipcRenderer.invoke(GET_CHANNEL),
  set: accelerator => ipcRenderer.invoke(SET_CHANNEL, accelerator),
  capture: active => ipcRenderer.invoke(CAPTURE_CHANNEL, active),
  onSelected: callback => subscribe(SELECT_EVENT, callback, value => typeof value === 'string' ? value : ''),
  onStatus: callback => subscribe(STATUS_EVENT, callback, value => ({ accelerator: typeof value?.accelerator === 'string' ? value.accelerator : '', registered: value?.registered === true, error: typeof value?.error === 'string' ? value.error : '' })),
  onMark: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on(MARK_EVENT, listener);
    return () => ipcRenderer.removeListener(MARK_EVENT, listener);
  }
}));

// The page receives only the narrow hotkey bridge above. A real click on this
// specific help destination can also request an external browser; window.open remains blocked.
const helpUrl = 'https://learn.chatgpt.com/docs/codex-cli';
function openHelp(event) {
  if (!event.isTrusted || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
  const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
  if (!link || link.href !== helpUrl) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send('netzwerk-kompass:open-help', link.href);
}
window.addEventListener('click', openHelp, true);
window.addEventListener('auxclick', openHelp, true);
