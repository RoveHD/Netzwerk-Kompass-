import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createApp } from '../server.js';
import { Monitor } from '../lib/monitor.js';

test('diagnosis and theme assets are served locally with their expected MIME types',async()=>{
  const monitor=new Monitor({});const server=createApp(monitor);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const assets = [['overview-details.js','text/javascript'],['dashboard.css','text/css'],['diagnosis-result.js','text/javascript'],['diagnosis-result.css','text/css'],['graphite.css','text/css'],['ui-help.js','text/javascript'],['live-signal.js','text/javascript'],['live-signal.css','text/css'],['ui-presentation.js','text/javascript']];
    for (const font of ['geist-variable.woff2','geist-mono-variable.woff2']) assets.push(['fonts/'+font,'font/woff2']);
    for(const [asset,type] of assets) {
      const response=await fetch(`${base}/${asset}`);
      assert.equal(response.status,200);assert.ok(response.headers.get('content-type').startsWith(type));
      assert.ok((await response.arrayBuffer()).byteLength>0);
    }
    assert.equal((await fetch(`${base}/fonts/barlow-condensed-regular.ttf`)).status,404);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();}
});

test('startup changes need the local action token and archived diagnoses stay local',async()=>{
  const monitor=new Monitor({});let enabled=true;
  const server=createApp(monitor,{token:'settings-test',startup:{snapshot:()=>({available:true,enabled,registered:enabled}),setEnabled:value=>{assert.equal(typeof value,'boolean');enabled=value;return {available:true,enabled,registered:enabled};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await(await fetch(base+'/api/startup')).json()).enabled,true);
    assert.equal((await fetch(base+'/api/startup',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"enabled":false}'})).status,403);assert.equal(enabled,true);
    const changed=await fetch(base+'/api/startup',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'settings-test'},body:'{"enabled":false}'});assert.equal((await changed.json()).enabled,false);
    assert.equal((await(await fetch(base+'/api/analysis/archive')).json()).total,0);
    assert.equal((await fetch(base+'/api/analysis/archive?id=../settings.json')).status,400);
    assert.equal((await fetch(base+'/api/analysis/archive?offset=-1')).status,400);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();}
});

test('shutdown acknowledges the request and waits for the peer FIN before stopping the process',async()=>{
  const monitor=new Monitor({});
  let shutdownSocket,shutdownResponse,observed;
  let resolveShutdown;const stopped=new Promise(resolve=>{resolveShutdown=resolve;});
  const server=createApp(monitor,{token:'shutdown-test',onShutdown:()=>{
    observed={socketClosed:shutdownSocket.destroyed,responseFinished:shutdownResponse.writableFinished,peerEnded:shutdownSocket.readableEnded};
    server.closeAllConnections();resolveShutdown();
  }});
  server.on('request',(req,res)=>{shutdownSocket=req.socket;shutdownResponse=res;});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const result=await fetch(`http://127.0.0.1:${server.address().port}/api/shutdown`,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'shutdown-test'},body:'{}'});
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),{ok:true});
    await stopped;assert.deepEqual(observed,{socketClosed:true,responseFinished:true,peerEnded:true});
  } catch(error) {
    throw new Error(`Shutdown transport: ${error.cause?.code||error.code||error.message}; responseFinished=${shutdownResponse?.writableFinished}; peerEnded=${shutdownSocket?.readableEnded}`,{cause:error});
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();}
});

test('repeater API adds multiple devices and selects the PC connection separately',async()=>{
  const monitor=new Monitor({});
  const server=createApp(monitor,{token:'repeater-test'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(endpoint,body)=>fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'repeater-test'},body:JSON.stringify(body)});
  try {
    assert.equal((await post('/api/repeater',{host:'192.168.178.2',label:'Oben'})).status,200);
    assert.equal((await post('/api/repeater',{host:'192.168.178.3',label:'Unten'})).status,200);
    assert.equal(monitor.state.targets.filter(target=>target.kind==='repeater').length,2);
    assert.equal((await post('/api/repeater/primary',{host:'192.168.178.3'})).status,200);
    assert.equal(monitor.state.repeaterHost,'192.168.178.3');
    assert.equal((await post('/api/repeater/primary',{host:'192.168.178.99'})).status,400);
    assert.equal(monitor.state.repeaterHost,'192.168.178.3');
    assert.equal((await post('/api/repeater/primary',{host:null})).status,200);
    assert.equal(monitor.state.repeaterHost,null);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();}
});

test('speedtest API rejects non-offered byte sizes before starting a test',async()=>{
  const monitor=new Monitor({});
  const server=createApp(monitor,{token:'speedtest-options-test'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const before=monitor.state.speedTest;
    const response=await fetch(`${base}/api/speedtest`,{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'speedtest-options-test'},body:JSON.stringify({downloadBytes:6_000_000,uploadBytes:8_000_000})});
    assert.equal(response.status,400);assert.match((await response.json()).error,/angebotene Download/);
    assert.equal(monitor.state.speedTest,before);assert.equal(monitor.state.speedTest.running,false);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await monitor.close();}
});

