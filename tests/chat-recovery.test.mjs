import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readNativeImageCard} from '../bridge/image-card.mjs';
import {historyCard,readChatCard} from '../bridge/chat-evidence.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=x=>createHash('sha256').update(x).digest('hex');

function fixture(){
 const params={type:'batch_generate_image_params',flowCode:'main_image',workflowId:248,sourceNodeIds:[['ref']],labels:['SYNTHETIC__IMAGE'],prompts:['Synthetic prompt']};
 const keys=[undefined,'length','1','generateParams','generateSubmitted','generateCancelled','then'];
 let deps;for(const key of keys.toReversed())deps={dep:{key},nextDep:deps};
 let reads=0;const getter=vm.runInNewContext('()=>o(e,2)',{o:fn=>fn(),e:()=>{reads++;return params;}});
 const owner={type:{__name:'ChatPanel'},scope:{effects:[{fn:getter,deps}]}};
 const card={classList:{contains:()=>false},closest:()=>({previousElementSibling:{classList:{contains:()=>true},querySelector:()=>({textContent:'Synthetic request'})}}),querySelector:s=>s==='.batch-confirm-btn'?{disabled:false}:{textContent:'全能图片PRO'},querySelectorAll:s=>s==='.batch-prompt-row'?[{querySelector:()=>({textContent:params.prompts[0]})}]:['全能图片PRO','16:9','2k'].map(textContent=>({textContent}))};
 owner.subTree={el:card};const root={_vnode:{component:owner},__vue_app__:{config:{globalProperties:{$pinia:{_s:new Map([['tapnow-canvas',{nodes:[{id:'ref',target:{findUrl:'https://example.test/ref.png'}}]}]])}}}}};
 const document={querySelectorAll:()=>[card],querySelector:()=>root};
 return {params,owner,card,document,reads:()=>reads};
}
test('production Vue vnode owner and bounded active-card watcher read current parameters',()=>{
 const f=fixture();const result=vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document});
 assert.equal(result.workflowId,248);assert.deepEqual(result.sourceNodeIds,[['ref']]);assert.equal(f.reads(),1);
});
test('unknown watcher dependencies cannot be invoked as a card reader',()=>{
 const f=fixture();f.owner.scope.effects[0].deps.nextDep=undefined;
 assert.throws(()=>vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document}),/COMPONENT_EVIDENCE_UNAVAILABLE/);assert.equal(f.reads(),0);
});
test('rendered message preserves Markdown line breaks for exact task matching',()=>{
 const f=fixture();f.card.closest=()=>({previousElementSibling:{classList:{contains:()=>true},querySelector:()=>({textContent:'firstsecond',innerText:'first\nsecond'})}});
 assert.equal(vm.runInNewContext('('+readNativeImageCard.toString()+')()',{document:f.document}).taskPrompt,'first\nsecond');
});
function historyFixture(){
 const fingerprint=sha('synthetic-session').slice(0,12),entity='<ENTITY_'+fingerprint+'>';
 const config={labels:{image:'SYNTHETIC__IMAGE'}},ledger={sessionId:'<SESSIONID_'+fingerprint+'>',referenceNodeId:'ref',imagePrompt:'Synthetic request',stages:{'image-chat':{attempts:1,businessCode:300,state:'response-observed'}}};
 const original={requestBodyComplete:true,responseBodyComplete:true,requestBody:JSON.stringify({message:ledger.imagePrompt,nodeId:entity,executionMode:'manual',referencedNodeIds:['ref']}),responseBody:JSON.stringify({code:300,data:null})};
 const source=fixture().params,metadata={action:'select_params',options:source};
 const messages=[{role:'user',content:ledger.imagePrompt},{id:'synthetic-message',role:'assistant',metadata:JSON.stringify(metadata)}];
 const history={url:'https://aix.studio/apinew/comfy/team/chat/history/'+entity,httpStatus:'200',responseBodyComplete:true,responseBody:JSON.stringify({code:200,data:messages})};
 return {config,ledger,original,history,messages,metadata};
}
test('code 300 recovers only the original task card from separately captured native history',()=>{
 const f=historyFixture(),before=JSON.stringify(f.original);assert.equal(historyCard(f.original,f.history,f.ledger,f.config,'image').source.workflowId,248);assert.equal(JSON.stringify(f.original),before);assert.equal(f.ledger.stages['image-chat'].attempts,1);
});
test('history rejects wrong session, task, reference, count, submitted card and incomplete evidence',()=>{
 const variants=[f=>f.history.url='https://aix.studio/apinew/comfy/team/chat/history/other',f=>f.messages[0].content='different task',f=>f.metadata.options.sourceNodeIds=[['wrong']],f=>f.metadata.options.prompts.push('extra'),f=>f.metadata.generateSubmitted=true,f=>f.history.responseBodyComplete=false,f=>f.messages.push({...f.messages[0]}),f=>f.metadata.options.labels=['OTHER__IMAGE']];
 for(const mutate of variants){const f=historyFixture();mutate(f);f.messages[1].metadata=JSON.stringify(f.metadata);f.history.responseBody=JSON.stringify({code:200,data:f.messages});assert.throws(()=>historyCard(f.original,f.history,f.ledger,f.config,'image'),/CHAT_HISTORY_/);}
});
test('recovery requires pinned original and history bytes, with no response or attempt rewrites',async()=>{
 const f=historyFixture(),dir=await fs.mkdtemp(resolve(os.tmpdir(),'aix-chat-synthetic-'));
 try{
  const original=JSON.stringify(f.original),history=JSON.stringify(f.history),file='image-chat-history-synthetic.json';
  await fs.writeFile(resolve(dir,'image-chat-network.json'),original);await fs.writeFile(resolve(dir,file),history);
  await assert.rejects(readChatCard(dir,f.ledger,f.config,'image'),/REQUIRES_HISTORY/);
  f.ledger.stages['image-chat'].historyRecovery={file,originalNetworkSha256:sha(original),historySha256:sha(history)};
  for(let i=0;i<3;i++)assert.equal((await readChatCard(dir,f.ledger,f.config,'image')).origin,'reconciled-native-history');
  assert.equal(await fs.readFile(resolve(dir,'image-chat-network.json'),'utf8'),original);assert.equal(f.ledger.stages['image-chat'].businessCode,300);assert.equal(f.ledger.stages['image-chat'].attempts,1);
  await fs.appendFile(resolve(dir,file),' ');await assert.rejects(readChatCard(dir,f.ledger,f.config,'image'),/EVIDENCE_CHANGED/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
