const fs = require('node:fs');
const path = require('node:path');
const {startNativeHotkey}=require('./native-hotkey.cjs');
const GET_CHANNEL = 'netzwerk-kompass:lag-hotkey:get';
const SET_CHANNEL = 'netzwerk-kompass:lag-hotkey:set';
const CAPTURE_CHANNEL = 'netzwerk-kompass:lag-hotkey:capture';
const MARK_EVENT = 'netzwerk-kompass:lag-hotkey:marked';
const SELECT_EVENT = 'netzwerk-kompass:lag-hotkey:selected';
const STATUS_EVENT = 'netzwerk-kompass:lag-hotkey:status';
const names=new Set(['Backspace','Tab','Enter','NumpadEnter','Shift','Control','Alt','Pause','CapsLock','Escape','Space','PageUp','PageDown','End','Home','Left','Up','Right','Down','PrintScreen','Insert','Delete','Super','SuperLeft','SuperRight','Apps','NumLock','ScrollLock','ShiftLeft','ShiftRight','ControlLeft','ControlRight','AltLeft','AltRight','VolumeMute','VolumeDown','VolumeUp','MediaNextTrack','MediaPreviousTrack','MediaStop','MediaPlayPause','MouseLeft','MouseRight','MouseMiddle','MouseBack','MouseForward','WheelUp','WheelDown','WheelLeft','WheelRight']);
const modifiers=new Set(['Control','Alt','Shift','Super']);
function validateAccelerator(value){
  if(typeof value!=='string'||value.length>80)return 'Ungültige Tastenkombination.';
  if(value==='')return '';
  const parts=value.split('+'),key=parts.pop();
  if(new Set(parts).size!==parts.length||parts.some(part=>!modifiers.has(part)))return 'Ungültige Tastenkombination.';
  if(names.has(key)||/^[A-Z0-9]$/.test(key)||/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key))return '';
  if(/^VK_[0-9A-F]{2}$/.test(key)&&parseInt(key.slice(3),16)>=8&&parseInt(key.slice(3),16)<=254)return '';
  return 'Ungültige Tastenkombination.';
}
function createLagHotkey({filePath,onMark,onSelected=()=>{},onStatus=()=>{},startObserver=startNativeHotkey,now=Date.now}){
  let accelerator='',registered=false,error='',lastMark=-Infinity,closed=false,observer=null,capturing=false,queue=Promise.resolve(),captureVersion=0;
  const status=()=>({accelerator,registered,error});
  const notify=()=>{try{onStatus(status());}catch{}};
  const serialize=action=>{const next=queue.then(action);queue=next.catch(()=>{});return next;};
  const persist=value=>{
    fs.mkdirSync(path.dirname(filePath),{recursive:true});const temporary=`${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try{fs.writeFileSync(temporary,JSON.stringify({accelerator:value},null,2)+'\n',{encoding:'utf8',flag:'wx'});fs.renameSync(temporary,filePath);}
    catch(failure){try{fs.rmSync(temporary,{force:true});}catch{}throw failure;}
  };
  async function launch(binding){
    let candidate;
    candidate=await startObserver({binding,onMark:()=>{
      if(closed||!registered||observer!==candidate||capturing)return;
      const current=now();if(current-lastMark<1000)return;lastMark=current;try{onMark();}catch{}
    },onSelected:value=>{
      if(closed||observer!==candidate||!capturing)return;capturing=false;
      if(!value||validateAccelerator(value)){error='Die gewählte Taste wird nicht unterstützt.';notify();return;}
      try{onSelected(value);}catch{}
    },onFailure:()=>{if(observer===candidate&&!closed){registered=false;capturing=false;error='Der Windows-Hotkey-Helfer ist nicht verfügbar. Bitte erneut einstellen.';notify();}}});
    if(closed||candidate.active===false){candidate.close();throw new Error('Hotkey-Helfer beendet.');}return candidate;
  }
  async function initialize(){
    let saved;try{saved=JSON.parse(fs.readFileSync(filePath,'utf8')).accelerator;}
    catch(failure){if(failure.code!=='ENOENT')error='Die Hotkey-Einstellung konnte nicht gelesen werden.';return status();}
    if(saved==='')return status();
    if(typeof saved!=='string'||validateAccelerator(saved)){error='Die gespeicherte Tastenkombination ist ungültig.';return status();}
    accelerator=saved;try{observer=await launch(saved);registered=true;}catch{error='Der Windows-Hotkey-Helfer ist nicht verfügbar. Bitte erneut einstellen.';}return status();
  }
  function set(value){return serialize(async()=>{
    if(closed)return status();const invalid=validateAccelerator(value);if(invalid){error=invalid;return status();}
    if(capturing){capturing=false;captureVersion++;await observer?.capture(false);}
    if(value===accelerator&&(value===''||registered)){error='';return status();}
    let next=null;try{if(value)next=await launch(value);}catch{error='Der Windows-Hotkey-Helfer ist nicht verfügbar. Die bisherige Bindung bleibt erhalten.';return status();}
    if(closed){next?.close();return status();}
    try{persist(value);}catch{next?.close();error='Die Hotkey-Einstellung konnte nicht gespeichert werden.';return status();}
    const previous=observer;observer=next;accelerator=value;registered=!!value;error='';lastMark=-Infinity;previous?.close();notify();return status();
  });}
  function capture(active){
    if(typeof active!=='boolean')return Promise.resolve({capturing:false,error:'Ungültige Anfrage.'});
    const version=++captureVersion;
    // Cancellation interrupts startup as well as an already armed recorder.
    if(!active){capturing=false;const current=observer;return Promise.resolve(current?.capture(false)).catch(()=>{}).then(()=>{if(!accelerator&&observer===current){current?.close();observer=null;}return {capturing:false,error:''};});}
    return serialize(async()=>{
      if(closed||version!==captureVersion)return {capturing:false,error:''};
      try{if(!observer||(!registered&&accelerator)){observer?.close();observer=await launch(accelerator);registered=!!accelerator;}if(closed||version!==captureVersion){if(!accelerator){observer.close();observer=null;}return {capturing:false,error:''};}capturing=true;await observer.capture(true);if(closed||version!==captureVersion){capturing=false;await observer?.capture(false);}return {capturing,error:''};}
      catch{capturing=false;return {capturing:false,error:'Aufnahme konnte nicht gestartet werden. Bitte erneut versuchen.'};}
    });
  }
  function close(){if(closed)return;closed=true;capturing=false;captureVersion++;observer?.close();observer=null;registered=false;}
  return {initialize,get:status,set,capture,close};
}
module.exports={GET_CHANNEL,SET_CHANNEL,CAPTURE_CHANNEL,MARK_EVENT,SELECT_EVENT,STATUS_EVENT,validateAccelerator,createLagHotkey};
