import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {stateDir,ensureState} from './paths.mjs';
const execute=promisify(execFile);
const permitted=/^\/apinew\/comfy\/(?:team\/chat(?:\/|$)|canvas-json-info\/(?:detail|saveCanvas)$|c-work-flow-info\/detailByCode\/|task-info\/initCanvasNodeStatus$|work\/promptTask$)/;

// Named pipes carry body bytes straight to memory; no raw network body is stored on disk.
export async function fullNetwork(call,{path,reqid}={}) {
  const listing=await call('list_network_requests',{resourceTypes:['fetch','xhr'],includePreservedRequests:true});
  const matches=(listing.data.networkRequests||[]).filter(r=>{
    const u=new URL(r.url);return u.origin==='https://aix.studio'&&(permitted.test(u.pathname)||/^\/apinew\/oss\/upload-file-info\/(uploadInit|uploading)$/.test(u.pathname))&&(reqid!=null?r.requestId===reqid:u.pathname===path||u.pathname.startsWith(path+'/'));
  });
  if(!matches.length) throw new Error('NO_ALLOWED_OBSERVED_REQUEST');
  const record=matches.at(-1);
  if(record.status==='pending') throw new Error('RESPONSE_STILL_PENDING');
  await ensureState();const dir=await fs.mkdtemp(resolve(stateDir,'pipes/.body-pipe-'));
  const streams=[];
  async function pipe(suffix){
    const name=resolve(dir,randomUUID()+suffix);
    await execute('/usr/bin/mkfifo',['-m','600',name]);
    const stream=createReadStream(name);streams.push(stream);
    const done=new Promise((resolve,reject)=>{const chunks=[];stream.on('data',x=>chunks.push(x));stream.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));stream.on('error',reject);});
    return {name,done};
  }
  try{
    const response=await pipe('.network-response');
    const omitMultipart=new URL(record.url).pathname.endsWith('/uploading');
    const request=record.method==='POST'&&!omitMultipart?await pipe('.network-request'):null;
    const result=await call('get_network_request',{reqid:record.requestId,responseFilePath:response.name,...request?{requestFilePath:request.name}:{}},true);
    if(result.isError) throw new Error(result.data?.message||'NETWORK_BODY_CAPTURE_FAILED');
    const n=result.data.networkRequest;
    if(!n?.responseBodyFilePath) throw new Error('RESPONSE_BODY_UNAVAILABLE');
    const responseBody=await response.done;
    const requestBody=request&&n.requestBodyFilePath?await request.done:null;
    try{JSON.parse(responseBody);}catch{throw new Error('UNSUPPORTED_NON_JSON_RESPONSE_BODY');}
    const url=new URL(n.url);
    return {cdpRequestId:record.requestId,method:n.method,url:n.url,query:Object.fromEntries(url.searchParams),httpStatus:n.status,requestBody,responseBody,requestBodyBytes:requestBody==null?null:Buffer.byteLength(requestBody),responseBodyBytes:Buffer.byteLength(responseBody),requestBodyComplete:requestBody!==null,requestBodyOmitted:omitMultipart?'multipart binary body intentionally omitted':null,responseBodyComplete:true,transport:'official MCP get_network_request via 0600 FIFO; no raw body files; headers excluded'};
  }finally{for(const s of streams)s.destroy();await fs.rm(dir,{recursive:true,force:true});}
}
