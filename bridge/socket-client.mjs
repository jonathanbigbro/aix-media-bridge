import net from 'node:net';
import {socketPath} from './paths.mjs';
export function request(q){return new Promise((resolveResult,reject)=>{
  const s=net.connect(socketPath);let out='',settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);s.destroy();error?reject(error):resolveResult(value);};
  const timer=setTimeout(()=>finish(new Error('BRIDGE_REPLY_TIMEOUT_RESULT_UNKNOWN_DO_NOT_REPLAY')),90000);
  s.setEncoding('utf8');s.on('connect',()=>s.write(JSON.stringify(q)+'\n'));s.on('data',x=>{out+=x;});
  s.on('error',e=>finish(new Error(e.code==='ENOENT'?'BRIDGE_NOT_RUNNING':e.code==='ECONNREFUSED'?'BRIDGE_SOCKET_STALE_USE_DOCTOR':e.message)));
  s.on('end',()=>{try{const value=JSON.parse(out);if(value.error||value.isError)finish(new Error(value.error||value.data?.message||'MCP_ERROR'));else finish(null,value);}catch(e){finish(e);}});
});}
