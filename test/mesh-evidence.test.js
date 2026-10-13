import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeshEvidence, compareMeshSnapshots } from '../lib/mesh-evidence.js';
import { normalizeMesh } from '../lib/fritzbox.js';

const now=1700000000000,mac=id=>`02:00:00:00:00:${String(id).padStart(2,'0')}`;
const node=(id,role)=>({id:String(id),mac:mac(id),role,name:`N${id}`,interfaces:[]});
const link=(from,to,type='LAN',extras={})=>({id:`${from}-${to}`,from:String(from),to:String(to),type,state:'CONNECTED',receiveRateMbps:100,transmitRateMbps:80,...extras});
const snapshot=(nodes=[node(1,'MASTER'),node(2)],links=[link(1,2)],at=now)=>({at:new Date(at).toISOString(),host:'fritz.box',sessionId:'same',mesh:{schemaVersion:'8.7',available:true,nodes,links}});
const build=(data,options={})=>buildMeshEvidence(data,{pcMac:mac(2),now,...options});
const later=data=>({...structuredClone(data),at:new Date(now+30000).toISOString()});
const kinds=result=>result.changes.map(change=>change.kind);

test('Direct PC connection is established only by a connected reported link',()=>{
  const result=build(snapshot());assert.equal(result.status,'available');assert.equal(result.path.status,'confirmed');assert.deepEqual(result.path.nodeIds,[`mac:${mac(2)}`,`mac:${mac(1)}`]);assert.equal(result.path.hops[0].type,'LAN');assert.equal(result.path.hops[0].receiveRateMbps,80);assert.equal(result.path.hops[0].transmitRateMbps,100);
  assert.equal(build(snapshot(undefined,[])).path.status,'missing');
  assert.equal(build(snapshot(undefined,[link(1,2,'LAN',{state:'DISCONNECTED'})])).path.status,'missing');
});
test('Two repeaters in a chain produce the real PC→master hops',()=>{
  const result=build(snapshot([node(1,'MASTER'),node(2),node(3,'SLAVE'),node(4,'SLAVE')],[link(2,3),link(3,4,'WLAN'),link(4,1,'LAN')]));
  assert.equal(result.path.status,'confirmed');assert.deepEqual(result.path.nodeIds,[2,3,4,1].map(id=>`mac:${mac(id)}`));assert.deepEqual(result.path.hops.map(hop=>hop.type),['LAN','WLAN','LAN']);
});
test('A short path, loop, PLC bus and parallel WLAN links cannot establish unique forwarding',()=>{
  const nodes=[node(1,'MASTER'),node(2),node(3,'SLAVE')];
  for(const links of [[link(1,2),link(1,3),link(3,2)],[link(1,2,'PLC'),link(1,3,'PLC'),link(3,2,'PLC')],[link(1,2,'WLAN'),link(1,2,'WLAN',{id:'second'})]])assert.equal(build(snapshot(nodes,links)).path.status,'ambiguous');
});
test('Cycles outside the PC→master path do not make that path ambiguous',()=>{
  const result=build(snapshot([node(1,'MASTER'),node(2),node(3),node(4),node(5)],[link(1,2),link(1,3),link(3,4),link(4,5),link(5,3)]));assert.equal(result.path.status,'confirmed');
});
test('Interface MAC can identify the PC, never IP/name/manual repeater ordering',()=>{
  const data=snapshot();data.mesh.nodes[1].interfaces=[{id:'adapter',mac:mac(9),type:'LAN'}];data.mesh.nodes[1].ip='192.168.1.20';
  assert.equal(build(data,{pcMac:mac(9)}).path.status,'confirmed');
  assert.equal(build(data,{pcMac:null,pcIp:'192.168.1.20',repeaterHost:'192.168.1.10'}).path.status,'unknown');
  assert.equal(build(data,{pcMac:mac(8),pcIp:'192.168.1.20'}).path.status,'missing');
  data.mesh.nodes[0].interfaces=[{id:'duplicate',mac:mac(9)}];assert.equal(build(data,{pcMac:mac(9)}).path.status,'ambiguous');
});
test('Known older schemas retain documented links; missing and unknown schemas are explicit',()=>{
  for(const version of ['1.0','1.5','1.6','1.9','4.11','5.0','6.7','7.8']){const data=snapshot();data.mesh.schemaVersion=version;const result=build(data);assert.equal(result.schema.status,'supported-legacy');assert.equal(result.path.status,'confirmed');}
  for(const version of [null,'9.0','8.70']){const data=snapshot();data.mesh.schemaVersion=version;assert.equal(build(data).status,'unsupported');assert.equal(build(data).links.length,0);}
});
test('Missing/stale/future snapshots and bounded or dangling graphs stay unknown',()=>{
  assert.equal(build(null).status,'unavailable');assert.equal(build({...snapshot(),mesh:null}).status,'unavailable');
  const unavailable=snapshot();unavailable.mesh.available=false;assert.equal(build(unavailable).status,'unavailable');
  assert.equal(build(snapshot(undefined,undefined,now-120001)).status,'stale');assert.equal(build(snapshot(undefined,undefined,now+1)).status,'unknown');
  assert.equal(build({...snapshot(),at:null}).status,'unknown');
  const truncated=snapshot();truncated.mesh.truncated=true;assert.equal(build(truncated).path.status,'partial');
  assert.equal(build(snapshot(undefined,[link(1,2),link(2,99)])).path.status,'partial');
  assert.equal(build(snapshot(undefined,[link(1,2,'unknown')])).path.status,'partial');
});
test('Duplicate node MACs/UIDs and absent or multiple masters never yield a false path',()=>{
  for(const nodes of [[node(1,'MASTER'),node(2),{...node(3),mac:mac(2)}],[node(1,'MASTER'),node(2),node(2)]])assert.equal(build(snapshot(nodes)).status,'partial');
  assert.equal(build(snapshot([node(1),node(2)])).path.status,'missing');assert.equal(build(snapshot([node(1,'MASTER'),node(2,'MASTER')])).path.status,'ambiguous');
});
test('UID changes and reversed link endpoints are stable across polls with correct rate direction',()=>{
  const before=snapshot(),after=later(before);after.mesh.nodes[0].id='new-master';after.mesh.nodes[1].id='new-pc';after.mesh.links=[{...link(1,2),id:'new-link',from:'new-pc',to:'new-master',receiveRateMbps:80,transmitRateMbps:100}];
  assert.deepEqual(kinds(compareMeshSnapshots(before,after)),[]);assert.deepEqual(build(after,{now:now+30000}).path.nodeIds,build(before).path.nodeIds);
  after.mesh.links[0].transmitRateMbps=50;const changes=compareMeshSnapshots(before,after).changes;assert.equal(changes[0].kind,'rate-drop');assert.equal(changes[0].direction,'receiveRateMbps');assert.equal(changes[0].receiverNodeId,`mac:${mac(1)}`);
});
test('Explicit disconnect and reconnect are bounded observation intervals',()=>{
  const before=snapshot(),after=later(before);after.mesh.links[0].state='DISCONNECTED';const result=compareMeshSnapshots(before,after);
  assert.deepEqual(kinds(result),['link-disconnected']);assert.deepEqual(result.changes[0].interval,{from:before.at,to:after.at});assert.ok(!('at' in result.changes[0]));
  const restored={...structuredClone(before),at:new Date(now+60000).toISOString()};assert.deepEqual(kinds(compareMeshSnapshots(after,restored)),['link-restored']);
});
test('Absent snapshot, unknown schema, gaps and session/router changes produce no disconnect claims',()=>{
  const before=snapshot();
  for(const after of [null,{...later(before),mesh:null},{...later(before),mesh:{nodes:[],links:[],schemaVersion:'9.0'}},{...later(before),sessionId:'different'},{...later(before),host:'other.box'},{...later(before),at:new Date(now+120001).toISOString()},before]){const result=compareMeshSnapshots(before,after);assert.equal(result.status,'unavailable');assert.deepEqual(result.changes,[]);}
  const after=later(before);after.mesh.truncated=true;assert.equal(compareMeshSnapshots(before,after).status,'unavailable');
});
test('Links disappear and reappear only as newly observed topology, nodes missing/new are separate',()=>{
  const before=snapshot(),after=later(before);after.mesh.links=[];assert.deepEqual(kinds(compareMeshSnapshots(before,after)),['link-missing']);
  const restored={...structuredClone(before),at:new Date(now+60000).toISOString()};assert.deepEqual(kinds(compareMeshSnapshots(after,restored)),['link-added']);
  after.mesh.nodes=[node(1,'MASTER'),node(3)];after.mesh.links=[link(1,3)];const result=compareMeshSnapshots(before,after);assert.ok(kinds(result).includes('node-missing'));assert.ok(kinds(result).includes('node-new'));assert.ok(!kinds(result).includes('link-disconnected'));
});
test('LAN/WLAN switch and changed repeater uplink are distinguished',()=>{
  const before=snapshot(),after=later(before);after.mesh.links[0].type='WLAN';after.mesh.links[0].receiveRateMbps=20;assert.deepEqual(kinds(compareMeshSnapshots(before,after)),['technology-changed']);
  const chain=snapshot([node(1,'MASTER'),node(2),node(3,'SLAVE'),node(4,'SLAVE')],[link(1,3,'WLAN'),link(1,4),link(2,3)]),moved=later(chain);moved.mesh.links[2]=link(2,4);assert.equal(compareMeshSnapshots(chain,moved).changes.find(change=>change.kind==='uplink-changed').nodeId,`mac:${mac(2)}`);
});
test('Rate drops use relative and absolute thresholds, preserve true zero and ignore missing values',()=>{
  const before=snapshot();
  for(const [value,expected]of [[80,false],[71,false],[70,true],[0,true],[null,false]]){const after=later(before);after.mesh.links[0].receiveRateMbps=value;assert.equal(kinds(compareMeshSnapshots(before,after)).includes('rate-drop'),expected);}
  const small=snapshot();small.mesh.links[0].receiveRateMbps=5;const after=later(small);after.mesh.links[0].receiveRateMbps=0;assert.ok(!kinds(compareMeshSnapshots(small,after)).includes('rate-drop'));
});
test('Stable interface identities correlate parallel links without reusing transient UIDs',()=>{
  const before=snapshot();before.mesh.nodes[0].interfaces=[{id:'box-1',mac:mac(5)},{id:'box-2',mac:mac(6)}];before.mesh.nodes[1].interfaces=[{id:'pc-1',mac:mac(7)},{id:'pc-2',mac:mac(8)}];before.mesh.links=[link(1,2,'WLAN',{fromInterface:'box-1',toInterface:'pc-1'}),link(1,2,'WLAN',{id:'parallel',fromInterface:'box-2',toInterface:'pc-2'})];
  const after=later(before);after.mesh.links[1].state='DISCONNECTED';assert.equal(compareMeshSnapshots(before,after).changes[0].kind,'link-disconnected');
  after.mesh.nodes[0].interfaces[1].id='new-box-if';after.mesh.nodes[1].interfaces[1].id='new-pc-if';after.mesh.links[1].id='new-link';after.mesh.links[1].fromInterface='new-box-if';after.mesh.links[1].toInterface='new-pc-if';assert.equal(compareMeshSnapshots(before,after).changes[0].kind,'link-disconnected');
});

