import test from 'node:test';
import assert from 'node:assert/strict';
import { FritzBoxClient, createDigestAuthorization, parseXml, isPrivateRouterIP, normalizeMesh, normalizeDeviceTraffic } from '../lib/fritzbox.js';

const challenge='Digest realm="fritz.box", nonce="test-nonce", algorithm=MD5, qop="auth"';
const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
const response=(action,data={})=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:dslforum-org:service:DeviceInfo:1">${Object.entries(data).map(([key,value])=>`<${key}>${escape(value)}</${key}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`;
const fault=(code=606,description='Access denied')=>`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>${code}</errorCode><errorDescription>${escape(description)}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
const services=['DeviceInfo','WANCommonInterfaceConfig','WANIPConnection','WANDSLInterfaceConfig','Hosts'];
const description=(names=services,control=name=>`/control/${name}`)=>`<?xml version="1.0"?><root xmlns="urn:dslforum-org:device-1-0"><device><serviceList>${names.map(name=>`<service><serviceType>urn:dslforum-org:service:${name}:1</serviceType><serviceId>urn:serviceId:${name}</serviceId><controlURL>${escape(control(name))}</controlURL><eventSubURL>/event/${name}</eventSubURL><SCPDURL>/${name}.xml</SCPDURL></service>`).join('')}</serviceList></device></root>`;
const credentials={host:'fritz.box',username:'router-user',password:'SuperSecret!991'};
function fixture({override,desc=description(),publicDevice=false,basic=false,wrong=false,hostPath='/hostlist.lua?sid=hidden-host-token',meshPath='/mesh.lua?sid=hidden-mesh-token',password=credentials.password,username=credentials.username}={}) {
  const calls=[],lookups=[];
  const requestImpl=async(url,options)=>{
    const call={url:new URL(url),...options};calls.push(call);
    const custom=await override?.(call,calls);if(custom)return custom;
    if(url.pathname==='/tr64desc.xml')return {statusCode:200,headers:{},body:desc};
    if(options.method==='GET'&&/^\/[a-z]+\.xml$/i.test(url.pathname)) {
      const name=url.pathname.slice(1,-4);const actions={DeviceInfo:['GetInfo','GetDeviceLog'],WANCommonInterfaceConfig:['GetCommonLinkProperties','GetTotalBytesReceived','GetTotalBytesSent'],WANIPConnection:['GetStatusInfo'],WANPPPConnection:['GetStatusInfo'],WANDSLInterfaceConfig:['GetInfo','GetStatisticsTotal'],Hosts:['GetHostNumberOfEntries','GetGenericHostEntry','X_AVM-DE_GetHostListPath','X_AVM-DE_GetMeshListPath'],WLANConfiguration:['GetInfo','GetTotalAssociations']}[name]||[];
      return {statusCode:200,headers:{},body:`<scpd><actionList>${actions.map(action=>`<action><name>${action}</name></action>`).join('')}</actionList></scpd>`};
    }
    if(options.method==='POST') {
      if(!options.headers.Authorization&&!publicDevice)return {statusCode:401,headers:{'www-authenticate':basic?'Basic realm="box"':challenge},body:''};
      if(wrong)return {statusCode:401,headers:{'www-authenticate':challenge},body:''};
      const action=options.headers.SOAPAction.split('#')[1].replace('"','');
      const service=url.pathname.split('/').at(-1);
      const data={
        'DeviceInfo/GetInfo':{NewModelName:'FRITZ!Box Cable',NewSoftwareVersion:'8.20',NewUpTime:123,NewDeviceLog:`${username} password=${password} http://fritz.box/log?sid=private-log-token`},
        'WANCommonInterfaceConfig/GetCommonLinkProperties':{NewLayer1DownstreamMaxBitRate:100000000,NewLayer1UpstreamMaxBitRate:20000000},
        'WANCommonInterfaceConfig/GetTotalBytesReceived':{NewTotalBytesReceived:123456},
        'WANCommonInterfaceConfig/GetTotalBytesSent':{NewTotalBytesSent:654321},
        'WANIPConnection/GetStatusInfo':{NewConnectionStatus:'Connected',NewUptime:100},
        'WANDSLInterfaceConfig/GetInfo':{NewStatus:'Up',NewDownstreamCurrRate:100000,NewUpstreamCurrRate:20000,NewDownstreamNoiseMargin:60},
        'WANDSLInterfaceConfig/GetStatisticsTotal':{NewCRCErrors:3,NewFECErrors:4,NewErroredSecs:2},
        'Hosts/X_AVM-DE_GetHostListPath':{'NewX_AVM-DE_HostListPath':hostPath},
        'Hosts/X_AVM-DE_GetMeshListPath':{'NewX_AVM-DE_MeshListPath':meshPath},
        'Hosts/GetHostNumberOfEntries':{NewHostNumberOfEntries:0}
      }[`${service}/${action}`];
      return {statusCode:data?200:500,headers:{},body:data?response(action,data):fault(401)};
    }
    if(url.pathname==='/hostlist.lua')return {statusCode:200,headers:{},body:'<List><Item><Index>0</Index><IPAddress>192.168.1.20</IPAddress><MACAddress>AA:BB:CC:DD:EE:FF</MACAddress><Active>1</Active><HostName>Gaming-PC</HostName><InterfaceType>Ethernet</InterfaceType><URLParameters>sid=must-not-export</URLParameters></Item></List>'};
    if(url.pathname==='/mesh.lua')return {statusCode:200,headers:{},body:JSON.stringify({nodes:[{uid:'node-a',device_friendly_name:'Box',device_model:'7590',mesh_role:'MASTER',ip_addresses:[{version:'V4',value:'192.168.1.1/24'}],node_interfaces:[{node_links:[{uid:'link-1',state:'CONNECTED',node_1_uid:'node-a',node_2_uid:'node-b',type:'WLAN',cur_data_rate_rx:400000,cur_data_rate_tx:300000,availability:100}]}]},{uid:'node-b',device_name:'Repeater',mesh_role:'SLAVE',ip_addresses:[{version:'V4',value:'192.168.1.2/24'}]}],token:'must-not-export'})};
    return {statusCode:404,headers:{},body:''};
  };
  const lookupImpl=async(host,options)=>{lookups.push({host,options});return [{address:'192.168.1.1',family:4}];};
  return {client:new FritzBoxClient({requestImpl,lookupImpl}),calls,lookups,credentials:{...credentials,username,password}};
}
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const scpd=actions=>({statusCode:200,headers:{},body:`<scpd><actionList>${actions.map(name=>`<action><name>${name}</name></action>`).join('')}</actionList></scpd>`});
function automaticFixture({userList='<List><Username last_user="1">internal-admin</Username></List>',anonymous='0',listUnavailable=false,discoveryStatus,override,...options}={}) {
  return fixture({...options,desc:description([...services,'LANConfigSecurity']),override:async(call,calls)=>{
    const custom=await override?.(call,calls);if(custom)return custom;
    if(call.url.pathname==='/control/LANConfigSecurity'){
      if(discoveryStatus)return {statusCode:discoveryStatus,headers:{'www-authenticate':challenge},body:''};
      if(call.headers.SOAPAction.includes('#X_AVM-DE_GetUserList'))return listUnavailable?{statusCode:500,headers:{},body:fault(401)}:{statusCode:200,headers:{},body:response('X_AVM-DE_GetUserList',userList===undefined?{}:{'NewX_AVM-DE_UserList':userList})};
      return {statusCode:200,headers:{},body:response('X_AVM-DE_GetAnonymousLogin',anonymous===undefined?{}:{'NewX_AVM-DE_AnonymousLoginEnabled':anonymous})};
    }
    return null;
  }});
}
const autoCredentials=(f,username='')=>({...f.credentials,username});

