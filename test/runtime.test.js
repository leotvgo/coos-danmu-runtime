import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdir, mkdtemp, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';
import { RuntimeClient } from '../src/client.js';
import { inspectArtifact, digest } from '../src/compatibility.js';
import { validateReleaseManifest } from '../src/channel.js';

const artifact=process.env.DANMU_ARTIFACT_DIR;
if(!artifact)throw new Error('Set DANMU_ARTIFACT_DIR to the built component directory');
const bytes=await readFile(join(artifact,'danmu_api_server.cjs'));
const manifest=validateReleaseManifest(JSON.parse(await readFile(join(artifact,'manifest.json'),'utf8')));
const config='TOKEN="test-player"\nADMIN_TOKEN="test-admin"\nSOURCE_ORDER="local"\nRATE_LIMIT_MAX_REQUESTS="0"\n';
async function instance(work) {
  const dir=await mkdtemp(join(tmpdir(),'coos-component-'));
  await mkdir(join(dir,'config'));await writeFile(join(dir,'config/.env'),config,{mode:0o600});
  const client=new RuntimeClient({bytes,dataDir:dir});
  try{return await work(client,dir);}finally{await client.close();await rm(dir,{recursive:true,force:true});}
}
const request=(client,path,body)=>client.request({method:body===undefined?'GET':'POST',path,origin:'http://127.0.0.1:9321',
  headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});