test('local API requires token, origin, JSON and expected host; export and custom targets work',async()=>{
  const m=new Monitor({});
  const server=createApp(m,{token:'test-token'});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(data={},extra={})=>fetch(base+'/api/targets',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'test-token',...extra},body:JSON.stringify(data)});
  try {
    const page=await (await fetch(base)).text();assert.ok(page.includes('test-token'));assert.ok(!page.includes('__API_TOKEN__'));
    m.starting=true;
    assert.equal((await post({host:'must-not-be-added.example'})).status,409);
    assert.equal(m.state.targets.length,0);
    m.starting=false;
    assert.equal((await post({host:'fritz.box'})).status,200);
    assert.equal((await post({host:'fritz.box'},{'X-Api-Token':'wrong'})).status,403);
    assert.equal((await post({host:'fritz.box'},{Origin:'https://evil.example'})).status,403);
    assert.equal((await post({host:'fritz.box'},{'Content-Type':'text/plain'})).status,415);
    assert.equal((await post({host:'http://fritz.box/'})).status,400);
    const rawStatus = await new Promise((resolve,reject)=>{const req=http.get(base+'/api/state',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
    assert.equal(rawStatus,403);
    assert.equal((await fetch(base+'/api/state',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
    assert.equal((await fetch(base+'/../package.json')).status,404);
    const report=await fetch(base+'/api/export');assert.equal(report.status,200);assert.ok(report.headers.get('content-disposition').includes('.json'));
    assert.equal((await report.json()).targets[0].host,'fritz.box');
    assert.equal((await fetch(base+'/api/history?hours=2')).status,400);
    assert.equal((await fetch(base+'/api/history?hours=24')).status,200);
    for(const fields of [{},{username:''}]) {
      const login=await fetch(base+'/api/fritzbox/connect',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'test-token'},body:JSON.stringify({host:'8.8.8.8',password:'test-only-secret',...fields})});
      assert.equal(login.status,400);assert.match((await login.json()).error,/private IPv4-Routeradressen/);
    }
    assert.ok(!(await(await fetch(base+'/api/export')).text()).includes('test-only-secret'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await m.close();}
});

test('reset API enforces local guards, reports busy and filters history and export by the new period',async()=>{
  const m=new Monitor({});m.addTarget('example.com','Server');m.state.targets[0].samples=[{at:new Date().toISOString(),ok:true,ms:500}];m.state.monitoring=false;m.log({type:'event',at:new Date(Date.now()-1000).toISOString(),title:'Old period event'});
  const server=createApp(m,{token:'reset-token'});server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  const post=(headers={})=>fetch(base+'/api/reset',{method:'POST',headers:{'Content-Type':'application/json','X-Api-Token':'reset-token',...headers},body:'{}'});
  try{
    assert.equal((await post({'X-Api-Token':'wrong'})).status,403);assert.equal((await post({Origin:'https://evil.example'})).status,403);assert.equal((await post({'Content-Type':'text/plain'})).status,415);assert.equal(m.state.measurementStartedAt,null);
    m.state.scan.running=true;const busy=await post();assert.equal(busy.status,409);assert.match((await busy.json()).error,/abwarten/);m.state.scan.running=false;
    const response=await post();assert.equal(response.status,200);const reset=await response.json();assert.equal(reset.ok,true);assert.equal(reset.measurementStartedAt,m.state.measurementStartedAt);
    m.log({type:'ping',at:reset.measurementStartedAt,results:[{host:'example.com',ok:true,ms:3}]});const state=await(await fetch(base+'/api/state')).json();assert.equal(state.monitoring,true);assert.equal(state.targets[0].samples.length,0);assert.deepEqual(state.events.map(event=>event.title),['Messung zurückgesetzt']);
    const history=await(await fetch(base+'/api/history?hours=168')).json();assert.equal(history.measurementStartedAt,reset.measurementStartedAt);assert.ok(!history.records.some(record=>record.title==='Old period event'));assert.ok(history.records.some(record=>record.type==='ping'));
    const exported=await(await fetch(base+'/api/export')).json();assert.equal(exported.measurementStartedAt,reset.measurementStartedAt);assert.ok(!exported.history.records.some(record=>record.title==='Old period event'));assert.ok(m.history.snapshot(168).records.some(record=>record.title==='Old period event'));
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await m.close();}
});

test('history API serves cursor deltas and resyncs reset, window changes and invalid cursors', async () => {
  const monitor = new Monitor({});
  const server = createApp(monitor);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const history = async (hours = 1, cursor) => (await fetch(`${base}/api/history?hours=${hours}${cursor === undefined ? '' : '&cursor=' + encodeURIComponent(cursor)}`)).json();
  try {
    const at = new Date(Date.now() - 1000).toISOString();
    monitor.log({ type: 'event', at, title: 'original' });
    const full = await history();
    assert.equal(full.incremental, false);
    assert.equal(full.records.length, 1);
    monitor.log({ type: 'event', at, title: 'same timestamp' });
    monitor.log({ type: 'event', at: new Date(Date.parse(at) - 1000).toISOString(), title: 'late' });
    const delta = await history(1, full.cursor);
    assert.equal(delta.incremental, true);
    assert.deepEqual(delta.records.map(row => row.title), ['late', 'same timestamp']);
    assert.equal(delta.total, 3);
    assert.deepEqual((await history(1, delta.cursor)).records, []);
    assert.equal((await history(6, delta.cursor)).incremental, false);
    assert.equal((await history(1, 'invalid')).incremental, false);
    assert.equal((await history()).records.length, 3);
    await monitor.reset();
    const reset = await history(1, delta.cursor);
    assert.equal(reset.incremental, false);
    assert.equal(reset.measurementStartedAt, monitor.state.measurementStartedAt);
    assert.ok(reset.records.every(row => !['original', 'late', 'same timestamp'].includes(row.title)));
    assert.ok(monitor.history.snapshot().records.some(row => row.title === 'original'));
    const exported = await (await fetch(base + '/api/export')).json();
    assert.equal(exported.history.incremental, false);
    assert.equal(exported.history.measurementStartedAt, reset.measurementStartedAt);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await monitor.close(); }
});
