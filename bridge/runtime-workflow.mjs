import fs from 'node:fs/promises';
export async function run(api,input){
  const entry=input.operation?.startsWith('job:')?'job-flow.mjs':input.operation?.startsWith('project:')?'project-ops.mjs':null;
  if(!entry)throw new Error('UNSUPPORTED_OPERATION_USE_PUBLIC_CLI');
  const path=new URL(entry,import.meta.url);
  const mod=await import(path.href+'?rev='+(await fs.stat(path)).mtimeMs);
  return entry==='job-flow.mjs'?mod.runJob(api,input):mod.runProject(api,input);
}