test('manifest identifies exact bytes, original upstream, version and immutable source',()=>{
  assert.equal(bytes.length,manifest.size);assert.equal(digest(bytes),manifest.sha256);
  assert.equal(inspectArtifact(bytes,manifest).version,manifest.version);
  assert.throws(()=>validateReleaseManifest({...manifest,source:'another/repo'}));
  assert.throws(()=>inspectArtifact(bytes,{sha256:'0'.repeat(64)}));
});
test('complete management interface initializes and supports original configuration controls',async()=>instance(async client=>{
  const cfg=await request(client,'/test-admin/api/config');assert.equal(cfg.status,200);
  const value=JSON.parse(cfg.body);assert.equal(value.version,manifest.version);assert.ok(Object.keys(value.envs).length>50);
  const page=await request(client,'/test-admin/');assert.equal(page.status,200);
  for(const marker of ['BILIBILI_COOKIE','cookie/qr/generate','SOURCE_ORDER','AI_MATCH_PROMPT','local-danmu'])assert.ok(page.body.includes(marker));
  const errors=[];let active=0,configCalls=0;
  const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error.name));
  const dom=new JSDOM(page.body.toString(),{url:'http://127.0.0.1:9321/test-admin/',runScripts:'dangerously',virtualConsole:vc,beforeParse(window){
    window.matchMedia=()=>({matches:false,addEventListener(){},addListener(){}});
    window.fetch=async(url,options={})=>{
      active++;const u=new URL(url,'http://127.0.0.1:9321/test-admin/');if(u.pathname.endsWith('/api/config'))configCalls++;
      try {const r=await client.request({method:options.method||'GET',path:u.pathname+u.search,origin:u.origin,headers:options.headers,body:options.body});
        return {ok:r.status<400,status:r.status,json:async()=>JSON.parse(r.body),text:async()=>r.body.toString()};
      }finally{active--;}
    };
  }});
  try {
    for(let i=0;i<100&&(!configCalls||active);i++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(configCalls);assert.deepEqual(errors,[]);
  }finally{dom.window.close();}
}));
test('local upload, numeric matches and JSON/XML comments preserve episode identity',async()=>instance(async client=>{
  for(const episode of ['1','2']) {
    const form=new FormData();form.set('file',new Blob(['<i><d p="1,1,25,16777215,0,0,0,1">Episode '+episode+'</d></i>']),'test.xml');
    for(const [key,value] of Object.entries({title:'COOS测试剧',year:String(new Date().getFullYear()),type:'tv',season:'1',episode}))form.set(key,value);
    const body=new Request('http://fixture.invalid',{method:'POST',body:form});
    const r=await client.request({method:'POST',path:'/test-admin/api/v2/local-danmu/upload',
      headers:{'content-type':body.headers.get('content-type')},body:Buffer.from(await body.arrayBuffer())});
    assert.equal(r.status,200);assert.equal(JSON.parse(r.body).success,true);
  }
  const ids=[];
  for(const episode of ['1','2']) {
    const match=JSON.parse((await request(client,'/test-player/api/v2/match',{fileName:'COOS测试剧 S01E0'+episode})).body);
    assert.equal(match.isMatched,true);const id=match.matches[0].episodeId;assert.equal(typeof id,'number');ids.push(id);
    const json=await request(client,'/test-player/api/v2/comment/'+id);assert.match(json.headers['content-type'],/json/);assert.ok(JSON.parse(json.body).comments.length);
    const xml=await request(client,'/test-player/api/v2/comment/'+id+'?format=xml');assert.match(xml.body.toString(),new RegExp('Episode '+episode));
  }
  assert.notEqual(ids[0],ids[1]);
  const missing=JSON.parse((await request(client,'/test-player/api/v2/match',{fileName:'No Such Series S01E01'})).body);
  assert.equal(missing.isMatched,false);assert.ok(Array.isArray(missing.matches));
}));
test('configuration survives Worker replacement',async()=>instance(async(client,dir)=>{
  const saved=await request(client,'/test-admin/api/env/set',{key:'BILIBILI_COOKIE',value:'synthetic-test-cookie'});
  assert.equal(saved.status,200);assert.equal(JSON.parse(saved.body).success,true);
  await client.close();const replacement=new RuntimeClient({bytes,dataDir:dir});
  try {await replacement.ready;assert.match(await readFile(join(dir,'config/.env'),'utf8'),/synthetic-test-cookie/);
    assert.equal((await request(replacement,'/test-admin/api/config')).status,200);
  }finally{await replacement.close();}
}));
test('standalone CJS can start without a pre-existing configuration and save it',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'coos-standalone-'));await mkdir(join(dir,'dist'));
  await copyFile(join(artifact,'danmu_api_server.cjs'),join(dir,'dist/runtime.cjs'));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;
  await new Promise(resolve=>socket.close(resolve));let child,stderr='';
  try {
    // Allocate an ephemeral auxiliary port instead of colliding with a local UZN service.
    const boot="const http=require('node:http'),listen=http.Server.prototype.listen;http.Server.prototype.listen=function(o,...a){if(o?.port===5321)o={...o,port:0};return listen.call(this,o,...a)};try{require('./dist/runtime.cjs')}catch(e){process.stderr.write(e.name+': '+e.message);process.exit(1)}";
    child=spawn(process.execPath,['-e',boot],{cwd:dir,stdio:['ignore','ignore','pipe'],env:{PATH:process.env.PATH,NODE_ENV:'production',DANMU_API_PORT:String(port),TOKEN:'test-player',ADMIN_TOKEN:'test-admin',SOURCE_ORDER:'local',RATE_LIMIT_MAX_REQUESTS:'0'}});
    child.on('error',()=>{});child.stderr.on('data',v=>{stderr=(stderr+v).slice(-1000);});
    const base='http://127.0.0.1:'+port+'/test-admin';let ready=false;
    for(let i=0;i<100;i++) {assert.equal(child.exitCode,null,stderr);
      try {const r=await fetch(base+'/api/config',{signal:AbortSignal.timeout(500)});if(r.ok){await r.arrayBuffer();ready=true;break;}await r.arrayBuffer();}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(ready);
    const r=await fetch(base+'/api/env/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'SOURCE_ORDER',value:'local'})});
    assert.equal(r.status,200);assert.equal((await r.json()).success,true);
  }finally{if(child?.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2000);await exited;clearTimeout(timer);}await rm(dir,{recursive:true,force:true});}
});
