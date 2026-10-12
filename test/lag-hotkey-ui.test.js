import test from 'node:test';
import assert from 'node:assert/strict';
import { hotkeyFromEvent, hotkeyFromMouseEvent, hotkeyLabel } from '../public/lag-hotkey.js';

test('hotkey recording uses the typed key and a stable modifier order', () => {
  assert.equal(hotkeyFromEvent({ key: 'l', ctrlKey: true, altKey: true }), 'Control+Alt+L');
  assert.equal(hotkeyFromEvent({ key: 'Z', ctrlKey: true, shiftKey: true }), 'Control+Shift+Z');
  assert.equal(hotkeyFromEvent({ key: 'ArrowLeft', metaKey: true }), 'Super+Left');
  assert.equal(hotkeyFromEvent({ key: ' ', ctrlKey: true }), 'Control+Space');
  for (const key of ['F1', 'F9', 'F12', 'F24']) assert.equal(hotkeyFromEvent({ key }), key);
});

test('single keys, Escape, Tab, modifiers and mouse side buttons are independently bindable', () => {
  for (const key of ['a', '1', 'Enter', 'Tab', 'Delete', 'Escape']) assert.equal(hotkeyFromEvent({ key }), key.toUpperCase().length===1?key.toUpperCase():key);
  assert.equal(hotkeyFromEvent({key:'Control',code:'ControlLeft',ctrlKey:true}),'ControlLeft');
  assert.equal(hotkeyFromEvent({key:'Alt',code:'AltRight',altKey:true}),'AltRight');
  assert.equal(hotkeyFromEvent({key:'ö',code:'Semicolon'}),'VK_BA');
  assert.equal(hotkeyFromEvent({key:'0',code:'Numpad0'}),'VK_60');
  assert.equal(hotkeyFromEvent({key:'Enter',code:'NumpadEnter'}),'NumpadEnter');
  assert.equal(hotkeyFromEvent({ key: 'A', shiftKey: true }), 'Shift+A');
  assert.deepEqual([0,1,2,3,4].map(button=>hotkeyFromMouseEvent({button})),['MouseLeft','MouseMiddle','MouseRight','MouseBack','MouseForward']);
  assert.equal(hotkeyFromMouseEvent({button:3,ctrlKey:true}),'Control+MouseBack');
  for(const key of ['F25','Unidentified','Fn'])assert.equal(hotkeyFromEvent({key}),'');
});
test('repeated and composing keys do not become hotkeys',()=>{
  assert.equal(hotkeyFromEvent({ key: 'l', ctrlKey: true, repeat: true }), '');
  assert.equal(hotkeyFromEvent({ key: 'l', ctrlKey: true, isComposing: true }), '');
  assert.equal(hotkeyFromEvent({ key: 'q', ctrlKey: true, altKey: true, getModifierState: key => key === 'AltGraph' }), 'Control+Alt+Q');
});

test('hotkey labels are readable on a German keyboard', () => {
  assert.equal(hotkeyLabel('Control+Alt+L'), 'Strg + Alt + L');
  assert.equal(hotkeyLabel('Control+Shift+Space'), 'Strg + Umschalt + Leertaste');
  assert.equal(hotkeyLabel(''), '');
});
