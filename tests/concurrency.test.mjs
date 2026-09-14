import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {resolve} from 'node:path';
import {main} from '../bridge/job-run.mjs';
import {createMediaOperations} from '../bridge/media-ops.mjs';
import {acquireLock,readJson,writeAtomic,sha} from '../bridge/job-config.mjs';
import {sanitize} from '../bridge/redact.mjs';

const barrier=()=>{let release;const promise=new Promise(r=>{release=r;});return {promise,release};};
async function fixture(fn){
 const dir=await fs.mkdtemp(resolve(os.tmpdir(),'aix-concurrency-'));
 const config={jobId:'SYNTHETIC-LOCK',project:{name:'Synthetic lock canvas',canvasIdAlias:sanitize({canvasId:'synthetic-canvas'}).canvasId},image:{model:'main_image',workflowId:'248',resolution:'2k',ratio:'16:9',count:1},video:{model:'1888',workflowId:'225',duration:4,resolution:'720p',ratio:'16:9',count:1},outputDir:resolve(dir,'output')};
 const ledger={runId:config.jobId,phase:'image-generation:observed',stages:{'image-generation':{attempts:1,state:'accepted-waiting-real-asset',existingCdpRequests:[],ack:{httpStatus:200,response:{code:200},checks:{workflow:false,resolution:false}}}}};
 const ctx={config,dir,ledgerPath:resolve(dir,'ledger.json'),existing:true};await writeAtomic(ctx.ledgerPath,ledger);
 await writeAtomic(resolve(dir,'result.json'),{state:'completed',marker:'keep original result'});await writeAtomic(resolve(config.outputDir,config.jobId+'__manifest.json'),{state:'completed',marker:'keep original manifest'});
 let browserCalls=0;const messages=[];
 const api={call:async()=>{browserCalls++;return {data:{evaluation:{canvasId:'synthetic-canvas',nodes:[],cards:[],generating:false}}};}};
 const adapters={loadConfig:async()=>ctx,emit:value=>messages.push(value),request:async q=>{browserCalls++;if(q.op==='bind')return {};return {ledger:await readJson(ctx.ledgerPath),page:{nodes:[]}};}};
 const status=layer=>layer==='cli'?main(['status','--job','synthetic'],adapters):createMediaOperations(ctx).runMedia(api,{operation:'media:status'});
 try{await fn({ctx,ledger,status,messages,browserCalls:()=>browserCalls,api,adapters});}finally{await fs.rm(dir,{recursive:true,force:true});}
}
async function hashes(dir){const result={};async function walk(path){for(const e of await fs.readdir(path,{withFileTypes:true})){const p=resolve(path,e.name);if(e.isDirectory())await walk(p);else result[p.slice(dir.length+1)]=sha(await fs.readFile(p));}}await walk(dir);return result;}
// Capture the first ledger read, then hold its returned snapshot until a real
// locked writer commits the newer state. No timers determine the interleaving.
async function interleave(ctx,reader,write){
 const read=fs.readFile,arrived=barrier(),continueRead=barrier();let intercepted=false;
 fs.readFile=async function(path,...args){const bytes=await read.call(this,path,...args);if(String(path)===ctx.ledgerPath&&!intercepted){intercepted=true;arrived.release();await continueRead.promise;}return bytes;};
 let reading;
 try{
  reading=reader();await arrived.promise;
  const owner=await acquireLock(resolve(ctx.dir,'.lock'));
  try{await withJobMutation({...ctx,lockToken:owner.owner.token},write);}finally{await owner.release();}
  continueRead.release();return await reading;
 }finally{continueRead.release();fs.readFile=read;await reading?.catch(()=>{});}
}
for(const layer of ['cli','operation'])for(const transition of ['reservation','acknowledgement','completion']){
 test(`${layer} status cannot overwrite a concurrent ${transition}`,{timeout:5000},()=>fixture(async({ctx,ledger,status})=>{
  const latest=structuredClone(ledger);
  latest.stages['video-generation']={attempts:1,state:transition==='reservation'?'action-reserved-result-unknown':transition==='acknowledgement'?'accepted-waiting-real-asset':'asset-record-observed',...(transition==='reservation'?{}:{ack:{response:{code:200},marker:'new acknowledgement'}})};
  latest.phase='video-generation:'+transition;
  await interleave(ctx,()=>status(layer),()=>writeAtomic(ctx.ledgerPath,latest));
  assert.deepEqual(await readJson(ctx.ledgerPath),latest,'new reservation/response/completion must remain byte-for-byte attributable to the writer');
 }));
}
for(const layer of ['cli','operation'])test(`${layer} status diagnoses errors without changing any job/result/manifest bytes`,()=>fixture(async({ctx,status,messages,browserCalls})=>{
 const before=await hashes(ctx.dir),value=await status(layer),reported=layer==='cli'?messages.at(-1):value;
 assert.deepEqual(await hashes(ctx.dir),before,'status must not write even invalidation backups');
 assert.equal(reported.parameterValidation.blocked,true);assert.equal(reported.observedPhase,'image-generation:observed');assert.equal(browserCalls(),0);
}));
test('CLI status never dispatches bind or any browser request',()=>fixture(async({status,browserCalls})=>{await status('cli');assert.equal(browserCalls(),0);}));

