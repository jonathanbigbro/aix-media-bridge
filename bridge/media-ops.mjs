import {withJobMutation,assertJobMutation,writeJobJson} from './job-lock.mjs';
import {readJobStatus} from './job-status.mjs';
import {readNativeImageCard,validateImageCard,imageConfirmationScript} from './image-card.mjs';
import {readChatCard,historyCard} from './chat-evidence.mjs';
import {submittedChecks,validateGenerations,requireValidGenerations} from './generation-validation.mjs';
import fs from 'node:fs/promises';
import {verifyBaseline} from './baseline.mjs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {completedNodeFromNetwork,mappedUploadedReference} from './job-evidence.mjs?resolve04';
import {restoreSession} from './job-history.mjs';
import {root} from './transport.mjs';
import {sanitize,sameNodeIdentity} from './redact.mjs?r6';
import {fullNetwork as captureNetwork} from './network-full.mjs?v03';
async function fullNetwork(call,args){for(let i=0;i<60;i++){try{return await captureNetwork(call,args);}catch(e){if(!['RESPONSE_STILL_PENDING','NO_ALLOWED_OBSERVED_REQUEST'].includes(e.message)||i===59)throw e;await new Promise(r=>setTimeout(r,500));}}}


export function createMediaOperations(context){
const {config,input:referenceInput,dir,ledgerPath,digest}=context;
const project=config.project.name;
const store="document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia._s.get('tapnow-canvas')";
const now=()=>new Date().toISOString();
async function atomic(path,value){await writeJobJson(context,path,sanitize(value));}
async function evidence(name,value){await atomic(resolve(dir,name+'.json'),value);}
async function originalEvidence(name,value){await assertJobMutation(context);const file=resolve(dir,name+'.json'),bytes=JSON.stringify(sanitize(value),null,2)+'\n';await fs.writeFile(file,bytes,{flag:'wx',mode:0o600}).catch(async e=>{if(e.code!=='EEXIST'||await fs.readFile(file,'utf8')!==bytes)throw new Error('ORIGINAL_NETWORK_EVIDENCE_CONFLICT');});}
async function ledger(){return JSON.parse(await fs.readFile(ledgerPath,'utf8'));}
async function runMedia(api,input){
 const op=input.operation.slice(6);
 if(op==='status')return sanitize(await readJobStatus(context));
 const readOnly=['preflight','wait-idle','inspect-agent'].includes(op);
 return sanitize(await (readOnly?runRaw(api,input):withJobMutation(context,()=>runRaw(api,input))));
}
async function runRaw(api,input){
  async function ev(body){const r=await api.call('evaluate_script',{function:body,waitForStableDom:false});if(r.isError)throw new Error(r.data.message||'MEDIA_EVALUATION_FAILED');return r.data.evaluation;}
  async function state(){const s=await ev(`()=>{const s=${store};if(s.canvaseInfo?.name!==${JSON.stringify(project)})throw new Error('WRONG_PROJECT');return {at:new Date().toISOString(),project:s.canvaseInfo.name,canvasId:s.canvaseInfo.id,edited:s.edited,generating:s.hasGeneratingNodes(),nodes:s.nodes.map(n=>({id:n.id,label:n.label,type:n.type,status:n.status,progress:n.progress,generationDone:n.generationDone,resourceReady:n.resourceReady,target:n.target,targetInfoList:n.targetInfoList,param:n.param,data:n.data})),connections:s.connections,chatLoading:!!document.querySelector('.ai-chat-panel .stop-btn'),editor:document.querySelector('.chat-editor')?.textContent||'',cards:[...document.querySelectorAll('.generate-params-card')].map(x=>({class:x.className,text:x.innerText,buttons:[...x.querySelectorAll('button')].map(b=>({text:b.innerText,disabled:b.disabled}))})),chatText:document.querySelector('.chat-messages')?.innerText||''};}`);if(sanitize({canvasId:s.canvasId}).canvasId!==config.project.canvasIdAlias)throw new Error('PROJECT_BINDING_MISMATCH');return s;}
  async function imageCardEvidence(l,beforePromptEdit=false){
    const effective=await readChatCard(dir,l,config,'image');const {source,request,originalNetworkSha256}=effective;
    const current=await ev('('+readNativeImageCard.toString()+')');
    await evidence(beforePromptEdit?'image-card-correction-state':'image-card-confirmation-state',{current,originalNetworkSha256,origin:effective.origin,historyEvidence:effective.historyEvidence});
    const checked=validateImageCard(current,source,request,l,config,{beforePromptEdit});
    return {...checked,originalNetworkSha256,origin:effective.origin,historyEvidence:effective.historyEvidence};
  }
  async function reserve(key,limit=1){const l=await ledger();const st=l.stages[key]||{attempts:0};if(st.attempts>=limit)throw new Error('ALREADY_ATTEMPTED_RECONCILE_'+key);l.phase=key+':reserved';l.stages[key]={...st,operationId:config.jobId+':'+key,attempts:st.attempts+1,state:'action-reserved-result-unknown',startedAt:now()};await atomic(ledgerPath,l);return l;}
  async function finish(l,key,result){l.phase=key+':observed';l.stages[key]={...l.stages[key],state:'observed',finishedAt:now(),result};await atomic(ledgerPath,l);await evidence(key,result);return result;}
  const op=input.operation.slice(6);
  const irreversibleStage={'upload':'upload','send-image-chat':'image-chat','send-video-chat':'video-chat','submit-image':'image-generation','submit-video':'video-generation','download-video':'video-download'}[op];
  if(irreversibleStage && (await ledger()).stages[irreversibleStage]?.attempts>=1)throw new Error('ALREADY_ATTEMPTED_RECONCILE_'+irreversibleStage);
  if(!['preflight','status','wait-generation','refresh-completed-status','wait-idle','inspect-agent'].includes(op))await requireValidGenerations(context,{requiredKinds:['verify-image'].includes(op)?['image']:['verify-video','download-video','record-local-download','restore','reopen-final','verify-restored'].includes(op)?['image','video']:[]});
  if(op==='preflight')return state();
  if(op==='reconcile-chat-history'){
    const kind=input.kind;if(!['image','video'].includes(kind))throw new Error('UNSUPPORTED_MEDIA_KIND');
    const l=await ledger(),page=await state();
    if(page.generating||page.chatLoading||!l.sessionId||!l[kind+'Prompt'])throw new Error('CHAT_HISTORY_RECONCILIATION_REQUIRES_BOUND_IDLE_TASK');
    let restored;
    try{restored=await restoreSession({...api,fullNetwork:args=>captureNetwork(api.call,args)},{sessionId:l.sessionId,prompt:l[kind+'Prompt']});}
    catch(error){
      const network=await captureNetwork(api.call,{path:'/apinew/comfy/team/chat/sessions'});
      await evidence(kind+'-chat-session-reconciliation',{error:error.message,expectedSession:l.sessionId,sessions:JSON.parse(network.responseBody).data?.map(s=>({sessionId:s.nodeId,title:s.title}))});
      throw error;
    }
    const name=kind+'-chat-history-'+Date.now();
    await originalEvidence(name,restored.network);
    const originalBytes=await fs.readFile(resolve(dir,kind+'-chat-network.json'));
    const checked=historyCard(JSON.parse(originalBytes),sanitize(restored.network),l,config,kind);
    // Persist only a separately hashed recovery proof. Do not alter the old
    // businessCode, request bytes, attempt count or generation state.
    const historyBytes=await fs.readFile(resolve(dir,name+'.json'));
    l.stages[kind+'-chat'].historyRecovery={file:name+'.json',originalNetworkSha256:createHash('sha256').update(originalBytes).digest('hex'),historySha256:createHash('sha256').update(historyBytes).digest('hex'),messageId:checked.messageId,at:now()};
    await atomic(ledgerPath,l);
    return {state:'original-chat-card-reconciled',evidence:name+'.json',switched:restored.switched,resubmitted:false};
  }
  if(op==='refresh-completed-status'){
    const l=await ledger(),page=await state();if(page.generating||page.chatLoading)throw new Error('COMPLETED_STATUS_REFRESH_REQUIRES_IDLE');
    const ids=[l.imageNodeId,l.videoNodeId].map(id=>page.nodes.find(n=>sameNodeIdentity(n.id,id))?.id);if(ids.some(id=>!id))throw new Error('MAPPED_MEDIA_NODE_MISSING');
    const before=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const prior=new Set((before.data.networkRequests||[]).map(r=>r.requestId));
    await ev(`async()=>{const s=${store};if(typeof s.initCanvasNodeStatus!=='function')throw new Error('NATIVE_STATUS_HANDLER_UNAVAILABLE');const ids=${JSON.stringify(ids)};await s.initCanvasNodeStatus(ids,false);return {nativeHandler:'initCanvasNodeStatus',nodeIds:ids};}`);
    const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const candidates=(listing.data.networkRequests||[]).filter(r=>!prior.has(r.requestId)&&new URL(r.url).pathname==='/apinew/comfy/task-info/initCanvasNodeStatus');
    for(const candidate of candidates.reverse()){
      const full=await fullNetwork(api.call,{reqid:candidate.requestId}),body=JSON.parse(full.responseBody),sent=JSON.parse(full.requestBody);
      if(ids.every(id=>sent.nodeIds.includes(id))&&ids.every(id=>body.data?.nodeInfoList?.some(n=>n.nodeId===id&&String(n.status)==='2'))){await evidence('completed-task-backend-status',full);return {state:'both-completed-tasks-refreshed',nodeIds:ids};}
    }throw new Error('COMPLETED_TASK_STATUS_NOT_RETURNED');
  }
  if(op==='reconcile-local-stage'){
    const l=await ledger(),page=await state(),stage=input.stage;
    let result;
    if(stage==='prepare-upload'||stage==='prepare-settings'){
      const label=stage==='prepare-upload'?config.labels.reference:config.labels.settings;
      const nodes=page.nodes.filter(n=>n.label===label);
      if(nodes.length===1)result={nodeId:nodes[0].id,componentReady:true,reconciled:true};
    }else if(stage==='prepare-image-chat'&&page.editor===config.imageAgentPrompt&&!page.chatLoading){
      const node=page.nodes.find(n=>sanitize(n.id)===l.referenceNodeId);if(node){l.imagePrompt=config.imageAgentPrompt;result={reconciled:true,editor:page.editor,referenceNodeIds:[node.id]};}
    }else if(stage==='prepare-video-chat'&&page.editor===config.videoAgentPrompt&&!page.chatLoading){l.videoPrompt=config.videoAgentPrompt;result={reconciled:true,editor:page.editor};}
    else if(stage==='upload'&&mappedUploadedReference(page,l,config.labels.reference)){await runRaw(api,{operation:'media:capture-upload'});return {resolved:true,source:'existing uploaded asset hash and normal upload response'};}
    if(result){await finish(l,stage,result);return {resolved:true,stage,result};}
    const observation={resolved:false,stage,at:now(),page:{generating:page.generating,chatLoading:page.chatLoading,ownNodes:page.nodes.filter(n=>n.label?.startsWith(config.jobId)).map(n=>({id:n.id,label:n.label,status:n.status,target:n.target}))},resubmitted:false};
    await evidence('reconciliation-'+stage,observation);return observation;
  }
  if(op==='ensure-card-model'){
    const kind=input.kind;if(!['image','video'].includes(kind))throw new Error('UNSUPPORTED_MEDIA_KIND');
    const l=await ledger();if(l.stages[kind+'-generation'])throw new Error('MODEL_CHANGE_AFTER_SUBMISSION_FORBIDDEN');
    const wanted=kind==='image'?'全能图片PRO':'Seedance2.0（真人）';
    l.settingsActions=l.settingsActions||[];l.settingsActions.push({kind,desiredModel:wanted,state:'reserved',at:now()});await atomic(ledgerPath,l);
    const result=await ev(`async()=>{const card=[...document.querySelectorAll('.generate-params-card')].filter(x=>!x.classList.contains('batch-card-disabled'));if(card.length!==1)throw new Error('UNIQUE_JOB_CARD_REQUIRED');const c=card[0],wanted=${JSON.stringify(wanted)};const badge=()=>c.querySelector('.batch-item-config-badge')?.textContent.trim();const before=badge();if(before!==wanted){const trigger=c.querySelector('button.batch-select .batch-model-icon')?.parentElement;if(!trigger)throw new Error('MODEL_TRIGGER_MISSING');trigger.click();await new Promise(r=>setTimeout(r,100));const matches=[...c.querySelectorAll('button,div,span')].filter(x=>x.textContent.trim()===wanted&&!Array.from(x.children).some(k=>k.textContent.trim()===wanted)&&x.getClientRects().length);if(matches.length!==1)throw new Error('AUTHORIZED_MODEL_NOT_UNIQUE');matches[0].click();for(let i=0;i<150&&badge()!==wanted;i++)await new Promise(r=>setTimeout(r,100));}if(badge()!==wanted)throw new Error('MODEL_SWITCH_NOT_SETTLED');return {before,after:badge(),nativeCorrection:before!==wanted,cardText:c.innerText};}`);
    await evidence(kind+'-model-correction',result);
    if(kind==='image'){const checked=await imageCardEvidence(l,!l.stages['apply-card-settings']);await evidence('image-card-after-correction',checked);l.imageCardCorrectionEvidence={originalNetworkSha256:checked.originalNetworkSha256,checks:checked.checks};}
    l.settingsActions.at(-1).state='observed';await atomic(ledgerPath,l);return result;
  }
  if(op==='wait-saved'){
    const seen=new Set();let last;
    for(let i=0;i<60;i++){
      const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});
      const record=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/canvas-json-info/saveCanvas'&&/^\d{3}$/.test(r.status)).at(-1);
      if(record&&!seen.has(record.requestId)){
        seen.add(record.requestId);try{return await runRaw(api,{operation:'media:reconcile-save'});}catch(e){last=e.message;}
      }
      await new Promise(r=>setTimeout(r,1000));
    }throw new Error('SAVE_NOT_VERIFIED_'+(last||'NO_NORMAL_SAVE_RESPONSE'));
  }
  if(op==='init'){
    try{const old=await ledger();if(old.configDigest!==digest)throw new Error('JOB_CONFIG_CHANGED');return {state:'existing-ledger',phase:old.phase};}catch(e){if(e.code!=='ENOENT')throw e;}
    const before=await state();if(before.edited||before.generating||before.chatLoading)throw new Error('BASELINE_MUST_BE_SAVED_AND_IDLE');
    if(before.nodes.some(n=>n.label?.startsWith(config.jobId)))throw new Error('JOB_NODES_EXIST_WITHOUT_LEDGER_RECONCILE');
    const l={runId:config.jobId,createdAt:now(),project,configDigest:digest,limits:config.limits,file:referenceInput,baseline:sanitize(before),stages:{},phase:'initialized'};
    await atomic(ledgerPath,l);await evidence('baseline',before);await evidence('input-summary',{config,input:referenceInput,digest});return {state:'initialized',limits:l.limits,file:l.file};
  }
  if(op==='status')return readJobStatus(context);
  if(op==='wait-idle'){
    const timeout=Math.min(input.timeoutMs||45000,45000),start=Date.now();
    while(Date.now()-start<timeout){const p=await ev(`()=>{const s=${store};return {generating:s.hasGeneratingNodes(),chatLoading:!!document.querySelector('.ai-chat-panel .stop-btn'),cards:[...document.querySelectorAll('.generate-params-card')].filter(x=>!x.classList.contains('batch-card-disabled')).length,edited:s.edited};}`);if(!p.generating&&!p.chatLoading&&(!input.requireCard||p.cards===1))return {state:'idle',...p};await new Promise(r=>setTimeout(r,1000));}return {state:'not-idle-or-card-not-visible',resubmitted:false};
  }
  if(op==='prepare-upload'){
    const before=await state();if(before.generating||before.chatLoading)throw new Error('ACTIVE_TASK');const old=before.nodes.filter(n=>n.label===config.labels.reference);if(old.length)throw new Error('REFERENCE_NODE_ALREADY_EXISTS');
    const l=await reserve('prepare-upload');const result=await ev(`async()=>{const s=${store};const p={x:Math.max(0,...s.nodes.map(n=>Number(n.position?.x||0)+Number(n.data?.width||0)))+250,y:100};const id=s.addNode('upload',p,s.getNodeSize('upload',${JSON.stringify(config.labels.reference)}));s.selectedNodeIds=[id];s.focusNode(id);for(let i=0;i<50;i++){const c=s.getNodeComponent(id);if(c?.uploadByout)return {nodeId:id,componentReady:true,exposedKeys:Object.keys(c),label:s.getNodeInfo(id).label};await new Promise(r=>setTimeout(r,100));}return {nodeId:id,componentReady:false};}`);return finish(l,'prepare-upload',result);
  }
  if(op==='upload'){
    const before=await state();const nodes=before.nodes.filter(n=>n.label===config.labels.reference);if(nodes.length!==1||nodes[0].target?.findUrl)throw new Error('UNIQUE_EMPTY_REFERENCE_REQUIRED');
    const l=await ledger(),bytes=await fs.readFile(l.file.path);if(createHash('sha256').update(bytes).digest('hex')!==l.file.sha256)throw new Error('FIXTURE_CHANGED');
    const active=await reserve('upload');const result=await ev(`async()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.reference)});const c=s.getNodeComponent(n.id);if(!c?.uploadByout)throw new Error('NATIVE_UPLOAD_HANDLER_MISSING');const bytes=Uint8Array.from(atob(${JSON.stringify(bytes.toString('base64'))}),x=>x.charCodeAt(0));const file=new File([bytes],${JSON.stringify(config.jobId+"-reference.png")},{type:'image/png'});await c.uploadByout(file);return {nativeUploadInvoked:true,nodeId:n.id,file:{name:file.name,size:file.size,type:file.type},node:s.getNodeInfo(n.id)};}`);return finish(active,'upload',result);
  }
  if(op==='capture-upload'){
    const init=await fullNetwork(api.call,{path:'/apinew/oss/upload-file-info/uploadInit'}),upload=await fullNetwork(api.call,{path:'/apinew/oss/upload-file-info/uploading'});
    const image=await ev(`async()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.reference)});if(!n?.target?.findUrl)throw new Error('NO_UPLOADED_ASSET');const r=await fetch(n.target.findUrl,{credentials:'omit'});const bytes=await r.arrayBuffer();const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');const im=new Image();im.src=n.target.findUrl;await im.decode();return {nodeId:n.id,target:n.target,httpStatus:r.status,bytes:bytes.byteLength,sha256:hash,width:im.naturalWidth,height:im.naturalHeight,allNodesForAI:s.getAllNodesForAI().filter(x=>x.id===n.id)};}`);
    const l=await ledger();if(image.sha256!==l.file.sha256||image.width!==referenceInput.width||image.height!==referenceInput.height)throw new Error('UPLOADED_REFERENCE_MISMATCH');
    const result={init,upload,image};l.referenceNodeId=image.nodeId;l.stages.upload.state='verified-uploaded-reference';l.stages.upload.asset=image;await atomic(ledgerPath,l);await evidence('upload-protocol',result);return result;
  }
  if(op==='inspect-agent'){
    return ev(`()=>{const app=document.querySelector('#__nuxt').__vue_app__;const root=app._container?._vnode||app._instance?.vnode;const found=[],seen=new Set();function walk(v){if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(v.component){const c=v.component;const name=c.type?.__name||c.type?.name||'';if(/chat|upload|aix/i.test(name))found.push({name,exposed:Object.keys(c.exposed||{}),setupKeys:Object.keys(c.setupState||{}),props:Object.keys(c.props||{}),refs:Object.keys(c.refs||{})});walk(c.subTree);}if(Array.isArray(v.children))v.children.forEach(walk);if(v.suspense){walk(v.suspense.activeBranch);}}walk(root);return {rootExists:!!root,found};}`);
  }
  if(op==='prepare-image-chat'){
    const page=await state();if(page.generating||page.chatLoading)throw new Error('TASK_ALREADY_ACTIVE');
    const ref=page.nodes.find(n=>n.label===config.labels.reference&&n.target?.findUrl);if(!ref)throw new Error('VERIFIED_REFERENCE_REQUIRED');
    const prompt=config.imageAgentPrompt;
    const l=await reserve('prepare-image-chat');
    const ready=await ev(`async()=>{const s=${store};if(!document.querySelector('.ai-chat-panel')){const open=document.querySelector('img[src*="aix-agent-toolbar"]')?.closest('button');if(!open)throw new Error('AGENT_TOOLBAR_UNAVAILABLE');open.click();for(let i=0;i<50&&!document.querySelector('.ai-chat-panel');i++)await new Promise(r=>setTimeout(r,100));}if(![...document.querySelectorAll('.ai-chat-panel button')].some(b=>b.textContent.trim()==='手动确认'))throw new Error('MANUAL_MODE_REQUIRED');document.querySelector('.ai-chat-panel button[title="新建对话"]').click();await new Promise(r=>setTimeout(r,100));const n=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.reference)});s.clearPickedNodes();s.addPickedNodes([n.id]);const e=document.querySelector('.chat-editor');e.focus();e.replaceChildren(document.createTextNode(${JSON.stringify(prompt)}));e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(prompt)}}));for(let i=0;i<50&&document.querySelector('.ai-chat-panel .send-btn')?.disabled;i++)await new Promise(r=>setTimeout(r,100));return {editor:e.textContent,referenceNodeIds:[...s.pickedNodeIds],sendDisabled:document.querySelector('.ai-chat-panel .send-btn').disabled};}`);
    if(ready.editor!==prompt||ready.referenceNodeIds.length!==1||ready.sendDisabled)throw new Error('MEDIA_EDITOR_PREFLIGHT_FAILED');l.imagePrompt=prompt;l.referenceNodeId=ref.id;return finish(l,'prepare-image-chat',ready);
  }
  if(op==='settle-image-preflight'){
    const l=await ledger();if(l.stages['image-chat'])throw new Error('CHAT_ALREADY_RESERVED');const page=await state();if(page.editor!==config.imageAgentPrompt||page.generating||page.chatLoading)throw new Error('PREPARED_EDITOR_NOT_FOUND');
    const ready=await ev(`()=>{const s=${store};return {editor:document.querySelector('.chat-editor').textContent,referenceNodeIds:[...s.pickedNodeIds],sendDisabled:document.querySelector('.send-btn').disabled};}`);const ref=page.nodes.find(n=>n.label===config.labels.reference);if(ready.sendDisabled||ready.referenceNodeIds.length!==1||ready.referenceNodeIds[0]!==ref.id)throw new Error('PREPARED_REFERENCE_MISMATCH');l.imagePrompt=page.editor;l.referenceNodeId=ref.id;return finish(l,'prepare-image-chat',ready);
  }
  if(op==='send-image-chat'){
    const l=await ledger(),page=await state();if(page.editor!==l.imagePrompt||page.chatLoading||page.generating)throw new Error('IMAGE_CHAT_PREFLIGHT_CHANGED');
    const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const existing=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/team/chat').map(r=>r.requestId);
    const active=await reserve('image-chat');active.stages['image-chat'].existingCdpRequests=existing;await atomic(ledgerPath,active);
    const result=await ev(`()=>{const b=document.querySelector('.ai-chat-panel .send-btn');if(!b||b.disabled)throw new Error('SEND_DISABLED');b.click();return {clickedOnce:true,at:new Date().toISOString()};}`);return finish(active,'image-chat',result);
  }
  if(op==='wait-chat'){
    const l=await ledger(),stage=input.stage||'image-chat',start=Date.now(),deadline=start+(input.timeoutMs||180000);if(!l.stages[stage]?.existingCdpRequests)throw new Error('NO_DISPATCHED_CHAT_STAGE');let last;
    while(Date.now()<deadline){
      const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const rows=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/team/chat'&&!l.stages[stage].existingCdpRequests.includes(r.requestId));last=rows.at(-1);
      if(last&&/^\d{3}$/.test(last.status)){
        const full=await fullNetwork(api.call,{reqid:last.requestId}),payload=JSON.parse(full.requestBody),response=JSON.parse(full.responseBody);if(payload.message!==(stage==='image-chat'?l.imagePrompt:l.videoPrompt))throw new Error('CHAT_PAYLOAD_TASK_MISMATCH');
        l.sessionId=payload.nodeId;l.stages[stage]={...l.stages[stage],state:'response-observed',observedChatRequests:rows.length,businessCode:response.code,requestId:payload.requestId,responseObservedAt:now()};await atomic(ledgerPath,l);await evidence(stage+'-network',full);const page=await state();await evidence(stage+'-page',page);return {state:'chat-response-observed',httpStatus:full.httpStatus,response,requestPayload:payload,page,waitMs:Date.now()-start};
      }
      await new Promise(r=>setTimeout(r,2500));
    }
    return {state:'result-unknown-continue-reading',lastObserved:last,waitMs:Date.now()-start};
  }
  if(op==='prepare-settings'){
    const before=await state();if(before.generating||before.chatLoading||before.nodes.some(n=>n.label===config.labels.settings))throw new Error('SETTINGS_NODE_PRECONDITION');const l=await reserve('prepare-settings');
    const result=await ev(`async()=>{const s=${store};const data=s.getNodeSize('image',${JSON.stringify(config.labels.settings)});data.flowCode='main_image';const id=s.addNode('image',{x:2200,y:100},data);s.selectedNodeIds=[id];s.focusNode(id);const c=await s.waitForNodeAgentComponent(id);return {nodeId:id,componentKeys:Object.keys(c||{}),componentReady:!!c};}`);return finish(l,'prepare-settings',result);
  }
  if(op==='settings-click'){
    const allowed=['8mm','ƒ/1.4','1/2000s-凝固','保存','相机台','摄像机台','AIX Lighting','飞思 XF IQ4 150MP','Cooke S4','50mm','ƒ/5.6','1/500s-清晰','电影三点光','45°侧光','柔雾灰'];if(!allowed.includes(input.text))throw new Error('UNREVIEWED_SETTINGS_CONTROL');
    const l=await ledger();l.settingsActions=l.settingsActions||[];l.settingsActions.push({text:input.text,state:'reserved',at:now()});await atomic(ledgerPath,l);
    const result=await ev(`async()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.settings)});if(!n||!s.selectedNodeIds.includes(n.id))throw new Error('SETTINGS_NODE_NOT_SELECTED');const matches=[...document.querySelectorAll('button,span,div')].filter(x=>x.textContent.trim()===${JSON.stringify(input.text)}&&x.getClientRects().length&&![...x.children].some(c=>c.textContent.trim()===${JSON.stringify(input.text)}));if(matches.length!==1)throw new Error('UNIQUE_SETTING_CONTROL_REQUIRED_'+matches.length);matches[0].click();await new Promise(r=>setTimeout(r,150));return {clicked:${JSON.stringify(input.text)},dialogs:[...document.querySelectorAll('[role="dialog"],.v-overlay__content')].filter(x=>x.getClientRects().length).map(x=>({class:x.className,text:x.innerText})),panel:document.querySelector('.agent-toolbar-layer')?.innerText};}`);
    l.settingsActions.at(-1).state='clicked';await atomic(ledgerPath,l);await evidence('settings-click-'+l.settingsActions.length,result);return result;
  }
  if(op==='select-camera'){
    const l=await reserve('camera-settings');const result=await ev(`async()=>{const s=${store};const node=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.settings)});if(!s.selectedNodeIds.includes(node.id))throw new Error('WRONG_SETTINGS_NODE');const roots=[...document.querySelectorAll('.camera-controller')].filter(x=>x.querySelector('.controller-title')?.textContent==='相机台');if(roots.length!==1)throw new Error('CAMERA_CONTROLLER_MISSING');const root=roots[0],columns=[...root.querySelectorAll('.controller-column')],wanted=${JSON.stringify(config.photography)},trail=[];if(columns.length!==5)throw new Error('CAMERA_SCHEMA_CHANGED');for(let col=0;col<5;col++){const observed=[];for(let i=0;i<=columns[col].querySelectorAll('.option-item').length;i++){const current=root.querySelectorAll('.value-desc')[col].textContent.trim();observed.push(current);if(current===wanted[col])break;if(i===columns[col].querySelectorAll('.option-item').length)throw new Error('CAMERA_OPTION_UNAVAILABLE_'+wanted[col]);columns[col].querySelector('.mdi-menu-right').parentElement.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}trail.push({column:col,wanted:wanted[col],observed});}root.querySelector('.save-btn').click();await new Promise(r=>setTimeout(r,150));s.getNodeAgentComponent(node.id).getParamList();return {trail,param:node.param,nodeId:node.id,panel:document.querySelector('.agent-toolbar-layer')?.innerText};}`);return finish(l,'camera-settings',result);
  }
  if(op==='select-lighting'){
    const l=await reserve('lighting-settings');const result=await ev(`async()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.settings)});if(!s.selectedNodeIds.includes(n.id))throw new Error('WRONG_SETTINGS_NODE');const root=[...document.querySelectorAll('.camera-controller')].find(x=>x.querySelector('.controller-title')?.textContent==='AIX Lighting');if(!root)throw new Error('LIGHTING_CONTROLLER_MISSING');const cols=[...root.querySelectorAll('.controller-column')],wanted=${JSON.stringify(config.lighting)},trail=[];if(cols.length!==3)throw new Error('LIGHTING_SCHEMA_CHANGED');for(let col=0;col<3;col++){const observed=[];for(let i=0;i<=cols[col].querySelectorAll('.option-item').length;i++){const current=root.querySelectorAll('.value-desc')[col].textContent.trim();observed.push(current);if(current===wanted[col])break;if(i===cols[col].querySelectorAll('.option-item').length)throw new Error('LIGHTING_OPTION_UNAVAILABLE');cols[col].querySelector('.mdi-menu-right').parentElement.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));}trail.push({column:col,wanted:wanted[col],observed});}root.querySelector('.save-btn').click();await new Promise(r=>setTimeout(r,150));s.getNodeAgentComponent(n.id).getParamList();return {trail,nodeId:n.id,param:n.param};}`);return finish(l,'lighting-settings',result);
  }
  if(op==='apply-card-settings'){
    const page=await state();if(page.generating||page.chatLoading||page.cards.length!==1)throw new Error('UNIQUE_IDLE_IMAGE_CARD_REQUIRED');const prior=await ledger();const l=prior.stages['apply-card-settings']?prior:await reserve('apply-card-settings');if(l.stages['image-generation'])throw new Error('GENERATION_ALREADY_RESERVED');
    const result=await ev(`async()=>{const s=${store};const node=s.nodes.find(n=>n.label===${JSON.stringify(config.labels.settings)});s.getNodeAgentComponent(node.id).getParamList();const positive=node.param.paramList.find(p=>p.component==='Positive');const descriptions=positive.desList||[];if(descriptions.length<2||!node.param.promptComponents.some(x=>x.name==='相机台'&&x.isActive&&x.selectIndices.FOC01===4&&x.selectIndices.APT01===4&&x.selectIndices.SH01===1))throw new Error('CAMERA_DESCRIPTIONS_MISSING');const card=document.querySelector('.generate-params-card');const text=card.querySelector('.batch-prompt-text');if(!text)throw new Error('PROMPT_ELEMENT_MISSING');text.click();await new Promise(r=>requestAnimationFrame(r));const edit=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='编辑');if(!edit)throw new Error('EDIT_BUTTON_MISSING');edit.click();await new Promise(r=>requestAnimationFrame(r));const area=card.querySelector('textarea.batch-prompt-edit');if(!area)throw new Error('PROMPT_EDITOR_MISSING');const original=area.value;const revised=${JSON.stringify(config.image.prompt)}+'\\n\\n[AIX camera and lighting prompt modifiers]\\n'+descriptions.join('\\n');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,revised);area.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));const done=card.querySelector('.batch-prompt-edit-btn');if(!done)throw new Error('EDIT_DONE_MISSING');done.click();await new Promise(r=>requestAnimationFrame(r));return {original,revised,descriptions,promptComponents:node.param.promptComponents,cardText:card.innerText,serializedAs:'Native camera/light descriptors copied into Agent card Positive.defValue; not independent model controls'};}`);l.imageGenerationPrompt=result.revised;return finish(l,'apply-card-settings',result);
  }
  if(op==='submit-image'){
    const l=await ledger(),page=await state();if(page.generating||page.chatLoading||page.cards.length!==1)throw new Error('IMAGE_CONFIRMATION_PRECONDITION');
    const {source}=await readChatCard(dir,l,config,'image');if(!page.nodes.some(n=>sanitize(n.id)===l.referenceNodeId&&sanitize(n.target?.findUrl)===l.stages.upload.asset.target.findUrl))throw new Error('MAPPED_IMAGE_INPUT_CHANGED');
    const preflight=await imageCardEvidence(l);
    if(l.imageCardCorrectionEvidence?.originalNetworkSha256&&l.imageCardCorrectionEvidence.originalNetworkSha256!==preflight.originalNetworkSha256)throw new Error('ORIGINAL_IMAGE_CHAT_EVIDENCE_CHANGED');
    await evidence('image-card-before-confirmation',preflight);
    const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const prior=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/work/promptTask').map(r=>r.requestId);
    const active=await reserve('image-generation');active.stages['image-generation'].existingCdpRequests=prior;active.imageLabel=source.labels[0];active.stages['image-generation'].preflight=preflight;await atomic(ledgerPath,active);
    const result=await ev(imageConfirmationScript(preflight.current));return finish(active,'image-generation',result);
  }
  if(op==='wait-generation'){
    const kind=input.kind||'image',stage=kind+'-generation',l=await ledger();if(!l.stages[stage]?.existingCdpRequests)throw new Error('NO_RESERVED_GENERATION');
    const previousValidation=await validateGenerations(context);
    if(previousValidation.blocked)return {state:'submitted-payload-mismatch-do-not-resubmit',parameterValidation:previousValidation,resubmitted:false};
    const started=Date.now(),deadline=started+(input.timeoutMs||45000),transitions=[];let signature='';
    while(Date.now()<deadline){
      const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});
      const tasks=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/work/promptTask'&&!l.stages[stage].existingCdpRequests.includes(r.requestId));
      if(!l.stages[stage].ack&&tasks.length>1)throw new Error('MORE_THAN_ONE_GENERATION_REQUEST_OBSERVED');
      if(tasks.length===1&&/^\d{3}$/.test(tasks[0].status)&&!l.stages[stage].ack){
        const full=await (api.fullNetwork?api.fullNetwork({reqid:tasks[0].requestId}):fullNetwork(api.call,{reqid:tasks[0].requestId}));const payload=JSON.parse(full.requestBody),response=JSON.parse(full.responseBody);
        const checks=submittedChecks(payload,kind,l,config,tasks.length===1);
        // Preserve the captured request before recording its acknowledgement. Never edit it to match the job.
        await originalEvidence(kind+'-generation-network',full);await evidence(kind+'-payload-checks',checks);
        l[kind+'NodeId']=payload.nodeId;l.stages[stage].ack={at:now(),httpStatus:full.httpStatus,response,checks};l.stages[stage].state=response.code===200?'accepted-waiting-real-asset':'business-response-failed-reconcile';await atomic(ledgerPath,l);
      }
      const parameterValidation=await validateGenerations(context,{requiredKinds:l.stages[stage].ack?[kind]:[]});
      if(parameterValidation.blocked)return {state:'submitted-payload-mismatch-do-not-resubmit',parameterValidation,resubmitted:false};
      Object.assign(l,await ledger());
      const snapshot=await ev(`()=>{const s=${store};const matches=s.nodes.filter(n=>n.label===${JSON.stringify(l[kind+'Label'])});if(matches.length>1)throw new Error('JOB_NODE_LABEL_NOT_UNIQUE');return {at:new Date().toISOString(),nodes:matches.map(n=>({id:n.id,label:n.label,type:n.type,status:n.status,progress:n.progress,msg:n.msg,target:n.target,targetInfoList:n.targetInfoList,generationDone:n.generationDone,resourceReady:n.resourceReady}))};}`);
      if(snapshot.nodes[0]&&l[kind+'NodeId']&&!sameNodeIdentity(snapshot.nodes[0].id,l[kind+'NodeId']))throw new Error('JOB_REMOTE_NODE_ID_CHANGED');
      const sig=JSON.stringify(snapshot.nodes);if(sig!==signature){signature=sig;transitions.push(snapshot);await fs.appendFile(resolve(dir,kind+'-status-transitions.jsonl'),JSON.stringify(sanitize(snapshot))+'\n');}
      const node=snapshot.nodes[0],assets=[node?.target,...node?.targetInfoList||[]].filter(x=>x?.findUrl&&Number(x.fileType)===(kind==='image'?1:2));
      if(node&&String(node.status)==='2'&&assets.length&&l.stages[stage].ack){l.stages[stage].state='asset-record-observed';l.stages[stage].assetObservedAt=now();l.stages[stage].node=node;await atomic(ledgerPath,l);const polls=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/task-info/initCanvasNodeStatus'&&/^\d{3}$/.test(r.status)).slice(-12).reverse();let captured=false;for(const poll of polls){const full=await fullNetwork(api.call,{reqid:poll.requestId});if(completedNodeFromNetwork(full,node.id)){await evidence(kind+'-terminal-status-network',full);captured=true;break;}}if(!captured)await evidence(kind+'-terminal-status-capture-gap',{at:now(),nodeId:node.id,state:'asset-observed-but-matching-completed-poll-not-in-recent-buffer',recovery:'completed-task-backend-status is checked on saved-project restoration'});return {state:'asset-record-observed',node,ack:l.stages[stage].ack,waitMs:Date.now()-started};}
      await new Promise(r=>setTimeout(r,5000));
    }
    return {state:'generation-still-unfinished-or-unknown',stage,transitions,ack:l.stages[stage].ack||null,waitMs:Date.now()-started,resubmitted:false};
  }
  if(op==='verify-image'){
    const l=await ledger();if(!['asset-record-observed','verified-readable-image'].includes(l.stages['image-generation']?.state))throw new Error('IMAGE_ASSET_NOT_OBSERVED');
    const result=await ev(`async()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(l.imageLabel)});if(String(n?.status)!=='2'||!n.target?.findUrl)throw new Error('IMAGE_NOT_COMPLETE');const im=new Image();im.src=n.target.findUrl;await im.decode();const r=await fetch(n.target.findUrl,{credentials:'omit'});const bytes=await r.arrayBuffer();return {nodeId:n.id,target:n.target,httpStatus:r.status,bytes:bytes.byteLength,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''),mime:r.headers.get('content-type'),localTransferBase64:btoa(Array.from(new Uint8Array(bytes),x=>String.fromCharCode(x)).join('')),width:im.naturalWidth,height:im.naturalHeight,complete:im.complete,allNodesForAI:s.getAllNodesForAI().filter(x=>x.id===n.id)};}`);
    if(!result.complete||!result.bytes||result.httpStatus!==200)throw new Error('IMAGE_DECODE_FAILED');const localImage=Buffer.from(result.localTransferBase64,'base64');delete result.localTransferBase64;if(createHash('sha256').update(localImage).digest('hex')!==result.sha256)throw new Error('LOCAL_IMAGE_HASH_MISMATCH');await fs.mkdir(config.outputDir,{recursive:true});result.localPath=resolve(config.outputDir,config.jobId+'__I001__PRO_2k'+(result.mime?.includes('png')?'.png':'.jpg'));await fs.writeFile(result.localPath,localImage,{mode:0o600,flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST'||createHash('sha256').update(await fs.readFile(result.localPath)).digest('hex')!==result.sha256)throw e;});l.imageAsset=result;l.stages['image-generation'].state='verified-readable-image';await atomic(ledgerPath,l);await evidence('image-asset-verification',result);
    const notification=await fullNetwork(api.call,{path:'/apinew/comfy/team/chat/generation-submitted'});await evidence('image-agent-generation-submitted',notification);
    let metadata;try{metadata=await fullNetwork(api.call,{path:'/apinew/comfy/team/chat/update-message-metadata'});}catch(e){if(e.message!=='NO_ALLOWED_OBSERVED_REQUEST')throw e;metadata={observed:false,reason:'No update-message-metadata request observed; immediate card may lack persisted message id. generation-submitted is separately captured.'};}await evidence('image-agent-confirmed-metadata',metadata);return {state:'verified-readable-image',image:result,notificationResponse:JSON.parse(notification.responseBody),metadata};
  }
  if(op==='prepare-video-chat'){
    const l=await ledger(),page=await state();if(l.stages['image-generation']?.state!=='verified-readable-image'||page.generating||page.chatLoading)throw new Error('READABLE_NEW_IMAGE_REQUIRED');
    const prompt=config.videoAgentPrompt;
    const active=await reserve('prepare-video-chat');const ready=await ev(`async()=>{const s=${store};if(!document.querySelector('.ai-chat-panel')){const open=document.querySelector('img[src*="aix-agent-toolbar"]')?.closest('button');if(!open)throw new Error('AGENT_TOOLBAR_UNAVAILABLE');open.click();for(let i=0;i<50&&!document.querySelector('.ai-chat-panel');i++)await new Promise(r=>setTimeout(r,100));}if(![...document.querySelectorAll('.ai-chat-panel button')].some(b=>b.textContent.trim()==='手动确认'))throw new Error('MANUAL_MODE_REQUIRED');const n=s.nodes.find(n=>n.label===${JSON.stringify(l.imageLabel)});if(!n?.target?.findUrl)throw new Error('NEW_IMAGE_MISSING');s.clearPickedNodes();s.addPickedNodes([n.id]);const e=document.querySelector('.chat-editor');e.focus();e.replaceChildren(document.createTextNode(${JSON.stringify(prompt)}));e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:${JSON.stringify(prompt)}}));for(let i=0;i<50&&document.querySelector('.ai-chat-panel .send-btn')?.disabled;i++)await new Promise(r=>setTimeout(r,100));return {editor:e.textContent,referenceNodeIds:[...s.pickedNodeIds],sendDisabled:document.querySelector('.ai-chat-panel .send-btn').disabled};}`);
    if(ready.editor!==prompt||ready.referenceNodeIds.length!==1||sanitize(ready.referenceNodeIds[0])!==l.imageNodeId||ready.sendDisabled)throw new Error('VIDEO_EDITOR_PREFLIGHT_FAILED');active.videoPrompt=prompt;return finish(active,'prepare-video-chat',ready);
  }
  if(op==='send-video-chat'){
    const l=await ledger(),page=await state();if(page.editor!==l.videoPrompt||page.chatLoading||page.generating)throw new Error('VIDEO_CHAT_PREFLIGHT_CHANGED');
    const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const existing=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/team/chat').map(r=>r.requestId);
    const active=await reserve('video-chat');active.stages['video-chat'].existingCdpRequests=existing;await atomic(ledgerPath,active);const result=await ev(`()=>{const b=document.querySelector('.ai-chat-panel .send-btn');if(!b||b.disabled)throw new Error('SEND_DISABLED');b.click();return {clickedOnce:true,at:new Date().toISOString()};}`);return finish(active,'video-chat',result);
  }
  if(op==='open-video-model'){
    const l=await reserve('open-video-model');const result=await ev(`async()=>{const card=[...document.querySelectorAll('.generate-params-card')].find(x=>!x.classList.contains('batch-card-disabled'));const b=card?.querySelector('button.batch-select .batch-model-icon')?.parentElement;if(!b)throw new Error('VIDEO_MODEL_TRIGGER_MISSING');b.click();await new Promise(r=>setTimeout(r,150));return {card:card.innerText,visibleText:document.body.innerText.slice(-14000)};}`);return finish(l,'open-video-model',result);
  }
  if(op==='select-video-model'){
    const l=await reserve('select-video-model');const result=await ev(`async()=>{const card=[...document.querySelectorAll('.generate-params-card')].find(x=>!x.classList.contains('batch-card-disabled'));const wanted='Seedance2.0（真人）';const matches=[...card.querySelectorAll('button,div,span')].filter(x=>x.textContent.trim()===wanted&&!Array.from(x.children).some(c=>c.textContent.trim()===wanted)&&x.getClientRects().length);if(matches.length!==1)throw new Error('AUTHORIZED_VIDEO_MODEL_NOT_UNIQUELY_AVAILABLE');matches[0].click();for(let i=0;i<100&&card.querySelector('.batch-item-config-badge')?.textContent.trim()!==wanted;i++)await new Promise(r=>setTimeout(r,100));if(card.querySelector('.batch-item-config-badge')?.textContent.trim()!==wanted)throw new Error('MODEL_SWITCH_NOT_SETTLED');return {cardText:card.innerText,buttons:[...card.querySelectorAll('button')].map(b=>({class:b.className,text:b.innerText,disabled:b.disabled}))};}`);return finish(l,'select-video-model',result);
  }
  if(op==='configure-video'){
    const l=await reserve('configure-video');const prompt=config.video.prompt;
    const result=await ev(`async()=>{const card=[...document.querySelectorAll('.generate-params-card')].find(x=>!x.classList.contains('batch-card-disabled'));if(!card)throw new Error('VIDEO_CARD_MISSING');for(let i=0;i<50;i++){if(card.querySelector('.batch-item-config-badge')?.textContent.trim()==='Seedance2.0（真人）')break;await new Promise(r=>setTimeout(r,100));}if(card.querySelector('.batch-item-config-badge')?.textContent.trim()!=='Seedance2.0（真人）')throw new Error('AUTHORIZED_MODEL_NOT_SELECTED');let durationOptions=[];const desired=[[${JSON.stringify(String(config.video.duration))},1],['16:9',2],['720p',3]];for(const [value,index] of desired){const trigger=[...card.querySelectorAll('.batch-select.image-config-trigger')][index];if(!trigger)throw new Error('VIDEO_PARAMETER_TRIGGER_MISSING');trigger.click();await new Promise(r=>requestAnimationFrame(r));const choices=[...card.querySelectorAll('.image-config-item')];if(index===1)durationOptions=choices.map(b=>b.textContent.trim());const choice=choices.find(b=>b.textContent.trim()===value);if(!choice)throw new Error('MODEL_OPTION_UNAVAILABLE_'+value);choice.click();await new Promise(r=>requestAnimationFrame(r));}card.querySelector('.batch-prompt-text').click();await new Promise(r=>requestAnimationFrame(r));const edit=[...card.querySelectorAll('button')].find(b=>b.textContent.trim()==='编辑');if(!edit)throw new Error('VIDEO_EDIT_BUTTON_MISSING');edit.click();await new Promise(r=>requestAnimationFrame(r));const area=card.querySelector('textarea.batch-prompt-edit');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,${JSON.stringify(prompt)});area.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(r=>requestAnimationFrame(r));card.querySelector('.batch-prompt-edit-btn').click();await new Promise(r=>requestAnimationFrame(r));const selected=[...card.querySelectorAll('.batch-select.image-config-trigger')].map(b=>b.textContent.trim());if(!selected.includes(${JSON.stringify(String(config.video.duration))})||!selected.includes('720p')||!selected.includes('16:9')||!selected.includes('Seedance2.0（真人）'))throw new Error('VIDEO_SPECIFICATION_MISMATCH');const s=${store};let definition=await s.getFlow('1888');if(!definition){const main=[...document.scripts].find(x=>x.src.includes('/_nuxt/'));definition=await(await import(main.src)).C('/comfy/c-work-flow-info/detailByCode/1888');}if(definition?.code!==200||String(definition.data.id)!=='225')throw new Error('VIDEO_WORKFLOW_DEFINITION_MISMATCH');return {selected,durationOptions,prompt:card.querySelector('.batch-prompt-text').textContent,workflow:definition.data,cardText:card.innerText};}`);
    l.videoGenerationPrompt=prompt;l.videoModelCorrection={from:(await readChatCard(dir,l,config,'video')).source.flowCode,to:'1888 / 225 / Seedance2.0（真人）',method:'native Agent card model selector; restored authorized model before any video generation'};return finish(l,'configure-video',result);
  }
  if(op==='submit-video'){
    const l=await ledger(),page=await state();if(page.generating||page.chatLoading||l.stages['configure-video']?.state!=='observed')throw new Error('VIDEO_CONFIRMATION_PRECONDITION');
    const {source}=await readChatCard(dir,l,config,'video');if(!page.nodes.some(n=>sanitize(n.id)===l.imageNodeId&&sanitize(n.target?.findUrl)===l.imageAsset.target.findUrl))throw new Error('MAPPED_VIDEO_INPUT_CHANGED');
    if(source.type!=='batch_generate_video_params'||source.prompts.length!==1||source.sourceNodeIds.length!==1||source.sourceNodeIds[0].length!==1||source.sourceNodeIds[0][0]!==l.imageNodeId)throw new Error('VIDEO_REFERENCE_OR_COUNT_MISMATCH');
    if(!source.labels?.[0]?.startsWith(config.jobId)||source.labels.length!==1)throw new Error('AGENT_JOB_LABEL_MISMATCH');
    const preflight=await ev(`()=>{const cards=[...document.querySelectorAll('.generate-params-card')].filter(x=>!x.classList.contains('batch-card-disabled'));if(cards.length!==1)throw new Error('UNIQUE_VIDEO_CARD_REQUIRED');const card=cards[0],prompt=card.querySelector('.batch-prompt-text')?.textContent.trim(),model=card.querySelector('.batch-item-config-badge')?.textContent.trim(),selected=[...card.querySelectorAll('.batch-select.image-config-trigger')].map(b=>b.textContent.trim()),button=card.querySelector('.batch-confirm-btn');if(model!=='Seedance2.0（真人）'||prompt!==${JSON.stringify(l.videoGenerationPrompt)}||selected.join('|')!==${JSON.stringify('Seedance2.0（真人）|'+config.video.duration+'|16:9|720p')}||card.querySelectorAll('.batch-prompt-row').length!==1||!button||button.disabled)throw new Error('VIDEO_CARD_SPECIFICATION_MISMATCH');return {model,selected,prompt,promptCount:1,confirmEnabled:true,cardText:card.innerText};}`);
    const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const prior=(listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/work/promptTask').map(r=>r.requestId);
    const active=await reserve('video-generation');active.stages['video-generation'].existingCdpRequests=prior;active.videoLabel=source.labels[0];active.stages['video-generation'].preflight=preflight;await atomic(ledgerPath,active);
    const result=await ev(`()=>{const card=[...document.querySelectorAll('.generate-params-card')].find(x=>!x.classList.contains('batch-card-disabled'));const b=card?.querySelector('.batch-confirm-btn');if(!b||b.disabled)throw new Error('VIDEO_CONFIRM_DISABLED');b.click();return {nativeAgentConfirmationClickedOnce:true,at:new Date().toISOString()};}`);return finish(active,'video-generation',result);
  }
  if(op==='verify-video'){
    const l=await ledger();if(!['asset-record-observed','verified-readable-video'].includes(l.stages['video-generation']?.state))throw new Error('VIDEO_ASSET_NOT_OBSERVED');
    const result=await ev(`async()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(l.videoLabel)});if(String(n?.status)!=='2'||!n.target?.findUrl)throw new Error('VIDEO_NOT_COMPLETE');const video=document.createElement('video');video.preload='metadata';video.src=n.target.findUrl;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('VIDEO_METADATA_TIMEOUT')),15000);video.onloadedmetadata=()=>{clearTimeout(timer);resolve();};video.onerror=()=>{clearTimeout(timer);reject(new Error('VIDEO_METADATA_ERROR'));};});const r=await fetch(n.target.findUrl,{credentials:'omit'});const bytes=await r.arrayBuffer();return {nodeId:n.id,target:n.target,httpStatus:r.status,mime:r.headers.get('content-type'),bytes:bytes.byteLength,sha256:[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join(''),width:video.videoWidth,height:video.videoHeight,durationSeconds:video.duration,readyState:video.readyState};}`);
    if(result.httpStatus!==200||!result.bytes||!result.width||!result.durationSeconds)throw new Error('VIDEO_NOT_READABLE');l.videoAsset=result;l.stages['video-generation'].state='verified-readable-video';await atomic(ledgerPath,l);await evidence('video-asset-verification',result);
    const notification=await fullNetwork(api.call,{path:'/apinew/comfy/team/chat/generation-submitted'});await evidence('video-agent-generation-submitted',notification);return {state:'verified-readable-video',video:result,notificationResponse:JSON.parse(notification.responseBody)};
  }
  if(op==='download-video'){
    const l=await ledger();if(l.stages['video-generation']?.state!=='verified-readable-video')throw new Error('VERIFIED_VIDEO_REQUIRED');await state();const active=await reserve('video-download');
    const result=await ev(`()=>{const s=${store};const n=s.nodes.find(n=>n.label===${JSON.stringify(l.videoLabel)});const c=n&&s.getNodeComponent(n.id);if(!c?.handleAction||String(n.status)!=='2'||!n.target?.findUrl)throw new Error('NATIVE_VIDEO_DOWNLOAD_UNAVAILABLE');c.handleAction('download');return {nativeVideoNodeDownloadInvokedOnce:true,nodeId:n.id,assetUrl:n.target.findUrl,at:new Date().toISOString()};}`);return finish(active,'video-download',result);
  }
  if(op==='record-local-download'){
    const l=await ledger(),verification=JSON.parse(await fs.readFile(resolve(dir,'video-local-verification.json'),'utf8'));
    if(verification.path!==resolve(config.outputDir,config.jobId+'__V001__1888_720p_'+config.video.duration+'s.mp4')||!verification.decodeComplete||verification.sha256!==l.videoAsset?.sha256||!l.stages['video-download']?.attempts)throw new Error('LOCAL_DOWNLOAD_VERIFICATION_FAILED');
    const bytes=await fs.readFile(verification.path);if(createHash('sha256').update(bytes).digest('hex')!==verification.sha256)throw new Error('LOCAL_FILE_CHANGED');
    l.localVideo=verification;l.stages['video-download'].state='verified-local-file';l.stages['video-download'].verifiedAt=now();await atomic(ledgerPath,l);return {state:'verified-local-file',verification};
  }
  if(op==='repair-connections'){
    const l=await reserve('repair-connections');const before=await state();if(before.generating||before.chatLoading)throw new Error('CONNECTIONS_REQUIRE_IDLE');
    const result=await ev(`()=>{const s=${store};const labels=[${JSON.stringify(config.labels.reference)},${JSON.stringify(l.imageLabel)},${JSON.stringify(l.videoLabel)}];const nodes=labels.map(label=>s.nodes.filter(n=>n.label===label));if(nodes.some(x=>x.length!==1))throw new Error('UNIQUE_MEDIA_NODES_REQUIRED');const actions=[];for(let i=0;i<2;i++){const from=nodes[i][0].id,to=nodes[i+1][0].id;const present=s.connections.some(c=>c.fromId===from&&c.toId===to);if(!present)s.connectNodes(from,to,'right','left');actions.push({fromId:from,toId:to,nativeConnectionAlreadyPresent:present,bridgeAdded:!present,verified:s.connections.some(c=>c.fromId===from&&c.toId===to)});}return {actions,connections:s.connections,nodeCount:s.nodes.length};}`);return finish(l,'repair-connections',result);
  }
  if(op==='save-final'){
    const before=await state();if(before.generating||before.chatLoading)throw new Error('SAVE_REQUIRES_IDLE');
    const listing=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const previous=new Set((listing.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/canvas-json-info/saveCanvas').map(r=>r.requestId));const l=await reserve('save-final');
    await api.call('press_key',{key:'Control+s'});
    await ev(`async()=>{for(let i=0;i<50;i++){const name=document.querySelector('input[placeholder="输入画布名称..."]');const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='确认保存');if(name&&b){if(name.value!==${JSON.stringify(project)})throw new Error('SAVE_PROJECT_NAME_MISMATCH');b.click();return {confirmed:true};}await new Promise(r=>setTimeout(r,100));}throw new Error('SAVE_DIALOG_NOT_READY');}`);
    let full;for(let i=0;i<40;i++){const list=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const record=(list.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/canvas-json-info/saveCanvas'&&!previous.has(r.requestId)&&/^\d{3}$/.test(r.status)).at(-1);if(record){full=await fullNetwork(api.call,{reqid:record.requestId});break;}await new Promise(r=>setTimeout(r,250));}if(!full)throw new Error('NEW_SAVE_RESPONSE_NOT_OBSERVED');
    const response=JSON.parse(full.responseBody),payload=JSON.parse(full.requestBody);if(response.code!==200||payload.name!==project)throw new Error('SAVE_RESPONSE_NOT_SUCCESS');const canvas=JSON.parse(payload.canvasContent);for(const label of [config.labels.reference,config.labels.settings,l.imageLabel,l.videoLabel])if(canvas.nodes.filter(n=>n.label===label).length!==1)throw new Error('SAVE_MEDIA_NODE_MISMATCH');await evidence('final-save-network',full);return finish(l,'save-final',{state:'save-confirmed',nodeCount:canvas.nodes.length,edgeCount:canvas.connections.length,response});
  }
  if(op==='reopen-final'||op==='restore'){
    const l=await ledger();
    const safe=await ev(`()=>{const s=${store};return {name:s.canvaseInfo?.name||'',edited:s.edited,generating:s.hasGeneratingNodes(),chatLoading:!!document.querySelector('.stop-btn')};}`);
    if(safe.edited||safe.generating||safe.chatLoading||safe.name&&safe.name!==project)throw new Error('RESTORE_REQUIRES_SAVED_IDLE_OR_UNBOUND_TEST_CANVAS');
    // Reopen through native history to verify persisted state. A completed job
    // does not need a renderer reload before every reconciliation.
    const openSavedProject=()=>ev(`async()=>{let s;for(let i=0;i<100;i++){const app=document.querySelector('#__nuxt')?.__vue_app__;s=app?.config.globalProperties.$pinia?._s.get('tapnow-canvas');if(s&&app.config.globalProperties.$nuxt?.isHydrating===false)break;s=null;await new Promise(r=>setTimeout(r,100));}if(!s)throw new Error('APP_NOT_READY');const menu=()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='历史画布'&&b.getClientRects().length);if(!menu()){const logo=document.querySelector('img[alt="logo"]')?.closest('button');if(!logo)throw new Error('LOGO_NOT_FOUND');logo.click();}for(let i=0;i<50&&!menu();i++)await new Promise(r=>setTimeout(r,100));if(!menu())throw new Error('HISTORY_MENU_NOT_READY');menu().click();let h;for(let i=0;i<100;i++){h=[...document.querySelectorAll('h1,h2,h3,h4,h5,[role="heading"]')].filter(x=>x.textContent.trim()===${JSON.stringify(project)});if(h.length===1)break;await new Promise(r=>setTimeout(r,100));}if(h?.length!==1)throw new Error('UNIQUE_TEST_PROJECT_NOT_FOUND');let p=h[0].parentElement;for(let i=0;i<7&&p;i++,p=p.parentElement){const buttons=[...p.querySelectorAll('button,[role="button"]')].filter(b=>b.textContent.trim()==='编辑'||b.title==='编辑'||b.getAttribute('aria-label')==='编辑');if(buttons.length===1){buttons[0].click();for(let j=0;j<100;j++){await new Promise(r=>setTimeout(r,100));const current=${store};if(current.canvaseInfo?.name===${JSON.stringify(project)}&&!current.isCanvasLoading&&current.nodes.length>=${l.baseline.nodes.length+['prepare-upload','prepare-settings'].filter(k=>l.stages[k]?.result?.nodeId).length+['image','video'].filter(k=>l[k+'NodeId']).length})return {opened:true};}throw new Error('PROJECT_REOPEN_TIMEOUT');}}throw new Error('EDIT_BUTTON_NOT_FOUND');}`);
    try{await openSavedProject();}catch(e){
      if(op!=='restore'||!/Target crashed/.test(e.message)||l.phase!=='media-chain-saved-and-restored')throw e;
      await evidence('restore-renderer-crash',{at:now(),message:e.message,action:'one bounded reload after saved/idle preflight; no submit',resubmitted:false});
      await api.call('navigate_page',{type:'reload'});await openSavedProject();
    }
    return runRaw(api,{operation:'media:verify-restored'});
  }
  if(op==='verify-restored'){
    const l=await ledger(),page=await state();const full=await fullNetwork(api.call,{path:'/apinew/comfy/canvas-json-info/detail'});const response=JSON.parse(full.responseBody),canvas=JSON.parse(response.data.canvasContent);
    if(response.code!==200||response.data.name!==project)throw new Error('RESTORED_PROJECT_MISMATCH');
    const labels=[config.labels.reference,l.imageLabel,l.videoLabel],nodes=labels.map(label=>canvas.nodes.find(n=>n.label===label));if(nodes.some(x=>!x?.target?.findUrl))throw new Error('RESTORED_MEDIA_ASSET_MISSING');
    const expected=[l.stages.upload.asset.target.findUrl,l.imageAsset.target.findUrl,l.videoAsset.target.findUrl];if(nodes.some((n,i)=>sanitize(n.target.findUrl)!==expected[i]))throw new Error('RESTORED_ASSET_CHANGED');
    const connections=[0,1].map(i=>canvas.connections.some(c=>c.fromId===nodes[i].id&&c.toId===nodes[i+1].id));if(!connections.every(Boolean))throw new Error('RESTORED_REFERENCE_CONNECTION_MISSING');
    verifyBaseline(l.baseline,canvas);
    const restoredHistory=await restoreSession({...api,fullNetwork:args=>captureNetwork(api.call,args)},{sessionId:l.sessionId,prompt:l.videoPrompt});const history=restoredHistory.network;const sessionMatches=true,hasOriginalTask=true;
    const local=await fs.readFile(l.localVideo.path);if(createHash('sha256').update(local).digest('hex')!==l.videoAsset.sha256)throw new Error('RECOVERED_LOCAL_FILE_MISMATCH');
    const current=await api.call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});const submissions=(current.data.networkRequests||[]).filter(r=>new URL(r.url).pathname==='/apinew/comfy/work/promptTask');
    const backendStatus=await runRaw(api,{operation:'media:refresh-completed-status'});
    const result={state:'saved-media-chain-and-local-file-verified',runId:l.runId,nodeCount:canvas.nodes.length,edgeCount:canvas.connections.length,connections,sessionMatches,hasOriginalTask,baselinePreserved:true,localFileHashMatches:true,backendStatus,imageSubmissions:l.stages['image-generation'].attempts,videoSubmissions:l.stages['video-generation'].attempts,downloads:l.stages['video-download'].attempts,observedSubmissionsInCurrentMcpBuffer:submissions.length,pageEdited:page.edited,resubmitted:false,verifiedAt:now()};
    await evidence('final-canvas-detail-network',full);await evidence('final-session-history-network',history);await evidence('restored-verification',result);l.phase='media-chain-saved-and-restored';l.lastRestoredAt=now();await atomic(ledgerPath,l);return result;
  }
  if(op==='reconcile-save'){
    const l=await ledger(),page=await state();if(page.edited||page.generating||page.chatLoading)throw new Error('SAVE_RECONCILIATION_REQUIRES_IDLE');
    const full=await fullNetwork(api.call,{path:'/apinew/comfy/canvas-json-info/saveCanvas'});const payload=JSON.parse(full.requestBody),response=JSON.parse(full.responseBody),canvas=JSON.parse(payload.canvasContent);
    if(response.code!==200||payload.name!==project)throw new Error('SAVE_NOT_SUCCESS');
    for(const [label,url] of [[config.labels.reference,l.stages.upload.asset.target.findUrl],[l.imageLabel,l.imageAsset.target.findUrl],[l.videoLabel,l.videoAsset.target.findUrl]]){const n=canvas.nodes.find(x=>x.label===label);if(!n||sanitize(n.target?.findUrl)!==url)throw new Error('SAVED_ASSET_MISMATCH');}
    const settings=canvas.nodes.find(n=>n.label===config.labels.settings);if(settings?.param?.promptComponents?.filter(x=>x.isActive).length!==2)throw new Error('SAVED_CAMERA_LIGHTING_MISSING');
    const result={state:'native-save-reconciled',saveMode:'observed AIX save request; no repeated save click',nodeCount:canvas.nodes.length,edgeCount:canvas.connections.length,response,requestBodyBytes:full.requestBodyBytes};l.stages['save-final']={...l.stages['save-final'],state:'observed',reconciledAt:now(),result};await atomic(ledgerPath,l);await evidence('final-save-network',full);return result;
  }
  throw new Error('UNSUPPORTED_OR_UNVERIFIED_MEDIA_OPERATION_'+op);
}

return {runMedia};
}
