// Isolated topology interaction/geometry QA. No live network or monitor is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import path from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fixture={nodes:Array.from({length:72},(_,i)=>({id:`n${i}`,mac:`02:00:00:00:00:${i.toString(16).padStart(2,'0')}`,role:i===0?'MASTER':i<8?'SLAVE':null,name:i===0?'FRITZ!Box · synthetischer Master':i<8?`Repeater ${i}`:`Client ${i} mit längerem Namen`,model:i<8?'FRITZ!Repeater':'PC',ip:`192.168.50.${i+1}`})),links:Array.from({length:71},(_,i)=>({id:`l${i+1}`,from:`n${i<7?0:1+(i%7)}`,to:`n${i+1}`,state:'CONNECTED',type:i%2?'LAN':'WLAN',receiveRateMbps:866,transmitRateMbps:433}))};
fixture.links.push({id:'parallel',from:'n0',to:'n1',state:'CONNECTED',type:'LAN',receiveRateMbps:1000},{id:'cross',from:'n1',to:'n2',state:'CONNECTED',type:'PLC'},{id:'off',from:'n5',to:'n71',state:'DISCONNECTED',type:'WLAN'},{id:'self',from:'n7',to:'n7',state:'CONNECTED',type:'PLC'});
// Preserve the production stylesheet order so later workspace/theme overrides
// are covered. The harness defines only its container, never theme/button styles.
const appHtml=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
const styles=[...appHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(match=>match[1]);
const html=`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${styles.map(href=>`<link rel="stylesheet" href="${href}">`).join('')}<style>body{margin:0;padding:20px}main{max-width:1280px;min-width:0;margin:auto}h1{font-size:20px}</style></head><body><main><h1>Mesh-Stammbaum · synthetische Prüfdaten</h1><div id="host"></div></main><script type="module">import{renderTopology}from'/topology.js';window.fixture=${JSON.stringify(fixture)};window.state={onLinkSelect:link=>window.clicked=link.id};window.render=()=>{document.querySelector('#host').replaceChildren();renderTopology(document.querySelector('#host'),window.fixture,window.state,'qa')};window.render();window.ready=true;</script></body></html>`;
const staticPaths=new Set(['/topology.js',...styles,'/fonts/geist-variable.woff2','/fonts/geist-mono-variable.woff2']);
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);}else if(staticPaths.has(req.url)){res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':req.url.endsWith('.woff2')?'font/woff2':'text/css');res.end(await readFile(new URL(`../public${req.url}`,import.meta.url)));}else{res.statusCode=404;res.end();}}catch{res.statusCode=500;res.end();}});
server.listen(0,'127.0.0.1');await once(server,'listening');const output=path.resolve('test-artifacts/topology-tree-app-css');await mkdir(output,{recursive:true});let browser;
try {
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const width of [1920,1400,768,390,320]) {
    await page.setViewportSize({width,height:900});await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.ready);await page.evaluate(()=>document.fonts.ready);
    const styleEvidence=await page.evaluate(()=>({
      themeText:getComputedStyle(document.querySelector('.mesh-topology')).color,
      labels:[...document.querySelectorAll('.mesh-link-label,.mesh-link-rate')].map(item=>({stroke:getComputedStyle(item).stroke,fill:getComputedStyle(item).fill})),
      buttons:[...document.querySelectorAll('.mesh-topology-toolbar button,.mesh-topology-connection')].map(item=>({shared:item.classList.contains('button')&&item.classList.contains('button-secondary'),color:getComputedStyle(item).color,background:getComputedStyle(item).backgroundColor,fontSize:getComputedStyle(item).fontSize,fontWeight:getComputedStyle(item).fontWeight,borderRadius:getComputedStyle(item).borderRadius}))
    }));
    assert.ok(styleEvidence.labels.length>0);assert.ok(styleEvidence.buttons.length>0);
    for(const label of styleEvidence.labels){assert.equal(label.stroke,'none');assert.equal(label.fill,styleEvidence.themeText);}
    for(const button of styleEvidence.buttons){assert.equal(button.shared,true);assert.equal(button.color,styleEvidence.themeText);assert.equal(button.background,'rgba(0, 0, 0, 0)');assert.equal(button.fontSize,'13px');assert.equal(button.fontWeight,'600');assert.equal(button.borderRadius,'6px');}
    console.log(`Full app CSS ${width}px: labels stroke=none fill=${styleEvidence.labels[0].fill}; buttons ${styleEvidence.buttons[0].background}, ${styleEvidence.buttons[0].fontSize}/${styleEvidence.buttons[0].fontWeight}, ${styleEvidence.buttons[0].borderRadius}.`);
    const result=await page.evaluate(()=>{
      const boxes=[...document.querySelectorAll('.mesh-node')].map(item=>item.getBoundingClientRect()),overlaps=[];
      for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],b=boxes[j];if(a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top)overlaps.push([i,j]);}
      const scroll=document.querySelector('.mesh-topology-scroll');return {overlaps,overflow:document.documentElement.scrollWidth>innerWidth,scrollable:scroll.scrollWidth>scroll.clientWidth,nodes:boxes.length,links:document.querySelectorAll('.mesh-link-group').length,masterVisible:boxes[0].top>=scroll.getBoundingClientRect().top&&boxes[0].bottom<=scroll.getBoundingClientRect().bottom};
    });
    assert.deepEqual(result.overlaps,[]);assert.equal(result.overflow,false,`page overflow ${width}`);if(width<1200)assert.equal(result.scrollable,true);assert.equal(result.nodes,fixture.nodes.length);assert.equal(result.links,fixture.links.length);assert.equal(result.masterVisible,true);
    await page.getByRole('button',{name:'+',exact:true}).click();assert.equal(await page.evaluate(()=>window.state.zoom),1.15);
    await page.getByRole('button',{name:'−',exact:true}).click();assert.equal(await page.evaluate(()=>window.state.zoom),1);
    await page.locator('.mesh-topology-scroll').dispatchEvent('wheel',{ctrlKey:true,deltaY:-100});assert.equal(await page.evaluate(()=>window.state.zoom),1.1);
    await page.locator('.mesh-topology-scroll').dispatchEvent('wheel',{ctrlKey:true,deltaY:100});assert.equal(await page.evaluate(()=>window.state.zoom),1);
    await page.locator('.mesh-link-group[data-link-id="l1"]').dispatchEvent('click');assert.equal(await page.evaluate(()=>window.clicked),'l1');assert.match(await page.locator('.mesh-topology-detail').innerText(),/RX zu/);
    await page.locator('.mesh-extra-links summary').click();await page.evaluate(()=>{window.state.extraLinksExpanded=document.querySelector('.mesh-extra-links').open;window.render();});assert.equal(await page.locator('.mesh-extra-links').evaluate(item=>item.open),false);
    assert.equal(await page.locator('.mesh-link-group.is-selected').getAttribute('data-link-id'),'l1');
    await page.locator('.mesh-link-group[data-link-id="l2"]').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.clicked),'l2');
    const previousLeft=await page.evaluate(()=>{document.querySelector('[data-node-id="n71"]').click();const sc=document.querySelector('.mesh-topology-scroll');sc.scrollLeft=420;sc.scrollTop=300;window.state.scrollLeft=sc.scrollLeft;window.state.scrollTop=sc.scrollTop;const previous=sc.scrollLeft;window.fixture.nodes=window.fixture.nodes.map(node=>({...node,id:'new-'+node.id}));window.fixture.links=window.fixture.links.map(link=>({...link,id:'new-'+link.id,from:'new-'+link.from,to:'new-'+link.to}));window.render();return previous;});
    assert.equal(await page.locator('.mesh-node.is-selected').getAttribute('data-node-id'),'new-n71');assert.equal(await page.locator('.mesh-topology-scroll').evaluate(item=>item.scrollLeft),previousLeft);
    await page.getByRole('button',{name:'Master',exact:true}).click();await page.screenshot({path:path.join(output,`tree-${width}.png`),fullPage:true});
    await page.locator('.mesh-extra-links summary').click();await page.locator('.mesh-extra-link-list button').first().click();assert.equal(await page.locator('.mesh-link-group.is-selected').count(),1);
    await page.getByRole('button',{name:'Einpassen',exact:true}).click();assert.ok(await page.evaluate(()=>window.state.zoom)>=.35);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  }
  assert.deepEqual(errors,[]);console.log(`Topology UI passed with ${styles.length} production stylesheets: 1920/1400/768/390/320px, computed text/button styles, no overlaps/page overflow, zoom/scroll/node+link selection/UID rotation. Screenshots: ${output}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
