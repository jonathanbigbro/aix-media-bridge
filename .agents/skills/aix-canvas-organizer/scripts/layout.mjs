import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {webcrypto} from 'node:crypto';

// Self-contained: the same model is embedded in the browser adapter and tested offline.
export function layoutModel(){
 const clone=x=>JSON.parse(JSON.stringify(x));
 const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):typeof x==='number'?Math.round(x*1e6)/1e6:x;
 const canonical=x=>JSON.stringify(sort(x));
 const ordered=a=>a.slice().sort((x,y)=>canonical(x).localeCompare(canonical(y)));
 const positions=s=>ordered(s.nodes.map(n=>({id:n.id,position:n.position})));
 const groups=s=>ordered(s.groups.map(g=>({id:g.id,label:g.label,color:g.color,nodeIds:g.nodeIds.slice().sort(),childGroupIds:(g.childGroupIds||[]).slice().sort(),position:g.position,size:g.size,isTemporary:!!g.isTemporary})));
 const protectedState=s=>({identity:s.identity,name:s.name,nodes:ordered(s.nodes.map(n=>({id:n.id,label:n.label,type:n.type,status:n.status??null,canvasType:n.canvasType??null,data:n.data??null,fromData:n.fromData??null,param:n.param??null,target:n.target??null}))),connections:ordered(s.connections.map(({id,...e})=>e))});
 const baseline=s=>({protected:protectedState(s),positions:positions(s),groups:groups(s)});
 const expected=p=>({positions:ordered(p.positions.map(({id,x,y})=>({id,position:{x,y}}))),groups:groups({groups:p.groups})});
 const placed=(s,p)=>canonical({positions:positions(s),groups:groups(s)})===canonical(expected(p));
 const validateSnapshot=s=>{
  if(!s||!s.identity||!Array.isArray(s.nodes)||!Array.isArray(s.groups)||!Array.isArray(s.connections))throw Error('INVALID_SNAPSHOT');
  if(new Set(s.nodes.map(n=>n.id)).size!==s.nodes.length)throw Error('DUPLICATE_NODE_ID');
  if(s.generating||s.chatLoading)throw Error('CANVAS_BUSY');
  if(s.connections.some(e=>e.fromType==='group'||e.toType==='group'))throw Error('GROUP_EDGES_REQUIRE_MANUAL_PLAN');
  for(const n of s.nodes)if(!n.id||![n.position?.x,n.position?.y,n.data?.width,n.data?.height].every(Number.isFinite)||n.data.width<=0||n.data.height<=0)throw Error('INVALID_NODE_GEOMETRY');
 };
 const validatePlan=(s,p)=>{
  validateSnapshot(s);
  if(p.schemaVersion!==1||p.identity!==s.identity||p.name!==s.name)throw Error('WRONG_CANVAS_OR_PLAN');
  const ids=s.nodes.map(n=>n.id).sort();
  if(canonical(p.positions.map(n=>n.id).sort())!==canonical(ids)||canonical(p.groups.flatMap(g=>g.nodeIds).sort())!==canonical(ids))throw Error('NONEXHAUSTIVE_OR_DUPLICATE_CLASSIFICATION');
  if(new Set(p.groups.map(g=>g.id)).size!==p.groups.length)throw Error('DUPLICATE_GROUP_ID');
  for(const n of p.positions)if(![n.x,n.y].every(Number.isFinite))throw Error('INVALID_PLACEMENT');
  for(const g of p.groups){if(!g.label||!/^#[a-f\d]{6}$/i.test(g.color)||g.childGroupIds?.length||![g.position.x,g.position.y,g.size.width,g.size.height].every(Number.isFinite)||g.size.width<=0||g.size.height<=0)throw Error('INVALID_GROUP');}
  const rects=p.positions.map(pos=>{const n=s.nodes.find(n=>n.id===pos.id);return {x:pos.x,y:pos.y,w:n.data.width,h:n.data.height};});
  const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++)if(overlap(rects[i],rects[j]))throw Error('OVERLAPPING_NODES');
  for(let i=0;i<p.groups.length;i++){const g=p.groups[i];for(const id of g.nodeIds){const n=s.nodes.find(n=>n.id===id),v=p.positions.find(n=>n.id===id);if(v.x<g.position.x||v.y<g.position.y||v.x+n.data.width>g.position.x+g.size.width+.001||v.y+n.data.height>g.position.y+g.size.height+.001)throw Error('NODE_OUTSIDE_GROUP');}for(let j=i+1;j<p.groups.length;j++){const h=p.groups[j];if(overlap({x:g.position.x,y:g.position.y,w:g.size.width,h:g.size.height},{x:h.position.x,y:h.position.y,w:h.size.width,h:h.size.height}))throw Error('OVERLAPPING_GROUPS');}}
 };
 return {clone,canonical,protectedState,baseline,placed,validateSnapshot,validatePlan};
}
const model=layoutModel();
const digest=async v=>Buffer.from(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(model.canonical(v)))).toString('hex');
export async function createPlan(snapshot,classification){
 model.validateSnapshot(snapshot);if(snapshot.edited)throw Error('SAVE_EXISTING_EDITS_FIRST');
 const p={schemaVersion:1,identity:snapshot.identity,name:snapshot.name,beforeHash:await digest(model.baseline(snapshot)),protectedHash:await digest(model.protectedState(snapshot)),positions:[],groups:[]};
 if(!Array.isArray(classification.groups)||!classification.groups.length)throw Error('EMPTY_CLASSIFICATION');
 const start=Date.now();
 for(const [i,g]of classification.groups.entries()){
  if(!Number.isInteger(g.columns)||g.columns<1||!Array.isArray(g.nodeIds)||!g.nodeIds.length||![g.x,g.y].every(Number.isFinite))throw Error('INVALID_CLASSIFICATION');
  const nodes=g.nodeIds.map(id=>{const n=snapshot.nodes.find(n=>n.id===id);if(!n)throw Error('UNKNOWN_NODE');return n;});
  const cw=Math.max(...nodes.map(n=>n.data.width))+120,ch=Math.max(...nodes.map(n=>n.data.height))+140;
  const pos=nodes.map((n,k)=>({id:n.id,x:g.x+60+(k%g.columns)*cw,y:g.y+90+Math.floor(k/g.columns)*ch}));p.positions.push(...pos);
  p.groups.push({id:`group-${start}${i.toString().padStart(3,'0')}`,label:g.label,color:g.color,nodeIds:g.nodeIds,childGroupIds:[],position:{x:g.x,y:g.y},size:{width:Math.max(...pos.map((v,k)=>v.x+nodes[k].data.width))-g.x+60,height:Math.max(...pos.map((v,k)=>v.y+nodes[k].data.height))-g.y+60},isTemporary:false});
 }
 model.validatePlan(snapshot,p);p.planHash=await digest(p);return p;
}
export async function verifyPlan(snapshot,plan){
 model.validatePlan(snapshot,plan);const {planHash,...payload}=plan;
 if(await digest(payload)!==planHash)throw Error('PLAN_CHANGED_REBUILD_FROM_SNAPSHOT');
 if(await digest(model.protectedState(snapshot))!==plan.protectedHash)throw Error('ASSET_OR_PARAMETERS_CHANGED');
 if(!model.placed(snapshot,plan))throw Error('LAYOUT_NOT_APPLIED');
 return {state:'layout-verified',nodes:snapshot.nodes.length,connections:snapshot.connections.length,groups:snapshot.groups.length,edited:snapshot.edited,saved:!snapshot.edited};
}
export function snapshotOnPage(){
 if(location.origin!=='https://aix.studio'||location.pathname!=='/AixCanvas')throw Error('WRONG_PAGE');
 const s=document.querySelector('#__nuxt')?.__vue_app__?.config.globalProperties.$pinia?._s.get('tapnow-canvas');
 if(!s||s.canvaseInfo?.id==null||s.canvaseInfo.id==='')throw Error('UNSUPPORTED_CANVAS_STORE');
 return JSON.parse(JSON.stringify({identity:String(s.canvaseInfo.id),name:s.canvaseInfo.name,edited:s.edited,generating:s.hasGeneratingNodes(),chatLoading:!!document.querySelector('.stop-btn'),nodes:s.nodes,connections:s.connections,groups:s.groups,transform:s.transform}));
}
export async function applyOnPage(plan,makeModel,readSnapshot){
 const m=makeModel();const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(m.canonical(v))))).map(b=>b.toString(16).padStart(2,'0')).join('');
 const before=readSnapshot();m.validatePlan(before,plan);const {planHash,...payload}=plan;
 if(await hash(payload)!==planHash)throw Error('PLAN_CHANGED_REBUILD_FROM_SNAPSHOT');
 if(await hash(m.protectedState(before))!==plan.protectedHash)throw Error('ASSET_OR_PARAMETERS_CHANGED');
 if(m.placed(before,plan))return {state:'already-applied',saved:!before.edited};
 if(before.edited||await hash(m.baseline(before))!==plan.beforeHash)throw Error('STALE_PLAN_NO_MUTATION');
 const s=document.querySelector('#__nuxt').__vue_app__.config.globalProperties.$pinia._s.get('tapnow-canvas');
 for(const method of ['deleteGroup','updateNodePosition','addGroup'])if(typeof s[method]!=='function')throw Error('UNSUPPORTED_LAYOUT_METHOD');
 // The disk snapshot is required by the CLI. This in-page copy supports immediate recovery as well.
 const current=readSnapshot();if(current.edited||current.generating||current.chatLoading||m.canonical(m.baseline(current))!==m.canonical(m.baseline(before)))throw Error('STALE_PLAN_NO_MUTATION');
 window.__aixLayoutBefore=m.clone(before);
 for(const g of before.groups)s.deleteGroup(g.id);
 for(const p of plan.positions){const n=s.nodes.find(n=>n.id===p.id);s.updateNodePosition([p.id],p.x-n.position.x,p.y-n.position.y);}
 for(const g of plan.groups)s.addGroup(m.clone(g));
 s.edited=1;s.selectedNodeIds=[];s.selectedGroupIds=[];
 const after=readSnapshot();if(await hash(m.protectedState(after))!==plan.protectedHash||!m.placed(after,plan))throw Error('POSTCHECK_FAILED_INSPECT_BACKUP_NO_RETRY');
 return {state:'applied-unsaved',nodes:after.nodes.length,groups:after.groups.length,connections:after.connections.length};
}
export function applyScript(plan){return `async()=>(${applyOnPage.toString()})(${JSON.stringify(plan)},${layoutModel.toString()},${snapshotOnPage.toString()})`;}
async function main(){
 const [mode,...args]=process.argv.slice(2);
 if(mode==='snapshot-script'&&args.length===1){await fs.writeFile(args[0],snapshotOnPage.toString(),{mode:0o600});return;}
 if(mode==='plan'&&args.length===3){const [snap,groups,out]=args,p=await createPlan(JSON.parse(await fs.readFile(snap)),JSON.parse(await fs.readFile(groups)));await fs.writeFile(out,JSON.stringify(p,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({state:'planned',nodes:p.positions.length,groups:p.groups.length}));return;}
 if(mode==='apply-script'&&args.length===3){const [snap,file,out]=args;const s=JSON.parse(await fs.readFile(snap)),p=JSON.parse(await fs.readFile(file));model.validatePlan(s,p);const {planHash,...payload}=p;if(await digest(payload)!==planHash||await digest(model.baseline(s))!==p.beforeHash)throw Error('PLAN_OR_BACKUP_MISMATCH');await fs.writeFile(out,applyScript(p),{mode:0o600,flag:'wx'});return;}
 if(mode==='verify'&&args.length===2){console.log(JSON.stringify(await verifyPlan(JSON.parse(await fs.readFile(args[0])),JSON.parse(await fs.readFile(args[1])))));return;}
 throw Error('USE snapshot-script OUT | plan SNAPSHOT CLASSIFICATION OUT | apply-script SNAPSHOT PLAN OUT | verify SNAPSHOT PLAN');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=2;});
