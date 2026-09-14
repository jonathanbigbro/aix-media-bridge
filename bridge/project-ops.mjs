import vm from 'node:vm';
import {resolve} from 'node:path';
import {sanitize} from './redact.mjs';
import {root,stateDir,ensureState} from './paths.mjs';
import {readJson,writeAtomic,acquireLock} from './job-config.mjs';
import {readProject,writeProject,validateKey,validateName} from './project-store.mjs';
const store="document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$pinia?._s.get('tapnow-canvas')";
export async function runProject(api,input){
  async function evaluate(fn){new vm.Script('('+fn+')');const r=await api.call('evaluate_script',{function:fn,waitForStableDom:false});if(r.isError)throw new Error(r.data?.message||'PROJECT_UI_ERROR');return r.data.evaluation;}
  async function current(){return sanitize(await evaluate(`()=>{const s=${store};if(!s)throw new Error('OPEN_AIX_CANVAS_IN_CHROME');return {name:s.canvaseInfo?.name||'',canvasId:s.canvaseInfo?.id,edited:s.edited,generating:s.hasGeneratingNodes(),nodeCount:s.nodes.length,chatLoading:!!document.querySelector('.stop-btn')};}`));}
  function idle(page){if(page.edited||page.generating||page.chatLoading)throw new Error('PROJECT_MUST_BE_SAVED_AND_IDLE');}
  async function menu(){return evaluate(`async()=>{const option=()=>[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='历史画布'&&x.getClientRects().length);if(!option()){const b=document.querySelector('img[alt="logo"]')?.closest('button');if(!b)throw new Error('CANVAS_MENU_MISSING');b.click();}for(let i=0;i<50&&!option();i++)await new Promise(r=>setTimeout(r,100));if(!option())throw new Error('CANVAS_MENU_NOT_READY');return {opened:true};}`);}
  const mode=input.operation?.slice(8);
  if(mode==='inspect')return {state:'current-canvas',project:await current()};
  if(!['bind','create','open','select'].includes(mode))throw new Error('UNSUPPORTED_PROJECT_OPERATION');
  const key=validateKey(input.key);await ensureState();
  const lock=await acquireLock(resolve(root,'jobs','.project.lock'));
  try{
    let bound;try{bound=await readProject(key);}catch(e){if(e.message!=='PROJECT_NOT_BOUND_USE_PROJECT_BIND_OR_CREATE')throw e;}
    if(mode==='bind'){
      const page=await current();idle(page);if(!page.name||!page.canvasId)throw new Error('SAVE_CANVAS_BEFORE_BINDING');
      const binding=await writeProject(key,{name:page.name,canvasIdAlias:page.canvasId,boundAt:new Date().toISOString()});
      return {state:'project-bound',binding};
    }
    if(mode==='open'||mode==='select'){
      if(mode==='open'&&!bound)throw new Error('PROJECT_NOT_BOUND_USE_PROJECT_BIND_OR_CREATE');
      const name=validateName(mode==='open'?bound.name:input.name);
      const page=await current();idle(page);
      if(page.name!==name||(bound&&page.canvasId!==bound.canvasIdAlias)){
        await menu();
        await evaluate(`async()=>{const menu=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='历史画布'&&x.getClientRects().length);menu.click();let headings=[];for(let i=0;i<100;i++){headings=[...document.querySelectorAll('h1,h2,h3,h4,h5,[role="heading"]')].filter(x=>x.textContent.trim()===${JSON.stringify(name)}&&x.getClientRects().length);if(headings.length)break;await new Promise(r=>setTimeout(r,100));}if(headings.length!==1)throw new Error('UNIQUE_PROJECT_NAME_REQUIRED_IN_HISTORY');let p=headings[0].parentElement;for(let i=0;i<7&&p;i++,p=p.parentElement){const b=[...p.querySelectorAll('button,[role="button"]')].filter(b=>b.textContent.trim()==='编辑'||b.title==='编辑'||b.getAttribute('aria-label')==='编辑');if(b.length===1){b[0].click();return {nativeHistorySelected:true};}}throw new Error('PROJECT_EDIT_CONTROL_MISSING');}`);
      }
      let selected;for(let i=0;i<100;i++){selected=await current();if(selected.name===name&&selected.canvasId&&!selected.edited)break;await new Promise(r=>setTimeout(r,100));}
      idle(selected);if(selected.name!==name||!selected.canvasId)throw new Error('PROJECT_OPEN_NOT_VERIFIED');
      if(bound&&(bound.name!==name||bound.canvasIdAlias!==selected.canvasId))throw new Error('PROJECT_ID_MISMATCH_NO_MUTATION');
      return {state:'project-opened',binding:await writeProject(key,{name,canvasIdAlias:selected.canvasId,boundAt:new Date().toISOString()})};
    }
    const name=validateName(input.name);
    if(bound){if(bound.name!==name)throw new Error('PROJECT_KEY_ALREADY_BOUND');return {state:'already-created-or-bound',binding:bound,newCanvases:0};}
    const path=resolve(stateDir,'projects',key+'.creation');
    let intent=await readJson(path);
    if(intent&&intent.name!==name)throw new Error('PROJECT_CREATION_CONFIG_CHANGED');
    if(intent&&!intent.newCanvasId)throw new Error('PROJECT_CREATION_ID_UNKNOWN_INSPECT_ORIGINAL_ATTEMPT_NO_RETRY');
    const createdThisCall=!intent;
    let page=await current();idle(page);
    if(!intent){
      await menu();
      intent={schemaVersion:1,key,name,before:page,state:'creation-reserved-result-unknown',attempts:1,createdAt:new Date().toISOString()};
      await writeAtomic(path,intent);
      await evaluate(`()=>{const b=[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='新建画布'&&x.getClientRects().length);if(b.length!==1)throw new Error('UNIQUE_CREATE_CANVAS_CONTROL_REQUIRED');b[0].click();return {nativeCreateClickedOnce:true};}`);
    }
    for(let i=0;i<100;i++){page=await current();if(page.canvasId&&page.canvasId!==intent.before.canvasId&&page.nodeCount===0&&!page.generating)break;await new Promise(r=>setTimeout(r,100));}
    if(!page.canvasId||page.canvasId===intent.before.canvasId||page.nodeCount!==0)throw new Error('PROJECT_CREATION_RESULT_UNKNOWN_NO_RETRY');
    if(intent.newCanvasId&&intent.newCanvasId!==page.canvasId)throw new Error('CREATED_CANVAS_CHANGED_NO_RETRY');
    intent.newCanvasId=page.canvasId;intent.state='new-empty-canvas-observed';await writeAtomic(path,intent);
    if(page.name!==name){
      await evaluate(`async()=>{const s=${store};if(s.nodes.length||s.hasGeneratingNodes())throw new Error('ONLY_RENAME_NEW_EMPTY_CANVAS');const e=document.querySelector('input[placeholder="无限生成式画布"]');if(!e)throw new Error('CANVAS_NAME_INPUT_MISSING');e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(name)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));e.blur();await new Promise(r=>requestAnimationFrame(r));return {nativeNameEdited:true};}`);
    }
    for(let i=0;i<100;i++){page=await current();if(page.name===name&&page.canvasId&&!page.edited)break;await new Promise(r=>setTimeout(r,100));}
    if(page.name!==name||!page.canvasId||page.edited)throw new Error('NEW_CANVAS_NAME_OR_SAVE_NOT_VERIFIED_RESUME_CREATE');
    intent.state='created-and-bound';intent.canvasIdAlias=page.canvasId;intent.finishedAt=new Date().toISOString();await writeAtomic(path,intent);
    return {state:'project-created',binding:await writeProject(key,{name,canvasIdAlias:page.canvasId,boundAt:new Date().toISOString()}),newCanvases:createdThisCall?1:0,reconciled:!createdThisCall};
  }finally{await lock.release();}
}
