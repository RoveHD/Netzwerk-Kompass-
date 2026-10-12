import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

// Read-only TR-064 actions documented at https://fritz.com/en/pages/interfaces.
const ALLOWED = {
  DeviceInfo: new Set(['GetInfo', 'GetDeviceLog']),
  LANConfigSecurity: new Set(['X_AVM-DE_GetUserList', 'X_AVM-DE_GetAnonymousLogin']),
  WANCommonInterfaceConfig: new Set(['GetCommonLinkProperties', 'GetTotalBytesReceived', 'GetTotalBytesSent']),
  WANIPConnection: new Set(['GetStatusInfo', 'GetInfo', 'GetPortMappingNumberOfEntries']), WANPPPConnection: new Set(['GetStatusInfo', 'GetInfo', 'GetPortMappingNumberOfEntries']),
  WANDSLInterfaceConfig: new Set(['GetInfo', 'GetStatisticsTotal']),
  WLANConfiguration: new Set(['GetInfo', 'GetTotalAssociations', 'GetStatistics', 'GetPacketStatistics']),
  LANEthernetInterfaceConfig: new Set(['GetInfo', 'GetStatistics']),
  LANHostConfigManagement: new Set(['GetInfo']),
  Hosts: new Set(['GetHostNumberOfEntries', 'GetGenericHostEntry', 'X_AVM-DE_GetHostListPath', 'X_AVM-DE_GetMeshListPath'])
};
const MAX_BYTES = 1024 * 1024;
class FritzError extends Error { constructor(code,message){super(message);this.code=code;} }
const fail = (code, message) => new FritzError(code,message);
const cancelled = () => fail('FRITZ_CANCELLED', 'FRITZ!Box-Verbindung wurde getrennt.');
const validUsername = value => typeof value==='string'&&value.length>0&&value.length<=128&&!/[\r\n\x00:]/.test(value);
const userRequired = message => fail('FRITZ_USER_REQUIRED', message+' Den FRITZ!Box-Benutzernamen im optionalen Namensfeld eintragen.');

export function isPrivateRouterIP(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function routerHost(value) {
  if (typeof value !== 'string') throw fail('FRITZ_HOST', 'Eine private IPv4-Adresse oder ein lokaler Routerhostname ist erforderlich.');
  const host = value.trim().toLowerCase();
  if (!host || host.length > 253 || !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) throw fail('FRITZ_HOST', 'Routeradresse ohne URL, Port oder Zugangsdaten eingeben.');
  if (/^[\d.]+$/.test(host) && !isPrivateRouterIP(host)) throw fail('FRITZ_HOST', 'Nur private IPv4-Routeradressen sind erlaubt.');
  return host;
}

function decodeXml(value) {
  if (/&(?![^&;\s]*;)/.test(value)) throw fail('FRITZ_XML', 'Ungültige XML-Zeichenreferenz.');
  return value.replace(/&([^;]*);/g, (_match, entity) => {
    const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const numeric = entity.match(/^#(x[\da-f]+|\d+)$/i);
    if (numeric) {
      const code = /^x/i.test(numeric[1]) ? parseInt(numeric[1].slice(1), 16) : Number(numeric[1]);
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff))) return String.fromCodePoint(code);
    }
    throw fail('FRITZ_XML', 'Ungültige XML-Zeichenreferenz.');
  });
}

export function parseXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_BYTES || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw fail('FRITZ_XML', 'Unsichere oder zu große XML-Antwort.');
  const document = { name:'#document', children:[], text:'' }, stack = [document];
  let offset = 0, count = 0;
  while (offset < xml.length) {
    if (xml.startsWith('<!--', offset)) {
      const end = xml.indexOf('-->', offset + 4);if (end === -1) throw fail('FRITZ_XML', 'Unvollständige XML-Antwort.');offset = end + 3;continue;
    }
    if (xml.startsWith('<![CDATA[', offset)) {
      const end = xml.indexOf(']]>', offset + 9);if (end === -1 || stack.length < 2) throw fail('FRITZ_XML', 'Ungültige XML-Antwort.');
      stack.at(-1).text += xml.slice(offset + 9, end);offset = end + 3;continue;
    }
    if (xml.startsWith('<?xml', offset)) {
      const end = xml.indexOf('?>', offset + 5);if (end === -1 || stack.length !== 1 || document.children.length) throw fail('FRITZ_XML', 'Ungültige XML-Deklaration.');offset = end + 2;continue;
    }
    if (xml[offset] !== '<') {
      const end = xml.indexOf('<', offset), stop = end === -1 ? xml.length : end;
      const text = xml.slice(offset, stop);
      if (stack.length === 1 && text.trim()) throw fail('FRITZ_XML', 'Ungültige XML-Antwort.');
      stack.at(-1).text += decodeXml(text);offset = stop;continue;
    }
    const match = xml.slice(offset).match(/^<(\/?)([a-z_][\w.:-]*)([^<>]*?)(\/?)>/i);
    if (!match) throw fail('FRITZ_XML', 'Ungültige XML-Tags.');
    const [, closing, qualified, attrs, selfClosing] = match;
    offset += match[0].length;
    if (closing) {
      if (attrs.trim() || selfClosing || stack.length < 2 || stack.at(-1).qualified !== qualified) throw fail('FRITZ_XML', 'XML-Tags passen nicht zusammen.');
      stack.pop();continue;
    }
    if (!/^(?:\s+[a-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*$/i.test(attrs)) throw fail('FRITZ_XML', 'Ungültige XML-Attribute.');
    for (const attribute of attrs.matchAll(/=\s*(?:"([^"]*)"|'([^']*)')/g)) decodeXml(attribute[1] ?? attribute[2]);
    if (++count > 12000 || stack.length > 32) throw fail('FRITZ_XML', 'XML-Antwort ist zu komplex.');
    const node = { name:qualified.split(':').at(-1), qualified, children:[], text:'' };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || document.children.length !== 1) throw fail('FRITZ_XML', 'Unvollständige XML-Antwort.');
  return document.children[0];
}

function nodes(root, name) {
  const result = [], stack = [root];
  while (stack.length) { const node=stack.pop();if(node.name===name)result.push(node);for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]); }
  return result;
}
function flat(node) { return Object.fromEntries(node.children.filter(child => !child.children.length).map(child => [child.name, child.text.trim()])); }
const xmlEscape = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[character]));

