import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {createMediaOperations} from '../bridge/media-ops.mjs';
import {sanitize} from '../bridge/redact.mjs';

async function fixture(fn){
 const dir=await fs.mkdtemp(resolve(os.tmpdir(),'aix-regression-'));
 const config={jobId:'SYNTHETIC',project:{name:'Synthetic canvas',canvasIdAlias:sanitize({canvasId:'synthetic-canvas'}).canvasId},labels:{reference:'SYNTHETIC__REF',image:'SYNTHETIC__IMAGE'},image:{model:'main_image',workflowId:'248',ratio:'16:9',resolution:'2k',count:1},video:{model:'1888',workflowId:'225',duration:4,ratio:'16:9',resolution:'720p',count:1},outputDir:resolve(dir,'output')};
 const ledger={runId:config.jobId,phase:'image-generation:observed',referenceNodeId:'ref',imageNodeId:'generated',imageLabel:config.labels.image,imageGenerationPrompt:'A boy types on a keyboard.',stages:{upload:{asset:{target:{findUrl:'https://example.test/ref.png'}}},'image-generation':{attempts:1,existingCdpRequests:[],ack:{response:{code:200},checks:{workflow:false,resolution:false}}}}};
 const ctx={config,dir,ledgerPath:resolve(dir,'ledger.json')};
 const save=()=>fs.writeFile(ctx.ledgerPath,JSON.stringify(ledger));
 const read=async()=>JSON.parse(await fs.readFile(ctx.ledgerPath,'utf8'));
 const ops=createMediaOperations(ctx);
 const api={call:async name=>{if(name==='list_network_requests')return {data:{networkRequests:[]}};if(name==='evaluate_script')return {data:{evaluation:{nodes:[{id:'generated',label:config.labels.image,status:2,target:{findUrl:'https://example.test/image.png',fileType:1}}]}}};throw new Error('UNEXPECTED_SYNTHETIC_CALL');}};
 try{await save();await fn({ctx,ledger,save,read,ops,api});}finally{await fs.rm(dir,{recursive:true,force:true});}
}
test('legacy false ack remains blocked on repeated generation reconciliation',()=>fixture(async({ops,api,read})=>{
 for(let n=0;n<3;n++){
  const value=await ops.runMedia(api,{operation:'media:wait-generation',kind:'image',timeoutMs:10});
  assert.equal(value.state,'submitted-payload-mismatch-do-not-resubmit');
  assert.equal((await read()).stages['image-generation'].state,'blocked-submitted-parameters');
 }
}));
test('legacy successful stage with missing request evidence cannot complete',()=>fixture(async({ledger,save,ops,api})=>{
 ledger.stages['image-generation'].state='verified-readable-image';ledger.stages['image-generation'].ack.checks={};await save();
 const value=await ops.runMedia(api,{operation:'media:wait-generation',kind:'image',timeoutMs:10});
 assert.equal(value.state,'submitted-payload-mismatch-do-not-resubmit');
}));
test('corrected native image card accepts wrong original Agent model without rewriting network evidence',()=>fixture(async({ctx,ledger,save,ops})=>{
 delete ledger.stages['image-generation'];
 const source={type:'batch_generate_image_params',prompts:[ledger.imageGenerationPrompt],flowCode:'wrong',workflowId:'999',sourceNodeIds:[['ref']],labels:[ctx.config.labels.image]};
 const network=JSON.stringify({requestBody:JSON.stringify({message:'Synthetic image request',nodeId:'session-synthetic'}),responseBody:JSON.stringify({code:200,data:{options:source}}),requestBodyComplete:true,responseBodyComplete:true});
 const file=resolve(ctx.dir,'image-chat-network.json');await fs.writeFile(file,network);await save();let confirms=0;
 const page={canvasId:'synthetic-canvas',generating:false,chatLoading:false,cards:[{}],nodes:[{id:'ref',target:{findUrl:'https://example.test/ref.png'}}]};
 const current={type:source.type,flowCode:'main_image',workflowId:'248',sourceNodeIds:[['ref']],labels:source.labels,prompts:source.prompts,model:'全能图片PRO',globalModel:'全能图片PRO',ratio:'16:9',resolution:'2k',count:1,prompt:ledger.imageGenerationPrompt,promptCount:1,confirmEnabled:true,sessionId:'session-synthetic',taskPrompt:'Synthetic image request',referenceAssets:['https://example.test/ref.png']};
 const api={call:async(name,args)=>{
  if(name==='list_network_requests')return {data:{networkRequests:[]}};
  assert.equal(name,'evaluate_script');const code=args.function;
  if(code.includes('const badge='))return {data:{evaluation:{before:'Wrong model',after:'全能图片PRO',nativeCorrection:true}}};
  if(code.includes('nativeAgentConfirmationClickedOnce')){confirms++;return {data:{evaluation:{nativeAgentConfirmationClickedOnce:true}}};}
  return {data:{evaluation:code.includes('canvaseInfo.name')?page:current}};
 }};
 await ops.runMedia(api,{operation:'media:ensure-card-model',kind:'image'});
 await ops.runMedia(api,{operation:'media:submit-image'});
 assert.equal(confirms,1);assert.equal(await fs.readFile(file,'utf8'),network);
}));
test('setup rejects Node 22.0 and 22.11 before any dependency installation',async()=>{
 const source=(await fs.readFile(new URL('../scripts/setup.mjs',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
 for(const version of ['22.0.0','22.11.0']){
  const calls=[];let error='';const context={process:{platform:'darwin',versions:{node:version},exit:()=>{throw new Error('EXIT');}},console:{error:x=>{error=x;},log:()=>{}},spawnSync:(...args)=>{calls.push(args);return {status:0};},resolve,root:'.',base:'.',ensureState:async()=>{}};
  const helper=await import('../bridge/node-version.mjs').catch(()=>null);if(helper)context.assertSupportedNode=()=>helper.assertSupportedNode(version);
  try{await vm.runInNewContext('(async()=>{'+source+'})()',context);}catch(e){error+=' '+e.message;}
  assert.equal(calls.length,0,'unsupported Node must stop before commands');assert.match(error,/22\.12\.0/);
 }
});

import {submittedChecks,requireValidGenerations,validateGenerations,reconcileHttpStatusRepresentation} from '../bridge/generation-validation.mjs';
import {readNativeImageCard,validateImageCard,imageConfirmationScript} from '../bridge/image-card.mjs';
import {supportsNode,assertSupportedNode} from '../bridge/node-version.mjs';
import {main} from '../bridge/job-run.mjs';
import {sha} from '../bridge/job-config.mjs';

function networkFor(ctx,ledger,kind='image'){
 const image=kind==='image',spec=ctx.config[kind];
 return {httpStatus:200,requestBodyComplete:true,responseBodyComplete:true,responseBody:JSON.stringify({code:200,data:{state:'synthetic accepted'}}),requestBody:JSON.stringify({id:spec.workflowId,nodeId:image?'generated':'video-result',paramList:[
  {component:'Positive',defValue:ledger[kind+'GenerationPrompt']},
  {component:'ImageUploadAuto',tapNodeId:image?'ref':'generated',defValue:image?'https://example.test/ref.png':'https://example.test/image.png'},
  {component:'AgentSelect',nodeId:image?'2aspectRatio':'1ratio',defValue:spec.ratio},
  {component:'AgentSelect',nodeId:image?'2resolution':'1resolution',defValue:spec.resolution},
  ...image?[]:[{component:'AgentSelectOne',nodeId:'1duration',defValue:spec.duration}]
 ]})};
}
async function valid(ctx,ledger,save,kind='image'){
 if(kind==='video'){ledger.videoNodeId='video-result';ledger.videoGenerationPrompt='The boy reviews the generated film.';ledger.videoLabel='SYNTHETIC__VIDEO';}
 const network=networkFor(ctx,ledger,kind),stage=ledger.stages[kind+'-generation']||={attempts:1,existingCdpRequests:[]};
 stage.ack={httpStatus:200,response:JSON.parse(network.responseBody),checks:submittedChecks(JSON.parse(network.requestBody),kind,ledger,ctx.config,true)};
 stage.state='verified-readable-'+kind;
 await fs.writeFile(resolve(ctx.dir,kind+'-generation-network.json'),JSON.stringify(network));await save();return network;
}
test('first observed wrong request persists across three resumes and retains original request',()=>fixture(async({ctx,ledger,save,ops,api,read})=>{
 const network=networkFor(ctx,ledger);const payload=JSON.parse(network.requestBody);payload.id='999';network.requestBody=JSON.stringify(payload);
 delete ledger.stages['image-generation'].ack;await save();let captures=0;
 api.fullNetwork=async()=>{captures++;return network;};
 api.call=async name=>{assert.equal(name,'list_network_requests');return {data:{networkRequests:[{url:'https://aix.studio/apinew/comfy/work/promptTask',requestId:1,status:'200'}]}};};
 assert.equal((await ops.runMedia(api,{operation:'media:wait-generation',timeoutMs:100})).state,'submitted-payload-mismatch-do-not-resubmit');
 const original=await fs.readFile(resolve(ctx.dir,'image-generation-network.json'));
 for(let i=0;i<3;i++)await assert.rejects(main(['resume','--job','synthetic'],{projectLockPath:resolve(ctx.dir,'.project.lock'),loadConfig:async()=>({...ctx,existing:true}),request:async()=>{throw new Error('MUST_NOT_CONNECT');},emit:()=>{}}),/SUBMITTED_PARAMETERS_BLOCKED/);
 assert.equal(captures,1);assert.equal((await read()).stages['image-generation'].attempts,1);
 assert.deepEqual(await fs.readFile(resolve(ctx.dir,'image-generation-network.json')),original);
 assert.equal(await fs.access(resolve(ctx.dir,'result.json')).then(()=>true,()=>false),false);
}));
test('legacy false or absent checks and missing original body block run/resume and completed recovery',()=>fixture(async({ctx,ledger,save})=>{
 for(const variant of ['false','empty','missing-body']){
  ledger.stages['image-generation']={attempts:1,existingCdpRequests:[]};ledger.stages['video-generation']={attempts:1,existingCdpRequests:[]};delete ledger.parameterValidation;
  ledger.imageAsset={target:{findUrl:'https://example.test/image.png'}};
  await valid(ctx,ledger,save);await valid(ctx,ledger,save,'video');ledger.phase='media-chain-saved-and-restored';
  if(variant==='false')ledger.stages['image-generation'].ack.checks.workflow=false;
  if(variant==='empty')ledger.stages['image-generation'].ack.checks={};
  if(variant==='missing-body')await fs.unlink(resolve(ctx.dir,'image-generation-network.json'));
  await save();
  const expected=variant==='false'?'ACK_CHECK_WORKFLOW_MISMATCH':variant==='empty'?'ACK_CHECK_WORKFLOW_MISSING':'ORIGINAL_NETWORK_EVIDENCE_MISSING';
  const inspected=await validateGenerations(ctx,{persist:false});assert(inspected.generations.image.reasons.includes(expected));assert.equal(inspected.generations.video.state,'validated-submitted-parameters');
  for(const mode of ['run','resume'])await assert.rejects(main([mode,'--job','synthetic'],{projectLockPath:resolve(ctx.dir,'.project.lock'),loadConfig:async()=>({...ctx,existing:true}),request:async()=>{throw new Error('MUST_NOT_CONNECT');},emit:()=>{}}),/SUBMITTED_PARAMETERS_BLOCKED/);
 }
}));
test('asset verification and restored verification stop before browser calls for invalid legacy ack',()=>fixture(async({ops})=>{
 let calls=0;for(const op of ['verify-image','verify-video','download-video','record-local-download','verify-restored','restore','reopen-final','submit-video'])await assert.rejects(ops.runMedia({call:async()=>{calls++;}},{operation:'media:'+op}),/SUBMITTED_PARAMETERS_BLOCKED/);
 assert.equal(calls,0);
}));
test('a misleading completed manifest is invalidated with a byte-identical retained copy',()=>fixture(async({ctx})=>{
 const body=JSON.stringify({state:'completed',artifacts:[{role:'image',sha256:'synthetic'}]});await fs.mkdir(ctx.config.outputDir);
 const paths=[resolve(ctx.dir,'result.json'),resolve(ctx.config.outputDir,'SYNTHETIC__manifest.json')];for(const p of paths)await fs.writeFile(p,body);
 assert((await validateGenerations(ctx)).blocked);
 for(const p of paths){assert.equal(JSON.parse(await fs.readFile(p)).state,'blocked-submitted-parameters');assert.equal(await fs.readFile(p+'.invalidated-'+sha(body)+'.json','utf8'),body);}
}));
test('correct submission completes and repeated read-only reconciliation stays valid',()=>fixture(async({ctx,ledger,save,ops,api,read})=>{
 await valid(ctx,ledger,save);for(let i=0;i<3;i++)assert.equal((await ops.runMedia(api,{operation:'media:wait-generation',timeoutMs:100})).state,'asset-record-observed');
 assert.equal((await read()).stages['image-generation'].attempts,1);assert.equal((await validateGenerations(ctx)).blocked,false);
}));
test('native 4.062-second output drift does not become a submitted-duration mismatch',()=>fixture(async({ctx,ledger,save})=>{
 ledger.imageAsset={target:{findUrl:'https://example.test/image.png'}};ledger.localVideo={durationSeconds:4.062};
 await valid(ctx,ledger,save);await valid(ctx,ledger,save,'video');
 const result=await requireValidGenerations(ctx,{requiredKinds:['image','video']});assert.equal(result.blocked,false);assert.equal(result.generations.video.checks.duration,true);
}));
async function completedFixture(ctx,ledger,save){
 await fs.mkdir(ctx.config.outputDir,{recursive:true});
 const media=async name=>{const path=resolve(ctx.config.outputDir,name);await fs.writeFile(path,'synthetic '+name);return {path,sha256:sha(await fs.readFile(path)),bytes:(await fs.stat(path)).size,width:1280,height:720};};
 ledger.file=await media('ref.png');ledger.imageAsset={...await media('image.png'),target:{findUrl:'https://example.test/image.png'}};ledger.imageAsset.localPath=ledger.imageAsset.path;
 ledger.videoAsset={target:{findUrl:'https://example.test/video.mp4'},durationSeconds:4.062};ledger.localVideo={...await media('video.mp4'),durationSeconds:4.062,decodeComplete:true};
 for(const k of ['upload','image-chat','video-chat','video-download'])ledger.stages[k]={...ledger.stages[k],attempts:1};
 await valid(ctx,ledger,save);await valid(ctx,ledger,save,'video');ledger.phase='media-chain-saved-and-restored';await save();
}
test('correct completed run/resume produces a validated manifest and never submits again',()=>fixture(async({ctx,ledger,save})=>{
 await completedFixture(ctx,ledger,save);const calls=[];
 for(const mode of ['run','resume','resume'])await main([mode,'--job','synthetic'],{projectLockPath:resolve(ctx.dir,'.project.lock'),loadConfig:async()=>({...ctx,existing:true}),request:async q=>{calls.push(q.op==='flow'?q.args.operation:q.op);return {state:'synthetic verified'};},emit:()=>{}});
 assert.deepEqual([...new Set(calls)].sort(),['bind','job:init','job:restore']);
 const result=JSON.parse(await fs.readFile(resolve(ctx.dir,'result.json')));assert.equal(result.state,'completed');assert.equal(result.strictDurationPassed,false);assert.equal(result.parameterValidation.blocked,false);
}));
test('final manifest rechecks parameters even if a restore caller returns success',()=>fixture(async({ctx,ledger,save,read})=>{
 await completedFixture(ctx,ledger,save);
 await assert.rejects(main(['resume','--job','synthetic'],{projectLockPath:resolve(ctx.dir,'.project.lock'),loadConfig:async()=>({...ctx,existing:true}),request:async q=>{if(q.args?.operation==='job:restore'){const latest=await read();latest.stages['video-generation'].ack.checks.duration=false;await fs.writeFile(ctx.ledgerPath,JSON.stringify(latest));}return {state:'synthetic verified'};},emit:()=>{}}),/SUBMITTED_PARAMETERS_BLOCKED/);
 assert.equal(await fs.access(resolve(ctx.dir,'result.json')).then(()=>true,()=>false),false);
}));
test('changing request bytes after validation is blocked and never makes the failure green',()=>fixture(async({ctx,ledger,save,read})=>{
 const network=await valid(ctx,ledger,save);await requireValidGenerations(ctx);
 const path=resolve(ctx.dir,'image-generation-network.json'),original=await fs.readFile(path);await fs.writeFile(path,JSON.stringify({...network,extra:'changed evidence'}));assert((await validateGenerations(ctx)).blocked);
 await fs.writeFile(path,original);assert((await validateGenerations(ctx)).blocked);assert((await read()).stages['image-generation'].parameterValidation.reasons.includes('ORIGINAL_NETWORK_EVIDENCE_CHANGED'));
}));
function cardFixture(){
 const params={type:'batch_generate_image_params',flowCode:'main_image',workflowId:'248',sourceNodeIds:[['ref']],labels:['SYNTHETIC__IMAGE'],prompts:['A boy types on a keyboard.']};
 const button={disabled:false,click(){this.clicks=(this.clicks||0)+1;}};
 const row={querySelector:()=>({textContent:params.prompts[0]})};
 const previous={classList:{contains:()=>true},querySelector:()=>({textContent:'Synthetic request'})};
 const card={classList:{contains:()=>false},__vueParentComponent:{props:{message:{generateParams:params}}},closest:()=>({previousElementSibling:previous}),querySelector:s=>s==='.batch-confirm-btn'?button:{textContent:'全能图片PRO'},querySelectorAll:s=>s==='.batch-prompt-row'?[row]:['全能图片PRO','16:9','2k'].map(textContent=>({textContent}))};
 const document={querySelectorAll:()=>[card],querySelector:()=>({__vue_app__:{config:{globalProperties:{$pinia:{_s:new Map([['tapnow-canvas',{nodes:[{id:'ref',target:{findUrl:'https://example.test/ref.png'}}]}]])}}}}})};
 return {params,button,card,document};
}
test('native component extraction and confirmation recheck use corrected current fields',()=>fixture(async({ctx,ledger})=>{
 const f=cardFixture(),current=vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document});
 const source={...f.params,flowCode:'wrong',workflowId:'999'};
 validateImageCard(current,source,{message:'Synthetic request'},ledger,ctx.config);
 vm.runInNewContext('('+imageConfirmationScript(current)+')()',{document:f.document});assert.equal(f.button.clicks,1);
 f.params.sourceNodeIds=[['wrong']];assert.throws(()=>vm.runInNewContext('('+imageConfirmationScript(current)+')()',{document:f.document}),/IMAGE_CARD_CHANGED/);assert.equal(f.button.clicks,1);
}));
test('wrong current image model/ref/count/prompt/task or incomplete evidence cannot confirm',()=>fixture(async({ctx,ledger})=>{
 const f=cardFixture(),current=vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document});
 for(const patch of [{flowCode:'wrong'},{workflowId:'999'},{model:'Wrong'},{globalModel:'Wrong'},{sourceNodeIds:[['wrong']]},{referenceAssets:['https://example.test/wrong.png']},{count:2},{promptCount:2},{prompts:['different']},{labels:['OTHER__IMAGE']},{taskPrompt:'another task'},{confirmEnabled:false},{sourceNodeIds:undefined}])assert.throws(()=>validateImageCard({...current,...patch},f.params,{message:'Synthetic request'},ledger,ctx.config),/ACTUAL_IMAGE_CARD_PREFLIGHT_FAILED/);
 assert.equal(f.button.clicks,undefined);
}));
test('missing native state fails closed without calling unknown effects',()=>{
 const f=cardFixture();let calls=0;f.card.__vueParentComponent={scope:{effects:[{fn:()=>{calls++;return {};}}]}};
 assert.throws(()=>vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document}),/COMPONENT_EVIDENCE_UNAVAILABLE/);assert.equal(calls,0);
});
test('Node version boundary is shared: 22.0/22.11 reject and 22.12/current pass',()=>{
 for(const version of ['20.19.0','22.0.0','22.11.0','22.11.99','22.12.0-rc.1','unknown']){assert.equal(supportsNode(version),false);assert.throws(()=>assertSupportedNode(version),/22\.12\.0/);}
 for(const version of ['22.12.0','22.12.1','22.16.0','24.0.0',process.versions.node]){assert(supportsNode(version));assert.doesNotThrow(()=>assertSupportedNode(version));}
});
test('daemon and doctor reject unsupported Node before connecting or loading bridge dependencies',async()=>{
 for(const file of ['daemon','doctor']){
  const url=new URL(file==='daemon'?'../bridge/daemon.mjs':'../scripts/doctor.mjs',import.meta.url);
  const source=(await fs.readFile(url,'utf8')).replace(/^import .*;\n/gm,'');
  for(const version of ['22.0.0','22.11.0'])await assert.rejects(vm.runInNewContext('(async()=>{'+source.replaceAll('import.meta.url',"'file:///synthetic/package.json'")+'})()',{assertSupportedNode:()=>assertSupportedNode(version)}),/22\.12\.0/);
 }
});
test('package, fixed lockfile and npm installation policy share the minimum without upgrading dependencies',async()=>{
 const read=async path=>JSON.parse(await fs.readFile(new URL(path,import.meta.url),'utf8'));
 const root=await read('../package.json'),bridge=await read('../bridge/package.json'),lock=await read('../bridge/package-lock.json');
 for(const meta of [root,bridge,lock.packages['']])assert.equal(meta.engines.node,'>=22.12.0');
 assert.equal(bridge.dependencies['chrome-devtools-mcp'],'1.9.0');assert.equal(lock.packages['node_modules/chrome-devtools-mcp'].engines.node,'^20.19.0 || ^22.12.0 || >=23');
 for(const path of ['../.npmrc','../bridge/.npmrc'])assert.equal((await fs.readFile(new URL(path,import.meta.url),'utf8')).trim(),'engine-strict=true');
});
test('captured native active-message getter can supply current corrected parameters',()=>{
 const f=cardFixture(),w={value:[{generateParams:f.params}]};
 const fn=vm.runInNewContext('()=>{var t;for(let o=w.value.length-1;o>=0;o--){const f=w.value[o];if(f.generateParams&&!f.generateSubmitted&&!f.generateCancelled)return f.generateParams}return(t=w.value[w.value.length-1])==null?void 0:t.generateParams}',{w});
 f.card.__vueParentComponent={scope:{effects:[{fn}]}};
 const current=vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document});assert.equal(current.workflowId,'248');assert.deepEqual(current.sourceNodeIds,[['ref']]);
});
test('MCP string HTTP 200 is accepted without modifying original network or acknowledgement',()=>fixture(async({ctx,ledger,save})=>{
 const network=await valid(ctx,ledger,save);network.httpStatus='200';ledger.stages['image-generation'].ack.httpStatus='200';
 const bytes=JSON.stringify(network);await fs.writeFile(resolve(ctx.dir,'image-generation-network.json'),bytes);await save();
 assert.equal((await validateGenerations(ctx)).blocked,false);assert.equal(await fs.readFile(resolve(ctx.dir,'image-generation-network.json'),'utf8'),bytes);
}));
test('exclusive historical HTTP string misclassification can be reconciled with a retained ledger',()=>fixture(async({ctx,ledger,save,read})=>{
 const network=await valid(ctx,ledger,save);network.httpStatus='200';const bytes=JSON.stringify(network);await fs.writeFile(resolve(ctx.dir,'image-generation-network.json'),bytes);
 const s=ledger.stages['image-generation'];s.ack.httpStatus='200';s.stateBeforeParameterBlock=s.state;s.state='blocked-submitted-parameters';s.parameterValidation={state:s.state,reasons:['ACCEPTED_RESPONSE_EVIDENCE_MISSING'],networkSha256:sha(bytes)};
 ledger.phaseBeforeParameterBlock=ledger.phase;ledger.phase=s.state;ledger.parameterValidation={state:s.state,generations:{image:s.parameterValidation}};await save();const before=await fs.readFile(ctx.ledgerPath);
 const result=await reconcileHttpStatusRepresentation(ctx,'image');assert.deepEqual(await fs.readFile(resolve(ctx.dir,result.retainedLedger)),before);assert.equal((await validateGenerations(ctx)).blocked,false);assert.equal((await read()).stages['image-generation'].attempts,1);
 await assert.rejects(reconcileHttpStatusRepresentation(ctx,'image'),/NOT_AN_EXCLUSIVE/);
}));
test('transport compatibility migration never unblocks false checks or changed evidence',()=>fixture(async({ctx,ledger,save})=>{
 for(const variant of ['false-check','changed-body','other-reason']){
  const network=await valid(ctx,ledger,save);network.httpStatus='200';const bytes=JSON.stringify(network);await fs.writeFile(resolve(ctx.dir,'image-generation-network.json'),bytes);
  const s=ledger.stages['image-generation'];s.ack.httpStatus='200';s.state='blocked-submitted-parameters';s.parameterValidation={state:s.state,reasons:['ACCEPTED_RESPONSE_EVIDENCE_MISSING'],networkSha256:sha(bytes)};ledger.parameterValidation={state:s.state,generations:{image:s.parameterValidation}};
  if(variant==='false-check')s.ack.checks.workflow=false;if(variant==='changed-body')s.parameterValidation.networkSha256='wrong';if(variant==='other-reason')s.parameterValidation.reasons.push('ACK_CHECK_WORKFLOW_MISMATCH');await save();
  await assert.rejects(reconcileHttpStatusRepresentation(ctx,'image'),/RECHECK_FAILED|PROOF_MISSING|NOT_AN_EXCLUSIVE/);assert.equal((await validateGenerations(ctx)).blocked,true);
 }
}));
