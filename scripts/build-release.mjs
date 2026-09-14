import fs from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {root} from '../bridge/paths.mjs';
import {auditFiles,scanBytes,isReviewedMedia} from './audit-release.mjs';
import {demoPng} from './make-demo-reference.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
function crc32(data){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
// ZIP with fixed timestamps and no author, host path or owner metadata.
function zip(entries){const local=[],central=[];let offset=0;for(const [name,data] of entries){const n=Buffer.from(name),compressed=deflateRawSync(data),crc=crc32(data),h=Buffer.alloc(30);h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);h.writeUInt16LE(8,8);h.writeUInt16LE(33,12);h.writeUInt32LE(crc,14);h.writeUInt32LE(compressed.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);local.push(h,n,compressed);const c=Buffer.alloc(46);c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);c.writeUInt16LE(8,10);c.writeUInt16LE(33,14);c.writeUInt32LE(crc,16);c.writeUInt32LE(compressed.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+compressed.length;}const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,cd,end]);}
try{
 const version=JSON.parse(await fs.readFile(resolve(root,'package.json'),'utf8')).version,name='aix-media-bridge-'+version;
 const paths=JSON.parse(await fs.readFile(resolve(root,'scripts/release-files.json'),'utf8')).sort();if(new Set(paths).size!==paths.length)throw new Error('DUPLICATE_RELEASE_PATH');
 const audit=await auditFiles(root,paths);if(audit.state!=='passed'){console.log(JSON.stringify(audit,null,2));throw new Error('RELEASE_BLOCKED_BY_CONTENT_AUDIT');}
 const destination=resolve(root,'dist',name);
 // A versioned release is immutable; a new development snapshot needs a new version.
 for(const path of [destination,destination+'.zip']){try{await fs.lstat(path);throw new Error('RELEASE_VERSION_ALREADY_EXISTS');}catch(e){if(e.code!=='ENOENT')throw e;}}
 await fs.mkdir(resolve(root,'dist'),{recursive:true});await fs.mkdir(destination);
 const entries=[];for(const path of paths){const data=await fs.readFile(resolve(root,path));if(scanBytes(path,data).length)throw new Error('SNAPSHOT_CONTENT_AUDIT_FAILED');if(path.endsWith('.png')&&!isReviewedMedia(path,data)&&(path!=='examples/demo-reference.png'||!data.equals(demoPng())))throw new Error('ONLY_SYNTHETIC_OR_REVIEWED_IMAGES_MAY_SHIP');const target=resolve(destination,path);await fs.mkdir(dirname(target),{recursive:true});await fs.writeFile(target,data);entries.push([path,data]);}
 const manifest={version,files:entries.map(([path,b])=>({path,bytes:b.length,sha256:hash(b)})),reviewedMedia:entries.filter(([p,b])=>isReviewedMedia(p,b)).map(([p])=>p),excluded:['original Git history','account bindings','runtime logs','job configs and ledgers','screenshots','original or unreviewed generated media','native project backups','dependencies','compiled binaries']};
 const m=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await fs.writeFile(resolve(destination,'release-files-manifest.json'),m);entries.push(['release-files-manifest.json',m]);
 const final=await auditFiles(destination,entries.map(x=>x[0]));if(final.state!=='passed')throw new Error('FINAL_TREE_AUDIT_FAILED');
 const bytes=zip(entries),archive=resolve(root,'dist',name+'.zip');await fs.writeFile(archive,bytes);await fs.writeFile(archive+'.sha256',hash(bytes)+'  '+name+'.zip\n');
 await fs.writeFile(resolve(root,'dist',name+'-audit.json'),JSON.stringify({...final,version,archiveSha256:hash(bytes),archiveBytes:bytes.length},null,2)+'\n');
 console.log(JSON.stringify({state:'release-built',version,files:entries.length,archive,sha256:hash(bytes),audit:final.state},null,2));
}catch(e){console.error(e.message);process.exitCode=2;}
