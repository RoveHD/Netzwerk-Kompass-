import test from 'node:test';
import assert from 'node:assert/strict';
import { initNavigation, pages, pageFromHash } from '../public/navigation.js';

function fixture(hash='',storage=new Map()) {
  const containers=pages.map(page=>({dataset:{page:page.id},hidden:false}));
  const links=pages.map(page=>({dataset:{navPage:page.id},attributes:{},classes:new Set(),listeners:{},setAttribute(key,value){this.attributes[key]=value;},removeAttribute(key){delete this.attributes[key];},addEventListener(key,fn){this.listeners[key]=fn;},classList:{toggle(){}}}));
  for(const link of links)link.classList.toggle=(key,on)=>on?link.classes.add(key):link.classes.delete(key);
  const changes=[];let focused=0;const listeners={};const window={location:{hash},sessionStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)},history:{pushState(_state,_title,next){window.location.hash=next;}},addEventListener:(key,fn)=>{listeners[key]=fn;},scrollTo(){}};
  const document={querySelectorAll:selector=>selector==='[data-page]'?containers:links,querySelector:()=>({focus(){focused++;}})};
  const navigation=initNavigation({document,window,onChange:page=>changes.push(page.id)});
  return {navigation,containers,links,changes,window,listeners,focused:()=>focused,storage};
}

test('known hashes and reload restore one visible area with the correct current link',()=>{
  const f=fixture('#router');assert.equal(f.navigation.activePage,'router');
  assert.deepEqual(f.containers.filter(c=>!c.hidden).map(c=>c.dataset.page),['router']);
  assert.deepEqual(f.links.filter(link=>link.attributes['aria-current']==='page').map(link=>link.dataset.navPage),['router']);
  assert.equal(fixture('#router',f.storage).navigation.activePage,'router');
});

test('target-history navigation switches pages synchronously and hash back restores the prior area',()=>{
  const f=fixture('#devices');assert.equal(f.navigation.navigate('history'),true);assert.equal(f.window.location.hash,'#history');
  assert.equal(f.containers.find(c=>c.dataset.page==='history').hidden,false);assert.equal(f.containers.find(c=>c.dataset.page==='devices').hidden,true);
  f.window.location.hash='#devices';f.listeners.hashchange();assert.equal(f.navigation.activePage,'devices');
  f.window.location.hash='#main';f.listeners.hashchange();assert.equal(f.navigation.activePage,'devices');
  assert.equal(fixture('#main',f.storage).navigation.activePage,'devices');
});

test('unknown hashes and IDs never become selectors, HTML or a forced page change',()=>{
  const f=fixture('#tests');for(const hash of ['#<img src=x>','#history/../../','#constructor','#%61i','#HISTORY','']){assert.equal(pageFromHash(hash),null);f.window.location.hash=hash;f.listeners.hashchange();assert.equal(f.navigation.activePage,'tests');}
  assert.equal(f.navigation.navigate('<script>'),false);assert.equal(f.navigation.activePage,'tests');
  assert.equal(fixture('#invalid').navigation.activePage,'overview');
});

test('native links work with keyboard clicks and keep modified clicks native',()=>{
  const f=fixture();const link=f.links.find(link=>link.dataset.navPage==='ai');let prevented=0;
  link.listeners.click({button:0,ctrlKey:true,preventDefault(){prevented++;}});assert.equal(f.navigation.activePage,'overview');assert.equal(prevented,0);
  link.listeners.click({button:0,preventDefault(){prevented++;}});assert.equal(f.navigation.activePage,'ai');assert.equal(prevented,1);assert.equal(f.focused(),1);
});