function digestChallenge(header) {
  if (typeof header !== 'string' || header.length > 8192 || /[\r\n]/.test(header)) throw fail('FRITZ_AUTH_UNSUPPORTED', 'Die Box bietet keine unterstützte Digest-Anmeldung an.');
  const start = header.match(/\bDigest\s+/i);if(!start)throw fail('FRITZ_AUTH_UNSUPPORTED', 'Die Box bietet keine unterstützte Digest-Anmeldung an.');
  const values = Object.create(null);
  const expression = /([a-z][\w-]*)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^,\s]+))/ig;
  for (const match of header.slice(start.index + start[0].length).matchAll(expression)) values[match[1].toLowerCase()] = (match[2] ?? match[3]).replace(/\\(.)/g, '$1');
  if (!Object.hasOwn(values,'realm') || !values.nonce || values.nonce.length>1024 || values.realm.length>1024) throw fail('FRITZ_AUTH_UNSUPPORTED', 'Unvollständige Digest-Anfrage der Box.');
  values.algorithm = (values.algorithm || 'MD5').toUpperCase();
  if (!['MD5','MD5-SESS','SHA-256','SHA-256-SESS'].includes(values.algorithm)) throw fail('FRITZ_AUTH_UNSUPPORTED', 'Digest-Verfahren der Box wird nicht unterstützt.');
  if (values.qop) {
    if (!values.qop.split(',').map(value=>value.trim().toLowerCase()).includes('auth')) throw fail('FRITZ_AUTH_UNSUPPORTED', 'Die Box unterstützt hier kein Digest qop=auth.');
    values.qop = 'auth';
  }
  return values;
}

export function createDigestAuthorization(challenge, {username,password,method,uri,nonceCount=1,cnonce=randomBytes(16).toString('hex')}) {
  const auth = typeof challenge === 'string' ? digestChallenge(challenge) : challenge;
  const hashName = auth.algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const hash = value => createHash(hashName).update(value, 'utf8').digest('hex');
  const quote = value => '"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';
  let a1 = hash(`${username}:${auth.realm}:${password}`);
  if (auth.algorithm.endsWith('-SESS')) a1 = hash(`${a1}:${auth.nonce}:${cnonce}`);
  const a2 = hash(`${method}:${uri}`), nc=nonceCount.toString(16).padStart(8,'0');
  const response = auth.qop ? hash(`${a1}:${auth.nonce}:${nc}:${cnonce}:auth:${a2}`) : hash(`${a1}:${auth.nonce}:${a2}`);
  const fields = [`username=${quote(username)}`,`realm=${quote(auth.realm)}`,`nonce=${quote(auth.nonce)}`,`uri=${quote(uri)}`,`response=${quote(response)}`,`algorithm=${auth.algorithm}`];
  if (auth.opaque) fields.push(`opaque=${quote(auth.opaque)}`);
  if (auth.qop) fields.push('qop=auth',`nc=${nc}`,`cnonce=${quote(cnonce)}`);
  else if (auth.algorithm.endsWith('-SESS')) fields.push(`cnonce=${quote(cnonce)}`);
  return 'Digest '+fields.join(', ');
}

function boundedCall(callback, signal, timeoutMs = 5000) {
  return new Promise((resolve,reject) => {
    if (signal?.aborted) return reject(cancelled());
    const controller = new AbortController();let done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);if(error){controller.abort();reject(error);}else resolve(value);};
    const abort=()=>finish(signal?.reason?.name==='TimeoutError'?fail('FRITZ_TIMEOUT','FRITZ!Box-Abfrage hat ihr Zeitlimit überschritten.'):cancelled());
    const timer=setTimeout(()=>finish(fail('FRITZ_TIMEOUT','FRITZ!Box-Abfrage hat ihr Zeitlimit überschritten.')),timeoutMs);
    signal?.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(controller.signal.aborted)throw cancelled();return callback(controller.signal);}).then(value=>finish(null,value),error=>finish(error instanceof FritzError?error:fail('FRITZ_NETWORK','FRITZ!Box ist nicht erreichbar oder TR-064 ist nicht verfügbar.')));
  });
}

