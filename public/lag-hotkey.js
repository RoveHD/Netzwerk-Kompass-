const labels={Control:'Strg',Alt:'Alt',Shift:'Umschalt',Super:'Win',ControlLeft:'Strg links',ControlRight:'Strg rechts',AltLeft:'Alt links',AltRight:'Alt rechts / AltGr',ShiftLeft:'Umschalt links',ShiftRight:'Umschalt rechts',SuperLeft:'Win links',SuperRight:'Win rechts',Space:'Leertaste',Enter:'Enter',NumpadEnter:'Enter (Ziffernblock)',Tab:'Tab',Escape:'Escape',Backspace:'Rücktaste',Insert:'Einfg',Delete:'Entf',Home:'Pos1',End:'Ende',PageUp:'Bild auf',PageDown:'Bild ab',Up:'Pfeil hoch',Down:'Pfeil runter',Left:'Pfeil links',Right:'Pfeil rechts',CapsLock:'Feststelltaste',PrintScreen:'Druck',Pause:'Pause',NumLock:'Num',ScrollLock:'Rollen',Apps:'Menütaste',MouseLeft:'Maustaste links',MouseRight:'Maustaste rechts',MouseMiddle:'Mausrad-Klick',MouseBack:'Seitentaste zurück (X1)',MouseForward:'Seitentaste vor (X2)',WheelUp:'Mausrad hoch',WheelDown:'Mausrad runter',WheelLeft:'Mausrad links',WheelRight:'Mausrad rechts',VolumeMute:'Stumm',VolumeUp:'Lauter',VolumeDown:'Leiser',MediaPlayPause:'Medien abspielen / Pause',MediaStop:'Medien stoppen',MediaNextTrack:'Nächster Titel',MediaPreviousTrack:'Vorheriger Titel',VK_BA:'Ö / ;',VK_BB:'+ / =',VK_BC:',',VK_BD:'- / ß',VK_BE:'.',VK_BF:'- / /',VK_C0:'^ / `',VK_DB:'Ü / [',VK_DC:'# / \\',VK_DD:'+ / ]',VK_DE:'Ä / Apostroph',VK_E2:'< / >'};
for(let digit=0;digit<=9;digit++)labels['VK_'+(0x60+digit).toString(16).toUpperCase()]='Ziffernblock '+digit;
Object.assign(labels,{VK_6A:'Ziffernblock *',VK_6B:'Ziffernblock +',VK_6C:'Ziffernblock Trennzeichen',VK_6D:'Ziffernblock -',VK_6E:'Ziffernblock Dezimal',VK_6F:'Ziffernblock /'});
export function hotkeyLabel(accelerator){return String(accelerator||'').split('+').map(key=>labels[key]||(/^VK_/.test(key)?'Windows-Taste (0x'+key.slice(3)+')':key)).join(' + ');}
const mods=(event,own='')=>[event.ctrlKey&&own!=='Control'&&'Control',event.altKey&&own!=='Alt'&&'Alt',event.shiftKey&&own!=='Shift'&&'Shift',event.metaKey&&own!=='Super'&&'Super'].filter(Boolean);
// Pure local conversion is used by tests/fallback tooling. Desktop recording
// uses the native one-shot selector, including keys Chromium cannot deliver.
export function hotkeyFromEvent(event){
  if(event.repeat||event.isComposing)return '';
  const named={' ':'Space',ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Meta:'Super',ContextMenu:'Apps'};
  let key=named[event.key]||event.key;
  if(['Control','Alt','Shift','Super'].includes(key)){const own=key;key=(event.code?.endsWith('Right')?key+'Right':key+'Left');return [...mods(event,own),key].join('+');}
  if(event.code==='NumpadEnter')key='NumpadEnter';
  else if(/^Numpad[0-9]$/.test(event.code||''))key='VK_'+(0x60+Number(event.code.at(-1))).toString(16).toUpperCase();
  else if(/^[a-z0-9]$/i.test(key||''))key=key.toUpperCase();
  else if(!labels[key]&&!/^F(?:[1-9]|1\d|2[0-4])$/.test(key||'')){
    const codes={Semicolon:0xBA,Equal:0xBB,Comma:0xBC,Minus:0xBD,Period:0xBE,Slash:0xBF,Backquote:0xC0,BracketLeft:0xDB,Backslash:0xDC,BracketRight:0xDD,Quote:0xDE,IntlBackslash:0xE2,NumpadMultiply:0x6A,NumpadAdd:0x6B,NumpadComma:0x6C,NumpadSubtract:0x6D,NumpadDecimal:0x6E,NumpadDivide:0x6F};
    if(!codes[event.code])return '';key='VK_'+codes[event.code].toString(16).toUpperCase();
  }
  return [...mods(event),key].join('+');
}
export function hotkeyFromMouseEvent(event){const key=['MouseLeft','MouseMiddle','MouseRight','MouseBack','MouseForward'][event.button];return key?[...mods(event),key].join('+'):'';}
export function initLagHotkey({markLag,showToast}){
  const $=selector=>document.querySelector(selector),bridge=window.desktopLagHotkey;
  const edit=$('#lag-hotkey-edit'),status=$('#lag-hotkey-status'),dialog=$('#lag-hotkey-dialog'),input=$('#lag-hotkey-input'),save=$('#lag-hotkey-save'),remove=$('#lag-hotkey-remove'),cancel=$('#lag-hotkey-cancel'),error=$('#lag-hotkey-error'),record=$('#lag-hotkey-record'),recordStatus=$('#lag-hotkey-record-status');
  let current={accelerator:'',registered:false,error:''},selected='',saving=false,recording=false,preparing=false,generation=0;
  const setHelp=(element,text)=>{element.title=text;element.dataset.help=text;};
  const help=$('#lag-hotkey-help');
  if(help){help.textContent='Wähle eine Taste oder Kombination zum Markieren.';setHelp(help,'Du kannst eine Tastatur- oder Maustaste, das Mausrad oder eine Kombination wählen. Tab und Escape sind ebenfalls möglich; einzelne Strg-, Alt-, Umschalt- und Win-Tasten werden beim Loslassen erkannt. Sicherheitsfolgen wie Strg+Alt+Entf und Hardware-Fn ohne Windows-Tastenereignis lassen sich nicht erfassen. Deine normale Eingabe bleibt im Spiel wirksam.');}
  function render(){
    const button=$('#history-mark'),label=hotkeyLabel(current.accelerator);
    status.textContent=current.error?`Fehler: ${current.error}`:current.accelerator?`${label}${current.registered?'':' · nicht aktiv'}`:'';
    status.hidden=!current.error&&!current.accelerator;
    edit.textContent=current.accelerator?'Hotkey ändern':'Hotkey festlegen';
    edit.title=current.error?'Hotkey-Einstellungen prüfen.':current.accelerator?'Lege eine andere Taste zum Markieren fest.':'Lege eine Taste zum Markieren fest.';
    button.title=current.registered?`Lag markieren: ${label}`:'Diesen Moment im Verlauf markieren';
    if(current.registered&&!/Mouse|Wheel|VK_/.test(current.accelerator))button.setAttribute('aria-keyshortcuts',current.accelerator.replace('Super','Meta'));else button.removeAttribute('aria-keyshortcuts');
    save.disabled=saving||recording||preparing||!selected;remove.disabled=saving||recording||preparing||!current.accelerator;cancel.disabled=saving;record.disabled=saving||recording||preparing;input.disabled=saving;
    dialog.classList.toggle('is-recording',recording);record.textContent=preparing?'Aufnahme vorbereiten …':recording?'Aufnahme läuft …':'Taste aufnehmen';
  }
  render();
  if(!bridge?.get||!bridge?.set||!bridge?.onMark||!bridge?.capture||!bridge?.onSelected){status.textContent='';status.hidden=true;edit.disabled=true;edit.title='Globale Hotkeys sind nur in der Desktop-App verfügbar.';return;}
  bridge.onMark(()=>{if(!dialog.open)markLag();});
  bridge.onStatus?.(value=>{
    current=value;
    if(value.error&&(recording||preparing)){
      generation++;recording=false;preparing=false;error.textContent=value.error;recordStatus.textContent='Aufnahme beendet.';setHelp(recordStatus,'Du kannst erneut aufnehmen oder abbrechen.');bridge.capture(false).catch(()=>{});
    }
    render();
  });
  bridge.onSelected(value=>{
    if(!dialog.open||(!recording&&!preparing))return;
    generation++;recording=false;preparing=false;selected=value;input.value=hotkeyLabel(value);error.textContent='';recordStatus.textContent='Taste gewählt.';setHelp(recordStatus,'Speichere die Auswahl oder starte eine neue Aufnahme.');render();
  });
  bridge.get().then(value=>{current=value;render();edit.disabled=false;}).catch(()=>{current={...current,error:'Einstellungen konnten nicht geladen werden.'};render();});
  edit.addEventListener('click',()=>{selected=current.accelerator;input.value=hotkeyLabel(selected);error.textContent=current.error||'';recordStatus.textContent='Klicke auf „Taste aufnehmen“, um zu starten.';recordStatus.title='';delete recordStatus.dataset.help;render();dialog.showModal();record.focus();});
  record.addEventListener('click',async()=>{
    if(preparing||recording||saving)return;const version=++generation;preparing=true;error.textContent='';recordStatus.textContent='Windows-Aufnahme wird vorbereitet …';render();
    try{const result=await bridge.capture(true);if(version!==generation||!dialog.open)return;preparing=false;recording=result.capturing===true;error.textContent=result.error||'';recordStatus.textContent=recording?'Drücke jetzt eine Taste oder klicke eine Maustaste.':result.error?'Aufnahme konnte nicht beginnen.':'Aufnahme beendet.';if(recording)setHelp(recordStatus,'Einzelne Modifier werden beim Loslassen erkannt.');else{recordStatus.title='';delete recordStatus.dataset.help;}}
    catch{if(version===generation){preparing=false;recording=false;error.textContent='Aufnahme konnte nicht gestartet werden.';}}
    finally{render();}
  });
  dialog.addEventListener('keydown',event=>{if(recording||preparing){event.preventDefault();event.stopPropagation();}},true);
  dialog.addEventListener('contextmenu',event=>{if(recording||preparing)event.preventDefault();});
  dialog.addEventListener('auxclick',event=>{if(recording||preparing)event.preventDefault();});
  dialog.addEventListener('cancel',event=>event.preventDefault());
  dialog.addEventListener('close',()=>{generation++;recording=false;preparing=false;bridge.capture(false).catch(()=>{});render();});
  async function apply(value){
    if(saving||recording||preparing)return;saving=true;error.textContent='';render();
    try{current=await bridge.set(value);if(current.error)error.textContent=current.error;else{dialog.close();showToast(value?`Hotkey gespeichert: ${hotkeyLabel(value)}`:'Hotkey entfernt.');}}
    catch{error.textContent='Hotkey konnte nicht gespeichert werden. Bitte erneut versuchen.';}
    finally{saving=false;render();}
  }
  save.addEventListener('click',()=>{if(selected)apply(selected);});remove.addEventListener('click',()=>apply(''));cancel.addEventListener('click',()=>{if(!saving)dialog.close();});
}
