import {withJobMutation,writeJobJson,assertJobMutation} from './job-lock.mjs';
import {readJobStatus} from './job-status.mjs';
import {requireValidGenerations,reconcileHttpStatusRepresentation} from './generation-validation.mjs';
import {readChatCard} from './chat-evidence.mjs';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {root} from './transport.mjs';
import {request} from './socket-client.mjs';
import {loadConfig,readJson,acquireLock,sha} from './job-config.mjs';
import {downloadJob} from './job-download.mjs';

export async function main(argv=process.argv.slice(2),adapters={}){
  const send=adapters.request||request;
  const mode=argv[0],flag=argv.indexOf('--job');
  if(!['plan','run','status','resume','reconcile-http'].includes(mode)||flag!==1||argv.length!==3)throw new Error('USE_MEDIA_RUN_PLAN_RUN_STATUS_RESUME_--job_CONFIG_JSON');
  const ctx={...await (adapters.loadConfig||loadConfig)(argv[2])};
  const emit=adapters.emit||(x=>console.log(JSON.stringify({at:new Date().toISOString(),jobId:ctx.config.jobId,...x})));
  const get=()=>readJson(ctx.ledgerPath);
  let jobLock,projectLock,currentOperation;
  async function append(name,line){return withJobMutation(ctx,async()=>{await assertJobMutation(ctx);await fs.appendFile(resolve(ctx.dir,name),line);});}
  async function step(name,args={}){
    currentOperation=name;const at=new Date().toISOString(),t=performance.now();
    let value,error;
    try{value=await send({op:'flow',args:{operation:'job:'+name,configPath:ctx.path,lockToken:jobLock?.owner.token,...args}});return value;}
    catch(e){error=e.message;throw e;}
    finally{if(jobLock)await append('timings.jsonl',JSON.stringify({at,operation:name,seconds:+((performance.now()-t)/1000).toFixed(3),state:value?.state||null,error:error||null})+'\n').catch(()=>{});}
  }
  async function idle(requireCard=false){for(let i=0;i<12;i++){const x=await step('wait-idle',{requireCard,timeoutMs:45000});if(x.state==='idle')return;emit({phase:'waiting-native-ui',state:x.state});}throw new Error('NATIVE_UI_NOT_READY_RECONCILE_ORIGINAL_JOB');}
  async function once(op,key=op,args={}){
    const l=await get(),prior=l.stages[key];
    if(prior){if(prior.state==='action-reserved-result-unknown'){
      const reconciliation=await step('reconcile-local-stage',{stage:key});
      if(!reconciliation.resolved)throw new Error('RESULT_UNKNOWN_RECONCILED_NO_REPLAY_'+key);
    }return;}
    emit({phase:op,state:'starting'});await step(op,args);
  }
  async function waitChat(kind){
    const name=kind+'-chat';for(let i=0;i<20;i++){
      const l=await get();if(l.stages[name]?.state==='response-observed'){
        if(l.stages[name].businessCode!==200){
          if(!l.stages[name].historyRecovery){const reconciled=await step('reconcile-chat-history',{kind});emit({phase:name,...reconciled});}
          await readChatCard(ctx.dir,await get(),ctx.config,kind);
        }return;
      }
      const value=await step('wait-chat',{stage:name,timeoutMs:45000});emit({phase:name,state:value.state,businessCode:value.response?.code});
    }throw new Error('CHAT_RESULT_UNKNOWN_NO_REPLAY');
  }
  async function waitGeneration(kind){
    for(let i=0;i<80;i++){
      await requireValidGenerations(ctx,{requiredKinds:[]});
      const l=await get(),s=l.stages[kind+'-generation'];
      if(['asset-record-observed','verified-readable-'+kind].includes(s?.state))return;
      const value=await step('wait-generation',{kind,timeoutMs:45000});const node=value.node||value.transitions?.at(-1)?.nodes?.[0];
      emit({phase:kind+'-generation',state:value.state,status:node?.status,progress:node?.progress,resubmitted:false});
      if(value.state==='submitted-payload-mismatch-do-not-resubmit')throw new Error('SUBMITTED_PAYLOAD_MISMATCH_NO_RETRY');
      if(value.ack?.response?.code&&value.ack.response.code!==200)throw new Error('GENERATION_RESULT_UNKNOWN_RECONCILE_NO_REPLAY');
    }throw new Error('GENERATION_WAIT_LIMIT_RESULT_UNKNOWN_NO_REPLAY');
  }
  async function manifest(verification){return withJobMutation(ctx,async()=>{
    const parameterValidation=await requireValidGenerations(ctx,{requiredKinds:['image','video']});
    const l=await get(),previous=await readJson(resolve(ctx.dir,'result.json'));
    const result={schemaVersion:1,jobId:l.runId,configDigest:l.configDigest,project:ctx.config.project,parameterValidation,state:'completed',strictDurationPassed:Math.abs(l.localVideo.durationSeconds-ctx.config.video.duration)<=0.001,completedAt:previous?.completedAt||new Date().toISOString(),lastVerifiedAt:new Date().toISOString(),sourceReference:l.file,artifacts:[
      {role:'reference',source:'authorized local PNG uploaded through AIX',nodeId:l.referenceNodeId,asset:l.stages.upload.asset.target,localPath:l.file.path,sha256:l.file.sha256,bytes:l.file.bytes,width:l.file.width,height:l.file.height},
      {role:'image',sourceReferenceNodeId:l.referenceNodeId,nodeId:l.imageNodeId,asset:l.imageAsset.target,localPath:l.imageAsset.localPath,sha256:l.imageAsset.sha256,bytes:l.imageAsset.bytes,width:l.imageAsset.width,height:l.imageAsset.height,requested:ctx.config.image,actualPrompt:l.imageGenerationPrompt,task:l.stages['image-generation'].ack.response.data},
      {role:'video',sourceReferenceNodeId:l.imageNodeId,nodeId:l.videoNodeId,asset:l.videoAsset.target,localPath:l.localVideo.path,sha256:l.localVideo.sha256,bytes:l.localVideo.bytes,width:l.localVideo.width,height:l.localVideo.height,requested:ctx.config.video,containerDurationSeconds:l.localVideo.durationSeconds,videoTrackDurationSeconds:l.localVideo.videoTrackDurationSeconds,browserDurationSeconds:l.videoAsset.durationSeconds,decodeComplete:l.localVideo.decodeComplete,decodedFrames:l.localVideo.decodedFrames,nominalFrameRate:l.localVideo.nominalFrameRate,task:l.stages['video-generation'].ack.response.data,nativeDownload:true}
    ],verification,counts:Object.fromEntries(['upload','image-chat','image-generation','video-chat','video-generation','video-download'].map(k=>[k,l.stages[k].attempts]))};
    for(const a of result.artifacts)if(sha(await fs.readFile(a.localPath))!==a.sha256)throw new Error('MANIFEST_LOCAL_HASH_MISMATCH');
    const referencePath=resolve(ctx.config.outputDir,ctx.config.jobId+'__REF.png');
    const referenceBytes=await fs.readFile(l.file.path);
    await fs.writeFile(referencePath,referenceBytes,{mode:0o600,flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST'||sha(await fs.readFile(referencePath))!==l.file.sha256)throw e;});
    result.artifacts[0].localPath=referencePath;
    for(const [kind,index] of [['image',1],['video',2]]){
      const evidencePath=resolve(ctx.dir,kind+'-generation-network.json'),network=await readJson(evidencePath),payload=JSON.parse(network.requestBody);
      const inputNode=kind==='image'?l.referenceNodeId:l.imageNodeId,inputAsset=kind==='image'?l.stages.upload.asset:l.imageAsset;
      const refs=payload.paramList.filter(p=>p.component==='ImageUploadAuto'&&p.defValue);
      if(refs.length!==1||refs[0].tapNodeId!==inputNode||refs[0].defValue!==inputAsset.target.findUrl)throw new Error('MANIFEST_ACTUAL_INPUT_MAPPING_MISMATCH');
      result.artifacts[index].actualRequest={workflowId:payload.id,nodeId:payload.nodeId,paramStr:payload.paramStr,paramList:payload.paramList,evidencePath};
    }
    await writeJobJson(ctx,resolve(ctx.dir,'result.json'),result);await writeJobJson(ctx,resolve(ctx.config.outputDir,ctx.config.jobId+'__manifest.json'),result);return result;
  });}
  try{
    if(mode==='plan'){
      await send({op:'bind',canvasIdAlias:ctx.config.project.canvasIdAlias});const page=await step('preflight');
      emit({state:'validated-plan',configDigest:ctx.digest,input:ctx.input,models:{image:ctx.config.image,video:ctx.config.video},limits:ctx.config.limits,existingJob:!!ctx.existing,currentProject:{name:page.project,nodeCount:page.nodes.length,edgeCount:page.connections.length,edited:page.edited,generating:page.generating},operations:['upload reference','prepare image Agent card','apply native photography/lighting descriptions','confirm one PRO image','prepare video Agent card','correct model and recheck exact parameters','confirm one video','native download once','save/reopen and verify mapped job assets'],sideEffectsExecuted:false});return;
    }
    if(mode==='status'){emit(await readJobStatus(ctx));return;}
    if(mode==='resume'&&!ctx.existing)throw new Error('JOB_NOT_STARTED_USE_RUN');
    projectLock=await acquireLock(adapters.projectLockPath||resolve(root,'jobs','.project.lock'));jobLock=await acquireLock(resolve(ctx.dir,'.lock'));ctx.lockToken=jobLock.owner.token;
    if(mode==='reconcile-http'){
      const l=await get(),kinds=['image','video'].filter(kind=>l?.stages?.[kind+'-generation']?.state==='blocked-submitted-parameters');
      if(kinds.length!==1)throw new Error('ONE_EXCLUSIVE_HTTP_REPRESENTATION_BLOCK_REQUIRED');
      emit(await reconcileHttpStatusRepresentation(ctx,kinds[0]));return;
    }
    const id=randomUUID(),startedAt=new Date().toISOString(),start=performance.now();
    await append('executions.jsonl',JSON.stringify({id,mode,startedAt,configDigest:ctx.digest,event:'started'})+'\n');
    try{
      await requireValidGenerations(ctx);
      await send({op:'bind',canvasIdAlias:ctx.config.project.canvasIdAlias});await step('init');let l=await get();
      if(l.phase==='media-chain-saved-and-restored'){
        const result=await step('restore');await manifest(result);emit({state:'already-completed-reconciled',verification:result,manifestPath:resolve(ctx.dir,'result.json'),newSubmissions:0});return;
      }
      await once('prepare-upload');await once('upload');l=await get();
      if(l.stages.upload.state!=='verified-uploaded-reference')await step('capture-upload');
      await idle();await once('prepare-image-chat');
      if(!(await get()).stages['image-chat'])await step('send-image-chat');
      await waitChat('image');
      l=await get();if(!l.stages['image-generation']){
        await idle(true);await once('prepare-settings');
        if(!l.stages['camera-settings']){await step('settings-click',{text:'相机台'});await once('select-camera','camera-settings');}
        l=await get();if(!l.stages['lighting-settings']){await step('settings-click',{text:'AIX Lighting'});await once('select-lighting','lighting-settings');}
        await step('ensure-card-model',{kind:'image'});await once('apply-card-settings');await step('submit-image');
      }
      await waitGeneration('image');l=await get();if(l.stages['image-generation'].state!=='verified-readable-image')await step('verify-image');
      await idle();await once('prepare-video-chat');
      if(!(await get()).stages['video-chat'])await step('send-video-chat');await waitChat('video');
      l=await get();if(!l.stages['video-generation']){
        await idle(true);await step('ensure-card-model',{kind:'video'});await once('configure-video');await step('submit-video');
      }
      await waitGeneration('video');l=await get();if(l.stages['video-generation'].state!=='verified-readable-video')await step('verify-video');
      l=await get();if(!l.localVideo){emit({phase:'native-download-and-decode'});await downloadJob(ctx,step);}
      await idle();await once('repair-connections');
      await step('wait-saved');const verification=await step('reopen-final');
      const result=await manifest(verification);emit({state:'completed',strictDurationPassed:result.strictDurationPassed,videoPath:result.artifacts[2].localPath,manifestPath:resolve(ctx.dir,'result.json'),counts:result.counts});
    }catch(e){await withJobMutation(ctx,()=>writeJobJson(ctx,resolve(ctx.dir,'last-error.json'),{at:new Date().toISOString(),operation:currentOperation,message:e.message,result:'unknown-or-incomplete-do-not-resubmit',recovery:'resume same config; reserved operations are not replayed'})).catch(()=>{});throw e;}
    finally{await append('executions.jsonl',JSON.stringify({id,mode,event:'ended',at:new Date().toISOString(),seconds:+((performance.now()-start)/1000).toFixed(3),finalPhase:(await get())?.phase})+'\n').catch(()=>{});}
  }finally{await jobLock?.release();await projectLock?.release();}
}