function httpRequest(url, {method,headers,body,signal}) {
  return new Promise((resolve,reject) => {
    const request=http.request(url,{method,headers,signal},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>MAX_BYTES){const error=fail('FRITZ_SIZE','FRITZ!Box-Antwort ist zu groß.');reject(error);response.destroy();request.destroy(error);}else chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>resolve({statusCode:response.statusCode,headers:response.headers,body:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);
    request.end(body || undefined);
  });
}

const number = value => value !== undefined && value !== null && value !== '' && /^\d+(?:\.\d+)?$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const scale = (value,divisor) => {const n=number(value);return n===null?null:n/divisor;};
const text = (value,max=200) => typeof value==='string'?value.slice(0,max):null;
const active = value => value==='1'||value==='true'?true:value==='0'||value==='false'?false:null;
const meshInteger = value => typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
const canonicalMac = value => typeof value==='string'&&/^(?:[\da-f]{2}:){5}[\da-f]{2}$/i.test(value)&&!/^00:00:00:00:00:00$|^ff:ff:ff:ff:ff:ff$/i.test(value)?value.toUpperCase():null;
const ipAddress = value => typeof value==='string'&&isIP(value)?value:null;
const ipList = value => {
  if(typeof value!=='string'||!value.trim())return null;
  const entries=value.split(',').map(item=>item.trim());
  return entries.length<=32&&entries.every(item=>isIP(item))?entries:null;
};

function meshLatency(node) {
  // Schema v8.7 uses microseconds for round-trip latency and a UNIX ms timestamp.
  const raw=node.metrics?.latency_measurement;
  const status=['SUCCESS','ERROR_TIMEOUT','ERROR_ABORTED','ERROR_UNREACHABLE','ERROR_OTHER'].includes(raw?.status_code)?raw.status_code:null;
  const timestamp=meshInteger(raw?.timestamp),latency=meshInteger(raw?.rt_latency);
  const measuredAtMs=timestamp!==null&&timestamp>0&&timestamp<=8640000000000000?timestamp:null;
  return {status,roundTripMs:status==='SUCCESS'&&measuredAtMs!==null&&latency!==null?latency/1000:null,measuredAtMs};
}

function wlanPacketStats(data,firmware) {
  // FRITZ! WLANConfiguration v49: both packet actions return only 0 since 8.10.
  const version=typeof firmware==='string'?firmware.match(/^(?:\d+\.)?(\d+)\.(\d+)(?:\D|$)/):null;
  const disabled=version&&(Number(version[1])>8||(Number(version[1])===8&&Number(version[2])>=10));
  const received=number(data?.NewTotalPacketsReceived),sent=number(data?.NewTotalPacketsSent);
  const available=!disabled&&received!==null&&sent!==null;
  return {available:Boolean(available),reason:disabled?'FRITZ!OS ab 8.10 meldet für WLAN-Paketzähler nur feste Nullwerte.':available?null:'Keine vollständig gültigen WLAN-Paketzähler gemeldet.',totalPacketsReceived:available?received:null,totalPacketsSent:available?sent:null};
}

function meshWanCounters(node) {
  // FRITZ! Mesh schema v8.7: these are WAN bytes at the IP layer,
  // not cur_data_rate_rx/tx (local link rates). The router supplies the clock.
  // https://fritz.support/resources/Mesh-Topology_Schema_v8.7.json
  const counters=node.metrics?.wan_counters;
  const received=meshInteger(counters?.bytes?.rx),sent=meshInteger(counters?.bytes?.tx),updated=meshInteger(counters?.last_update);
  const available=received!==null&&sent!==null&&updated!==null&&updated>0&&updated<=8640000000000000;
  return {available,reason:available?null:counters==null?'Die Box meldet für dieses Gerät keine Internet-Bytezähler.':'Die Box meldet keine vollständig gültigen Internet-Bytezähler mit Zeitstempel.',totalBytesReceived:available?received:null,totalBytesSent:available?sent:null,lastUpdateMs:available?updated:null};
}

function hostEntry(data,prefix='') {
  const value=key=>data[prefix+key],wanAccess=value('X_AVM-DE_WANAccess'),port=number(value('X_AVM-DE_Port'));
  return {ip:ipAddress(value('IPAddress')),name:text(value('HostName')),mac:text(value('MACAddress'),30),active:active(value('Active')),interfaceType:text(value('InterfaceType'),40),
    guest:active(value('X_AVM-DE_Guest')),wanAccess:['unknown','error','granted','denied'].includes(wanAccess)?wanAccess:null,priority:active(value('X_AVM-DE_Priority')),filterProfileId:text(value('X_AVM-DE_FilterProfileID'),100),
    model:text(value('X_AVM-DE_Model')),linkRateMbps:number(value('X_AVM-DE_Speed')),lanPort:port!==null&&port>0?port:null,vpn:active(value('X_AVM-DE_VPN')),updateAvailable:active(value('X_AVM-DE_UpdateAvailable')),
    addressSource:text(value('AddressSource'),40),leaseTimeRemainingSeconds:number(value('LeaseTimeRemaining')),deviceClass:text(value('X_AVM-DE_DeviceClassUser')||value('X_AVM-DE_DeviceClass'),60)};
}

export function normalizeMesh(raw) {
  if (!raw || !Array.isArray(raw.nodes)) throw fail('FRITZ_MESH','Mesh-Liste hat kein unterstütztes Format.');
  const mesh={nodes:[],links:[],schemaVersion:text(raw.schema_version,30)},seen=new Set(),nodeIds=new Set();
  for(const node of raw.nodes.slice(0,256)) {
    if(!node||typeof node.uid!=='string'||!node.uid||node.uid.length>200||nodeIds.has(node.uid))continue;
    nodeIds.add(node.uid);
    const ip=(Array.isArray(node.ip_addresses)?node.ip_addresses:[]).find(address=>address?.version==='V4'&&typeof address.value==='string')?.value?.split('/')[0];
    const role=text(node.mesh_role,30);
    mesh.nodes.push({id:text(node.uid),name:text(node.device_friendly_name||node.device_name),ip:isIP(ip||'')===4?ip:null,mac:canonicalMac(node.device_mac_address),model:text(node.device_model),role:['master','slave'].includes(role?.toLowerCase())?role.toUpperCase():role,wanCounters:meshWanCounters(node),latency:meshLatency(node)});
    for(const iface of (Array.isArray(node.node_interfaces)?node.node_interfaces:[]).slice(0,32)) {
      for(const link of (Array.isArray(iface?.node_links)?iface.node_links:[]).slice(0,128)) {
        if(!link||mesh.links.length>=1024||typeof link.uid!=='string'||!link.uid||link.uid.length>200||seen.has(link.uid)||!['CONNECTED','DISCONNECTED'].includes(link.state)||typeof link.node_1_uid!=='string'||!link.node_1_uid||link.node_1_uid.length>200||typeof link.node_2_uid!=='string'||!link.node_2_uid||link.node_2_uid.length>200)continue;
        seen.add(link.uid);
        mesh.links.push({id:link.uid,from:link.node_1_uid,to:link.node_2_uid,state:link.state,type:text(link.type,30),rateMbps:link.state==='CONNECTED'?scale(link.cur_data_rate_rx,1000):null,receiveRateMbps:link.state==='CONNECTED'?scale(link.cur_data_rate_rx,1000):null,transmitRateMbps:link.state==='CONNECTED'?scale(link.cur_data_rate_tx,1000):null,signalPercent:null});
      }
    }
  }
  return mesh;
}

export function normalizeDeviceTraffic(mesh,hosts=[]) {
  const result=[],byMac=new Map();
  const allNodes=Array.isArray(mesh?.nodes)?mesh.nodes.slice(0,256):[];
  const isMaster=item=>typeof item?.role==='string'&&item.role.toUpperCase()==='MASTER';
  // The router is already represented by total WAN traffic, not a client device.
  const routerMacs=new Set(allNodes.filter(isMaster).map(item=>canonicalMac(item.mac)).filter(Boolean));
  const meshNodes=allNodes.filter(item=>!isMaster(item)&&!routerMacs.has(canonicalMac(item?.mac)));
  const macCounts=new Map();for(const item of meshNodes){const mac=canonicalMac(item?.mac);if(mac)macCounts.set(mac,(macCounts.get(mac)||0)+1);}
  for(const item of meshNodes) {
    if(!item)continue;
    const mac=canonicalMac(item.mac);
    if(mac&&byMac.has(mac))continue;
    const counters=item.wanCounters;
    const validCounters=counters?.available===true&&meshInteger(counters.totalBytesReceived)!==null&&meshInteger(counters.totalBytesSent)!==null&&meshInteger(counters.lastUpdateMs)!==null&&counters.lastUpdateMs>0&&counters.lastUpdateMs<=8640000000000000;
    const ambiguous=mac&&macCounts.get(mac)>1;
    const available=Boolean(validCounters&&mac&&!ambiguous);
    const reason=!mac?'Keine eindeutige Geräte-MAC gemeldet; ein sicherer Verbrauchsverlauf kann nicht zugeordnet werden.':ambiguous?'Mehrere Mesh-Knoten melden dieselbe MAC; Internetzähler werden nicht zusammengeführt.':!validCounters?counters?.reason||'Die Box meldet für dieses Gerät keine Internet-Bytezähler.':null;
    const entry={id:mac?'mac:'+mac:null,nodeId:text(item.id),name:text(item.name),ip:isIP(item.ip||'')===4?item.ip:null,mac,source:'mesh-wan-counters',scope:'internet',available,reason,totalBytesReceived:available?counters.totalBytesReceived:null,totalBytesSent:available?counters.totalBytesSent:null,lastUpdateMs:available?counters.lastUpdateMs:null};
    result.push(entry);if(mac)byMac.set(mac,entry);
  }
  for(const host of (Array.isArray(hosts)?hosts:[]).slice(0,128)) {
    if(!host)continue;
    const mac=canonicalMac(host.mac),existing=mac?byMac.get(mac):null;
    if(routerMacs.has(mac))continue;
    if(existing){existing.name||=text(host.name);existing.ip||=isIP(host.ip||'')===4?host.ip:null;continue;}
    const entry={id:mac?'mac:'+mac:null,nodeId:null,name:text(host.name),ip:isIP(host.ip||'')===4?host.ip:null,mac,source:'mesh-wan-counters',scope:'internet',available:false,reason:'Kein eindeutig zugeordneter Mesh-Knoten mit Internet-Bytezählern gemeldet.',totalBytesReceived:null,totalBytesSent:null,lastUpdateMs:null};
    result.push(entry);if(mac)byMac.set(mac,entry);
  }
  return result;
}

export class FritzBoxClient {
  #session = null;
  #requestImpl;
  #lookupImpl;
  constructor({requestImpl=httpRequest,lookupImpl=lookup}={}) {this.#requestImpl=requestImpl;this.#lookupImpl=lookupImpl;}
  get connected() {return Boolean(this.#session?.authenticated&&!this.#session.controller.signal.aborted);}
  disconnect() {
    const session=this.#session;this.#session=null;
    if(session){session.controller.abort();session.username='';session.password='';session.auth.clear();session.secretPaths.clear();}
  }
  #assertSession(session) {if(this.#session!==session||session.controller.signal.aborted)throw cancelled();}
  #safeUrl(value,session) {
    if(typeof value!=='string'||!value||value.length>4096||/[\s\\]/.test(value))throw fail('FRITZ_URL','Die Box lieferte einen unsicheren lokalen Pfad.');
    let url;try{url=new URL(value,`http://${session.ip}:49000/`);}catch{throw fail('FRITZ_URL','Die Box lieferte einen ungültigen lokalen Pfad.');}
    if(url.protocol!=='http:'||url.username||url.password||url.hash||![session.ip,session.host].includes(url.hostname)||!['80','49000'].includes(url.port||'80'))throw fail('FRITZ_URL','Ein Pfad außerhalb der angemeldeten Box wurde abgewiesen.');
    url.hostname=session.ip;
    session.secretPaths.add(url.pathname+url.search);
    return url;
  }
  async #request(session,value,{method='GET',body='',headers={},signal=session.controller.signal,unauthenticated=false}={}) {
    this.#assertSession(session);
    const url=this.#safeUrl(value,session),origin=url.origin;
    let digestUsed=false;
    for(let attempt=0;attempt<2;attempt++) {
      const outgoing={...headers};
      const auth=unauthenticated?null:session.auth.get(origin);
      if(auth){auth.nc++;outgoing.Authorization=createDigestAuthorization(auth.challenge,{username:session.username,password:session.password,method,uri:url.pathname+url.search,nonceCount:auth.nc});digestUsed=true;}
      const response=await boundedCall(abortSignal=>this.#requestImpl(url,{method,headers:outgoing,body,signal:abortSignal,maxBytes:MAX_BYTES,timeoutMs:5000,redirect:'error'}),signal);
      this.#assertSession(session);
      if(!response||typeof response.body!=='string'||Buffer.byteLength(response.body)>MAX_BYTES)throw fail('FRITZ_SIZE','Ungültige oder zu große FRITZ!Box-Antwort.');
      if(response.statusCode>=300&&response.statusCode<400)throw fail('FRITZ_REDIRECT','Weiterleitungen der Box werden aus Sicherheitsgründen abgewiesen.');
      if(response.statusCode===401) {
        if(unauthenticated)throw userRequired('Die Box erlaubt keine automatische Benutzererkennung ohne Anmeldung.');
        if(attempt===1){session.authenticated=false;throw fail('FRITZ_AUTH','Anmeldung abgewiesen. Benutzer, Kennwort und TR-064-Rechte prüfen.');}
        const header=response.headers?.['www-authenticate']??response.headers?.['WWW-Authenticate'];
        session.auth.set(origin,{challenge:digestChallenge(Array.isArray(header)?header.join(', '):header),nc:0});
        continue;
      }
      if(response.statusCode===403)throw fail('FRITZ_ACCESS','Der Routerbenutzer hat für diese Abfrage keine ausreichenden Rechte.');
      return {...response,digestUsed};
    }
  }
  async #action(session,service,action,args={},signal,{unauthenticated=false}={}) {
    if(!service||!ALLOWED[service.name]?.has(action))throw fail('FRITZ_UNSUPPORTED','Lesende TR-064-Funktion ist auf dieser Box nicht verfügbar.');
    const parameters=Object.entries(args).map(([key,value])=>`<${key}>${xmlEscape(value)}</${key}>`).join('');
    const body=`<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${parameters}</u:${action}></s:Body></s:Envelope>`;
    const response=await this.#request(session,service.control,{method:'POST',body,signal,unauthenticated,headers:{'Content-Type':'text/xml; charset=utf-8',SOAPAction:`"${service.type}#${action}"`}});
    if(response.statusCode!==200&&response.statusCode!==500)throw fail('FRITZ_HTTP',`FRITZ!Box-Abfrage fehlgeschlagen (HTTP ${Number(response.statusCode)||0}).`);
    const xml=parseXml(response.body),fault=nodes(xml,'Fault')[0];
    if(fault){const code=nodes(fault,'errorCode')[0]?.text;if(code==='606')throw fail('FRITZ_ACCESS','Der Routerbenutzer hat für diese Abfrage keine ausreichenden Rechte (Code 606).');if(code==='401')throw fail('FRITZ_UNSUPPORTED','Diese Funktion wird von der Box nicht unterstützt (SOAP-Code 401: Invalid Action).');throw fail('FRITZ_SOAP',`TR-064-Abfrage wurde von der Box abgewiesen${/^\d+$/.test(code||'')?' (Code '+code+')':''}.`);}
    if(response.statusCode!==200)throw fail('FRITZ_HTTP',`FRITZ!Box-Abfrage fehlgeschlagen (HTTP ${Number(response.statusCode)||0}).`);
    const result=nodes(xml,action+'Response')[0];if(!result)throw fail('FRITZ_XML','Die Box lieferte keine passende TR-064-Antwort.');
    return {data:flat(result),digestUsed:response.digestUsed};
  }
  async #discoverUsername(session) {
    const service=session.services.find(item=>item.name==='LANConfigSecurity');
    if(!service)throw userRequired('Die Box stellt die automatische Benutzererkennung über TR-064 nicht bereit.');
    // Both discovery actions are explicitly public in FRITZ! TR-064 First Steps,
    // chapter 6.1.4. Never respond to their challenges with supplied credentials.
    const discover=async action=>{
      try{return (await this.#action(session,service,action,{},undefined,{unauthenticated:true})).data;}
      catch(error){this.#assertSession(session);if(['FRITZ_UNSUPPORTED','FRITZ_SOAP','FRITZ_USER_REQUIRED','FRITZ_ACCESS'].includes(error.code))return null;throw error;}
    };
    const users=await discover('X_AVM-DE_GetUserList');
    const xmlList=users?.['NewX_AVM-DE_UserList'];
    if(xmlList!==undefined) {
      const list=parseXml(xmlList);
      if(list.name!=='List'||list.children.length>128||list.children.some(item=>item.name!=='Username'||item.children.length||!validUsername(item.text.trim())))throw userRequired('Die Box lieferte keine sicher auswertbare Benutzerliste.');
      if(list.children.length>1)throw userRequired('Auf der Box sind mehrere Benutzer eingerichtet; eine eindeutige automatische Auswahl ist nicht möglich.');
      if(list.children.length===1)return list.children[0].text.trim();
    }
    // Older password-only configurations accept an arbitrary Digest username
    // only when AnonymousLogin is explicitly enabled (LANConfigSecurity 2.3).
    const anonymous=await discover('X_AVM-DE_GetAnonymousLogin');
    if(active(anonymous?.['NewX_AVM-DE_AnonymousLoginEnabled'])===true)return 'dslf-config';
    throw userRequired('Die Box lieferte keinen eindeutig bestimmbaren Benutzer und bestätigte keinen Kennwort-only-Altmodus.');
  }
  async #loadCapabilities(session) {
    const signal=AbortSignal.any([session.controller.signal,AbortSignal.timeout(15000)]);
    // Fetch only read-only service descriptions once per login, never on each poll.
    await Promise.all(session.services.filter(item=>item.name!=='LANConfigSecurity').map(async service=>{
      service.actions=new Set();service.unavailable=new Map();
      try {
        if(!service.scpd)throw fail('FRITZ_UNSUPPORTED','Keine Funktionsbeschreibung gemeldet.');
        const response=await this.#request(session,service.scpd,{signal});
        if(response.statusCode!==200)throw fail('FRITZ_UNSUPPORTED','Funktionsbeschreibung nicht verfügbar.');
        const xml=parseXml(response.body);if(xml.name!=='scpd')throw fail('FRITZ_XML','Ungültige Funktionsbeschreibung.');
        for(const action of nodes(xml,'action')){const name=flat(action).name;if(ALLOWED[service.name].has(name))service.actions.add(name);}
      }catch(error){this.#assertSession(session);if(error.code==='FRITZ_AUTH')throw error;service.capabilityReason=error.message;}
    }));
  }
  async connect({host,username,password}={}) {
    this.disconnect();
    host=routerHost(host);
    const automatic=username===undefined||(typeof username==='string'&&!username.trim());
    if((!automatic&&!validUsername(username))||typeof password!=='string'||!password||password.length>1024)throw fail('FRITZ_CREDENTIALS','Kennwort und gegebenenfalls einen gültigen Routerbenutzernamen eingeben.');
    if(automatic)username='';
    const session={host,ip:null,username,password,controller:new AbortController(),auth:new Map(),secretPaths:new Set(),services:[],authenticated:false,busy:true};this.#session=session;
    try {
      if(isPrivateRouterIP(host))session.ip=host;
      else {
        const resolved=await boundedCall(signal=>this.#lookupImpl(host,{family:4,all:true,signal}),session.controller.signal);
        this.#assertSession(session);
        const addresses=Array.isArray(resolved)?resolved:[resolved];
        if(!addresses.length||addresses.some(item=>!isPrivateRouterIP(typeof item==='string'?item:item?.address)))throw fail('FRITZ_HOST','Routerhostname zeigt nicht ausschließlich auf private IPv4-Adressen.');
        session.ip=typeof addresses[0]==='string'?addresses[0]:addresses[0].address;
      }
      const description=await this.#request(session,'/tr64desc.xml',{unauthenticated:automatic});
      if(description.statusCode!==200)throw fail('FRITZ_UNSUPPORTED','TR-064-Gerätebeschreibung ist nicht verfügbar.');
      for(const node of nodes(parseXml(description.body),'service').slice(0,64)) {
        const data=flat(node),match=data.serviceType?.match(/^urn:dslforum-org:service:([a-z\d-]+):(\d+)$/i);
        if(!match||!Object.hasOwn(ALLOWED,match[1]))continue;
        session.services.push({name:match[1],id:text(data.serviceId)||`${match[1]}-${session.services.length}`,type:data.serviceType,control:this.#safeUrl(data.controlURL,session).href,scpd:data.SCPDURL?this.#safeUrl(data.SCPDURL,session).href:null});
      }
      if(automatic){const discovered=await this.#discoverUsername(session);this.#assertSession(session);session.username=discovered;}
      const device=await this.#action(session,session.services.find(service=>service.name==='DeviceInfo'),'GetInfo');
      if(!device.digestUsed)throw fail('FRITZ_AUTH_UNCONFIRMED','Die Box hat keine Digest-Anmeldung bestätigt.');
      session.authenticated=true;
      await this.#loadCapabilities(session);
      return await this.#collect(session,device.data);
    } catch(error) {if(this.#session===session)this.disconnect();throw error instanceof FritzError?error:fail('FRITZ_NETWORK','FRITZ!Box-Verbindung konnte nicht hergestellt werden.');}
    finally {session.busy=false;}
  }
  async poll() {
    const session=this.#session;
    if(!this.connected)throw fail('FRITZ_DISCONNECTED','Keine FRITZ!Box ist angemeldet.');
    if(session.busy)throw fail('FRITZ_BUSY','Eine FRITZ!Box-Abfrage läuft bereits.');
    session.busy=true;
    try {const device=await this.#action(session,session.services.find(service=>service.name==='DeviceInfo'),'GetInfo');return await this.#collect(session,device.data);}
    catch(error){if(['FRITZ_AUTH','FRITZ_ACCESS'].includes(error?.code)&&this.#session===session)this.disconnect();throw error instanceof FritzError?error:fail('FRITZ_NETWORK','FRITZ!Box-Abfrage fehlgeschlagen.');}
    finally{session.busy=false;}
  }
  async #collect(session,device) {
    const warnings=[],signal=AbortSignal.any([session.controller.signal,AbortSignal.timeout(20000)]);
    const service=name=>session.services.find(item=>item.name===name);
    const optional=async(name,action,args={},selected=service(name))=>{
      if(!selected?.actions?.has(action)||selected.unavailable.has(action))return null;
      try{return (await this.#action(session,selected,action,args,signal)).data;}
      catch(error){this.#assertSession(session);if(error.code==='FRITZ_AUTH')throw error;if(['FRITZ_UNSUPPORTED','FRITZ_ACCESS'].includes(error.code))selected.unavailable.set(action,error.message);if(error.code==='FRITZ_UNSUPPORTED')return null;warnings.push(`${name}/${action}: ${error.message}`);return null;}
    };
    const [common,received,sent,dsl,dslStats,wanIpStatus,wanIpInfo,lanInfo]=await Promise.all([
      optional('WANCommonInterfaceConfig','GetCommonLinkProperties'),optional('WANCommonInterfaceConfig','GetTotalBytesReceived'),optional('WANCommonInterfaceConfig','GetTotalBytesSent'),
      optional('WANDSLInterfaceConfig','GetInfo'),optional('WANDSLInterfaceConfig','GetStatisticsTotal'),optional('WANIPConnection','GetStatusInfo'),optional('WANIPConnection','GetInfo'),optional('LANHostConfigManagement','GetInfo')
    ]);
    const wanIp=wanIpStatus||wanIpInfo;
    const [wanPppStatus,wanPppInfo]=wanIp?.NewConnectionStatus==='Connected'?[null,null]:await Promise.all([optional('WANPPPConnection','GetStatusInfo'),optional('WANPPPConnection','GetInfo')]);
    const wanPpp=wanPppStatus||wanPppInfo;
    const wan=[wanIp,wanPpp].find(item=>item?.NewConnectionStatus==='Connected')||wanIp||wanPpp;
    const selectedWan=wan===wanPpp&&wanPpp?'WANPPPConnection':wanIp||service('WANIPConnection')?'WANIPConnection':'WANPPPConnection';
    const internetInfo=selectedWan==='WANIPConnection'?wanIpInfo:wanPppInfo;
    const portMappings=await optional(selectedWan,'GetPortMappingNumberOfEntries');
    const unavailableReason=(name,action)=>{const selected=service(name);return !selected?'Dienst nicht von dieser Box gemeldet.':selected.capabilityReason||selected.unavailable.get(action)||(!selected.actions.has(action)?'Funktion nicht von dieser Box gemeldet.':'Die Box lieferte keine lesbaren Daten.');};
    const ethernet=await Promise.all(session.services.filter(item=>item.name==='LANEthernetInterfaceConfig').slice(0,16).map(async selected=>{
      const [info,stats]=await Promise.all([optional('LANEthernetInterfaceConfig','GetInfo',{},selected),optional('LANEthernetInterfaceConfig','GetStatistics',{},selected)]);
      return {id:selected.id,available:Boolean(info||stats),reason:info||stats?null:selected.capabilityReason||selected.unavailable.get('GetInfo')||'Keine LAN-Schnittstellendaten gemeldet.',enabled:active(info?.NewEnable),status:text(info?.NewStatus,50),mac:canonicalMac(info?.NewMACAddress),maxBitRateMbps:number(info?.NewMaxBitRate),duplexMode:text(info?.NewDuplexMode,30),
        totalBytesReceived:number(stats?.NewBytesReceived),totalBytesSent:number(stats?.NewBytesSent),totalPacketsReceived:number(stats?.NewPacketsReceived),totalPacketsSent:number(stats?.NewPacketsSent)};
    }));
    const diagnostics={ethernet,
      lan:{available:Boolean(lanInfo),reason:lanInfo?null:unavailableReason('LANHostConfigManagement','GetInfo'),dhcpEnabled:active(lanInfo?.NewDHCPServerEnable),dhcpConfigurable:active(lanInfo?.NewDHCPServerConfigurable),dhcpRelay:active(lanInfo?.NewDHCPRelay),minAddress:ipAddress(lanInfo?.NewMinAddress),maxAddress:ipAddress(lanInfo?.NewMaxAddress),subnetMask:ipAddress(lanInfo?.NewSubnetMask),dnsServers:ipList(lanInfo?.NewDNSServers),routers:ipList(lanInfo?.NewIPRouters),domainName:text(lanInfo?.NewDomainName,253)},
      internet:{available:Boolean(internetInfo||portMappings),reason:internetInfo||portMappings?null:unavailableReason(selectedWan,'GetInfo'),service:service(selectedWan)?selectedWan:null,status:text(internetInfo?.NewConnectionStatus||wan?.NewConnectionStatus,50),enabled:active(internetInfo?.NewEnable),connectionType:text(internetInfo?.NewConnectionType,50),natEnabled:active(internetInfo?.NewNATEnabled),rsipAvailable:active(internetInfo?.NewRSIPAvailable),externalIp:ipAddress(internetInfo?.NewExternalIPAddress),dnsServers:ipList(internetInfo?.NewDNSServers),portMappingCount:number(portMappings?.NewPortMappingNumberOfEntries),lastConnectionError:text(internetInfo?.NewLastConnectionError||wan?.NewLastConnectionError,100),ipv6Status:text(internetInfo?.['NewX_AVM-DE_IPv6ConnectionStatus'],50),ipv6UptimeSeconds:number(internetInfo?.['NewX_AVM-DE_IPv6Uptime'])}};
    const wlan=await Promise.all(session.services.filter(item=>item.name==='WLANConfiguration').slice(0,8).map(async selected=>{
      const [info,associations]=await Promise.all([optional('WLANConfiguration','GetInfo',{},selected),optional('WLANConfiguration','GetTotalAssociations',{},selected)]);
      const stats=await optional('WLANConfiguration','GetPacketStatistics',{},selected)||await optional('WLANConfiguration','GetStatistics',{},selected);
      return {id:selected.id,enabled:active(info?.NewEnable),status:text(info?.NewStatus,50),ssid:text(info?.NewSSID,128),channel:number(info?.NewChannel),frequencyBand:text(info?.['NewX_AVM-DE_FrequencyBand'],40),standard:text(info?.NewStandard,40),associatedDevices:number(associations?.NewTotalAssociations),beaconType:text(info?.NewBeaconType,50),basicEncryptionModes:text(info?.NewBasicEncryptionModes,50),macFilterEnabled:active(info?.NewMACAddressControlEnabled),bssid:canonicalMac(info?.NewBSSID),packetStats:wlanPacketStats(stats,device.NewSoftwareVersion)};
    }));
    let log=device.NewDeviceLog;
    if(log===undefined)log=(await optional('DeviceInfo','GetDeviceLog'))?.NewDeviceLog;
    let hosts=[],hostsRead=false,mesh={nodes:[],links:[]};
    const hostList=await optional('Hosts','X_AVM-DE_GetHostListPath');
    if(hostList?.['NewX_AVM-DE_HostListPath']) {
      try {
        const response=await this.#request(session,hostList['NewX_AVM-DE_HostListPath'],{signal});if(response.statusCode!==200)throw fail('FRITZ_HOSTS','Geräteliste ist nicht verfügbar.');
        const xml=parseXml(response.body);if(xml.name!=='List')throw fail('FRITZ_HOSTS','Geräteliste hat kein unterstütztes XML-Format.');
        const items=nodes(xml,'Item');hosts=items.slice(0,128).map(item=>hostEntry(flat(item)));hostsRead=true;
        if(items.length>128)warnings.push('Geräteliste wurde auf 128 Einträge begrenzt.');
      }catch(error){this.#assertSession(session);if(error.code==='FRITZ_AUTH')throw error;warnings.push(`Geräteliste: ${error.message}`);}
    }
    if(!hostsRead) {
      const count=number((await optional('Hosts','GetHostNumberOfEntries'))?.NewHostNumberOfEntries);
      if(count!==null){
        if(count>128)warnings.push('Geräteliste wurde auf 128 Einträge begrenzt.');
        for(let offset=0;offset<Math.min(count,128)&&!signal.aborted;offset+=8){
          const entries=await Promise.all(Array.from({length:Math.min(8,Math.min(count,128)-offset)},(_,i)=>optional('Hosts','GetGenericHostEntry',{NewIndex:offset+i})));
          hosts.push(...entries.filter(Boolean).map(item=>hostEntry(item,'New')));
        }
      }
    }
    const meshList=await optional('Hosts','X_AVM-DE_GetMeshListPath');
    if(meshList?.['NewX_AVM-DE_MeshListPath']) {
      try{const response=await this.#request(session,meshList['NewX_AVM-DE_MeshListPath'],{signal});if(response.statusCode!==200)throw fail('FRITZ_MESH','Mesh-Liste ist nicht verfügbar.');mesh=normalizeMesh(JSON.parse(response.body));warnings.push('Mesh-UIDs gelten nur innerhalb der aktuellen Topologie; Linkraten sind keine gemessene Internetgeschwindigkeit.');}
      catch(error){this.#assertSession(session);if(error.code==='FRITZ_AUTH')throw error;warnings.push('Mesh-Liste konnte nicht sicher gelesen werden.');}
    }
    if(signal.aborted)warnings.push('Ein Teil der Box-Daten wurde wegen des Zeitlimits nicht gelesen.');
    this.#assertSession(session);
    const deviceTraffic=normalizeDeviceTraffic(mesh,hosts);
    const deviceTrafficAvailable=deviceTraffic.some(item=>item.available);
    const snapshot={connected:true,host:session.host,updatedAt:new Date().toISOString(),device:{model:text(device.NewModelName),firmware:text(device.NewSoftwareVersion),uptimeSeconds:number(device.NewUpTime)},
      wan:{status:text(wan?.NewConnectionStatus,50),uptimeSeconds:number(wan?.NewUptime),downstreamMbps:scale(common?.NewLayer1DownstreamMaxBitRate,1000000),upstreamMbps:scale(common?.NewLayer1UpstreamMaxBitRate,1000000),totalBytesReceived:number(received?.NewTotalBytesReceived),totalBytesSent:number(sent?.NewTotalBytesSent)},
      dsl:dsl?{status:text(dsl.NewStatus,50),downstreamRateRaw:number(dsl.NewDownstreamCurrRate),upstreamRateRaw:number(dsl.NewUpstreamCurrRate),downstreamNoiseMarginRaw:number(dsl.NewDownstreamNoiseMargin),upstreamNoiseMarginRaw:number(dsl.NewUpstreamNoiseMargin),crcErrors:number(dslStats?.NewCRCErrors),atucCrcErrors:number(dslStats?.NewATUCCRCErrors),fecErrors:number(dslStats?.NewFECErrors),erroredSeconds:number(dslStats?.NewErroredSecs),severelyErroredSeconds:number(dslStats?.NewSeverelyErroredSecs),linkRetrains:number(dslStats?.NewLinkRetrain)}:null,
      hosts,mesh,wlan,diagnostics,deviceTraffic,deviceTrafficCapability:{available:deviceTrafficAvailable,source:'mesh-wan-counters',scope:'internet',reason:deviceTrafficAvailable?null:'Die Box meldet keine sicher einem Gerät zuordenbaren Internet-Bytezähler. Die Mesh-Schnittstelle bietet diese erst im Schema 8.7; Verfügbarkeit hängt von FRITZ!OS und Routermeldung ab. Werte im FRITZ!Box-Online-Monitor garantieren keine exportierten Gerätezähler.'},capabilities:Object.entries(ALLOWED).filter(([name])=>name!=='LANConfigSecurity').flatMap(([name,actions])=>{
        const services=session.services.filter(item=>item.name===name);
        return (services.length?services:[null]).flatMap(item=>[...actions].map(action=>({service:name,instance:item?.id||null,action,available:Boolean(item?.actions?.has(action)&&!item.unavailable.has(action)),reason:!item?'Dienst nicht von dieser Box gemeldet.':item.capabilityReason||item.unavailable.get(action)||(!item.actions.has(action)?'Funktion nicht von dieser Box gemeldet.':null)})));
      }),log:text(log,20000)||'',warnings:[...new Set(warnings)].slice(0,40)};
    const redact=value=>{
      for(const secret of [session.password,session.username]) {
        if(!secret)continue;
        // Short credentials must not destroy ordinary words (e.g. password "a").
        const escaped=secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        value=secret.length>=4?value.split(secret).join('[geschützt]'):value.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'gu'),'[geschützt]');
      }
      for(const secret of session.secretPaths)if(secret.length>1)value=value.split(secret).join('[Pfad entfernt]');
      return value.replace(/https?:\/\/[^\s<>"']+/gi,'[Link entfernt]').replace(/\b(sid|token|password|passwd|authorization)\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s&<>"']+)/gi,'$1=[geschützt]');
    };
    return JSON.parse(JSON.stringify(snapshot,(_key,value)=>typeof value==='string'?redact(value):value));
  }
}