test('Digest matches RFC 2617 vectors with auth and without qop',()=>{
  const params={username:'Mufasa',password:'Circle Of Life',method:'GET',uri:'/dir/index.html',cnonce:'0a4f113b'};
  const prefix='Digest realm="testrealm@host.com", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093"';
  assert.match(createDigestAuthorization(prefix+', qop="auth,auth-int"',params),/response="6629fae49393a05397450978507c4ef1"/);
  assert.match(createDigestAuthorization(prefix,params),/response="670fd8c2df070c60b045671b8b24ff02"/);
  assert.throws(()=>createDigestAuthorization('Basic realm="box"',params),{code:'FRITZ_AUTH_UNSUPPORTED'});
  assert.throws(()=>createDigestAuthorization(prefix+', qop="auth-int"',params),{code:'FRITZ_AUTH_UNSUPPORTED'});
  assert.match(createDigestAuthorization(prefix+', algorithm=SHA-256, qop="auth"',params),/response="[a-f0-9]{64}"/);
});

test('XML namespaces, entities and CDATA work; malformed or expanding XML fails',()=>{
  const xml=parseXml('<x:root xmlns:x="urn:test"><x:value>A&amp;B &#x1f600;</x:value><![CDATA[<plain>]]></x:root>');
  assert.equal(xml.name,'root');assert.equal(xml.children[0].text,'A&B 😀');assert.equal(xml.text,'<plain>');
  for(const input of ['<!DOCTYPE r [<!ENTITY e SYSTEM "file:///secret">]><r>&e;</r>','<r>&unknown;</r>','<r>&broken</r>','<r x="&broken"/>','<r><a></r>','<r/><r/>','<r>'+('x'.repeat(1024*1024))+'</r>'])assert.throws(()=>parseXml(input),{code:'FRITZ_XML'});
});

