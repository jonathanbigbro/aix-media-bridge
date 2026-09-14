import fs from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {deflateSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
export function demoPng(){
  const w=640,h=360,raw=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const sphere=(x-320)**2+(y-166)**2<74**2,shadow=((x-329)/103)**2+((y-251)/13)**2<1;
    const color=sphere?[29,141,143]:shadow?[202,207,201]:[240,239,230];
    const i=y*(w*3+1)+1+x*3;raw.set(color,i);
  }
  function crc32(data){let c=0xffffffff;for(const b of data){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
  function chunk(type,data){const t=Buffer.from(type),b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length);t.copy(b,4);data.copy(b,8);b.writeUInt32BE(crc32(Buffer.concat([t,data])),8+data.length);return b;}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const path=resolve(process.argv[2]||'examples/demo-reference.png');await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,demoPng());console.log('Demo reference written.');
}
