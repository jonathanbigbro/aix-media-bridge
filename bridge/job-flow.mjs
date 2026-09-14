import fs from 'node:fs/promises';
import vm from 'node:vm';
import {assertJobOwner} from './job-lock.mjs';
export async function runJob(api,input,adapters={}){
  const configModule=new URL('./job-config.mjs',import.meta.url);
  const {loadConfig}=await import(configModule.href+'?rev='+(await fs.stat(configModule)).mtimeMs);
  const context={...await (adapters.loadConfig||loadConfig)(input.configPath)};
  const operation=input.operation.slice(4);
  if(!['preflight','status'].includes(operation)){
    await assertJobOwner(context,input.lockToken);context.lockToken=input.lockToken;
  }
  const path=new URL('./media-ops.mjs',import.meta.url);
  const module=await import(path.href+'?rev='+(await fs.stat(path)).mtimeMs);
  const checkedApi={...api,call:async(name,args,...rest)=>{
    if(operation==='status')throw new Error('STATUS_BROWSER_ACCESS_FORBIDDEN');
    if(name==='evaluate_script')new vm.Script('('+args.function+')');
    return api.call(name,args,...rest);
  }};
  return module.createMediaOperations(context).runMedia(checkedApi,{...input,operation:'media:'+operation});
}
