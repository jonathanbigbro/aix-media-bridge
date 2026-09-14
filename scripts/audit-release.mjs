import fs from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import mediaRegistry from './release-media.json' with {type:'json'};
const reviewedMedia=new Map(mediaRegistry.reviewedMedia.map(x=>[x.path,x]));
export function isReviewedMedia(path,bytes){const entry=reviewedMedia.get(path);return !!entry&&bytes.length===entry.bytes&&createHash('sha256').update(bytes).digest('hex')===entry.sha256;}
const rules=[
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
 ['credential',/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
 ['jwt',/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g],
 ['home-path',/\/(?:Users|home)\/[A-Za-z0-9_.-]+/g],
 ['account-alias',/<[A-Z][A-Z0-9_]*_[a-f0-9]{12}>/g],
 ['private-asset-url',/https?:\/\/oss\.aix\.studio\/(?!<|%3C)[^\s"'<>`]+/g],
 ['url-credentials',/https?:\/\/[^\s/"']+:[^\s/@"']+@/g],
 ['email',/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
 ['raw-account-id',/\b(?:session_[A-Za-z0-9_-]{12,}|req_[A-Za-z0-9_-]{12,}|user_\d{5,})\b/g]
];
const allowedEmails=new Set(['maintainers@example.invalid']);
export function scanBytes(path,bytes){
 const findings=[];
 if(reviewedMedia.has(path)&&!isReviewedMedia(path,bytes))return [{path,category:'reviewed-media-bytes-changed'}];
 if(path.endsWith('.mp4'))return isReviewedMedia(path,bytes)?[]:[{path,category:'unreviewed-video'}];
 if(path.endsWith('.png')){
  if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')return [{path,category:'invalid-png'}];
  let end=false;for(let i=8;i<bytes.length;){const n=bytes.readUInt32BE(i),type=bytes.toString('ascii',i+4,i+8);if(!['IHDR','IDAT','IEND'].includes(type))findings.push({path,category:'image-metadata-or-unexpected-chunk'});i+=12+n;if(i>bytes.length)throw new Error('TRUNCATED_PNG');if(type==='IEND'){end=true;if(i!==bytes.length)findings.push({path,category:'image-trailing-data'});break;}}if(!end)findings.push({path,category:'missing-image-end'});return findings;
 }
 if(bytes.includes(0))return [{path,category:'unexpected-binary'}];
 const source=bytes.toString('utf8');
 if(path.endsWith('.json')){
  try{
   const value=JSON.parse(source);
   function visit(item,parent=''){
    if(!item||typeof item!=='object')return;
    for(const [key,v] of Object.entries(item)){
     const packageVersion=path.endsWith('package-lock.json')&&parent==='dependencies'&&key==='cookie'&&typeof v==='string'&&/^[~^]?\d+\.\d+\.\d+$/.test(v);
     if(!packageVersion&&/^(userId|teamId|canvasId|sessionId|accessToken|refreshToken|token|password|cookie|authorization|email|phone|mobile|nickName|avatar)$/i.test(key)&&v!==null&&v!==''&&v!=='[OMITTED]')findings.push({path,category:'account-or-credential-field',field:key});
     if(typeof v==='object')visit(v,key);
    }
   }
   visit(value);
  }catch{findings.push({path,category:'invalid-json'});}
 }
 for(const [category,pattern] of rules){pattern.lastIndex=0;for(const match of source.matchAll(pattern)){if(category==='email'&&allowedEmails.has(match[0]))continue;findings.push({path,category,line:source.slice(0,match.index).split('\n').length});}}
 return findings;
}
export async function auditFiles(directory,paths){
 const findings=[];for(const path of paths){if(path.startsWith('/')||path.split('/').includes('..'))throw new Error('UNSAFE_RELEASE_PATH');const full=resolve(directory,path),st=await fs.lstat(full);if(!st.isFile()||st.isSymbolicLink())throw new Error('RELEASE_REQUIRES_REGULAR_FILES');if(await fs.realpath(full)!==full)throw new Error('RELEASE_SYMLINK_ANCESTOR');findings.push(...scanBytes(path,await fs.readFile(full)));}
 if(paths.some(p=>reviewedMedia.has(p)))for(const record of mediaRegistry.reviewRecords){if(!paths.includes(record.path))findings.push({path:record.path,category:'media-review-record-missing'});else if(createHash('sha256').update(await fs.readFile(resolve(directory,record.path))).digest('hex')!==record.sha256)findings.push({path:record.path,category:'media-review-record-changed'});}
 return {state:findings.length?'findings':'passed',checkedFiles:paths.length,reviewedMediaFiles:paths.filter(p=>reviewedMedia.has(p)).length,findings,disclosurePolicy:'Text is pattern-scanned; reviewed media is verified against exact approved hashes. Visual review is separate. Reports never include matched secret values.'};
}
export function auditGit(directory){
 const run=args=>{const r=spawnSync('git',args,{cwd:directory,encoding:'utf8',maxBuffer:32*1024*1024});if(r.status!==0)throw new Error('GIT_AUDIT_FAILED');return r.stdout;};
 const objects=run(['rev-list','--objects','--all']).trim().split('\n').filter(Boolean),findings=[];let blobs=0;
 for(const record of objects){const i=record.indexOf(' '),id=i<0?record:record.slice(0,i),path=i<0?'git-object':record.slice(i+1);if(run(['cat-file','-t',id]).trim()!=='blob')continue;const r=spawnSync('git',['cat-file','blob',id],{cwd:directory,maxBuffer:32*1024*1024});if(r.status!==0)throw new Error('GIT_BLOB_READ_FAILED');blobs++;findings.push(...scanBytes(path,r.stdout));}
 const metadata=run(['log','--all','--format=%an <%ae>%n%cn <%ce>%n%B']);findings.push(...scanBytes('git-commit-metadata',Buffer.from(metadata)));
 return {state:findings.length?'findings':'passed',checkedBlobs:blobs,findings};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const version=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;const directory=resolve(process.argv.slice(2).find(x=>!x.startsWith('--'))||'dist/aix-media-bridge-'+version),manifest=JSON.parse(await fs.readFile(resolve(directory,'release-files-manifest.json'),'utf8'));const result=await auditFiles(directory,[...manifest.files.map(x=>x.path),'release-files-manifest.json']);if(process.argv.includes('--git'))result.git=auditGit(directory);console.log(JSON.stringify(result,null,2));if(result.state!=='passed'||result.git&&result.git.state!=='passed')process.exitCode=2;}catch(e){console.error(e.message);process.exitCode=2;}
}
