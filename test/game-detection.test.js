import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameLibrary, epicManifest, GameDetector, initialGameDetection, insideInstallPath, matchGameProcess, parseValveKeyValues, steamManifest, validateGameSettings } from '../lib/game-detection.js';

const root = 'D:\\Games\\Steam';
const manifest = '"AppState" { "appid" "12345" "name" "Fixture Game" "installdir" "Fixture" }';
const library = {games:[steamManifest(manifest,root)],partial:false};
const process = (id=42,extra={}) => ({id,name:'Fixture-Win64-Shipping',path:'D:\\Games\\Steam\\steamapps\\common\\Fixture\\Bin\\Fixture-Win64-Shipping.exe',startedAt:'2026-10-12T10:00:00.1234567Z',...extra});
const snapshot = (...processes) => ({processes,partial:false,truncated:false});

test('Valve parser handles modern/legacy roots, comments, escaped paths, case and hostile keys',()=>{
  const parsed=parseValveKeyValues('// comment\n "libraryfolders" { "0" { "path" "D:\\\\Steam" "apps" {"1" "22"} } "1" "E:\\\\Library" "__proto__" "safe" }');
  assert.equal(parsed.libraryfolders['0'].path,'D:\\Steam'); assert.equal(parsed.libraryfolders['1'],'E:\\Library');
  assert.equal(parsed.libraryfolders.__proto__,'safe'); assert.equal(Object.getPrototypeOf(parsed),null);
  assert.throws(()=>parseValveKeyValues('"root" { "missing" }'));
  assert.throws(()=>parseValveKeyValues('"root" {'));
});

test('Steam and Epic manifest projection validates names, roots and install-directory traversal',()=>{
  assert.deepEqual(library.games[0],{id:'steam:12345',name:'Fixture Game',source:'steam',installPath:'D:\\Games\\Steam\\steamapps\\common\\Fixture'});
  for(const directory of ['..','.','..\\escape','C:\\escape','bad\nname']) assert.equal(steamManifest(manifest.replace('"Fixture"',`"${directory}"`),root),null);
  assert.equal(steamManifest(manifest,'relative'),null);
  const epic=epicManifest(JSON.stringify({DisplayName:'Test Epic',AppName:'opaque-library-id',InstallLocation:'E:\\Games\\Epic Fixture'}));
  assert.equal(epic.name,'Test Epic');assert.match(epic.id,/^epic:[a-f\d]{24}$/);assert.equal(epic.source,'epic');
  assert.equal(epicManifest(JSON.stringify({DisplayName:'Invalid',AppName:'x',InstallLocation:'relative'})),null);
});

test('matching respects path boundaries, case, excludes launchers, anti-cheat, crash handlers and path spoofing',()=>{
  assert.equal(matchGameProcess(process(),library.games).id,'steam:12345');
  assert.equal(matchGameProcess(process(42,{path:process().path.toUpperCase(),name:'FIXTURE-WIN64-SHIPPING.EXE'}),library.games).id,'steam:12345');
  assert.equal(insideInstallPath('D:\\Games\\FixtureTwo\\game.exe','D:\\Games\\Fixture'),false);
  assert.equal(insideInstallPath('D:\\Games\\Fixture\\..\\Other\\game.exe','D:\\Games\\Fixture'),false);
  assert.equal(matchGameProcess(process(42,{path:process().path.replace('Fixture\\Bin','FixtureTwo\\Bin')}),library.games),null);
  assert.equal(matchGameProcess(process(42,{path:process().path.replace('Fixture-Win64-Shipping.exe','other.exe')}),library.games),null);
  for(const name of ['Steam','EpicGamesLauncher','CrashReportClient','UnityCrashHandler64','EasyAntiCheat','GameUpdater','Game-Win64-Shipping_BE']){
    assert.equal(matchGameProcess(process(42,{name,path:library.games[0].installPath+'\\'+name+'.exe'}),library.games),null);
  }
  assert.equal(matchGameProcess(process(42,{path:null}),library.games),null);
});

