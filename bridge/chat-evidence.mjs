import fs from 'node:fs/promises';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {sanitize} from './redact.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const sessionFingerprint=value=>{if(typeof value!=='string'||!value)return null;const decoded=decodeURIComponent(value),alias=sanitize(decoded).match(/^<(?:ENTITY|SESSIONID)_([a-f0-9]{12})>$/);return alias?alias[1]:sha(decoded).slice(0,12);};

// History is a second, separately captured source. A non-200 original response
// remains non-200 and is never rewritten into a successful Agent response.
export function historyCard(original,history,ledger,config,kind){
 const request=JSON.parse(original.requestBody),response=JSON.parse(history.responseBody);
 const url=new URL(history.url),expectedRef=kind==='image'?ledger.referenceNodeId:ledger.imageNodeId;
 if(original.requestBodyComplete!==true||original.responseBodyComplete!==true||history.responseBodyComplete!==true||String(history.httpStatus)!=='200'||response.code!==200)throw new Error('CHAT_HISTORY_EVIDENCE_INCOMPLETE');
 const bound=sessionFingerprint(ledger.sessionId);
 if(!bound||url.origin!=='https://aix.studio'||!url.pathname.startsWith('/apinew/comfy/team/chat/history/')||sessionFingerprint(url.pathname.split('/').at(-1))!==bound||sessionFingerprint(request.nodeId)!==bound)throw new Error('CHAT_HISTORY_SESSION_MISMATCH');
 if(request.message!==ledger[kind+'Prompt']||request.executionMode!=='manual'||JSON.stringify(sanitize(request.referencedNodeIds))!==JSON.stringify([expectedRef]))throw new Error('CHAT_HISTORY_ORIGINAL_REQUEST_MISMATCH');
 const messages=response.data;if(!Array.isArray(messages))throw new Error('CHAT_HISTORY_MESSAGES_MISSING');
 const matches=messages.map((m,i)=>m.role==='user'&&m.content===request.message?i:-1).filter(i=>i>=0);
 if(matches.length!==1)throw new Error('CHAT_HISTORY_TASK_NOT_UNIQUE');
 const following=messages.slice(matches[0]+1);const nextUser=following.findIndex(m=>m.role==='user');
 const candidates=(nextUser<0?following:following.slice(0,nextUser)).filter(m=>m.role==='assistant').map(m=>({message:m,metadata:typeof m.metadata==='string'?JSON.parse(m.metadata):m.metadata})).filter(x=>x.metadata?.options);
 if(candidates.length!==1)throw new Error('CHAT_HISTORY_CARD_NOT_UNIQUE');
 const {metadata,message}=candidates[0],source=metadata.options;
 if(metadata.action!=='select_params'||metadata.generateSubmitted||metadata.generateCancelled||source.type!==`batch_generate_${kind}_params`||source.labels?.length!==1||source.labels[0]!==config.labels[kind]||source.prompts?.length!==1||JSON.stringify(sanitize(source.sourceNodeIds))!==JSON.stringify([[expectedRef]]))throw new Error('CHAT_HISTORY_CARD_IDENTITY_MISMATCH');
 return {source,request,messageId:message.id};
}

export async function readChatCard(dir,ledger,config,kind){
 const bytes=await fs.readFile(resolve(dir,kind+'-chat-network.json')),original=JSON.parse(bytes),response=JSON.parse(original.responseBody),request=JSON.parse(original.requestBody);
 if(original.requestBodyComplete!==true||original.responseBodyComplete!==true)throw new Error('ORIGINAL_IMAGE_CHAT_EVIDENCE_INCOMPLETE');
 const originalNetworkSha256=sha(bytes);
 if(response.code===200&&response.data?.options)return {source:response.data.options,request,originalNetworkSha256,origin:'original-agent-response'};
 const proof=ledger.stages[kind+'-chat']?.historyRecovery;
 if(!proof||proof.originalNetworkSha256!==originalNetworkSha256||basename(proof.file)!==proof.file||!proof.file.startsWith(kind+'-chat-history-'))throw new Error('AGENT_RESULT_REQUIRES_HISTORY_RECONCILIATION_NO_REPLAY');
 const historyBytes=await fs.readFile(resolve(dir,proof.file));
 if(sha(historyBytes)!==proof.historySha256)throw new Error('CHAT_HISTORY_EVIDENCE_CHANGED');
 return {...historyCard(original,JSON.parse(historyBytes),ledger,config,kind),originalNetworkSha256,origin:'reconciled-native-history',historyEvidence:proof};
}