test('Authenticated realistic services are pinned and normalized without tokens or credentials',async()=>{
  const f=fixture();const snapshot=await f.client.connect(f.credentials);
  assert.equal(f.client.connected,true);assert.equal(snapshot.device.model,'FRITZ!Box Cable');assert.equal(snapshot.wan.downstreamMbps,100);assert.equal(snapshot.wan.upstreamMbps,20);assert.equal(snapshot.wan.status,'Connected');
  assert.equal(snapshot.dsl.crcErrors,3);assert.equal(snapshot.hosts[0].name,'Gaming-PC');assert.equal(snapshot.hosts[0].active,true);assert.equal(snapshot.mesh.links[0].rateMbps,400);assert.equal(snapshot.mesh.links[0].transmitRateMbps,300);assert.equal(snapshot.mesh.links[0].signalPercent,null);
  assert.equal(f.lookups.length,1);assert.ok(f.calls.every(call=>call.url.hostname==='192.168.1.1'));assert.equal(JSON.stringify(f.client),'{}');
  const serialized=JSON.stringify(snapshot);for(const secret of [credentials.username,credentials.password,'hidden-host-token','hidden-mesh-token','private-log-token','must-not-export','http://'])assert.ok(!serialized.includes(secret),secret);
  assert.ok(f.calls.some(call=>call.headers.Authorization?.startsWith('Digest ')));assert.ok(f.calls.filter(call=>call.method==='POST').every(call=>!/#(?:Set|Add|Delete)/.test(call.headers.SOAPAction)));
  await f.client.poll();assert.equal(f.lookups.length,1);f.client.disconnect();assert.equal(f.client.connected,false);
});

test('Short password does not corrupt ordinary names and still scrubs echoed credentials',async()=>{
  const f=fixture({password:'a',username:'u'});const snapshot=await f.client.connect(f.credentials);
  assert.equal(snapshot.device.model,'FRITZ!Box Cable');assert.equal(snapshot.host,'fritz.box');assert.ok(!snapshot.log.includes('password=a'));assert.match(snapshot.log,/geschützt/);f.client.disconnect();
});

test('Quoted SID and token assignments are removed from free text logs',async()=>{
  const f=fixture({override:call=>call.method==='POST'&&call.headers.Authorization&&call.headers.SOAPAction.includes('DeviceInfo:1#GetInfo')?{statusCode:200,headers:{},body:response('GetInfo',{NewModelName:'FRITZ!Box',NewDeviceLog:'sid="quote-secret" token=\'token-secret\''})}:null});
  const result=await f.client.connect(f.credentials);assert.ok(!result.log.includes('quote-secret'));assert.ok(!result.log.includes('token-secret'));f.client.disconnect();
});

test('Host validation blocks public, metadata, URL, port and DNS rebinding targets',async()=>{
  assert.equal(isPrivateRouterIP('172.31.1.1'),true);assert.equal(isPrivateRouterIP('172.32.1.1'),false);
  for(const host of ['8.8.8.8','169.254.169.254','127.0.0.1','192.168.1.1:49000','http://fritz.box','user:pass@fritz.box','0xc0a80101','192.168.001.1']){
    const calls=[];const client=new FritzBoxClient({requestImpl:async()=>{calls.push(1);},lookupImpl:async()=>[{address:'8.8.8.8'}]});
    await assert.rejects(client.connect({...credentials,host}),{code:'FRITZ_HOST'});assert.equal(calls.length,0);
  }
  const client=new FritzBoxClient({lookupImpl:async()=>[{address:'192.168.1.1'},{address:'8.8.8.8'}],requestImpl:()=>assert.fail('Must not connect')});
  await assert.rejects(client.connect(credentials),{code:'FRITZ_HOST'});
});

test('Foreign or unsafe control URLs are rejected before sending credentials',async()=>{
  for(const path of ['http://8.8.8.8/control','http://192.168.1.2/control','http://user:pass@192.168.1.1/control','https://192.168.1.1/control','http://192.168.1.1:8080/control','//other.box/control']){
    const f=fixture({desc:description(['DeviceInfo'],()=>path)});await assert.rejects(f.client.connect(f.credentials),{code:'FRITZ_URL'});assert.equal(f.calls.length,1);
  }
});

test('Foreign list paths and redirects never forward authentication',async()=>{
  const f=fixture({hostPath:'http://8.8.8.8/list?sid=secret',meshPath:'http://other.box/mesh'});const result=await f.client.connect(f.credentials);
  assert.equal(result.hosts.length,0);assert.equal(result.mesh.nodes.length,0);assert.ok(result.warnings.some(item=>item.startsWith('Geräteliste:')));assert.ok(f.calls.every(call=>call.url.hostname==='192.168.1.1'));f.client.disconnect();
  const redirected=fixture({override:call=>call.url.pathname==='/tr64desc.xml'?{statusCode:302,headers:{location:'http://8.8.8.8/'},body:''}:null});
  await assert.rejects(redirected.client.connect(redirected.credentials),{code:'FRITZ_REDIRECT'});assert.equal(redirected.calls.length,1);
});

test('Wrong password and Basic cannot authenticate; public GetInfo cannot prove login',async()=>{
  for(const [options,code] of [[{wrong:true},'FRITZ_AUTH'],[{basic:true},'FRITZ_AUTH_UNSUPPORTED'],[{publicDevice:true},'FRITZ_AUTH_UNCONFIRMED']]){
    const f=fixture(options);await assert.rejects(f.client.connect(f.credentials),error=>{assert.equal(error.code,code);assert.ok(!error.message.includes(credentials.password));return true;});assert.equal(f.client.connected,false);assert.ok(f.calls.filter(call=>call.method==='POST').length<=2);
  }
});

test('Missing services and SOAP access faults use explicit sanitized errors',async()=>{
  const missing=fixture({desc:description(['Hosts'])});await assert.rejects(missing.client.connect(missing.credentials),{code:'FRITZ_UNSUPPORTED'});
  const denied=fixture({override:call=>call.method==='POST'&&call.headers.Authorization?{statusCode:500,headers:{},body:fault(606,credentials.password)}:null});
  await assert.rejects(denied.client.connect(denied.credentials),error=>{assert.equal(error.code,'FRITZ_ACCESS');assert.ok(!error.message.includes(credentials.password));return true;});
  const minimal=fixture({desc:description(['DeviceInfo'])});const result=await minimal.client.connect(minimal.credentials);assert.equal(result.warnings.length,0);assert.ok(result.capabilities.some(item=>item.service==='WANDSLInterfaceConfig'&&item.available===false));assert.equal(result.wan.status,null);minimal.client.disconnect();
});

test('Bounded responses and arbitrary transport errors cannot leak credentials',async()=>{
  const oversized=fixture({override:()=>({statusCode:200,headers:{},body:'x'.repeat(1024*1024+1)})});await assert.rejects(oversized.client.connect(oversized.credentials),{code:'FRITZ_SIZE'});
  const client=new FritzBoxClient({requestImpl:()=>{throw Object.assign(new Error(credentials.password),{code:'FRITZ_FAKE'});}});
  await assert.rejects(client.connect({...credentials,host:'192.168.1.1'}),error=>{assert.equal(error.code,'FRITZ_NETWORK');assert.ok(!error.message.includes(credentials.password));return true;});
});

test('Disconnect cancels even a transport ignoring abort and late replies cannot reconnect',async()=>{
  const gate=deferred(),entered=deferred();const f=fixture({override:call=>{if(call.url.pathname==='/tr64desc.xml'){entered.resolve();return gate.promise;}}});
  const pending=f.client.connect(f.credentials);await entered.promise;f.client.disconnect();await assert.rejects(pending,{code:'FRITZ_CANCELLED'});assert.equal(f.client.connected,false);gate.resolve({statusCode:200,headers:{},body:description()});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.client.connected,false);
});

test('Unresponsive transport is bounded to the request deadline without retries',async()=>{
  let requests=0,requestSignal;
  const client=new FritzBoxClient({requestImpl:(_url,{signal})=>{requests++;requestSignal=signal;return new Promise(()=>{});}});
  await assert.rejects(client.connect({...credentials,host:'192.168.1.1'}),{code:'FRITZ_TIMEOUT'});assert.equal(requests,1);assert.equal(requestSignal.aborted,true);assert.equal(client.connected,false);
});

test('Reconnect isolates old operations; overlapping polls are rejected and abort cleanly',async()=>{
  const gate=deferred(),entered=deferred();let block=false;
  const f=fixture({override:call=>{if(block&&call.method==='POST'&&call.headers.SOAPAction.includes('DeviceInfo:1#GetInfo')){entered.resolve();return gate.promise;}}});
  await f.client.connect(f.credentials);block=true;const pending=f.client.poll();await entered.promise;await assert.rejects(f.client.poll(),{code:'FRITZ_BUSY'});f.client.disconnect();await assert.rejects(pending,{code:'FRITZ_CANCELLED'});block=false;await f.client.connect(f.credentials);gate.resolve({statusCode:200,headers:{},body:response('GetInfo',{})});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.client.connected,true);f.client.disconnect();
});

test('Generic host fallback is read only and limited to 128 entries',async()=>{
  let entries=0;
  const f=fixture({hostPath:'',meshPath:'',override:call=>{
    if(call.method!=='POST'||!call.headers.Authorization)return null;
    if(call.headers.SOAPAction.includes('#GetHostNumberOfEntries'))return {statusCode:200,headers:{},body:response('GetHostNumberOfEntries',{NewHostNumberOfEntries:200})};
    if(call.headers.SOAPAction.includes('#GetGenericHostEntry')){entries++;const index=Number(call.body.match(/<NewIndex>(\d+)<\/NewIndex>/)[1]);return {statusCode:200,headers:{},body:response('GetGenericHostEntry',{NewIPAddress:`192.168.1.${index+1}`,NewHostName:`PC ${index}`,NewActive:0,NewInterfaceType:'Ethernet'})};}
    return null;
  }});
  const result=await f.client.connect(f.credentials);assert.equal(entries,128);assert.equal(result.hosts.length,128);assert.equal(result.hosts[127].active,false);assert.ok(result.warnings.includes('Geräteliste wurde auf 128 Einträge begrenzt.'));f.client.disconnect();
});

test('Password-only modern login uses the single public internal user without leaking it',async()=>{
  for(const username of ['',undefined,'   ']){
    const f=automaticFixture({override:call=>call.method==='POST'&&call.headers.Authorization&&call.headers.SOAPAction.includes('DeviceInfo:1#GetInfo')?{statusCode:200,headers:{},body:response('GetInfo',{NewModelName:'FRITZ!Box 6690 Cable',NewDeviceLog:'internal-admin logged in'})}:null});
    const input=autoCredentials(f,username);if(username===undefined)delete input.username;
    const result=await f.client.connect(input);assert.equal(result.device.model,'FRITZ!Box 6690 Cable');assert.equal(f.client.connected,true);
    const discovery=f.calls.filter(call=>call.url.pathname==='/control/LANConfigSecurity');assert.equal(discovery.length,1);assert.ok(discovery.every(call=>!call.headers.Authorization&&!call.body.includes(f.credentials.password)));
    assert.ok(f.calls.some(call=>call.headers.Authorization?.includes('username="internal-admin"')));assert.ok(!JSON.stringify(result).includes('internal-admin'));assert.ok(!JSON.stringify(result).includes('last_user'));assert.ok(!JSON.stringify(result).includes(f.credentials.password));
    await f.client.poll();assert.equal(f.calls.filter(call=>call.url.pathname==='/control/LANConfigSecurity').length,1);f.client.disconnect();
  }
});