test('Marvel Rivals works without process-path access and custom mappings take priority',()=>{
  const marvel=process(99,{name:'MARVEL-WIN64-SHIPPING',path:null});
  assert.deepEqual(matchGameProcess(marvel),{id:'known:marvel-rivals',name:'Marvel Rivals',source:'known'});
  const custom=validateGameSettings({enabled:true,customGames:[{name:'My Game',executable:'Marvel-Win64-Shipping.EXE'}]});
  assert.equal(matchGameProcess(marvel,[],custom.customGames).name,'My Game');
  assert.equal(matchGameProcess(marvel,[],custom.customGames).source,'custom');
});

test('Wallpaper Engine desktop processes are excluded without guessing that other Steam apps are tools',()=>{
  const wallpaper={id:'steam:431960',name:'Wallpaper Engine',source:'steam',installPath:'D:\\Steam\\steamapps\\common\\wallpaper_engine'};
  for(const name of ['wallpaper32','wallpaper64','WALLPAPER64.EXE']) {
    assert.equal(matchGameProcess(process(42,{name,path:wallpaper.installPath+'\\'+name.replace(/\.exe$/i,'')+'.exe'}),[wallpaper]),null);
    assert.equal(matchGameProcess(process(42,{name,path:null}),[wallpaper]),null);
  }
  assert.equal(matchGameProcess(process(),library.games).id,'steam:12345');
});

test('custom settings reject paths, wildcards, command syntax, duplicates, helpers and invalid bounds',()=>{
  for(const value of [null,{}, {enabled:1,customGames:[]},{enabled:true,customGames:Array(33).fill({name:'x',executable:'x.exe'})}]) assert.throws(()=>validateGameSettings(value),TypeError);
  for(const executable of ['C:\\game.exe','../game.exe','game*.exe','game?.exe','game.exe;whoami','$(x).exe','game.exe\n','game.exe|x','game.exe`x',' launcher.exe','Steam.exe','GameLauncher.exe']) assert.throws(()=>validateGameSettings({enabled:true,customGames:[{name:'Test',executable}]}),TypeError);
  for(const name of ['','x'.repeat(81),'bad\nname','C:\\Secret'])assert.throws(()=>validateGameSettings({enabled:true,customGames:[{name,executable:'game.exe'}]}),TypeError);
  assert.throws(()=>validateGameSettings({enabled:true,customGames:[{name:'one',executable:'GAME.exe'},{name:'two',executable:'game.exe'}]}),/EXE/);
  assert.deepEqual(validateGameSettings({enabled:false,customGames:[{name:' Test ',executable:'Game Name.exe'}]}),{enabled:false,customGames:[{name:'Test',executable:'Game Name.exe'}]});
});

test('library only reads known manifest directories, caches scans and marks read failures partial',async()=>{
  let time=100,reads=0;const files=new Map([
    [root+'\\steamapps\\libraryfolders.vdf','"libraryfolders" { "0" { "path" "E:\\\\Extra" } }'],
    [root+'\\steamapps\\appmanifest_12345.acf',manifest],
    ['E:\\Extra\\steamapps\\appmanifest_12346.acf',manifest.replace('12345','12346')],
    ['C:\\ProgramData\\Epic\\Manifests\\abc.item',JSON.stringify({DisplayName:'Epic fixture',AppName:'abc',InstallLocation:'E:\\Epic Fixture'})]
  ]);
  const cache=createGameLibrary({now:()=>time,ttlMs:100,read:async file=>{reads++;if(!files.has(file))throw Object.assign(new Error('No file'),{code:'ENOENT'});return files.get(file);},fileStat:async()=>({size:100}),list:async directory=>{
    assert.ok([root+'\\steamapps','E:\\Extra\\steamapps','C:\\ProgramData\\Epic\\Manifests'].includes(directory));
    return [...files.keys()].filter(file=>file.slice(0,file.lastIndexOf('\\'))===directory).map(file=>file.slice(file.lastIndexOf('\\')+1));
  }});
  const options={steamRoots:[root],epicRoots:['C:\\ProgramData\\Epic\\Manifests']};
  const first=await cache.load(options);assert.equal(first.games.length,3);assert.equal(first.partial,false);const count=reads;
  assert.equal(await cache.load(options),first);assert.equal(reads,count);
  time+=101;await cache.load(options);assert.ok(reads>count);
  const failed=createGameLibrary({fileStat:async()=>{throw Object.assign(new Error('C:\\private'),{code:'EACCES'});},list:async()=>{throw Object.assign(new Error('Denied'),{code:'EACCES'});}});
  assert.deepEqual(await failed.load({steamRoots:[root]}),{games:[],partial:true});
});

