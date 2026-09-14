import {withJobMutation,writeJobJson} from './job-lock.mjs';
import fs from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {base,downloadsDir} from './paths.mjs';
import {sha,readJson} from './job-config.mjs';
const exec=promisify(execFile);
export async function downloadJob(context,step){
  const l=await readJson(context.ledgerPath),{config,dir}=context;
  if(!l.videoAsset?.sha256)throw new Error('VERIFIED_VIDEO_ASSET_REQUIRED');
  const path=resolve(config.outputDir,config.jobId+'__V001__1888_720p_'+config.video.duration+'s.mp4');
  await fs.mkdir(config.outputDir,{recursive:true});
  const started=l.stages['video-download']?.startedAt||new Date().toISOString();
  if(!l.stages['video-download'])await step('download-video');
  let source;
  for(let count=0;count<180&&!source;count++){
    for(const directory of [config.outputDir,downloadsDir]){
      for(const name of await fs.readdir(directory).catch(()=>[])){
        if(!name.endsWith('.mp4'))continue;
        const candidate=join(directory,name),stat=await fs.stat(candidate);
        if(stat.size!==l.videoAsset.bytes||(candidate!==path&&stat.mtimeMs<Date.parse(started)-2000))continue;
        if(sha(await fs.readFile(candidate))===l.videoAsset.sha256){source=candidate;break;}
      }if(source)break;
    }if(!source)await new Promise(r=>setTimeout(r,500));
  }
  if(!source)throw new Error('DOWNLOAD_RESULT_UNKNOWN_DO_NOT_DOWNLOAD_AGAIN');
  if(source!==path){try{await fs.access(path);throw new Error('OUTPUT_CONFLICT');}catch(e){if(e.code!=='ENOENT')throw e;}await fs.rename(source,path);}
  const decoded=JSON.parse((await exec(resolve(base,'probe-video'),[path,String(config.video.duration)])).stdout);
  if(decoded.sha256!==l.videoAsset.sha256||!decoded.decodeComplete)throw new Error('LOCAL_VIDEO_VERIFICATION_FAILED');
  const result={...decoded,nativeDownload:true,browserAssetHashMatches:true,sourceDownloadPath:source,verifiedAt:new Date().toISOString(),secondsSinceDownloadReservation:(Date.now()-Date.parse(started))/1000};
  await withJobMutation(context,()=>writeJobJson(context,resolve(dir,'video-local-verification.json'),result));
  return step('record-local-download');
}
