import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const preloadPath = fileURLToPath(new URL('../desktop/preload.cjs', import.meta.url));

test('sandbox preload exposes only narrow hotkey methods and forwards no event objects', () => {
  const source = fs.readFileSync(preloadPath, 'utf8');
  const listeners = new Map();
  const calls = [];
  let exposedName;
  let exposedApi;
  const ipcRenderer = {
    invoke: (...args) => { calls.push(['invoke', ...args]); return Promise.resolve({ registered: true }); },
    on: (channel, callback) => { listeners.set(channel, callback); },
    removeListener: (channel, callback) => {
      calls.push(['removeListener', channel, callback]);
      if (listeners.get(channel) === callback) listeners.delete(channel);
    }
  };
  const contextBridge = { exposeInMainWorld: (name, api) => { exposedName = name; exposedApi = api; } };
  const sandbox = {
    require(name) {
      assert.equal(name, 'electron', 'sandbox preload may require Electron only');
      return { contextBridge, ipcRenderer };
    },
    window: { addEventListener() {} },
    HTMLAnchorElement: class {}
  };

  vm.runInNewContext(source, sandbox, { filename: path.basename(preloadPath) });
  assert.equal(exposedName, 'desktopLagHotkey');
  assert.deepEqual(Object.keys(exposedApi), ['get', 'set', 'capture', 'onSelected', 'onStatus', 'onMark']);
  assert.equal(Object.isFrozen(exposedApi), true);

  exposedApi.get();
  exposedApi.set('Control+Alt+L');
  assert.deepEqual(calls.slice(0, 2).map(call => call.slice(0, 3)), [
    ['invoke', 'netzwerk-kompass:lag-hotkey:get'],
    ['invoke', 'netzwerk-kompass:lag-hotkey:set', 'Control+Alt+L']
  ]);

  let callbackArgs = 'not-called';
  const unsubscribe = exposedApi.onMark((...args) => { callbackArgs = args; });
  const markListener = listeners.get('netzwerk-kompass:lag-hotkey:marked');
  assert.equal(typeof markListener, 'function');
  const rawEvent = { sender: 'private', secret: 'must-not-leak' };
  markListener(rawEvent, 'extra');
  assert.deepEqual(callbackArgs, []);
  unsubscribe();
  assert.equal(listeners.has('netzwerk-kompass:lag-hotkey:marked'), false);
  assert.equal(calls.some(call => call[0] === 'send'), false);
  exposedApi.capture(true);
  assert.deepEqual(calls.at(-1),['invoke','netzwerk-kompass:lag-hotkey:capture',true]);
  let selection;exposedApi.onSelected(value=>{selection=value;});listeners.get('netzwerk-kompass:lag-hotkey:selected')(rawEvent,'MouseBack');assert.equal(selection,'MouseBack');
  let status;exposedApi.onStatus(value=>{status=value;});listeners.get('netzwerk-kompass:lag-hotkey:status')(rawEvent,{accelerator:'A',registered:true,error:'',secret:'must-not-leak'});assert.equal(status.accelerator,'A');assert.equal(Object.hasOwn(status,'secret'),false);
});
