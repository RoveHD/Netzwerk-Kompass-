import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../public/topology.js';
import { Monitor } from '../lib/monitor.js';

const mesh={nodes:[{id:'box',role:'MASTER',name:'SIMULIERT FRITZ!Box'},{id:'r1',role:'SLAVE',model:'FRITZ!Repeater'},{id:'r2',role:'SLAVE',model:'FRITZ!Repeater'},{id:'pc'},{id:'idle'}],links:[{id:'backhaul1',from:'box',to:'r1',type:'LAN',state:'CONNECTED'},{id:'backhaul2',from:'r1',to:'r2',type:'WLAN',state:'CONNECTED'},{id:'client',from:'r2',to:'pc',state:'CONNECTED'},{id:'parallel',from:'r1',to:'r2',type:'LAN',state:'CONNECTED'},{id:'dangling',from:'pc',to:'not-reported',state:'CONNECTED'}]};
test('Two repeater hops and isolated clients get only reported links',()=>{
  const graph=buildTopology(mesh);assert.equal(graph.nodes.length,5);assert.equal(graph.links.length,4);assert.equal(graph.dangling.length,1);assert.equal(graph.components.length,2);
  assert.ok(graph.byId.get('r2').x>graph.byId.get('r1').x);assert.ok(graph.byId.get('pc').x>graph.byId.get('r2').x);assert.equal(graph.byId.get('idle').x,graph.byId.get('box').x);assert.ok(!graph.links.some(link=>link.from==='idle'||link.to==='idle'));
});
test('Cycles, self-links and disconnected recorded links never loop or fabricate reachability',()=>{
  const graph=buildTopology({...mesh,links:[...mesh.links,{id:'cycle',from:'pc',to:'box'},{id:'self',from:'r1',to:'r1'},{id:'off',from:'pc',to:'idle',state:'DISCONNECTED'}]});
  assert.equal(graph.components.length,2);assert.equal(graph.links.length,7);assert.ok(graph.nodes.every(item=>Number.isFinite(item.x)&&Number.isFinite(item.y)));
  const noLinks=buildTopology({nodes:mesh.nodes,links:[]});assert.equal(noLinks.links.length,0);assert.equal(noLinks.components.length,5);
});
test('Duplicate IDs, hostile strings, absent data and bad link endpoints are bounded data',()=>{
  const graph=buildTopology({nodes:[{id:'<script>alert(1)</script>',name:'<img onerror=bad>'},{id:'__proto__'},{id:'__proto__'},null],links:[null,{from:'bad'},{id:'one',from:'__proto__',to:'<script>alert(1)</script>'},{id:'one',from:'__proto__',to:'__proto__'}]});
  assert.equal(graph.nodes.length,2);assert.equal(graph.links.length,1);assert.equal(graph.nodes[0].name,'<img onerror=bad>');assert.equal(buildTopology(null).nodes.length,0);
});
test('Router history stores independent bounded graph and WLAN projections without raw secrets',async()=>{
  const m=new Monitor({});
  try {
    const data={host:'fritz.box',device:{model:'SIMULIERT'},wan:{status:'Connected'},hosts:[],mesh:structuredClone(mesh),wlan:[{id:'wifi',ssid:'SIMULIERT',channel:36,enabled:true,keyPassphrase:'not-stored'}],capabilities:[{service:'WLANConfiguration',action:'GetInfo',available:true,password:'not-stored'}]};
    m.applyFritz(data);const record=m.history.snapshot(1).records[0];assert.deepEqual(record.mesh.nodes.map(node=>node.id),mesh.nodes.map(node=>node.id));assert.equal(record.mesh.links.length,5);assert.equal(record.wlan[0].channel,36);assert.ok(!JSON.stringify(record).includes('not-stored'));
    data.mesh.nodes[0].name='changed';data.wlan[0].ssid='changed';assert.equal(record.mesh.nodes[0].name,'SIMULIERT FRITZ!Box');assert.equal(record.wlan[0].ssid,'SIMULIERT');
    const huge={...data,mesh:{nodes:Array.from({length:256},(_,i)=>({id:`n${i}`,name:'😀'.repeat(200),model:'😀'.repeat(200),role:'SLAVE'})),links:Array.from({length:1024},(_,i)=>({id:`l${i}`,from:`n${i%256}`,to:`n${(i+1)%256}`,type:'WLAN',receiveRateMbps:100}))},capabilities:Array.from({length:128},()=>({service:'WLANConfiguration',instance:'😀'.repeat(200),action:'GetInfo',available:false,reason:'😀'.repeat(200)}))};
    m.applyFritz(huge);const latest=m.history.snapshot(1).records.at(-1);assert.equal(latest.mesh.truncated,true);assert.equal(latest.mesh.totalNodes,256);assert.ok(Buffer.byteLength(JSON.stringify(latest))<64000);assert.equal(m.history.snapshot(1).records.length,2);
  }finally{await m.close();}
});
