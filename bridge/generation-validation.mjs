import {withJobMutation,assertJobMutation,writeJobJson} from './job-lock.mjs';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {readJson,sha} from './job-config.mjs';
import {sanitize,sameNodeIdentity} from './redact.mjs';

export const blockedState='blocked-submitted-parameters';
const requiredChecks=['oneRequest','workflow','oneReference','correctReference','prompt','noOtherMediaReferences','aspectRatio','resolution'];
const acceptedHttp=value=>value===200||value==='200';
export function submittedChecks(payload,kind,ledger,config,oneRequest){
 const parameters=Array.isArray(payload?.paramList)?payload.paramList:[];
 const refs=parameters.filter(p=>p.component==='ImageUploadAuto'&&(p.defValue||p.tapNodeId));
 const positives=parameters.filter(p=>p.component==='Positive');
 const input=kind==='image'?ledger.referenceNodeId:ledger.imageNodeId;
 const asset=kind==='image'?ledger.stages?.upload?.asset:ledger.imageAsset;
 const expected=config[kind];
 const param=(id,value)=>{const rows=parameters.filter(p=>p.nodeId===id);return rows.length===1&&String(rows[0].defValue)===String(value);};
 return {
  oneRequest:oneRequest===true,workflow:String(payload?.id)===expected.workflowId,
  oneReference:refs.length===1,
  correctReference:refs.length===1&&sameNodeIdentity(refs[0].tapNodeId,input),
  referenceAsset:refs.length===1&&!!asset?.target?.findUrl&&sanitize(refs[0].defValue)===sanitize(asset.target.findUrl),
  prompt:typeof ledger[kind+'GenerationPrompt']==='string'&&positives.length===1&&positives[0].defValue===ledger[kind+'GenerationPrompt'],
  noOtherMediaReferences:parameters.filter(p=>/VideoUploadAuto|AudioUploadAuto/.test(p.component)).every(p=>!p.defValue&&!p.tapNodeId),
  aspectRatio:param(kind==='image'?'2aspectRatio':'1ratio',expected.ratio),
  resolution:param(kind==='image'?'2resolution':'1resolution',expected.resolution),
  ...(kind==='video'?{duration:param('1duration',expected.duration)}:{})
 };
}
export async function inspectGeneration(ctx,ledger,kind,{required=false}={}){
 const stage=ledger?.stages?.[kind+'-generation'];
 if(ledger?.parameterValidation?.generations?.[kind]?.state===blockedState)return ledger.parameterValidation.generations[kind];
 if(stage?.parameterValidation?.state===blockedState)return stage.parameterValidation;
 const claimsSuccess=['asset-record-observed','verified-readable-'+kind].includes(stage?.state);
 if(!required&&!stage?.ack&&!claimsSuccess&&stage?.state!==blockedState)return {state:'awaiting-submission-evidence',kind};
 const reasons=[];
 const keys=[...requiredChecks,...kind==='video'?['duration']:[]];
 if(!stage?.ack)reasons.push('ACK_MISSING');
 for(const key of keys)if(stage?.ack?.checks?.[key]!==true)reasons.push('ACK_CHECK_'+key.toUpperCase()+'_'+(stage?.ack?.checks?.[key]===false?'MISMATCH':'MISSING'));
 for(const [key,value] of Object.entries(stage?.ack?.checks||{}))if(value!==true&&!keys.includes(key))reasons.push('ACK_CHECK_'+key.toUpperCase()+'_MISMATCH');
 if(stage?.attempts!==1)reasons.push('SINGLE_SUBMISSION_EVIDENCE_MISSING');
 let checks={},networkSha256=null;
 try{
  const bytes=await fs.readFile(resolve(ctx.dir,kind+'-generation-network.json'));networkSha256=sha(bytes);
  if(stage?.parameterValidation?.networkSha256&&stage.parameterValidation.networkSha256!==networkSha256)reasons.push('ORIGINAL_NETWORK_EVIDENCE_CHANGED');
  const network=JSON.parse(bytes),payload=JSON.parse(network.requestBody),response=JSON.parse(network.responseBody);
  if(network.requestBodyComplete!==true||network.responseBodyComplete!==true)reasons.push('COMPLETE_NETWORK_EVIDENCE_MISSING');
  if(!acceptedHttp(network.httpStatus)||!acceptedHttp(stage?.ack?.httpStatus)||response.code!==200||stage?.ack?.response?.code!==200)reasons.push('ACCEPTED_RESPONSE_EVIDENCE_MISSING');
  if(!sameNodeIdentity(payload.nodeId,ledger[kind+'NodeId']))reasons.push('SUBMITTED_NODE_ID_MISMATCH');
  checks=submittedChecks(payload,kind,ledger,ctx.config,stage?.ack?.checks?.oneRequest);
  for(const [key,value] of Object.entries(checks))if(value!==true)reasons.push('REQUEST_'+key.toUpperCase()+'_MISMATCH');
 }catch(e){reasons.push(e.code==='ENOENT'?'ORIGINAL_NETWORK_EVIDENCE_MISSING':'ORIGINAL_NETWORK_EVIDENCE_UNREADABLE');}
 return {schemaVersion:1,kind,state:reasons.length?blockedState:'validated-submitted-parameters',reasons:[...new Set(reasons)],checks,networkSha256,checkedAt:new Date().toISOString(),scope:'submitted request only; native output duration is reported separately'};
}
async function invalidateResult(ctx,path,validation){
 await assertJobMutation(ctx);
 const bytes=await fs.readFile(path).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});if(!bytes)return;
 const result=JSON.parse(bytes);if(result.state!=='completed')return;
 const digest=sha(bytes),backup=path+'.invalidated-'+digest+'.json';
 await fs.writeFile(backup,bytes,{flag:'wx',mode:0o600}).catch(async e=>{if(e.code!=='EEXIST'||sha(await fs.readFile(backup))!==digest)throw e;});
 await writeJobJson(ctx,path,{...result,state:blockedState,parameterValidation:validation,invalidatedResultSha256:digest});
}
// Diagnostics are a pure projection of an observed ledger. Only network
// evidence is read; no stages, phase, result files or backups are modified.
export async function diagnoseGenerations(ctx,ledger,{requiredKinds=[]}={}){
 if(!ledger)return {blocked:false,generations:{}};
 const completed=ledger.phase==='media-chain-saved-and-restored',generations={};
 for(const kind of ['image','video'])generations[kind]=await inspectGeneration(ctx,ledger,kind,{required:completed||requiredKinds.includes(kind)});
 return {blocked:Object.values(generations).some(v=>v.state===blockedState),generations};
}
export async function validateGenerations(ctx,{requiredKinds=[],persist=true}={}){
 if(!persist)return diagnoseGenerations(ctx,await readJson(ctx.ledgerPath),{requiredKinds});
 return withJobMutation(ctx,async()=>{
  // Never accept a caller's earlier snapshot for a write transaction.
  const ledger=await readJson(ctx.ledgerPath);
  const result=await diagnoseGenerations(ctx,ledger,{requiredKinds});
  if(!ledger)return result;
  const {blocked,generations}=result;let changed=false;
  for(const [kind,validation] of Object.entries(generations)){
   if(validation.state==='awaiting-submission-evidence')continue;
   const stage=ledger.stages[kind+'-generation']||={};
   if(validation.state===blockedState&&stage.state!==blockedState){stage.stateBeforeParameterBlock=stage.state||null;stage.state=blockedState;changed=true;}
   if(JSON.stringify(stage.parameterValidation)!==JSON.stringify(validation)){stage.parameterValidation=validation;changed=true;}
  }
  if(blocked){
   if(ledger.phase!==blockedState){ledger.phaseBeforeParameterBlock=ledger.phase;ledger.phase=blockedState;}
   ledger.parameterValidation={state:blockedState,generations};changed=true;
  }
  if(changed)await writeJobJson(ctx,ctx.ledgerPath,sanitize(ledger));
  if(blocked){await invalidateResult(ctx,resolve(ctx.dir,'result.json'),generations);await invalidateResult(ctx,resolve(ctx.config.outputDir,ctx.config.jobId+'__manifest.json'),generations);}
  return result;
 });
}
export async function requireValidGenerations(ctx,options){
 const validation=await validateGenerations(ctx,options);
 if(validation.blocked)throw new Error('SUBMITTED_PARAMETERS_BLOCKED_NO_RETRY: '+Object.entries(validation.generations).filter(([,v])=>v.state===blockedState).map(([kind,v])=>kind+'='+v.reasons.join(',')).join(';'));
 return validation;
}