test('sessions deduplicate processes, retain identity after path loss, recognize restarts and bound recent history',()=>{
  const state=initialGameDetection(),events=[],detector=new GameDetector(state,event=>events.push(event));
  let time=Date.now();const at=()=>new Date(time+=10).toISOString();
  detector.apply(snapshot(process(),process(43)),library,at());assert.equal(state.active.length,1);assert.equal(events.length,1);
  const session=state.active[0].sessionId;assert.deepEqual(detector.processIds(session),[42,43]);
  detector.apply(snapshot(process(43,{path:null})),library,at());assert.equal(state.active[0].sessionId,session);assert.deepEqual(detector.processIds(session),[43]);assert.equal(state.status,'partial');
  detector.apply(snapshot(process(43,{startedAt:'2026-10-12T11:00:00.7654321Z'})),library,at());assert.notEqual(state.active[0].sessionId,session);assert.equal(events[1].action,'ended');assert.equal(events[2].action,'started');
  detector.apply(snapshot(),library,at());assert.equal(state.active.length,0);assert.equal(state.recent[0].reason,'process-exited');
  for(let i=0;i<22;i++){detector.apply(snapshot(process()),library,at());detector.apply(snapshot(),library,at());}
  assert.equal(state.recent.length,20);assert.ok(events.every(event=>event.type==='event'&&event.kind==='game'));
  const encoded=JSON.stringify({state,events});for(const forbidden of ['D:\\Games','startedAt":"2026-10-12T10:00:00.1234567','Fixture-Win64-Shipping','processes','path'])assert.ok(!encoded.includes(forbidden));
});

test('failed and truncated scans cannot claim a process exit; recovery updates freshness',()=>{
  const state=initialGameDetection(),events=[],detector=new GameDetector(state,event=>events.push(event));
  detector.apply(snapshot(process()),library);const session=state.active[0].sessionId,checked=state.checkedAt;
  detector.fail();assert.equal(state.status,'error');assert.equal(state.active.length,1);assert.equal(state.checkedAt,checked);assert.deepEqual(detector.processIds(session),[]);
  detector.apply({...snapshot(),truncated:true},library);assert.equal(state.active.length,1);assert.equal(events.length,1);assert.deepEqual(detector.processIds(session),[]);
  detector.apply(snapshot(process()),library);assert.equal(state.active[0].sessionId,session);assert.deepEqual(detector.processIds(session),[42]);
  detector.stop('disabled');assert.equal(state.active.length,0);assert.equal(events.at(-1).action,'observation-ended');assert.equal(state.recent[0].reason,'disabled');
});

test('lost StartTime and temporarily unreadable libraries retain a session until a verified restart',()=>{
  const state=initialGameDetection(),events=[],detector=new GameDetector(state,event=>events.push(event));
  detector.apply(snapshot(process()),library);const session=state.active[0].sessionId;
  detector.apply(snapshot(process(42,{startedAt:null})),{games:[],partial:true});assert.equal(state.active[0].sessionId,session);assert.equal(events.length,1);assert.deepEqual(detector.processIds(session),[42]);
  detector.apply(snapshot(process()),library);assert.equal(state.active[0].sessionId,session);assert.equal(events.length,1);
  detector.apply(snapshot(process(42,{startedAt:'2026-10-12T12:00:00.1234567Z'})),library);assert.notEqual(state.active[0].sessionId,session);assert.equal(events[1].action,'ended');assert.equal(events[2].action,'started');
});

test('Windows Idle PID zero does not poison snapshots or match a game; invalid negative IDs still fail',()=>{
  const state=initialGameDetection(),events=[],detector=new GameDetector(state,event=>events.push(event));
  detector.apply(snapshot({id:0,name:'Idle',path:null,startedAt:null},process()),library);
  assert.equal(state.status,'ready');assert.equal(state.active.length,1);assert.equal(events.length,1);
  assert.deepEqual(detector.processIds(state.active[0].sessionId),[42]);
  detector.apply(snapshot({id:0,name:'Marvel-Win64-Shipping',path:null,startedAt:null}),library);
  assert.equal(state.active.length,0);assert.equal(events.at(-1).action,'ended');
  assert.throws(()=>detector.apply(snapshot({id:-1,name:'Invalid'}),library),/Ungültige/);
});
