import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology, topologyEvidenceLines, topologyLinkOnPath, topologyLinkKey, topologyPathData } from '../public/topology.js';
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
test('Unknown link states never count as active topology connections',()=>{
  assert.equal(buildTopology({nodes:[{id:'a'},{id:'b'}],links:[{from:'a',to:'b',state:null}]}).components.length,2);
});
const rectangleOverlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
function assertGeometry(graph) {
  for(const [index,node]of graph.nodes.entries()) {
    assert.ok(node.x>=0&&node.y>=0&&node.x+node.width<=graph.width&&node.y+node.height<=graph.height,`node inside canvas: ${node.id}`);
    for(const other of graph.nodes.slice(index+1))assert.equal(rectangleOverlap(node,other),false,`${node.id} overlaps ${other.id}`);
  }
  const labels=graph.treeLinks.map(link=>link.geometry.label);
  for(const [index,label]of labels.entries()) {
    for(const node of graph.nodes)assert.equal(rectangleOverlap(label,node),false,'link label covers a node');
    for(const other of labels.slice(index+1))assert.equal(rectangleOverlap(label,other),false,'link labels overlap');
  }
  for(const link of graph.links) {
    const points=link.geometry.points;assert.match(topologyPathData(points),/^M /);
    for(const point of points)assert.ok(point.x>=0&&point.y>=0&&point.x<=graph.width&&point.y<=graph.height,'edge inside canvas');
    for(let i=1;i<points.length;i++) {
      const a=points[i-1],b=points[i];assert.ok(a.x===b.x||a.y===b.y,'orthogonal route');
      for(const node of graph.nodes) {
        const through=a.x===b.x?a.x>node.x&&a.x<node.x+node.width&&Math.min(a.y,b.y)<node.y+node.height&&Math.max(a.y,b.y)>node.y:a.y>node.y&&a.y<node.y+node.height&&Math.min(a.x,b.x)<node.x+node.width&&Math.max(a.x,b.x)>node.x;
        assert.equal(through,false,`${link.id} crosses ${node.id}`);
      }
    }
  }
}
function generatedTree(count,parentOf) {
  return {nodes:Array.from({length:count},(_,i)=>({id:`n${i}`,mac:`02:00:00:00:${Math.floor(i/256).toString(16).padStart(2,'0')}:${(i%256).toString(16).padStart(2,'0')}`,role:i===0?'MASTER':i<12?'SLAVE':null,name:`Gerät ${i}`})),links:Array.from({length:count-1},(_,i)=>({id:`l${i+1}`,from:`n${parentOf(i+1)}`,to:`n${i+1}`,state:'CONNECTED',type:i%2?'LAN':'WLAN'}))};
}
test('Disjoint subtree geometry fits a large star, a deep chain and an uneven family tree',()=>{
  for(const fixture of [generatedTree(256,()=>0),generatedTree(256,i=>i-1),generatedTree(180,i=>i<12?0:i<100?1:Math.floor(i/7))]) {
    const graph=buildTopology(fixture);assertGeometry(graph);assert.equal(graph.treeLinks.length,fixture.nodes.length-1);
    for(const node of graph.nodes)if(node.layoutParentId){const parent=graph.byId.get(node.layoutParentId);assert.ok(node.x>parent.x);assert.ok(node.subtreeTop>=parent.subtreeTop&&node.subtreeBottom<=parent.subtreeBottom);}
  }
});
test('Parallel, crossing, self and disconnected links stay real and avoid node interiors',()=>{
  const fixture=generatedTree(32,i=>Math.floor((i-1)/3));fixture.nodes.push({id:'idle'});
  fixture.links.push({id:'parallel',from:'n0',to:'n1',type:'PLC',state:'CONNECTED'},{id:'loop',from:'n7',to:'n7',state:'CONNECTED'},{id:'cross',from:'n4',to:'n15',state:'CONNECTED'},{id:'off',from:'n31',to:'idle',state:'DISCONNECTED'},{id:'unknown',from:'n10',to:'idle'});
  const original=structuredClone(fixture),graph=buildTopology(fixture);assertGeometry(graph);assert.deepEqual(fixture,original);
  assert.equal(graph.components.length,2);assert.equal(graph.links.length,fixture.links.length);assert.ok(graph.extraLinks.some(link=>[link.from,link.to].includes('n0')&&[link.from,link.to].includes('n1')));assert.ok(graph.extraLinks.some(link=>link.id==='off'));assert.ok(graph.extraLinks.some(link=>link.id==='unknown'));
  for(const node of graph.nodes)if(node.layoutParentId)assert.ok(fixture.links.some(link=>link.state==='CONNECTED'&&[link.from,link.to].includes(node.id)&&[link.from,link.to].includes(node.layoutParentId)),'layout parent has a real active link');
});
test('Stable MAC order keeps subtree positions across reordered snapshots and transient UID rotation',()=>{
  const fixture=generatedTree(50,i=>Math.floor((i-1)/4)),before=buildTopology(fixture);
  const rotated={nodes:fixture.nodes.slice().reverse().map(node=>({...node,id:`new-${node.id}`})),links:fixture.links.slice().reverse().map(link=>({...link,id:`new-${link.id}`,from:`new-${link.from}`,to:`new-${link.to}`}))},after=buildTopology(rotated);
  for(const node of before.nodes){const match=after.nodes.find(item=>item.mac===node.mac);assert.equal(match.x,node.x);assert.equal(match.y,node.y);}
  assert.equal(topologyLinkKey(fixture,fixture.links[0]),topologyLinkKey(rotated,rotated.links.at(-1)));
});
test('A disconnected forest reserves separate components and link-label room',()=>{
  const fixture=generatedTree(100,i=>Math.floor((i-1)/3));fixture.links=fixture.links.filter((_,i)=>i%7!==0);assertGeometry(buildTopology(fixture));
});
test('Topology evidence distinguishes a confirmed chain, ambiguity and bounded changes',()=>{
  const evidence={nodes:[{id:'mac:a',name:'PC'},{id:'mac:b',name:'Master'}],path:{status:'confirmed',nodeIds:['mac:a','mac:b'],reason:'Aus Links'},limitations:[]};
  assert.match(topologyEvidenceLines(evidence)[0],/PC → Master/);
  assert.match(topologyEvidenceLines({path:{status:'ambiguous',reason:'Mehrere Wege'}})[0],/nicht belegt: Mehrere Wege/);
  const comparison={status:'compared',interval:{from:'2026-10-13T10:00:00Z',to:'2026-10-13T10:00:30Z'},changes:[{kind:'link-missing',reason:'Kein Disconnect-Beweis.'},{kind:'rate-drop',beforeMbps:100,afterMbps:0}]};
  const lines=topologyEvidenceLines(null,comparison);assert.match(lines[0],/beobachtet zwischen/);assert.match(lines[0],/Kein Disconnect-Beweis/);assert.match(lines[1],/100 Mbit\/s → 0 Mbit\/s/);assert.match(lines.at(-1),/genaue Änderungszeitpunkt/);
});
test('Path highlights use stable MAC/interface identity and require confirmed evidence',()=>{
  const data={nodes:[{id:'old1',mac:'02:00:00:00:00:01',interfaces:[{id:'if1',mac:'02:00:00:00:00:03'}]},{id:'old2',mac:'02:00:00:00:00:02',interfaces:[{id:'if2',mac:'02:00:00:00:00:04'}]}]};
  const edge={from:'old1',to:'old2',fromInterface:'if1',toInterface:'if2'},evidence={path:{status:'confirmed',hops:[{id:'mac:02:00:00:00:00:01/02:00:00:00:00:03|mac:02:00:00:00:00:02/02:00:00:00:00:04'}]}};
  assert.equal(topologyLinkOnPath(data,edge,evidence),true);assert.equal(topologyLinkOnPath(data,{...edge,fromInterface:null},evidence),false);
  assert.equal(topologyLinkOnPath(data,edge,{path:{status:'ambiguous'}}),false);
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
