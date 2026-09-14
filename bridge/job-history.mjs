import {sanitize} from './redact.mjs';
export async function awaitNetwork(api,args){
  for(let i=0;i<60;i++){try{return await api.fullNetwork(args);}catch(e){if(!['NO_ALLOWED_OBSERVED_REQUEST','RESPONSE_STILL_PENDING'].includes(e.message)||i===59)throw e;await new Promise(r=>setTimeout(r,500));}}
}
async function evaluate(api,fn){const r=await api.call('evaluate_script',{function:fn,waitForStableDom:false});if(r.isError)throw new Error(r.data.message||'HISTORY_UI_ERROR');return r.data.evaluation;}
export async function restoreSession(api,{sessionId,prompt}){
  const matches=network=>sanitize({sessionId:new URL(network.url).pathname.split('/').at(-1)}).sessionId===sessionId&&JSON.parse(network.responseBody).data?.some(m=>m.role==='user'&&m.content===prompt);
  // A restarted bridge has no prior request cache; inspect it once, then use
  // native history controls to observe fresh requests instead of waiting for it.
  try{const current=await api.fullNetwork({path:'/apinew/comfy/team/chat/history'});if(matches(current))return {network:current,switched:false};}catch(e){if(!['NO_ALLOWED_OBSERVED_REQUEST','RESPONSE_STILL_PENDING'].includes(e.message))throw e;}
  await evaluate(api,`()=>{if(!document.querySelector('.history-item')){const b=document.querySelector('.ai-chat-panel button[title="历史对话"]');if(!b)throw new Error('NATIVE_HISTORY_BUTTON_MISSING');b.click();}return {opened:true};}`);
  const sessions=JSON.parse((await awaitNetwork(api,{path:'/apinew/comfy/team/chat/sessions'})).responseBody).data;
  const target=sessions.filter(s=>sanitize({sessionId:s.nodeId}).sessionId===sessionId);if(target.length!==1)throw new Error('BOUND_JOB_SESSION_NOT_UNIQUE');
  await evaluate(api,`async()=>{const title=${JSON.stringify(target[0].title)};for(let i=0;i<50;i++){const rows=[...document.querySelectorAll('.history-item')].filter(x=>x.querySelector('.history-item-title')?.textContent.trim()===title&&x.getClientRects().length);if(rows.length===1){rows[0].click();return {selected:true};}await new Promise(r=>setTimeout(r,100));}throw new Error('BOUND_JOB_SESSION_ROW_NOT_UNIQUE');}`);
  for(let i=0;i<30;i++){
    try{const network=await api.fullNetwork({path:'/apinew/comfy/team/chat/history'});if(matches(network))return {network,switched:true};}catch(e){if(!['NO_ALLOWED_OBSERVED_REQUEST','RESPONSE_STILL_PENDING'].includes(e.message))throw e;}
    await new Promise(r=>setTimeout(r,300));
  }
  throw new Error('ORIGINAL_JOB_HISTORY_NOT_RECOVERED');
}
