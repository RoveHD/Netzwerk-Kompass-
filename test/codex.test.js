import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CodexClient, discoverCodex, parseCodexOutput } from '../lib/codex.js';

const features='shell_tool unified_exec shell_snapshot apps plugins remote_plugin browser_use browser_use_external computer_use image_generation multi_agent code_mode code_mode_host hooks memories skill_search skill_mcp_dependency_install workspace_dependencies auth_elicitation tool_suggest goals skip_host_skill_discovery'.split(' ');
const help='--ignore-user-config --ephemeral --sandbox --skip-git-repo-check --json --disable --strict-config';
const event=value=>JSON.stringify(value)+'\n';
const successful=text=>event({type:'thread.started',thread_id:'fixture'})+event({type:'turn.started'})+event({type:'item.completed',item:{type:'agent_message',text}})+event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
const code=expected=>error=>error.code===expected;

function fixture({authenticated=true,onExec,onLogin,helpText=help,featureText=features.join('\n')}={}) {
  const calls=[];
  const spawnImpl=(executable,args,options)=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;child.kill=()=>{child.killed=true;return true;};
    const call={executable,args,options,child,input:''};calls.push(call);
    child.stdin.on('data',chunk=>{call.input+=chunk.toString();});
    const finish=(stdout='',stderr='',exitCode=0)=>{if(stdout)child.stdout.write(stdout);if(stderr)child.stderr.write(stderr);child.emit('close',exitCode);};call.finish=finish;
    child.stdin.on('finish',()=>queueMicrotask(()=>{
      if(args[0]==='exec'&&args[1]==='--help')finish(helpText);
      else if(args[0]==='features')finish(featureText);
      else if(args[0]==='login'&&args[1]==='status')finish('',authenticated?'Logged in using ChatGPT':'Not logged in',authenticated?0:1);
      else if(args[0]==='login'){if(onLogin)onLogin(call,()=>{authenticated=true;});else {authenticated=true;finish();}}
      else if(onExec)onExec(call);else finish(successful('Fixture-Auswertung vollständig.'));
    }));
    return child;
  };
  const client=new CodexClient({spawnImpl,discoverImpl:async()=>path.join(os.tmpdir(),'codex-fixture.exe'),timeoutMs:1000});
  return {client,calls,spawnImpl};
}
async function waitFor(predicate) {for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Fixture did not reach expected state');}
async function temp(t) {const dir=await mkdtemp(path.join(os.tmpdir(),'network-codex-test-'));t.after(async()=>{const resolved=path.resolve(dir);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('network-codex-test-'));await rm(resolved,{recursive:true,force:true});});return dir;}

test('parser requires exit zero, completed turn and a completed message',()=>{
  assert.equal(parseCodexOutput(successful('Antwort')), 'Antwort');
  assert.throws(()=>parseCodexOutput(event({type:'item.completed',item:{type:'agent_message',text:'Antwort'}})),code('CODEX_INCOMPLETE'));
  assert.throws(()=>parseCodexOutput(event({type:'turn.completed'})),code('CODEX_INCOMPLETE'));
  assert.throws(()=>parseCodexOutput(successful('Antwort'),1,'private secret'),code('CODEX_FAILED'));
  assert.throws(()=>parseCodexOutput(successful('Antwort')+event({type:'turn.failed',error:{message:'429 quota'}})),code('CODEX_LIMIT'));
  assert.throws(()=>parseCodexOutput(successful('Antwort')+event({type:'turn.started'})),code('CODEX_INCOMPLETE'));
});

test('parser refuses tool calls, unknown events and malformed or bounded output',()=>{
  for(const type of ['command_execution','mcp_tool_call','web_search','file_change','collab_tool_call','image_generation','future_action'])for(const phase of ['item.started','item.updated','item.completed'])assert.throws(()=>parseCodexOutput(event({type:phase,item:{type}})),code('CODEX_TOOLS'));
  assert.throws(()=>parseCodexOutput('{invalid'),code('CODEX_PROTOCOL'));
  assert.throws(()=>parseCodexOutput(event({type:'future.unknown'})),code('CODEX_PROTOCOL'));
  assert.throws(()=>parseCodexOutput('x'.repeat(1024*1024+1)),code('CODEX_OUTPUT'));
  assert.throws(()=>parseCodexOutput(successful('x'.repeat(64001))),code('CODEX_OUTPUT'));
});