// Explicit migration of a proven 200 string/number classification bug only.
// Actual parameter failures, absent bodies, changed hashes and any other reason
// remain sticky. Preserve the old ledger and diagnostics before restoring state.
export async function reconcileHttpStatusRepresentation(ctx,kind){
 if(!['image','video'].includes(kind))throw new Error('UNSUPPORTED_MEDIA_KIND');
 return withJobMutation(ctx,async()=>{
  const bytes=await fs.readFile(ctx.ledgerPath),ledger=JSON.parse(bytes),stage=ledger.stages?.[kind+'-generation'];
  const previous=stage?.parameterValidation,summary=ledger.parameterValidation?.generations?.[kind];
  const exact=validation=>validation?.state===blockedState&&JSON.stringify(validation.reasons)===JSON.stringify(['ACCEPTED_RESPONSE_EVIDENCE_MISSING']);
  if(!exact(previous)||!exact(summary))throw new Error('NOT_AN_EXCLUSIVE_HTTP_REPRESENTATION_BLOCK');
  const networkBytes=await fs.readFile(resolve(ctx.dir,kind+'-generation-network.json')),network=JSON.parse(networkBytes);
  if(sha(networkBytes)!==previous.networkSha256||!acceptedHttp(network.httpStatus)||!acceptedHttp(stage.ack?.httpStatus)||![network.httpStatus,stage.ack.httpStatus].includes('200'))throw new Error('HTTP_REPRESENTATION_PROOF_MISSING');
  const candidate=structuredClone(ledger);delete candidate.parameterValidation;
  const next=candidate.stages[kind+'-generation'];delete next.parameterValidation;
  next.state=next.stateBeforeParameterBlock;
  const fresh=await inspectGeneration(ctx,candidate,kind,{required:true});
  if(fresh.state!=='validated-submitted-parameters')throw new Error('HTTP_REPRESENTATION_RECHECK_FAILED: '+fresh.reasons.join(','));
  await assertJobMutation(ctx);const retained='ledger-before-http-reconciliation-'+sha(bytes)+'.json';
  await fs.writeFile(resolve(ctx.dir,retained),bytes,{flag:'wx',mode:0o600}).catch(async e=>{if(e.code!=='EEXIST'||sha(await fs.readFile(resolve(ctx.dir,retained)))!==sha(bytes))throw e;});
  ledger.httpRepresentationReconciliations||=[];
  ledger.httpRepresentationReconciliations.push({kind,retainedLedger:retained,retainedLedgerSha256:sha(bytes),previousValidation:previous,originalNetworkSha256:sha(networkBytes),at:new Date().toISOString(),reason:'HTTP 200 was returned as a string; complete original request, response and every parameter check revalidated; no submission replay'});
  stage.state=stage.stateBeforeParameterBlock;stage.parameterValidation=fresh;
  ledger.parameterValidation.generations[kind]=fresh;
  if(!Object.values(ledger.parameterValidation.generations).some(v=>v.state===blockedState)){
   ledger.phase=ledger.phaseBeforeParameterBlock;delete ledger.parameterValidation;
  }
  await writeJobJson(ctx,ctx.ledgerPath,sanitize(ledger));
  return {state:'http-status-representation-reconciled',kind,retainedLedger:retained,resubmitted:false};
 });
}