import {withJobMutation,writeJobJson} from '../bridge/job-lock.mjs';
import {validateGenerations} from '../bridge/generation-validation.mjs';
import {runJob} from '../bridge/job-flow.mjs';
import {createDaemonOperations} from '../bridge/daemon-operations.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

test('daemon status stays local while a writer is active and preserves the bound browser target',()=>fixture(async({ctx})=>{
 const calls=[],client={callTool:async request=>{const {name,arguments:args}=request;calls.push({name,args});return {structuredContent:name==='list_pages'?{pages:[{id:7,url:'https://aix.studio/AixCanvas',title:'Synthetic canvas'}]}:{evaluation:{ok:true}}};}};
 const daemon=createDaemonOperations({client,version:'synthetic',metricsPath:resolve(ctx.dir,'synthetic-metrics.jsonl'),runFlow:(api,input)=>input.operation==='probe'?api.call('evaluate_script',{function:'()=>true'}):runJob(api,input,{loadConfig:async()=>ctx})});
 await daemon.dispatch({op:'bind',pageId:7});const beforeCalls=calls.length;
 await withJobMutation(ctx,async()=>{
  const before=await hashes(ctx.dir);
  const result=await daemon.dispatch({op:'flow',args:{operation:'job:status',configPath:'synthetic'}});
  assert.equal(result.parameterValidation.blocked,true);assert.equal(result.readOnly,true);assert.deepEqual(await hashes(ctx.dir),before);assert.equal(calls.length,beforeCalls);
 });
 await daemon.dispatch({op:'flow',args:{operation:'probe'}});assert.equal(calls.at(-1).args.pageId,7);
}));
test('daemon rejects missing/wrong workflow ownership, including restored verification',()=>fixture(async({ctx,api,browserCalls})=>{
 const before=await hashes(ctx.dir);
 for(const operation of ['init','wait-generation','verify-restored'])for(const lockToken of [undefined,'wrong-owner'])await assert.rejects(runJob(api,{operation:'job:'+operation,configPath:'synthetic',lockToken},{loadConfig:async()=>ctx}),/JOB_LOCK_REQUIRED/);
 assert.deepEqual(await hashes(ctx.dir),before);assert.equal(browserCalls(),0);
}));
test('daemon accepts delegated CLI ownership without reacquiring its workflow lock', {timeout:5000},()=>fixture(async({ctx,api})=>{
 const owner=await acquireLock(resolve(ctx.dir,'.lock'));
 try{
  const result=await runJob(api,{operation:'job:wait-generation',configPath:'synthetic',lockToken:owner.owner.token},{loadConfig:async()=>ctx});
  assert.equal(result.state,'submitted-payload-mismatch-do-not-resubmit');assert.equal((await readJson(ctx.ledgerPath)).phase,'blocked-submitted-parameters');
  assert.equal((await readJson(resolve(ctx.dir,'.lock'))).token,owner.owner.token);assert.equal(await readJson(resolve(ctx.dir,'.mutation.lock')),null);
 }finally{await owner.release();}
}));
test('persistent validation cannot bypass another workflow owner; status can still diagnose',()=>fixture(async({ctx,status})=>{
 const owner=await acquireLock(resolve(ctx.dir,'.lock'));
 try{const before=await hashes(ctx.dir);await assert.rejects(validateGenerations(ctx),/LOCKED/);assert.equal((await status('operation')).parameterValidation.blocked,true);assert.deepEqual(await hashes(ctx.dir),before);}finally{await owner.release();}
}));
test('a delayed writer retains exclusion after CLI ownership is released and cannot write with stale ownership',{timeout:5000},()=>fixture(async({ctx})=>{
 const owner=await acquireLock(resolve(ctx.dir,'.lock')),entered=barrier(),finish=barrier();let replacement;
 const delayed=withJobMutation({...ctx,lockToken:owner.owner.token},async()=>{entered.release();await finish.promise;await writeJobJson(ctx,ctx.ledgerPath,{phase:'stale writer'});});
 const rejected=assert.rejects(delayed,/JOB_LOCK_REQUIRED/);
 try{
  await entered.promise;await owner.release();replacement=await acquireLock(resolve(ctx.dir,'.lock'));
  await assert.rejects(validateGenerations({...ctx,lockToken:replacement.owner.token}),/LOCKED/);
  finish.release();await rejected;assert.notEqual((await readJson(ctx.ledgerPath)).phase,'stale writer');
  assert.equal((await readJson(resolve(ctx.dir,'.lock'))).token,replacement.owner.token);
 }finally{finish.release();await rejected;await replacement?.release();await owner.release();}
}));
test('persistent validation reads latest state only after both locks are held',()=>fixture(async({ctx,ledger})=>{
 ctx.existing=structuredClone(ledger);const latest=structuredClone(ledger);latest.stages['video-generation']={attempts:1,state:'action-reserved-result-unknown'};latest.phase='newest-reservation';await writeAtomic(ctx.ledgerPath,latest);
 const read=fs.readFile;let observed=false;
 fs.readFile=async function(path,...args){if(String(path)===ctx.ledgerPath&&!observed){observed=true;for(const name of ['.lock','.mutation.lock'])assert(JSON.parse(await read(resolve(ctx.dir,name),'utf8')).token);}return read.call(this,path,...args);};
 try{assert((await validateGenerations(ctx)).blocked);}finally{fs.readFile=read;}
 const saved=await readJson(ctx.ledgerPath);assert(observed);assert.equal(saved.stages['video-generation'].attempts,1);assert.equal(saved.phaseBeforeParameterBlock,'newest-reservation');
}));
for(const mode of ['run','resume'])test(`${mode} persists blocking and invalidated results inside the task transaction`,()=>fixture(async({ctx,adapters})=>{
 await assert.rejects(main([mode,'--job','synthetic'],{...adapters,projectLockPath:resolve(ctx.dir,'.project.lock')}),/SUBMITTED_PARAMETERS_BLOCKED/);
 const result=await readJson(resolve(ctx.dir,'result.json'));assert.equal(result.state,'blocked-submitted-parameters');assert.equal((await readJson(ctx.ledgerPath)).phase,'blocked-submitted-parameters');
 assert.equal(await readJson(resolve(ctx.dir,'.lock')),null);assert.equal(await readJson(resolve(ctx.dir,'.mutation.lock')),null);
}));
test('guarded JSON writes cannot execute outside a task mutation transaction',()=>fixture(async({ctx})=>{
 const before=await hashes(ctx.dir);await assert.rejects(writeJobJson(ctx,ctx.ledgerPath,{phase:'unguarded'}),/JOB_MUTATION_LOCK_REQUIRED/);assert.deepEqual(await hashes(ctx.dir),before);
}));
test('CLI status interleaves deterministically with a separate delegated writer process',{timeout:10000},()=>fixture(async({ctx,status,ledger})=>{
 const owner=await acquireLock(resolve(ctx.dir,'.lock'));
 const lockModule=new URL('../bridge/job-lock.mjs',import.meta.url).href;
 const code=`import {withJobMutation,writeJobJson} from ${JSON.stringify(lockModule)};process.once('message',async({ctx,ledger})=>{try{await withJobMutation(ctx,()=>writeJobJson(ctx,ctx.ledgerPath,ledger));process.send({state:'committed'});}catch(e){process.send({error:e.message});}finally{process.disconnect();}});process.send({state:'ready'});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe','ipc']});
 const read=fs.readFile,arrived=barrier(),resume=barrier();let intercepted=false,reading;
 try{
  assert.equal((await once(child,'message'))[0].state,'ready');
  fs.readFile=async function(path,...args){const bytes=await read.call(this,path,...args);if(String(path)===ctx.ledgerPath&&!intercepted){intercepted=true;arrived.release();await resume.promise;}return bytes;};
  reading=status('cli');await arrived.promise;
  const latest={...ledger,phase:'video-generation:reserved',stages:{...ledger.stages,'video-generation':{attempts:1,state:'action-reserved-result-unknown'}}};
  const committed=once(child,'message');child.send({ctx:{...ctx,lockToken:owner.owner.token},ledger:latest});assert.equal((await committed)[0].state,'committed');
  resume.release();await reading;assert.deepEqual(await readJson(ctx.ledgerPath),latest);
 }finally{resume.release();fs.readFile=read;await reading?.catch(()=>{});if(child.exitCode===null)child.kill();await owner.release();}
}));