test('native startup diagnostic items do not become tools, failures or answer text',()=>{
  // CLI 0.159.2 emitted two completed ErrorItems before turn.started in the
  // synthetic live reproduction. Their messages are deliberately synthetic.
  const warning=event({type:'item.completed',item:{id:'warning_0',type:'error',message:'Synthetic startup warning password=private'}});
  const output=event({type:'thread.started',thread_id:'fixture'})+warning+warning+event({type:'turn.started'})+
    event({type:'item.started',item:{id:'reason_0',type:'reasoning',text:''}})+
    event({type:'item.updated',item:{id:'reason_0',type:'reasoning',text:'Synthetic reasoning'}})+
    event({type:'item.completed',item:{id:'reason_0',type:'reasoning',text:'Synthetic reasoning'}})+
    event({type:'item.started',item:{id:'message_0',type:'agent_message',text:''}})+
    event({type:'item.updated',item:{id:'message_0',type:'agent_message',text:'Partial'}})+
    event({type:'item.completed',item:{id:'message_0',type:'agent_message',text:'Vollständige Auswertung'}})+
    event({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
  assert.equal(parseCodexOutput(output),'Vollständige Auswertung');
  assert.throws(()=>parseCodexOutput(warning+event({type:'turn.completed'})),code('CODEX_INCOMPLETE'));
  assert.throws(()=>parseCodexOutput(output,1,'synthetic failure'),code('CODEX_FAILED'));
  assert.throws(()=>parseCodexOutput(output+event({type:'turn.failed',error:{message:'429 quota'}})),code('CODEX_LIMIT'));
  assert.throws(()=>parseCodexOutput(output+event({type:'error',message:'401 authentication'})),code('CODEX_AUTH'));
});

test('plan status lifecycle is allowed but never substitutes for the final message',()=>{
  const steps=[{text:'Read supplied measurements',completed:false}];
  const progress=event({type:'item.started',item:{id:'plan_0',type:'todo_list',items:steps}})+
    event({type:'item.updated',item:{id:'plan_0',type:'todo_list',items:[{...steps[0],completed:true}]}})+
    event({type:'item.completed',item:{id:'plan_0',type:'todo_list',items:[{...steps[0],completed:true}]}});
  assert.equal(parseCodexOutput(progress+successful('Antwort')),'Antwort');
  assert.throws(()=>parseCodexOutput(progress+event({type:'turn.completed'})),code('CODEX_INCOMPLETE'));
  assert.throws(()=>parseCodexOutput(progress+event({type:'item.started',item:{type:'command_execution',command:'private'}})),code('CODEX_TOOLS'));
});

test('diagnostic and status payloads remain bounded and malformed items fail closed',()=>{
  for(const item of [null,[],{},{type:'error'},{type:'error',message:[]},{type:'error',message:'x'.repeat(64001)},
    {type:'todo_list'},{type:'todo_list',items:[{text:'step',completed:'yes'}]},{type:'todo_list',items:[null]}]) {
    assert.throws(()=>parseCodexOutput(event({type:'item.completed',item})),code('CODEX_PROTOCOL'));
  }
  for(const phase of ['item.started','item.updated'])assert.throws(()=>parseCodexOutput(event({type:phase,item:{type:'error',message:'warning'}})),code('CODEX_PROTOCOL'));
  assert.throws(()=>parseCodexOutput(event({type:'item.updated',item:{type:'agent_message',text:{command:'private'}}})),code('CODEX_OUTPUT'));
  assert.throws(()=>parseCodexOutput(event({type:'item.completed',item:{type:'reasoning',text:[]}})),code('CODEX_OUTPUT'));
  assert.throws(()=>parseCodexOutput(event({type:'item.completed',item:{type:'error',message:'401 invalid token password=private'}})),error=>error.code==='CODEX_AUTH'&&!error.message.includes('private'));
});

test('blocked item errors expose only a fixed safe category',()=>{
  assert.throws(()=>parseCodexOutput(event({type:'item.started',item:{type:'command_execution',command:'password=private'}})),error=>error.code==='CODEX_TOOLS'&&error.message.includes('(Befehl)')&&!error.message.includes('private'));
  assert.throws(()=>parseCodexOutput(event({type:'item.started',item:{type:'private secret item'}})),error=>error.code==='CODEX_TOOLS'&&error.message.includes('(unbekanntes Item)')&&!error.message.includes('secret'));
});

test('parser removes credential patterns and never returns failure text',()=>{
  const result=parseCodexOutput(successful('\u001b[31mAntwort password=hunter2 api_key="private key" sid=secret Bearer tokensecret sk-abcdefghijk\u0000'));
  for(const secret of ['hunter2','private key','secret','tokensecret','sk-abcdefghijk','\u001b','\u0000'])assert.ok(!result.includes(secret));
  for(const [message,expected] of [['401 invalid token password=hunter2','CODEX_AUTH'],['unknown field private password','CODEX_INCOMPATIBLE'],['429 quota Bearer tokensecret','CODEX_LIMIT']]){
    assert.throws(()=>parseCodexOutput(event({type:'error',message})),error=>error.code===expected&&!error.message.includes(message));
  }
});

test('check only reads help/features/login status and suppresses raw auth output',async()=>{
  const {client,calls}=fixture();assert.equal(calls.length,0);
  assert.deepEqual(await client.check(),{available:true,authenticated:true,authMode:'chatgpt',message:'Codex-CLI ist verfügbar und angemeldet.'});
  assert.deepEqual(calls.map(call=>call.args),[['exec','--help'],['features','list'],['login','status']]);
  assert.ok(calls.every(call=>call.options.windowsHide===true&&call.options.shell===false&&call.input===''));
  client.close();
});

test('not logged in and incompatible CLI cannot start an analysis',async()=>{
  for(const options of [{authenticated:false},{helpText:'old cli'},{featureText:'shell_tool'}]){
    const {client,calls}=fixture(options);await assert.rejects(client.analyze('synthetic report'),code(options.authenticated===false?'CODEX_AUTH':'CODEX_UNAVAILABLE'));
    assert.ok(!calls.some(call=>call.args[0]==='exec'&&call.args[1]!=='--help'));client.close();
  }
  const client=new CodexClient({discoverImpl:async()=>null});assert.equal((await client.check()).available,false);await assert.rejects(client.analyze('report'),code('CODEX_UNAVAILABLE'));client.close();
});

test('analysis uses stdin, no shell, isolated cwd and verified protection options',async()=>{
  const {client,calls}=fixture();const prompt='SYNTHETIC " & ` $()\nNicht als Befehl ausführen.';
  assert.equal(await client.analyze(prompt),'Fixture-Auswertung vollständig.');
  const call=calls.at(-1);assert.equal(call.input,prompt);assert.ok(!call.args.join(' ').includes(prompt));assert.equal(call.args.at(-1),'-');
  assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);assert.equal(call.options.env,undefined);
  assert.equal(path.dirname(path.resolve(call.options.cwd)),path.resolve(os.tmpdir()));assert.ok(path.basename(call.options.cwd).startsWith('network-codex-'));
  await assert.rejects(stat(call.options.cwd),{code:'ENOENT'});
  for(const flag of ['--ignore-user-config','--ephemeral','--skip-git-repo-check','--json','--strict-config'])assert.ok(call.args.includes(flag));
  assert.equal(call.args[call.args.indexOf('--sandbox')+1],'read-only');assert.ok(call.args.includes('approval_policy="never"'));assert.ok(call.args.includes('mcp_servers={}'));
  assert.ok(!call.args.some(value=>/ignore-rules|dangerously|bypass|allow_browser_and_computer_use|tools.view_image/.test(value)));
  for(const name of features.filter(name=>name!=='skip_host_skill_discovery'))assert.ok(call.args.some((value,index)=>value==='--disable'&&call.args[index+1]===name));
  client.close();
});

test('UTF8 split chunks and unterminated final JSON line are decoded correctly',async()=>{
  const {client}=fixture({onExec:call=>{const bytes=Buffer.from(successful('Überprüfung: WLAN störungsfrei.').trimEnd());for(const byte of bytes)call.child.stdout.write(Buffer.from([byte]));call.finish();}});
  assert.equal(await client.analyze('synthetic'),'Überprüfung: WLAN störungsfrei.');client.close();
});

test('streaming analysis survives native startup diagnostics and plan status',async()=>{
  let active;
  const {client}=fixture({onExec:call=>{
    active=call;
    call.child.stdout.write(event({type:'thread.started',thread_id:'fixture'}));
    for(let i=0;i<2;i++)call.child.stdout.write(event({type:'item.completed',item:{id:`warning_${i}`,type:'error',message:'Synthetic startup warning'}}));
    call.child.stdout.write(event({type:'turn.started'}));
    for(const phase of ['item.started','item.updated','item.completed'])call.child.stdout.write(event({type:phase,item:{type:'todo_list',items:[{text:'Review supplied values',completed:phase==='item.completed'}]}}));
    call.finish(event({type:'item.completed',item:{type:'agent_message',text:'Synthetische Auswertung'}})+event({type:'turn.completed'}));
  }});
  assert.equal(await client.analyze('synthetic'),'Synthetische Auswertung');assert.equal(active.child.killed,false);client.close();
});

test('tool event kills process immediately and cannot become success on late close',async()=>{
  let call;const {client}=fixture({onExec:value=>{call=value;call.child.stdout.write(event({type:'item.started',item:{type:'command_execution',command:'echo secret'}}));}});
  await assert.rejects(client.analyze('synthetic'),code('CODEX_TOOLS'));assert.equal(call.child.killed,true);call.finish(successful('late answer'));client.close();
});

test('one in-flight analysis, cancellation rejects and next manual job is allowed',async()=>{
  let active;const {client,calls}=fixture({onExec:call=>{active=call;}});const controller=new AbortController();
  const first=client.analyze('synthetic one',{signal:controller.signal});const rejected=assert.rejects(first,code('CODEX_CANCELLED'));await waitFor(()=>active);
  await assert.rejects(client.analyze('concurrent'),code('CODEX_BUSY'));controller.abort();await rejected;assert.equal(active.child.killed,true);
  const old=active;active=null;const second=client.analyze('synthetic two');await waitFor(()=>active);old.finish(successful('Old late result'));active.finish(successful('New result'));assert.equal(await second,'New result');assert.equal(calls.filter(call=>call.args[0]==='exec'&&call.args[1]!=='--help').length,2);client.close();
});

test('close cancels pending job permanently; already aborted signal never spawns',async()=>{
  let active;const {client,calls}=fixture({onExec:call=>{active=call;}});const controller=new AbortController();controller.abort();await assert.rejects(client.analyze('synthetic',{signal:controller.signal}),code('CODEX_CANCELLED'));assert.equal(calls.length,0);
  const promise=client.analyze('synthetic');const rejected=assert.rejects(promise,code('CODEX_CANCELLED'));await waitFor(()=>active);client.close();await rejected;assert.equal(active.child.killed,true);await assert.rejects(client.analyze('again'),code('CODEX_CLOSED'));await assert.rejects(client.check(),code('CODEX_CLOSED'));
});

test('deadline covers preflight/discovery, and kills a stalled analysis',async()=>{
  const discovery=new CodexClient({discoverImpl:()=>new Promise(()=>{}),timeoutMs:15});await assert.rejects(discovery.analyze('synthetic'),code('CODEX_TIMEOUT'));discovery.close();
  let active;const f=fixture({onExec:call=>{active=call;}});const client=new CodexClient({spawnImpl:f.spawnImpl,discoverImpl:async()=>'/fixture/codex.exe',timeoutMs:250});await assert.rejects(client.analyze('synthetic'),code('CODEX_TIMEOUT'));assert.equal(active.child.killed,true);client.close();f.client.close();
});

test('stdout/stderr bounds kill the worker and do not expose diagnostic text',async()=>{
  for(const stream of ['stdout','stderr']){let active;const {client}=fixture({onExec:call=>{active=call;call.child[stream].write('private secret '.repeat(stream==='stdout'?80000:12000));}});await assert.rejects(client.analyze('synthetic'),error=>error.code==='CODEX_OUTPUT'&&!error.message.includes('private secret'));assert.equal(active.child.killed,true);client.close();}
});

test('spawn and input stream errors are sanitized',async()=>{
  const client=new CodexClient({discoverImpl:async()=>'/fixture',spawnImpl:()=>{throw Object.assign(new Error('private secret'),{code:'ENOENT'});}});assert.equal((await client.check()).available,false);client.close();
  const {client:input}=fixture({onExec:call=>call.child.stdin.emit('error',new Error('private password'))});await assert.rejects(input.analyze('synthetic'),error=>error.code==='CODEX_INPUT'&&!error.message.includes('private'));input.close();
});

test('unexpected close or process error rejects without exposing stderr',async()=>{
  for(const mode of ['close','error']){const {client}=fixture({onExec:call=>{if(mode==='close')call.finish('', 'private credential',1);else call.child.emit('error',new Error('private credential'));}});await assert.rejects(client.analyze('synthetic'),error=>error.code===(mode==='close'?'CODEX_FAILED':'CODEX_START')&&!error.message.includes('private credential'));client.close();}
});

test('login is only explicit, uses ordinary browser command and checks confirmed auth',async()=>{
  const {client,calls}=fixture({authenticated:false,onLogin:(call,authenticated)=>{authenticated();call.finish('Browser login fixture');}});await client.login();assert.equal(calls.filter(call=>call.args[0]==='login'&&call.args.length===1).length,1);assert.ok(!calls.flatMap(call=>call.args).some(arg=>/api-key|access-token|device-auth/.test(arg)));client.close();
  const failed=fixture({authenticated:false,onLogin:call=>call.finish('', 'private token',1)});await assert.rejects(failed.client.login(),error=>error.code==='CODEX_FAILED'&&!error.message.includes('private'));failed.client.close();
});

test('unconfirmed successful login is rejected and login can be cancelled',async()=>{
  const unconfirmed=fixture({authenticated:false,onLogin:call=>call.finish()});await assert.rejects(unconfirmed.client.login(),code('CODEX_AUTH'));unconfirmed.client.close();
  let active;const pending=fixture({authenticated:false,onLogin:call=>{active=call;}});const promise=pending.client.login();const rejected=assert.rejects(promise,code('CODEX_CANCELLED'));await waitFor(()=>active);pending.client.cancel();await rejected;assert.equal(active.child.killed,true);pending.client.close();
});

test('invalid prompt and oversized time limit rejected before any subprocess',async()=>{
  const {client,calls}=fixture();for(const value of ['',null,'x'.repeat(512*1024+1)])await assert.rejects(client.analyze(value),code('CODEX_PROMPT'));assert.equal(calls.length,0);assert.throws(()=>new CodexClient({timeoutMs:300001}),TypeError);client.close();
});

test('discovery uses native PATH executable; never a .cmd shell shim',async t=>{
  const dir=await temp(t);await writeFile(path.join(dir,'codex.cmd'),'fixture only');assert.equal(await discoverCodex({platform:'win32',env:{PATH:dir,LOCALAPPDATA:dir}}),null);await writeFile(path.join(dir,'codex.exe'),'fixture only');assert.equal(await discoverCodex({platform:'win32',env:{PATH:dir,LOCALAPPDATA:dir}}),path.join(dir,'codex.exe'));
});

test('discovery supports official app bin and nested npm optional native package',async t=>{
  const dir=await temp(t);const app=path.join(dir,'OpenAI','Codex','bin','de8a38d2100ae498','codex.exe');await mkdir(path.dirname(app),{recursive:true});await writeFile(app,'fixture only');assert.equal(await discoverCodex({platform:'win32',env:{LOCALAPPDATA:dir}}),app);
  const npm=path.join(dir,'npm','node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','codex','codex.exe');await mkdir(path.dirname(npm),{recursive:true});await writeFile(npm,'fixture only');assert.equal(await discoverCodex({platform:'win32',env:{LOCALAPPDATA:path.join(dir,'absent'),APPDATA:dir}}),npm);
});