test('Explicit usernames bypass automatic discovery entirely',async()=>{
  const f=automaticFixture({discoveryStatus:401});await f.client.connect(f.credentials);
  assert.equal(f.calls.filter(call=>call.url.pathname==='/control/LANConfigSecurity').length,0);assert.ok(f.calls.some(call=>call.headers.Authorization?.includes('username="router-user"')));f.client.disconnect();
});

test('Legacy password-only login requires explicit AnonymousLogin true',async()=>{
  for(const options of [{userList:'<List/>',anonymous:'1'},{listUnavailable:true,anonymous:'true'}]){
    const f=automaticFixture(options);await f.client.connect(autoCredentials(f));assert.equal(f.client.connected,true);
    const discovery=f.calls.filter(call=>call.url.pathname==='/control/LANConfigSecurity');assert.equal(discovery.length,2);assert.ok(discovery.every(call=>!call.headers.Authorization));assert.ok(f.calls.some(call=>call.headers.Authorization?.includes('username="dslf-config"')));f.client.disconnect();
  }
});

test('Multiple users cannot be selected by last_user or tried even when anonymous mode is enabled',async()=>{
  const f=automaticFixture({userList:'<List><Username last_user="1">alice-private</Username><Username last_user="0">bob-private</Username></List>',anonymous:'1'});
  await assert.rejects(f.client.connect(autoCredentials(f)),error=>{assert.equal(error.code,'FRITZ_USER_REQUIRED');assert.match(error.message,/mehrere Benutzer/);assert.match(error.message,/optionalen Namensfeld/);assert.ok(!error.message.includes('alice-private'));assert.ok(!error.message.includes('bob-private'));return true;});
  assert.equal(f.client.connected,false);assert.equal(f.calls.filter(call=>call.headers.Authorization).length,0);assert.equal(f.calls.filter(call=>call.url.pathname==='/control/LANConfigSecurity').length,1);
});

test('Absent discovery service, empty list and disabled or missing legacy state explain the required name',async()=>{
  const missing=fixture();await assert.rejects(missing.client.connect(autoCredentials(missing)),{code:'FRITZ_USER_REQUIRED'});assert.equal(missing.calls.length,1);
  for(const options of [{userList:'<List/>',anonymous:'0'},{listUnavailable:true,anonymous:'false'},{listUnavailable:true,anonymous:'unknown'},{listUnavailable:true,override:call=>call.url.pathname==='/control/LANConfigSecurity'&&call.headers.SOAPAction.includes('GetAnonymousLogin')?{statusCode:500,headers:{},body:fault(401)}:null}]){
    const f=automaticFixture(options);await assert.rejects(f.client.connect(autoCredentials(f)),error=>{assert.equal(error.code,'FRITZ_USER_REQUIRED');assert.match(error.message,/Benutzernamen/);return true;});assert.equal(f.client.connected,false);assert.equal(f.calls.filter(call=>call.headers.Authorization).length,0);
  }
  const absentFields=automaticFixture({override:call=>call.url.pathname==='/control/LANConfigSecurity'?{statusCode:200,headers:{},body:response(call.headers.SOAPAction.includes('GetUserList')?'X_AVM-DE_GetUserList':'X_AVM-DE_GetAnonymousLogin',{})}:null});
  await assert.rejects(absentFields.client.connect(autoCredentials(absentFields)),{code:'FRITZ_USER_REQUIRED'});assert.equal(absentFields.calls.filter(call=>call.headers.Authorization).length,0);
});

test('Discovery HTTP challenges never receive credentials or trigger authentication retries',async()=>{
  const f=automaticFixture({discoveryStatus:401});await assert.rejects(f.client.connect(autoCredentials(f)),{code:'FRITZ_USER_REQUIRED'});
  assert.equal(f.calls.length,3);assert.ok(f.calls.every(call=>!call.headers.Authorization));assert.equal(f.client.connected,false);
  const desc=automaticFixture({override:call=>call.url.pathname==='/tr64desc.xml'?{statusCode:401,headers:{'www-authenticate':challenge},body:''}:null});
  await assert.rejects(desc.client.connect(autoCredentials(desc)),{code:'FRITZ_USER_REQUIRED'});assert.equal(desc.calls.length,1);assert.ok(!desc.calls[0].headers.Authorization);
});

test('Incorrect password after user discovery stops without another user or legacy fallback',async()=>{
  const f=automaticFixture({wrong:true,anonymous:'1'});await assert.rejects(f.client.connect(autoCredentials(f)),{code:'FRITZ_AUTH'});
  assert.equal(f.calls.filter(call=>call.url.pathname==='/control/LANConfigSecurity').length,1);assert.equal(f.calls.filter(call=>call.url.pathname==='/control/DeviceInfo').length,2);
  const authenticated=f.calls.filter(call=>call.headers.Authorization);assert.equal(authenticated.length,1);assert.match(authenticated[0].headers.Authorization,/username="internal-admin"/);assert.equal(f.client.connected,false);
});

test('Unsafe and malformed public user lists are bounded and never become login attempts',async()=>{
  for(const userList of ['<!DOCTYPE List [<!ENTITY e SYSTEM "file:///secret">]><List><Username>&e;</Username></List>','<List><Username>broken</List>','<List><Username><nested>admin</nested></Username></List>','<List><Username>bad:name</Username></List>','<List>'+Array.from({length:129},()=>'<Username>admin</Username>').join('')+'</List>']){
    const f=automaticFixture({userList,anonymous:'1'});await assert.rejects(f.client.connect(autoCredentials(f)),error=>['FRITZ_XML','FRITZ_USER_REQUIRED'].includes(error.code));assert.equal(f.calls.filter(call=>call.headers.Authorization).length,0);assert.equal(f.client.connected,false);
  }
  const oversized=automaticFixture({override:call=>call.url.pathname==='/control/LANConfigSecurity'?{statusCode:200,headers:{},body:'x'.repeat(1024*1024+1)}:null});
  await assert.rejects(oversized.client.connect(autoCredentials(oversized)),{code:'FRITZ_SIZE'});assert.equal(oversized.calls.filter(call=>call.headers.Authorization).length,0);
});

