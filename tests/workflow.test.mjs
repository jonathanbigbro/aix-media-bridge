import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadConfig,writeAtomic,acquireLock,sha} from '../bridge/job-config.mjs';
import {writeProject,projectPath} from '../bridge/project-store.mjs';
import {root,stateDir} from '../bridge/paths.mjs';
import {sanitize,sameNodeIdentity} from '../bridge/redact.mjs';
import {createMediaOperations} from '../bridge/media-ops.mjs';
import {runProject} from '../bridge/project-ops.mjs';
import {verifyBaseline} from '../bridge/baseline.mjs';
import {completedNodeFromNetwork,mappedUploadedReference} from '../bridge/job-evidence.mjs';
import {demoPng} from '../scripts/make-demo-reference.mjs';
import {restoreSession} from '../bridge/job-history.mjs';
async function fixture(fn){
  const key='test-'+randomUUID().slice(0,8),id='TEST-'+randomUUID().toUpperCase(),dir=await fs.mkdtemp(resolve(os.tmpdir(),'aix-portable-')),file=resolve(dir,'job.json'),png=resolve(dir,'ref.png');
  const binding={name:'Synthetic test canvas',canvasIdAlias:sanitize({canvasId:randomUUID()}).canvasId};
  await writeProject(key,binding);await fs.writeFile(png,demoPng());
  const config=JSON.parse(await fs.readFile(resolve(root,'examples/media-job.template.json'),'utf8'));
  Object.assign(config,{schemaVersion:2,jobId:id,project:{key},referencePng:png,outputDir:resolve(root,'outputs',id)});
  config.image.prompt='One teal sphere on an ivory surface.';config.video.prompt='One continuous five-second camera push-in.';config.video.duration=5;
  await fs.writeFile(file,JSON.stringify(config));
  try{await fn({key,id,dir,file,config,binding});}finally{await fs.rm(dir,{recursive:true,force:true});await fs.rm(resolve(root,'jobs',id),{recursive:true,force:true});await fs.unlink(projectPath(key));}
}
test('portable config binds a synthetic canvas without historical files',()=>fixture(async({file,binding})=>{const c=await loadConfig(file);assert.deepEqual(c.config.project,binding);assert.equal(c.config.video.duration,5);assert(c.config.videoAgentPrompt.includes('duration 5 seconds'));assert.equal(c.input.width,640);}));
test('all three story templates resolve the included redacted reference after copying to configs',()=>fixture(async({file,key,id})=>{
 for(const index of [1,2,3]){
  const config=JSON.parse(await fs.readFile(resolve(root,`examples/story/shot-${index}.job.json`),'utf8'));
  const referencePng=resolve(root,'configs',config.referencePng);
  Object.assign(config,{jobId:id,project:{key},referencePng,outputDir:resolve(root,'outputs',id)});
  await fs.writeFile(file,JSON.stringify(config));const c=await loadConfig(file);
  assert.equal(c.input.width,1280);assert.equal(c.config.video.duration,5);
 }
}));
test('unsupported fields, models, duration and extra submissions fail closed',()=>fixture(async({file,config})=>{
  for(const c of [{...config,script:'unused'},...['5',3,6,null].map(duration=>({...config,video:{...config.video,duration}})),{...config,video:{...config.video,model:'other'}},{...config,limits:{...config.limits,videoSubmissions:2}}]){await fs.writeFile(file,JSON.stringify(c));await assert.rejects(loadConfig(file),/INVALID_CONFIG_FIELDS|UNSUPPORTED_OR_UNVERIFIED/);}
}));
test('configuration and input changes cannot silently start the same job again',()=>fixture(async({file,config})=>{
  const c=await loadConfig(file);await writeAtomic(c.ledgerPath,{configDigest:c.digest,stages:{}});assert.equal((await loadConfig(file)).digest,c.digest);
  await fs.writeFile(file,JSON.stringify({...config,video:{...config.video,duration:4}}));await assert.rejects(loadConfig(file),/JOB_CONFIG_CHANGED/);
  await fs.writeFile(file,JSON.stringify(config));const bytes=await fs.readFile(config.referencePng);bytes[bytes.length-5]^=1;await fs.writeFile(config.referencePng,bytes);await assert.rejects(loadConfig(file),/JOB_CONFIG_CHANGED/);
}));
test('project keys cannot be rebound and repeated create makes no browser call',()=>fixture(async({key,binding})=>{
  await assert.rejects(writeProject(key,{...binding,canvasIdAlias:sanitize({canvasId:randomUUID()}).canvasId}),/ALREADY_BOUND/);
  let calls=0;const result=await runProject({call:async()=>{calls++;throw new Error('UNEXPECTED_BROWSER_CALL');}},{operation:'project:create',key,name:binding.name});assert.equal(result.newCanvases,0);assert.equal(calls,0);
}));
test('unknown creation identity cannot adopt or rename another empty canvas',async()=>{
  const key='test-'+randomUUID().slice(0,8),path=resolve(stateDir,'projects',key+'.creation');let calls=0;
  await writeAtomic(path,{key,name:'Synthetic pending canvas',state:'creation-reserved-result-unknown',attempts:1});
  try{await assert.rejects(runProject({call:async()=>{calls++;throw new Error('UNEXPECTED_BROWSER_CALL');}},{operation:'project:create',key,name:'Synthetic pending canvas'}),/CREATION_ID_UNKNOWN/);assert.equal(calls,0);}finally{await fs.unlink(path);}
});
test('reserved, observed and accepted operations cannot submit twice',()=>fixture(async({file,dir})=>{
  const c=await loadConfig(file),ledgerPath=resolve(dir,'ledger.json');let calls=0;
  for(const state of ['action-reserved-result-unknown','observed','accepted-waiting-real-asset']){
    await writeAtomic(ledgerPath,{configDigest:c.digest,stages:Object.fromEntries(['upload','image-chat','video-chat','image-generation','video-generation','video-download'].map(k=>[k,{attempts:1,state}]))});
    const before=sha(await fs.readFile(ledgerPath)),ops=createMediaOperations({...c,dir,ledgerPath});
    for(const op of ['upload','send-image-chat','send-video-chat','submit-image','submit-video','download-video'])await assert.rejects(ops.runMedia({call:async()=>{calls++;}},{operation:'media:'+op}),/ALREADY_ATTEMPTED/);
    assert.equal(sha(await fs.readFile(ledgerPath)),before);
  }assert.equal(calls,0);
}));
test('lock permits one process owner and is reusable after release',async()=>{
  const d=await fs.mkdtemp(resolve(os.tmpdir(),'aix-lock-'));try{const path=resolve(d,'lock'),a=await acquireLock(path);await assert.rejects(acquireLock(path),/LOCKED/);await a.release();await(await acquireLock(path)).release();}finally{await fs.rm(d,{recursive:true,force:true});}
});
test('empty initial canvas is valid; existing assets and connections remain protected',()=>{
  assert(verifyBaseline({nodes:[],connections:[]},{nodes:[{id:'new'}],connections:[]}));
  const baseline={nodes:[{id:'a',target:{findUrl:'https://example.test/a.png'}},{id:'b'}],connections:[{fromId:'a',toId:'b'}]};assert(verifyBaseline(baseline,structuredClone(baseline)));
  const changed=structuredClone(baseline);changed.nodes[0].target.findUrl='https://example.test/b.png';assert.throws(()=>verifyBaseline(baseline,changed),/ASSET_CHANGED/);assert.throws(()=>verifyBaseline(baseline,{...baseline,connections:[]}),/CONNECTION_CHANGED/);
});
test('empty polls are not completion; identity aliases still match',()=>{
  const raw='image-'+randomUUID().replaceAll('-','');assert(sameNodeIdentity(raw,sanitize(raw)));assert(!sameNodeIdentity(raw,'another'));
  const n={requestBodyComplete:true,responseBodyComplete:true,requestBody:JSON.stringify({nodeIds:[raw]}),responseBody:JSON.stringify({code:200,data:{nodeInfoList:[]}})};assert.equal(completedNodeFromNetwork(n,raw),null);
  n.responseBody=JSON.stringify({code:200,data:{nodeInfoList:[{nodeId:raw,status:'2',targetInfoList:[{findUrl:'https://example.test/image.png'}]}]}});assert.equal(completedNodeFromNetwork(n,sanitize(raw)).status,'2');
});
test('an upload timeout can reconcile the prepared node without replaying upload',()=>{
 const id='upload-'+randomUUID().replaceAll('-',''),label='SYNTHETIC__REFERENCE';
 const ledger={stages:{'prepare-upload':{result:{nodeId:sanitize(id)}}}};
 const node={id,label,target:{findUrl:'https://example.test/reference.png'}};
 assert.equal(mappedUploadedReference({nodes:[node]},ledger,label),node);
 assert.equal(mappedUploadedReference({nodes:[{...node,id:'another'}]},ledger,label),null);
 assert.equal(mappedUploadedReference({nodes:[{...node,label:'other'}]},ledger,label),null);
 assert.equal(mappedUploadedReference({nodes:[node]}, {},label),null);
});
test('restarted bridge opens native history immediately when its request cache is empty',async()=>{
  const raw=randomUUID(),sessionId=sanitize({sessionId:raw}).sessionId,prompt='Synthetic recovery prompt';let calls=0,reads=0;
  const api={call:async name=>{assert.equal(name,'evaluate_script');calls++;return {data:{evaluation:{ok:true}}};},fullNetwork:async({path})=>{
    reads++;if(reads===1)throw new Error('NO_ALLOWED_OBSERVED_REQUEST');
    if(path.endsWith('/sessions'))return {responseBody:JSON.stringify({data:[{nodeId:raw,title:'Synthetic history'}]})};
    return {url:'https://example.test/history/'+raw,responseBody:JSON.stringify({data:[{role:'user',content:prompt}]})};
  }};
  const result=await restoreSession(api,{sessionId,prompt});assert.equal(result.switched,true);assert.equal(calls,2);assert.equal(reads,3);
});
