import {sanitize} from './redact.mjs';

// Read the active native message from its card component. The captured native
// ChatPanel keeps generateParams on the message and edits its workflow through
// its model selector. Prompt edits are rendered from the batch prompt rows.
// No fallback to the original Agent model or to a badge alone is permitted.
export function readNativeImageCard(){
 const cards=[...document.querySelectorAll('.generate-params-card')].filter(c=>!c.classList.contains('batch-card-disabled'));
 if(cards.length!==1)throw new Error('UNIQUE_UNSUBMITTED_CARD_REQUIRED');
 const card=cards[0],params=[];
 let component=card.__vueParentComponent;
 // Production Vue omits DOM component pointers. Find the owner of this exact
 // live element in the mounted vnode tree; never select another chat panel.
 if(!component){
  const seen=new Set(),owners=new Set();
  function visit(node,owner,depth=0){
   if(!node||typeof node!=='object'||seen.has(node)||depth>150)return;
   seen.add(node);if(node.el===card&&owner)owners.add(owner);
   if(node.component)visit(node.component.subTree,node.component,depth+1);
   if(Array.isArray(node.children))node.children.forEach(child=>visit(child,owner,depth+1));
   if(node.ssContent)visit(node.ssContent,owner,depth+1);
  }
  visit(document.querySelector('#__nuxt')?._vnode,null);
  if(owners.size===1)component=[...owners][0];
 }
 const collect=message=>{if(message?.generateParams&&!message.generateSubmitted&&!message.generateCancelled)params.push(message.generateParams);};
 for(const owner of [component?.props,component?.setupState,component?.exposed]){
  collect(owner?.message);
  const messages=owner?.messages?.value||owner?.messages;
  if(Array.isArray(messages))messages.forEach(collect);
 }
 // The existing ChatPanel also registers a read-only getter of the active
 // generateParams. Only its exact getter body shape is callable, never the
 // render effect, a watcher callback, or a generation handler.
 const getter=/^\(\)=>\{var (\w+);for\(let (\w+)=(\w+)\.value\.length-1;\2>=0;\2--\)\{const (\w+)=\3\.value\[\2\];if\(\4\.generateParams&&!\4\.generateSubmitted&&!\4\.generateCancelled\)return \4\.generateParams\}return\(\1=\3\.value\[\3\.value\.length-1\]\)==null\?void 0:\1\.generateParams\}$/;
 for(const effect of component?.scope?.effects||[]){
  if(effect!==component.effect&&typeof effect.fn==='function'&&getter.test(Function.prototype.toString.call(effect.fn))){const current=effect.fn();if(current)params.push(current);}
 }
 // The inspected production build wraps watch *source getters* in Vue's
 // callWithAsyncErrorHandling(source, 2). Its active-card getter has this exact
 // dependency sequence: messages ref, array length/index, and the three message
 // fields above (plus Vue's thenable check). No scheduler/job/callback is run.
 // A generic wrapper without this bounded dependency fingerprint is rejected.
 if(!params.length&&component?.type?.__name==='ChatPanel'){
  const candidates=[];
  for(const effect of component.scope?.effects||[]){
   if(effect===component.effect||!/^\(\)=>\w+\(\w+,2\)$/.test(String(effect.fn)))continue;
   const links=[],seen=new Set();let link=effect.deps;
   while(link&&!seen.has(link)&&links.length<100){seen.add(link);links.push(link.dep);link=link.nextDep;}
   if(link||links.some(dep=>!dep||dep.computed))continue;
   const keys=links.map(dep=>dep.key);
   if(keys[0]!==undefined||keys[1]!=='length'||!keys.includes('generateParams')||!keys.includes('generateSubmitted')||!keys.includes('generateCancelled'))continue;
   if(keys.slice(2).some(key=>typeof key!=='string'||!(/^(?:\d+|generateParams|generateSubmitted|generateCancelled|then)$/.test(key))))continue;
   candidates.push(effect);
  }
  if(candidates.length===1){const current=candidates[0].fn();if(current)params.push(current);}
 }
 const unique=[...new Set(params)];
 if(unique.length!==1)throw new Error('CURRENT_IMAGE_CARD_COMPONENT_EVIDENCE_UNAVAILABLE');
 const current=unique[0],message=card.closest('.chat-msg');
 let previous=message?.previousElementSibling;
 while(previous&&!previous.classList.contains('user'))previous=previous.previousElementSibling;
 const messageText=previous?.querySelector('.msg-text');
 const taskPrompt=messageText?.innerText??messageText?.textContent;
 const rows=[...card.querySelectorAll('.batch-prompt-row')],prompts=rows.map(row=>row.querySelector('.batch-prompt-text')?.textContent.trim());
 const store=document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$pinia?._s.get('tapnow-canvas');
 const refs=current.sourceNodeIds,referenceAssets=Array.isArray(refs)&&refs.length===1&&Array.isArray(refs[0])?refs[0].map(id=>store?.nodes.find(n=>n.id===id)?.target?.findUrl):[];
 const selected=[...card.querySelectorAll('.batch-select.image-config-trigger')].map(b=>b.textContent.trim());
 const button=card.querySelector('.batch-confirm-btn');
 return {type:current.type,flowCode:current.flowCode,workflowId:current.workflowId,sourceNodeIds:refs,referenceAssets,labels:current.labels,prompts,taskPrompt,
  count:current.prompts?.length,ratio:selected[1],resolution:selected[2],model:card.querySelector('.batch-item-config-badge')?.textContent.trim(),globalModel:selected[0],prompt:prompts[0],promptCount:rows.length,confirmEnabled:!!button&&!button.disabled};
}
export function validateImageCard(current,source,request,ledger,config,{beforePromptEdit=false}={}){
 const exact=(a,b)=>JSON.stringify(sanitize(a))===JSON.stringify(sanitize(b));
 const expectedPrompt=beforePromptEdit?source.prompts?.[0]:ledger.imageGenerationPrompt;
 const checks={
  originalTask:source.type==='batch_generate_image_params'&&source.labels?.length===1&&source.labels[0]===config.labels.image&&source.prompts?.length===1,
  originalReference:exact(source.sourceNodeIds,[[ledger.referenceNodeId]]),
  taskIdentity:!!request.message&&current.taskPrompt===request.message,
  currentType:current.type==='batch_generate_image_params',
  model:current.model==='全能图片PRO'&&current.globalModel==='全能图片PRO'&&current.flowCode===config.image.model&&String(current.workflowId)===config.image.workflowId,
  currentLabels:exact(current.labels,source.labels),
  currentReference:exact(current.sourceNodeIds,[[ledger.referenceNodeId]])&&exact(current.referenceAssets,[ledger.stages.upload.asset.target.findUrl]),
  singleImage:current.count===1&&current.promptCount===1&&current.prompts?.length===1,
  prompt:typeof expectedPrompt==='string'&&current.prompt===expectedPrompt&&current.prompts?.[0]===expectedPrompt,
  parameters:current.ratio===config.image.ratio&&current.resolution===config.image.resolution,
  confirmEnabled:current.confirmEnabled===true
 };
 if(Object.values(checks).some(v=>v!==true))throw new Error('ACTUAL_IMAGE_CARD_PREFLIGHT_FAILED: '+Object.keys(checks).filter(k=>checks[k]!==true).join(','));
 return {current,checks};
}
export function imageConfirmationScript(expected){
 return `()=>{const read=${readNativeImageCard.toString()};const current=read();if(JSON.stringify(current)!==${JSON.stringify(JSON.stringify(expected))})throw new Error('IMAGE_CARD_CHANGED_BEFORE_CONFIRM');const card=[...document.querySelectorAll('.generate-params-card')].filter(c=>!c.classList.contains('batch-card-disabled'))[0];card.querySelector('.batch-confirm-btn').click();return {nativeAgentConfirmationClickedOnce:true,at:new Date().toISOString()};}`;
}