test('Disconnect during public discovery aborts and late user lists cannot authenticate',async()=>{
  const gate=deferred(),entered=deferred();const f=automaticFixture({override:call=>{if(call.url.pathname==='/control/LANConfigSecurity'){entered.resolve();return gate.promise;}}});
  const pending=f.client.connect(autoCredentials(f));await entered.promise;f.client.disconnect();await assert.rejects(pending,{code:'FRITZ_CANCELLED'});
  gate.resolve({statusCode:200,headers:{},body:response('X_AVM-DE_GetUserList',{'NewX_AVM-DE_UserList':'<List><Username>internal-admin</Username></List>'})});await new Promise(resolve=>setImmediate(resolve));assert.equal(f.client.connected,false);assert.equal(f.calls.filter(call=>call.headers.Authorization).length,0);
});

test('Cable services skip absent DSL and unused PPP; capabilities are cached per session',async()=>{
  const f=fixture({desc:description(['DeviceInfo','WANCommonInterfaceConfig','WANIPConnection','WANPPPConnection','Hosts'])});
  const snapshot=await f.client.connect(f.credentials);assert.equal(snapshot.dsl,null);assert.equal(snapshot.wan.status,'Connected');
  assert.ok(snapshot.capabilities.filter(item=>item.service==='WANDSLInterfaceConfig').every(item=>!item.available&&item.reason.includes('nicht')));
  assert.ok(!snapshot.warnings.some(item=>/DSL|WANPPP/.test(item)));assert.ok(!f.calls.some(item=>/WANDSL|control\/WANPPP/.test(item.url.pathname)));
  const descriptions=f.calls.filter(item=>item.method==='GET'&&item.url.pathname.endsWith('.xml')).length;
  await f.client.poll();assert.equal(f.calls.filter(item=>item.method==='GET'&&item.url.pathname.endsWith('.xml')).length,descriptions);f.client.disconnect();
});

