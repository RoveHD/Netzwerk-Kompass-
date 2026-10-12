import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
// Development-only dependency; the shipped app itself needs no npm packages.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base=process.argv[2];
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base||''))throw new Error('Lokale App-URL angeben.');
const output=path.resolve('test-artifacts');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});
const page=await browser.newPage({viewport:{width:1440,height:1050}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const results=[];
try {
  await page.goto(base);await page.locator('#interface-select option').first().waitFor();
  await page.waitForFunction(()=>document.querySelector('#interface-select')?.value,{},{timeout:45000});
  await page.locator('#target-label').fill('UI-Prüfung');await page.locator('#target-host').fill('127.0.0.1');
  await page.locator('#target-form button').click();
  const target=page.locator('.target-card').filter({hasText:'UI-Prüfung'});
  await target.waitFor();
  await page.waitForFunction(async()=>{const s=await(await fetch('/api/state')).json();return s.targets.find(t=>t.host==='127.0.0.1')?.stats.received>0;},{},{timeout:45000});
  results.push('Eigene Ziele angelegt und echte localhost-Ping-Antwort empfangen');
  await target.getByRole('button',{name:'Route zu 127.0.0.1 verfolgen'}).click();
  await page.waitForFunction(()=>document.querySelector('#trace-output')?.textContent.includes('127.0.0.1'),{},{timeout:30000});
  await page.locator('#trace-done').click();results.push('Reale localhost-Routenprüfung');
  await page.locator('#monitor-btn').click();await page.waitForFunction(()=>document.querySelector('#monitor-text')?.textContent.includes('pausiert'));
  await page.locator('#monitor-btn').click();await page.waitForFunction(()=>document.querySelector('#monitor-text')?.textContent.includes('aktiv'));results.push('Pause und Fortsetzen');
  const downloadPromise=page.waitForEvent('download');await page.locator('#export-btn').click();const download=await downloadPromise;
  await download.saveAs(path.join(output,'ui-export.json'));results.push('JSON-Bericht heruntergeladen');
  await page.locator('#scan-btn').click();
  await page.waitForFunction(async()=>{const s=await(await fetch('/api/state')).json();return s.scan.done>0&&!s.scan.running;},{},{timeout:90000});
  const scanned=await(await fetch(base+'/api/state')).json();assert.equal(scanned.scan.error,null);results.push(`Realer lokaler Gerätescan: ${scanned.scan.done}/${scanned.scan.total} Adressen geprüft`);
  for(const width of [1440,768,390,320]) {
    await page.setViewportSize({width,height:1050});
    await page.screenshot({path:path.join(output,`dashboard-${width}.png`),fullPage:true});
    const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
    assert.ok(overflow.scroll<=overflow.width,`Horizontaler Überlauf bei ${width}px: ${overflow.scroll}`);
    results.push(`Layout ${width}px ohne Seitenüberlauf`);
  }
  await target.getByRole('button',{name:'UI-Prüfung entfernen',exact:true}).click();await target.waitFor({state:'detached'});results.push('Eigenes Ziel entfernt');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'browser-results.json'),JSON.stringify({at:new Date().toISOString(),results,errors},null,2));
  console.log(JSON.stringify({results,errors},null,2));
} finally {await browser.close();}
