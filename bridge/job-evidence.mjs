import {sameNodeIdentity} from './redact.mjs?r6';
export function mappedUploadedReference(page, ledger, label){
  const id=ledger.referenceNodeId||ledger.stages?.['prepare-upload']?.result?.nodeId;
  if(!id)return null;
  const matches=page.nodes.filter(n=>sameNodeIdentity(n.id,id)&&n.label===label&&n.target?.findUrl);
  return matches.length===1?matches[0]:null;
}
// Empty/background polls are never evidence for a mapped task's completion.
export function completedNodeFromNetwork(network,nodeId){
  if(!network?.requestBodyComplete||!network?.responseBodyComplete)return null;
  const sent=JSON.parse(network.requestBody),body=JSON.parse(network.responseBody);
  if(body.code!==200||!sent.nodeIds?.some(id=>sameNodeIdentity(id,nodeId)))return null;
  return body.data?.nodeInfoList?.find(n=>sameNodeIdentity(n.nodeId,nodeId)&&String(n.status)==='2'&&n.targetInfoList?.some(t=>t.findUrl))||null;
}
