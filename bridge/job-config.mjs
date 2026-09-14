import fs from 'node:fs/promises';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {root} from './paths.mjs';
import {readProject,listProjects} from './project-store.mjs';
export const sha=x=>createHash('sha256').update(x).digest('hex');
export const canonical=x=>JSON.stringify(sort(x));
function sort(x){return Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;}
function exact(x,keys,name){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!keys.includes(k))||keys.some(k=>!(k in x)))throw new Error('INVALID_CONFIG_FIELDS_'+name);}
function equal(a,b,name){if(canonical(a)!==canonical(b))throw new Error('UNSUPPORTED_OR_UNVERIFIED_'+name);}
export const supported={image:{model:'main_image',workflowId:'248',ratio:'16:9',resolution:'2k',count:1},video:{model:'1888',workflowId:'225',ratio:'16:9',resolution:'720p',duration:4,count:1},photography:['飞思 XF IQ4 150MP','Cooke S4','50mm','ƒ/5.6','1/500s-清晰'],lighting:['电影三点光','45°侧光','柔雾灰'],limits:{uploads:1,imageSubmissions:1,videoSubmissions:1,downloads:1,imageAgentRequests:1,videoAgentRequests:1}};
export async function loadConfig(file){
  const path=resolve(file),raw=JSON.parse(await fs.readFile(path,'utf8'));
  exact(raw,['schemaVersion','jobId','project','referencePng','image','video','photography','lighting','outputDir','limits'],'root');
  if(![1,2].includes(raw.schemaVersion)||!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(raw.jobId))throw new Error('INVALID_JOB_ID_OR_SCHEMA');
  let project;
  if(raw.schemaVersion===2){
    exact(raw.project,['key'],'project');
    const binding=await readProject(raw.project.key);project={name:binding.name,canvasIdAlias:binding.canvasIdAlias};
  }else{
    exact(raw.project,['name','canvasIdAlias'],'project');
    const known=await listProjects();
    if(!known.some(p=>p.name===raw.project.name&&p.canvasIdAlias===raw.project.canvasIdAlias))throw new Error('PROJECT_NOT_BOUND_USE_PROJECT_BIND_OR_CREATE');
    project=raw.project;
  }
  for(const kind of ['image','video']){
    exact(raw[kind],[...Object.keys(supported[kind]),'prompt'],kind);
    const {prompt,...options}=raw[kind];
    const expected=kind==='video'&&[4,5].includes(options.duration)?{...supported.video,duration:options.duration}:supported[kind];
    equal(options,expected,kind+'_PARAMETERS');
    if(typeof prompt!=='string'||prompt.trim().length<10||prompt.length>6000||prompt.includes('\0'))throw new Error('INVALID_'+kind+'_PROMPT');
  }
  for(const name of ['photography','lighting','limits'])equal(raw[name],supported[name],name);
  if(typeof raw.referencePng!=='string'||typeof raw.outputDir!=='string')throw new Error('INVALID_PATH');
  const inputPath=await fs.realpath(resolve(dirname(path),raw.referencePng)),bytes=await fs.readFile(inputPath);
  if(bytes.length<33||bytes.length>5*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR')throw new Error('INVALID_OR_UNSUPPORTED_PNG');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(!width||!height||width>4096||height>4096)throw new Error('UNSUPPORTED_REFERENCE_DIMENSIONS');
  const outputDir=resolve(dirname(path),raw.outputDir),outputsRoot=resolve(root,'outputs');
  if(!relative(outputsRoot,outputDir)||relative(outputsRoot,outputDir).startsWith('..')||isAbsolute(relative(outputsRoot,outputDir)))throw new Error('OUTPUT_MUST_BE_JOB_SUBDIRECTORY_UNDER_OUTPUTS');
  // Existing ancestors may not redirect output into a historical evidence directory.
  for(let parent=outputDir;;parent=dirname(parent)){try{const real=await fs.realpath(parent);if(real!==parent)throw new Error('SYMLINKED_OUTPUT_UNSUPPORTED');break;}catch(e){if(e.code!=='ENOENT')throw e;if(parent===dirname(parent))throw e;}}
  const config={...raw,project,referencePng:inputPath,outputDir};
  const input={path:inputPath,bytes:bytes.length,sha256:sha(bytes),width,height};
  const digest=sha(canonical({config,input}));
  const dir=resolve(root,'jobs',raw.jobId),ledgerPath=resolve(dir,'ledger.json');
  const existing=await readJson(ledgerPath);
  if(existing&&existing.configDigest!==digest)throw new Error('JOB_CONFIG_CHANGED_USE_ORIGINAL_CONFIG');
  const labels={reference:raw.jobId+'__REFERENCE',settings:raw.jobId+'__SETTINGS',image:raw.jobId+'__IMAGE',video:raw.jobId+'__VIDEO'};
  const imageAgentPrompt=`${raw.jobId} IMAGE stage. Work only in the selected canvas. Prepare exactly ONE image generation parameter card using 全能图片PRO, flowCode main_image, workflowId 248, 16:9, 2k, count 1. Use ONLY the attached ${labels.reference} as 图1. Image brief: ${raw.image.prompt}\nSet the single output label to ${labels.image}. Return the native parameter card; I will confirm it after checking the parameters. Do NOT submit generation automatically; do not generate other media or change existing nodes.`;
  const videoAgentPrompt=`${raw.jobId} VIDEO stage. Use ONLY the attached newly generated PRO image as 图1. Prepare exactly ONE native video parameter card using Seedance2.0（真人）, flowCode 1888, workflowId 225, duration ${raw.video.duration} seconds, resolution 720p, aspect ratio 16:9. All other image, video, audio slots empty. Video brief: ${raw.video.prompt}\nSet the single output label to ${labels.video}. Return the native confirmation card. Do NOT submit generation automatically, create another image, or modify existing nodes.`;
  return {path,config:{...config,labels,imageAgentPrompt,videoAgentPrompt},input,digest,dir,ledgerPath,existing};
}
export async function readJson(path){try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export async function writeAtomic(path,value){await fs.mkdir(dirname(path),{recursive:true});const tmp=path+'.'+randomUUID()+'.tmp';const f=await fs.open(tmp,'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}await fs.rename(tmp,path);const d=await fs.open(dirname(path),'r');try{await d.sync();}finally{await d.close();}}
export async function acquireLock(path){
  await fs.mkdir(dirname(path),{recursive:true});const owner={pid:process.pid,token:randomUUID(),createdAt:new Date().toISOString()};
  for(let i=0;i<2;i++){
    try{const f=await fs.open(path,'wx',0o600);try{await f.writeFile(JSON.stringify(owner));await f.sync();}finally{await f.close();}return {owner,release:async()=>{if((await readJson(path))?.token===owner.token)await fs.unlink(path);}};}
    catch(e){if(e.code!=='EEXIST')throw e;const old=await readJson(path);if(!old?.pid)throw new Error('LOCK_OWNER_UNKNOWN');try{process.kill(old.pid,0);throw new Error('JOB_OR_PROJECT_LOCKED');}catch(test){if(test.code!=='ESRCH')throw test;}await fs.rename(path,path+'.stale-'+randomUUID());}
  }throw new Error('LOCK_ACQUISITION_FAILED');
}
