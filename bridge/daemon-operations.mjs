import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {base,root,stateDir} from './paths.mjs';
import {sanitize,normalizeMcpData} from './redact.mjs';
import {fullNetwork} from './network-full.mjs';

// Injectable transport for offline dispatch tests; no connection is opened here.
export function createDaemonOperations({client,version,onShutdown,runFlow,metricsPath=resolve(stateDir,'logs','mcp-calls.jsonl')}){
let boundPage=null;
const allowed=new Set(['list_pages','evaluate_script','take_snapshot','click','fill','press_key','list_network_requests','get_network_request','navigate_page','hover']);
async function call(name,args={},internalPipes=false){
  if(!allowed.has(name))throw new Error('UNSUPPORTED_TOOL');
  if(name!=='list_pages'&&boundPage===null)throw new Error('NO_VERIFIED_AIX_BINDING');
  if(name!=='list_pages')args={...args,pageId:boundPage};
  if(name==='navigate_page'&&args.type!=='reload')throw new Error('UNSUPPORTED_NAVIGATION');
  if(name==='get_network_request'&&(args.requestFilePath||args.responseFilePath)&&!internalPipes)throw new Error('RAW_NETWORK_FILES_DISABLED');
  if(name==='evaluate_script'&&args.filePath)throw new Error('RAW_EVALUATION_FILES_DISABLED');
  const started=new Date().toISOString(),t=performance.now();
  const result=await client.callTool({name,arguments:args},undefined,{timeout:60000});
  await fs.appendFile(metricsPath,JSON.stringify({started,name,durationMs:Math.round(performance.now()-t),isError:!!result.isError})+'\n');
  const data=result.structuredContent||{message:result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n')};
  if(result.isError&&!data.message)data.message=result.content?.filter(x=>x.type==='text').map(x=>x.text).join('\n');
  if(data.pages)data.pages=data.pages.filter(p=>{try{return new URL(p.url).origin==='https://aix.studio';}catch{return false;}});
  return {isError:!!result.isError,data:normalizeMcpData(data)};
}
async function targets(){const r=await call('list_pages');if(r.isError)throw new Error(r.data?.message||'CHROME_CONNECTION_FAILED');if(!r.data.pages)throw new Error('CHROME_PAGE_LIST_UNAVAILABLE');return r.data.pages.filter(p=>new URL(p.url).pathname==='/AixCanvas');}
async function dispatch(q){
  if(q.op==='health')return {state:'bridge-running',version,pid:process.pid};
  if(q.op==='pages')return {pages:(await targets()).map(p=>({id:p.id,title:p.title,url:'https://aix.studio/AixCanvas'}))};
  if(q.op==='bind'){
    let pages=await targets();
    if(q.pageId!==undefined)pages=pages.filter(p=>p.id===q.pageId);
    if(q.canvasIdAlias){
      const matches=[];
      for(const p of pages){boundPage=p.id;const result=await call('evaluate_script',{function:"()=>({canvasId:document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$pinia?._s.get('tapnow-canvas')?.canvaseInfo?.id})",waitForStableDom:false});if(!result.isError&&sanitize(result.data.evaluation)?.canvasId===q.canvasIdAlias)matches.push(p);}
      pages=matches;boundPage=null;
    }
    if(pages.length!==1)throw new Error('AIX_TARGET_COUNT_'+pages.length+'_USE_PROJECT_PAGES_AND_--page');
    boundPage=pages[0].id;return {boundPage,url:'https://aix.studio/AixCanvas'};
  }
  if(q.op==='flow'){
    const path=resolve(base,'runtime-workflow.mjs');
    const run=runFlow||(await import('./runtime-workflow.mjs?rev='+(await fs.stat(path)).mtimeMs)).run;
    return run({call,fullNetwork:args=>fullNetwork(call,args)},q.args);
  }
  if(q.op==='shutdown'){
    try{const lock=JSON.parse(await fs.readFile(resolve(root,'jobs','.project.lock'),'utf8'));try{process.kill(lock.pid,0);throw new Error('ACTIVE_JOB_REFUSES_SHUTDOWN');}catch(e){if(e.code!=='ESRCH')throw e;}}catch(e){if(e.code!=='ENOENT')throw e;}
    if(boundPage!==null){const r=await call('evaluate_script',{function:"()=>{const s=document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$pinia?._s.get('tapnow-canvas');return {busy:!!s&&(!!s.edited||s.hasGeneratingNodes()||!!document.querySelector('.stop-btn'))};}",waitForStableDom:false});if(r.isError||r.data.evaluation?.busy)throw new Error('CANVAS_NOT_IDLE_REFUSES_SHUTDOWN');}
    setTimeout(()=>onShutdown(),100);return {state:'stopping'};
  }
  throw new Error('UNSUPPORTED_OPERATION_USE_PUBLIC_CLI');
}
return {dispatch};
}
