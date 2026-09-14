import {sanitize,sameNodeIdentity} from './redact.mjs';
export function verifyBaseline(baseline,canvas){
  if(!Array.isArray(baseline?.nodes)||!Array.isArray(baseline?.connections)||!Array.isArray(canvas?.nodes)||!Array.isArray(canvas?.connections))throw new Error('INVALID_CANVAS_BASELINE');
  for(const old of baseline.nodes){
    const current=canvas.nodes.find(n=>sameNodeIdentity(n.id,old.id));
    if(!current||sanitize(current.target?.findUrl)!==sanitize(old.target?.findUrl))throw new Error('BASELINE_NODE_OR_ASSET_CHANGED');
  }
  for(const old of baseline.connections)if(!canvas.connections.some(c=>sameNodeIdentity(c.fromId,old.fromId)&&sameNodeIdentity(c.toId,old.toId)))throw new Error('BASELINE_CONNECTION_CHANGED');
  return true;
}