test('SCPD advertised actions restrict reads and never allow secrets or router writes',async()=>{
  const f=fixture({desc:description(['DeviceInfo','Hosts','WLANConfiguration']),override:call=>{
    if(call.url.pathname==='/WLANConfiguration.xml')return {statusCode:200,headers:{},body:'<scpd><actionList><action><name>GetInfo</name></action><action><name>GetTotalAssociations</name></action><action><name>GetSecurityKeys</name></action><action><name>SetEnable</name></action></actionList></scpd>'};
    if(call.url.pathname==='/Hosts.xml')return {statusCode:200,headers:{},body:'<scpd><actionList/></scpd>'};
    if(call.url.pathname==='/control/WLANConfiguration')return {statusCode:200,headers:{},body:call.headers.SOAPAction.includes('#GetInfo')?response('GetInfo',{NewEnable:1,NewStatus:'Up',NewSSID:'SIMULIERT WLAN',NewChannel:36,NewStandard:'ax','NewX_AVM-DE_FrequencyBand':'5GHz',NewMaxBitRate:'54',NewKeyPassphrase:'must-never-export'}):response('GetTotalAssociations',{NewTotalAssociations:3})};
    return null;
  }});
  const snapshot=await f.client.connect(f.credentials);assert.equal(snapshot.wlan[0].ssid,'SIMULIERT WLAN');assert.equal(snapshot.wlan[0].channel,36);assert.equal(snapshot.wlan[0].associatedDevices,3);assert.equal(snapshot.wlan[0].enabled,true);
  assert.ok(!JSON.stringify(snapshot).includes('must-never-export'));assert.ok(!Object.hasOwn(snapshot.wlan[0],'rateMbps'));
  assert.ok(!f.calls.some(item=>item.url.pathname==='/control/Hosts'));assert.ok(f.calls.filter(item=>item.method==='POST').every(item=>!/#(?:Set|GetSecurityKeys|GetConfigFile)/.test(item.headers.SOAPAction)));f.client.disconnect();
});

test('SOAP invalid action is neutral and cached; permission failures stay explicit',async()=>{
  for(const code of [401,606]) {
    const f=fixture({override:call=>call.url.pathname==='/control/WANDSLInterfaceConfig'?{statusCode:500,headers:{},body:fault(code)}:null});
    const snapshot=await f.client.connect(f.credentials);assert.equal(snapshot.dsl,null);assert.equal(f.client.connected,true);
    assert.ok(snapshot.capabilities.filter(item=>item.service==='WANDSLInterfaceConfig').every(item=>!item.available&&item.reason));
    assert.equal(snapshot.warnings.some(item=>/WANDSLInterfaceConfig/.test(item)),code===606);
    const count=f.calls.filter(item=>item.url.pathname==='/control/WANDSLInterfaceConfig').length;await f.client.poll();assert.equal(f.calls.filter(item=>item.url.pathname==='/control/WANDSLInterfaceConfig').length,count);f.client.disconnect();
  }
});

test('Unsafe or expanding capability XML cannot loosen private host pinning',async()=>{
  const foreign=fixture({desc:description(['DeviceInfo']).replace('/DeviceInfo.xml','http://192.168.1.2/capabilities.xml')});await assert.rejects(foreign.client.connect(foreign.credentials),{code:'FRITZ_URL'});assert.equal(foreign.calls.length,1);
  const f=fixture({override:call=>call.url.pathname==='/Hosts.xml'?{statusCode:200,headers:{},body:'<!DOCTYPE scpd [<!ENTITY e SYSTEM "file:///secret">]><scpd>&e;</scpd>'}:null});
  const snapshot=await f.client.connect(f.credentials);assert.ok(snapshot.capabilities.filter(item=>item.service==='Hosts').every(item=>!item.available));assert.ok(!f.calls.some(item=>item.url.pathname==='/control/Hosts'));assert.ok(f.calls.every(item=>item.url.hostname==='192.168.1.1'));f.client.disconnect();
});

test('Mesh retains distinct parallel links, disconnected nodes and reported dangling endpoints',()=>{
  const link=(uid,from,to,state='CONNECTED')=>({uid,node_1_uid:from,node_2_uid:to,state,type:'WLAN',cur_data_rate_rx:100000});
  const raw={nodes:[null,{uid:'box',node_interfaces:[{node_links:[link('one','box','r1'),link('two','box','r1'),link('three','r1','r2'),link('off','r2','idle','DISCONNECTED'),link('dangling','r2','missing')]}]},{uid:'r1',node_interfaces:[null,{node_links:[link('one','box','r1')]}]},{uid:'r2'},{uid:'idle'},{uid:'idle'}]};
  const result=normalizeMesh(raw);assert.equal(result.nodes.length,4);assert.equal(result.links.length,5);assert.equal(result.links.find(item=>item.id==='off').receiveRateMbps,null);assert.equal(result.links.find(item=>item.id==='dangling').to,'missing');
});

test('Official Mesh WAN bytes are normalized independently from local link rates',()=>{
  const mesh=normalizeMesh({schema_version:'8.7',nodes:[{uid:'pc',device_mac_address:'aa:bb:cc:dd:ee:02',mesh_role:'slave',device_name:'PC',metrics:{wan_counters:{last_update:1700000000000,bytes:{rx:123456,tx:4567}},secret:'never-export'},node_interfaces:[{node_links:[{uid:'wifi',node_1_uid:'box',node_2_uid:'pc',state:'CONNECTED',type:'WLAN',cur_data_rate_rx:866000,cur_data_rate_tx:720000}]}]}]});
  assert.equal(mesh.schemaVersion,'8.7');assert.equal(mesh.nodes[0].role,'SLAVE');assert.equal(mesh.nodes[0].mac,'AA:BB:CC:DD:EE:02');
  assert.deepEqual(mesh.nodes[0].wanCounters,{available:true,reason:null,totalBytesReceived:123456,totalBytesSent:4567,lastUpdateMs:1700000000000});assert.equal(mesh.links[0].receiveRateMbps,866);assert.ok(!JSON.stringify(mesh).includes('never-export'));
  const rows=normalizeDeviceTraffic(mesh,[{mac:'AA:BB:CC:DD:EE:02',name:'Host PC',ip:'192.168.1.20'}]);assert.equal(rows.length,1);assert.equal(rows[0].id,'mac:AA:BB:CC:DD:EE:02');assert.equal(rows[0].available,true);assert.equal(rows[0].totalBytesReceived,123456);assert.equal(rows[0].ip,'192.168.1.20');assert.equal(rows[0].source,'mesh-wan-counters');
});

test('Missing, unsafe and partial mesh byte metrics remain unknown, never inferred from PHY rates',()=>{
  const counters={last_update:1700000000000,bytes:{rx:0,tx:0}};
  for(const wan_counters of [undefined,null,{...counters,bytes:{rx:-1,tx:2}},{...counters,bytes:{rx:'123',tx:2}},{...counters,bytes:{rx:1.5,tx:2}},{...counters,bytes:{rx:Number.MAX_SAFE_INTEGER+1,tx:2}},{...counters,bytes:{rx:1}},{...counters,last_update:0},{...counters,last_update:'1700000000000'},{...counters,last_update:8640000000000001}]){
    const mesh=normalizeMesh({nodes:[{uid:'pc',device_mac_address:'02:00:00:00:00:01',metrics:{wan_counters},cur_data_rate_rx:999999}]});
    assert.equal(mesh.nodes[0].wanCounters.available,false);const row=normalizeDeviceTraffic(mesh)[0];assert.equal(row.available,false);assert.equal(row.totalBytesReceived,null);assert.ok(row.reason);
  }
  const zero=normalizeDeviceTraffic(normalizeMesh({nodes:[{uid:'pc',device_mac_address:'02:00:00:00:00:01',metrics:{wan_counters:counters}}]}))[0];assert.equal(zero.available,true);assert.equal(zero.totalBytesReceived,0);
});

test('Mesh UIDs do not define traffic identity and ambiguous MACs or host-only devices stay explicit',()=>{
  const node=(uid,device_mac_address='02:00:00:00:00:01')=>({uid,device_mac_address,metrics:{wan_counters:{last_update:1700000000000,bytes:{rx:100,tx:20}}}});
  const first=normalizeDeviceTraffic(normalizeMesh({nodes:[node('old')]}))[0],second=normalizeDeviceTraffic(normalizeMesh({nodes:[node('new')]}))[0];assert.equal(first.id,second.id);assert.notEqual(first.nodeId,second.nodeId);
  const duplicates=normalizeDeviceTraffic(normalizeMesh({nodes:[node('a'),node('b')]}));assert.equal(duplicates.length,1);assert.equal(duplicates[0].available,false);assert.equal(duplicates[0].totalBytesReceived,null);assert.match(duplicates[0].reason,/Mehrere/);
  for(const address of [undefined,'not-a-mac','00:00:00:00:00:00','FF:FF:FF:FF:FF:FF']){const row=normalizeDeviceTraffic(normalizeMesh({nodes:[{...node('x'),device_mac_address:address}]}))[0];assert.equal(row.id,null);assert.equal(row.available,false);}
  const hosts=normalizeDeviceTraffic({nodes:[]},[{name:'NAS',ip:'192.168.1.30',mac:'02:00:00:00:00:30'}]);assert.equal(hosts[0].id,'mac:02:00:00:00:00:30');assert.equal(hosts[0].available,false);assert.ok(hosts[0].reason);
});

test('Authenticated Mesh traffic snapshot exports only reported bytes without extra queries or secrets',async()=>{
  const f=fixture({override:call=>call.url.pathname==='/mesh.lua'?{statusCode:200,headers:{},body:JSON.stringify({schema_version:'8.7',nodes:[{uid:'pc',device_mac_address:'AA:BB:CC:DD:EE:FF',device_name:'Gaming-PC',metrics:{wan_counters:{last_update:1700000000000,bytes:{rx:1250000,tx:250000}},password:credentials.password},node_interfaces:[]}],token:'must-not-export'})}:null});
  const snapshot=await f.client.connect(f.credentials);assert.equal(snapshot.deviceTraffic.length,1);assert.equal(snapshot.deviceTraffic[0].available,true);assert.equal(snapshot.deviceTraffic[0].totalBytesReceived,1250000);assert.equal(snapshot.deviceTrafficCapability.available,true);
  assert.ok(!JSON.stringify(snapshot).includes('must-not-export'));assert.ok(!JSON.stringify(snapshot).includes(credentials.password));assert.ok(f.calls.filter(call=>call.method==='POST').every(call=>!/#(?:Set|GetSecurityKeys|GetConfigFile)/.test(call.headers.SOAPAction)));f.client.disconnect();
  const unsupported=fixture();const unknown=await unsupported.client.connect(unsupported.credentials);assert.equal(unknown.deviceTrafficCapability.available,false);assert.ok(unknown.deviceTraffic.every(item=>item.totalBytesReceived===null));unsupported.client.disconnect();
});

test('Read diagnostics preserve two LAN instances, DHCP, host metadata and WAN detail without secrets',async()=>{
  let ethernetIndex=0,instanceIndex=0;
  const desc=description(['DeviceInfo','WANIPConnection','Hosts','WLANConfiguration','LANHostConfigManagement','LANEthernetInterfaceConfig','LANEthernetInterfaceConfig'],name=>name==='LANEthernetInterfaceConfig'?`/control/ethernet${++ethernetIndex}`:`/control/${name}`).replace(/urn:serviceId:LANEthernetInterfaceConfig<\/serviceId>/g,()=>`urn:serviceId:LANEthernetInterfaceConfig${++instanceIndex}</serviceId>`);
  const f=fixture({desc,override:call=>{
    if(call.method==='GET'&&call.url.pathname==='/WANIPConnection.xml')return scpd(['GetStatusInfo','GetInfo','GetPortMappingNumberOfEntries','AddPortMapping','GetConfigFile']);
    if(call.method==='GET'&&call.url.pathname==='/LANEthernetInterfaceConfig.xml')return scpd(['GetInfo','GetStatistics','SetEnable']);
    if(call.method==='GET'&&call.url.pathname==='/LANHostConfigManagement.xml')return scpd(['GetInfo','SetDHCPServerEnable']);
    if(call.url.pathname==='/hostlist.lua')return {statusCode:200,headers:{},body:'<List><Item><IPAddress>192.168.1.20</IPAddress><MACAddress>AA:BB:CC:DD:EE:FF</MACAddress><HostName>Testgerät</HostName><Active>1</Active><InterfaceType>Ethernet</InterfaceType><X_AVM-DE_Guest>1</X_AVM-DE_Guest><X_AVM-DE_WANAccess>denied</X_AVM-DE_WANAccess><X_AVM-DE_Priority>0</X_AVM-DE_Priority><X_AVM-DE_FilterProfileID>filtprof1</X_AVM-DE_FilterProfileID><X_AVM-DE_Model>Repeater</X_AVM-DE_Model><X_AVM-DE_Speed>1000</X_AVM-DE_Speed><X_AVM-DE_Port>2</X_AVM-DE_Port><X_AVM-DE_VPN>0</X_AVM-DE_VPN><X_AVM-DE_UpdateAvailable>1</X_AVM-DE_UpdateAvailable><AddressSource>DHCP</AddressSource><LeaseTimeRemaining>120</LeaseTimeRemaining><X_AVM-DE_URLParameters>token=host-secret</X_AVM-DE_URLParameters></Item></List>'};
    if(call.method!=='POST'||!call.headers.Authorization)return null;
    const action=call.headers.SOAPAction.split('#')[1].replace('"','');
    let data;
    if(call.url.pathname.startsWith('/control/ethernet'))data=action==='GetInfo'?{NewEnable:1,NewStatus:'Up',NewMACAddress:'AA:BB:CC:DD:EE:10',NewMaxBitRate:1000,NewDuplexMode:'Full'}:{NewBytesReceived:Number(call.url.pathname.at(-1))*1000,NewBytesSent:150,NewPacketsReceived:40,NewPacketsSent:30};
    if(call.url.pathname==='/control/LANHostConfigManagement')data={NewDHCPServerEnable:1,NewDHCPServerConfigurable:1,NewDHCPRelay:0,NewMinAddress:'192.168.1.20',NewMaxAddress:'192.168.1.200',NewSubnetMask:'255.255.255.0',NewDNSServers:'192.168.1.1, 2001:db8::1',NewIPRouters:'192.168.1.1',NewDomainName:'fritz.box',NewPassword:'lan-secret'};
    if(call.url.pathname==='/control/WANIPConnection'&&action==='GetInfo')data={NewEnable:1,NewConnectionStatus:'Connected',NewConnectionType:'IP_Routed',NewNATEnabled:1,NewRSIPAvailable:0,NewExternalIPAddress:'203.0.113.1',NewDNSServers:'1.1.1.1,8.8.8.8',NewLastConnectionError:'ERROR_NONE','NewX_AVM-DE_IPv6ConnectionStatus':'Connected','NewX_AVM-DE_IPv6Uptime':80,NewUserName:'isp-secret',NewPassword:'wan-secret'};
    if(call.url.pathname==='/control/WANIPConnection'&&action==='GetPortMappingNumberOfEntries')data={NewPortMappingNumberOfEntries:3};
    return data?{statusCode:200,headers:{},body:response(action,data)}:null;
  }});
  const result=await f.client.connect(f.credentials);
  assert.equal(result.diagnostics.ethernet.length,2);assert.notEqual(result.diagnostics.ethernet[0].id,result.diagnostics.ethernet[1].id);assert.deepEqual(result.diagnostics.ethernet.map(item=>item.totalBytesReceived),[1000,2000]);assert.equal(result.diagnostics.ethernet[0].maxBitRateMbps,1000);
  assert.equal(result.diagnostics.lan.dhcpEnabled,true);assert.deepEqual(result.diagnostics.lan.dnsServers,['192.168.1.1','2001:db8::1']);assert.equal(result.diagnostics.lan.subnetMask,'255.255.255.0');
  assert.equal(result.diagnostics.internet.available,true);assert.equal(result.diagnostics.internet.portMappingCount,3);assert.equal(result.diagnostics.internet.natEnabled,true);assert.equal(result.diagnostics.internet.externalIp,'203.0.113.1');assert.equal(result.diagnostics.internet.ipv6UptimeSeconds,80);
  assert.equal(result.hosts[0].guest,true);assert.equal(result.hosts[0].wanAccess,'denied');assert.equal(result.hosts[0].priority,false);assert.equal(result.hosts[0].filterProfileId,'filtprof1');assert.equal(result.hosts[0].linkRateMbps,1000);assert.equal(result.hosts[0].lanPort,2);assert.equal(result.hosts[0].vpn,false);assert.equal(result.hosts[0].updateAvailable,true);assert.equal(result.hosts[0].leaseTimeRemainingSeconds,120);
  for(const secret of ['lan-secret','wan-secret','isp-secret','host-secret'])assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(f.calls.filter(call=>call.method==='POST').every(call=>!/#(?:Set|Add|GetConfigFile)/.test(call.headers.SOAPAction)));f.client.disconnect();
});

test('PPP GetInfo works without GetStatusInfo and never exports internet account fields',async()=>{
  const f=fixture({desc:description(['DeviceInfo','WANPPPConnection']),override:call=>{
    if(call.url.pathname==='/WANPPPConnection.xml')return scpd(['GetInfo','GetPortMappingNumberOfEntries','SetPassword']);
    if(call.url.pathname==='/control/WANPPPConnection')return {statusCode:200,headers:{},body:call.headers.SOAPAction.includes('#GetInfo')?response('GetInfo',{NewConnectionStatus:'Connected',NewUptime:100,NewNATEnabled:1,NewConnectionType:'IP_Routed',NewUserName:'private-isp-login',NewPassword:'private-isp-password'}):response('GetPortMappingNumberOfEntries',{NewPortMappingNumberOfEntries:0})};
    return null;
  }});
  const result=await f.client.connect(f.credentials);assert.equal(result.wan.status,'Connected');assert.equal(result.diagnostics.internet.service,'WANPPPConnection');assert.equal(result.diagnostics.internet.portMappingCount,0);assert.ok(!JSON.stringify(result).includes('private-isp'));assert.ok(!f.calls.some(call=>call.headers.SOAPAction?.includes('#SetPassword')));f.client.disconnect();
});

test('Missing diagnostics and malformed host or network values remain unknown rather than invented',async()=>{
  const absent=fixture({desc:description(['DeviceInfo'])});const missing=await absent.client.connect(absent.credentials);
  assert.equal(missing.diagnostics.lan.available,false);assert.match(missing.diagnostics.lan.reason,/Dienst/);assert.equal(missing.diagnostics.internet.available,false);assert.deepEqual(missing.diagnostics.ethernet,[]);absent.client.disconnect();
  const f=fixture({desc:description(['DeviceInfo','Hosts','LANHostConfigManagement']),override:call=>{
    if(call.url.pathname==='/LANHostConfigManagement.xml')return scpd(['GetInfo']);
    if(call.url.pathname==='/control/LANHostConfigManagement')return {statusCode:200,headers:{},body:response('GetInfo',{NewDHCPServerEnable:'yes',NewDNSServers:'192.168.1.1,not-an-address',NewMinAddress:'invalid',NewIPRouters:'http://evil.example'})};
    if(call.url.pathname==='/hostlist.lua')return {statusCode:200,headers:{},body:'<List><Item><X_AVM-DE_Guest>yes</X_AVM-DE_Guest><X_AVM-DE_WANAccess>allowed</X_AVM-DE_WANAccess><X_AVM-DE_Speed>-1</X_AVM-DE_Speed><X_AVM-DE_Port>0</X_AVM-DE_Port><LeaseTimeRemaining>9007199254740992</LeaseTimeRemaining></Item></List>'};
    return null;
  }});
  const result=await f.client.connect(f.credentials);assert.equal(result.diagnostics.lan.dhcpEnabled,null);assert.equal(result.diagnostics.lan.dnsServers,null);assert.equal(result.diagnostics.lan.routers,null);assert.equal(result.diagnostics.lan.minAddress,null);
  for(const key of ['guest','wanAccess','linkRateMbps','lanPort','leaseTimeRemainingSeconds','vpn','filterProfileId'])assert.equal(result.hosts[0][key],null,key);f.client.disconnect();
});

test('Generic host fallback preserves documented address source and lease fields',async()=>{
  const f=fixture({desc:description(['DeviceInfo','Hosts']),override:call=>{
    if(call.url.pathname==='/Hosts.xml')return scpd(['GetHostNumberOfEntries','GetGenericHostEntry']);
    if(call.url.pathname==='/control/Hosts')return {statusCode:200,headers:{},body:call.headers.SOAPAction.includes('#GetHostNumberOfEntries')?response('GetHostNumberOfEntries',{NewHostNumberOfEntries:1}):response('GetGenericHostEntry',{NewIPAddress:'192.168.1.20',NewAddressSource:'DHCP',NewLeaseTimeRemaining:0,NewActive:0,'NewX_AVM-DE_Guest':0})};
    return null;
  }});
  const result=await f.client.connect(f.credentials);assert.equal(result.hosts[0].addressSource,'DHCP');assert.equal(result.hosts[0].leaseTimeRemainingSeconds,0);assert.equal(result.hosts[0].guest,false);f.client.disconnect();
});

test('WLAN exports encryption type without keys and treats modern fixed zero packet counters as unavailable',async()=>{
  for(const [firmware,packetAction] of [['7.90','GetStatistics'],['8.20','GetPacketStatistics'],['161.08.10','GetPacketStatistics']]) {
    const f=fixture({desc:description(['DeviceInfo','WLANConfiguration']),override:call=>{
      if(call.url.pathname==='/WLANConfiguration.xml')return scpd(['GetInfo',packetAction,'GetSecurityKeys','SetSecurityKeys']);
      if(call.method==='POST'&&call.headers.Authorization&&call.url.pathname==='/control/DeviceInfo')return {statusCode:200,headers:{},body:response('GetInfo',{NewSoftwareVersion:firmware})};
      if(call.url.pathname==='/control/WLANConfiguration')return {statusCode:200,headers:{},body:call.headers.SOAPAction.includes('#GetInfo')?response('GetInfo',{NewBeaconType:'WPA2andWPA3',NewBasicEncryptionModes:'None',NewMACAddressControlEnabled:1,NewBSSID:'AA:BB:CC:DD:EE:10',NewPreSharedKey:'private-wlan-key',NewKeyPassphrase:'private-wlan-passphrase'}):response(packetAction,{NewTotalPacketsReceived:0,NewTotalPacketsSent:0})};
      return null;
    }});
    const result=await f.client.connect(f.credentials),wlan=result.wlan[0];assert.equal(wlan.beaconType,'WPA2andWPA3');assert.equal(wlan.macFilterEnabled,true);assert.equal(wlan.bssid,'AA:BB:CC:DD:EE:10');assert.ok(!JSON.stringify(result).includes('private-wlan'));
    assert.equal(wlan.packetStats.available,firmware==='7.90');assert.equal(wlan.packetStats.totalPacketsReceived,firmware==='7.90'?0:null);if(firmware!=='7.90')assert.match(wlan.packetStats.reason,/8.10/);
    assert.ok(!f.calls.some(call=>call.headers.SOAPAction?.includes('#GetSecurityKeys')));f.client.disconnect();
  }
});

test('Mesh latency uses schema microseconds and preserves errors without invented successful results',()=>{
  const values=[{status_code:'SUCCESS',timestamp:1700000000000,rt_latency:2500},{status_code:'ERROR_TIMEOUT',timestamp:1700000000000,rt_latency:0},{status_code:'SUCCESS',timestamp:-1,rt_latency:1000},{status_code:'SUCCESS',timestamp:1700000000000,rt_latency:'2000'},{status_code:'invented',timestamp:1700000000000,rt_latency:1000},null];
  const result=normalizeMesh({nodes:values.map((value,index)=>({uid:String(index),metrics:{latency_measurement:value}}))});
  assert.deepEqual(result.nodes[0].latency,{status:'SUCCESS',roundTripMs:2.5,measuredAtMs:1700000000000});assert.equal(result.nodes[1].latency.status,'ERROR_TIMEOUT');
  assert.ok(result.nodes.slice(1).every(node=>node.latency.roundTripMs===null));assert.equal(result.nodes[2].latency.measuredAtMs,null);assert.equal(result.nodes[4].latency.status,null);assert.equal(result.nodes[5].latency.measuredAtMs,null);
});

test('Mesh master router and its host MAC never become individual device traffic',()=>{
  const routerMac='02:00:00:00:00:01',clientMac='02:00:00:00:00:02';
  const metrics={wan_counters:{last_update:1700000000000,bytes:{rx:10000,tx:1000}}};
  const mesh=normalizeMesh({nodes:[{uid:'box',mesh_role:'master',device_mac_address:routerMac,metrics},{uid:'client',device_mac_address:clientMac,metrics}]});
  const result=normalizeDeviceTraffic(mesh,[{mac:routerMac,name:'FRITZ!Box'},{mac:clientMac,name:'PC'}]);
  assert.equal(result.length,1);assert.equal(result[0].mac,clientMac);assert.equal(result[0].available,true);assert.equal(mesh.nodes.length,2);
  assert.deepEqual(normalizeDeviceTraffic(normalizeMesh({nodes:[{uid:'box',mesh_role:'MASTER',metrics}]})),[]);
});