test('Replacing the sole physical link cannot attribute new interface rates to the previous link',()=>{
  const before=snapshot();
  before.mesh.nodes[0].interfaces=[{id:'old-router',mac:mac(5)}];before.mesh.nodes[1].interfaces=[{id:'old-client',mac:mac(6)}];
  Object.assign(before.mesh.links[0],{type:'WLAN',fromInterface:'old-router',toInterface:'old-client'});
  const after=later(before);
  after.mesh.nodes[0].interfaces=[{id:'new-router',mac:mac(7)}];after.mesh.nodes[1].interfaces=[{id:'new-client',mac:mac(8)}];
  Object.assign(after.mesh.links[0],{fromInterface:'new-router',toInterface:'new-client',receiveRateMbps:10,transmitRateMbps:10});
  const changes=compareMeshSnapshots(before,after).changes;
  assert.deepEqual(changes.map(change=>change.kind),['link-missing','link-added']);
  assert.notEqual(changes[0].linkId,changes[1].linkId);
});
test('Unidentified parallel links do not fabricate individual rate or disconnect changes',()=>{
  const before=snapshot(undefined,[link(1,2,'WLAN'),link(1,2,'WLAN',{id:'parallel'})]),after=later(before);after.mesh.links[1].receiveRateMbps=0;assert.deepEqual(kinds(compareMeshSnapshots(before,after)),['link-identity-ambiguous']);
});
test('Official normalization retains only safe interface references and flags truncation',()=>{
  const raw={schema_version:'8.7',nodes:[{uid:'box',device_mac_address:mac(1),mesh_role:'master',node_interfaces:[{uid:'lan-1',mac_address:mac(5),type:'LAN',is_upstream:true,password:'must-not-export',node_links:[{uid:'l1',type:'LAN',state:'CONNECTED',node_1_uid:'box',node_2_uid:'pc',node_interface_1_uid:'lan-1',node_interface_2_uid:'lan-2',cur_data_rate_rx:1000000,cur_data_rate_tx:100000}]}]},{uid:'pc',device_mac_address:mac(2),node_interfaces:[{uid:'lan-2',mac_address:mac(6),type:'LAN',is_upstream:null}]}]};
  const mesh=normalizeMesh(raw);assert.equal(mesh.available,true);assert.equal(mesh.truncated,false);assert.equal(mesh.links[0].fromInterface,'lan-1');assert.equal(mesh.links[0].receiveRateMbps,1000);assert.deepEqual(mesh.nodes[0].interfaces,[{id:'lan-1',mac:mac(5),type:'LAN',isUpstream:true}]);assert.ok(!JSON.stringify(mesh).includes('must-not-export'));
  assert.equal(build({...snapshot(),mesh}).path.status,'confirmed');raw.nodes[0].node_interfaces=Array.from({length:33},(_,i)=>({uid:`if${i}`}));assert.equal(normalizeMesh(raw).truncated,true);
});
test('Evidence and comparisons do not mutate their input snapshots',()=>{
  const before=snapshot(),after=later(before),saved=JSON.stringify([before,after]);build(before);compareMeshSnapshots(before,after);assert.equal(JSON.stringify([before,after]),saved);
});
test('Repeated identical links normalize once; contradictory states disable graph certainty',()=>{
  const edge={uid:'one',type:'LAN',state:'CONNECTED',node_1_uid:'a',node_2_uid:'b'};
  const raw={schema_version:'8.7',nodes:[{uid:'a',device_mac_address:mac(1),node_interfaces:[{node_links:[edge]}]},{uid:'b',device_mac_address:mac(2),node_interfaces:[{node_links:[{...edge}]}]}]};
  assert.equal(normalizeMesh(raw).links.length,1);assert.equal(normalizeMesh(raw).truncated,false);
  raw.nodes[1].node_interfaces[0].node_links[0].state='DISCONNECTED';assert.equal(normalizeMesh(raw).truncated,true);assert.equal(build({...snapshot(),mesh:normalizeMesh(raw)}).status,'partial');
});
