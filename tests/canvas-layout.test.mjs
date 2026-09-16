import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {createPlan,verifyPlan,applyScript,layoutModel} from '../.agents/skills/aix-canvas-organizer/scripts/layout.mjs';
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(){return {identity:'synthetic-canvas',name:'Synthetic layout',edited:0,generating:false,chatLoading:false,nodes:[{id:'n1',label:'Selected output',type:'video',position:{x:10,y:20},data:{width:190,height:340},param:{prompt:'A rotating ceramic vessel'},target:{findUrl:'https://example.invalid/one.mp4'}},{id:'n2',label:'Alternative image',type:'image',position:{x:300,y:20},data:{width:300,height:300},target:{findUrl:'https://example.invalid/two.png'}}],groups:[],connections:[{id:'edge-a',fromId:'n2',toId:'n1',fromType:'node',toType:'node'}]};}
const classification=()=>({groups:[{label:'Adopted',color:'#33AA88',nodeIds:['n1'],x:0,y:0,columns:1},{label:'Archive',color:'#888888',nodeIds:['n2'],x:1200,y:0,columns:1}]});
function browser(snapshot){
 let moves=0,deletes=0;const s={canvaseInfo:{id:snapshot.identity,name:snapshot.name},...clone(snapshot),hasGeneratingNodes(){return this.generating;},updateNodePosition(ids,dx,dy){moves++;for(const n of this.nodes)if(ids.includes(n.id)){n.position.x+=dx;n.position.y+=dy;}},deleteGroup(id){deletes++;this.groups=this.groups.filter(g=>g.id!==id);},addGroup(g){this.groups.push(g);}};
 const ctx=vm.createContext({crypto:webcrypto,TextEncoder,Uint8Array,window:{},location:{origin:'https://aix.studio',pathname:'/AixCanvas'},document:{querySelector(sel){return sel==='#__nuxt'?{__vue_app__:{config:{globalProperties:{$pinia:{_s:new Map([['tapnow-canvas',s]])}}}}}:null;}}});
 return {s,ctx,counts:()=>({moves,deletes}),snapshot:()=>({...clone(s),identity:s.canvaseInfo.id,name:s.canvaseInfo.name})};
}
test('layout preserves assets, parameters and connections; verifies after reload representation changes',async()=>{
 const s=fixture(),p=await createPlan(s,classification()),b=browser(s),before=layoutModel().canonical(layoutModel().protectedState(s));
 const r=await vm.runInContext('('+applyScript(p)+')()',b.ctx);assert.equal(r.state,'applied-unsaved');assert.equal(before,layoutModel().canonical(layoutModel().protectedState(b.snapshot())));
 b.s.edited=0;b.s.connections[0].id='new-server-edge-id';b.s.nodes[0].position.x+=1e-11;
 assert.equal((await verifyPlan(b.snapshot(),p)).saved,true);
});
test('applying an already matching plan does not move or remove again',async()=>{
 const s=fixture(),p=await createPlan(s,classification()),b=browser(s);const js='('+applyScript(p)+')()';await vm.runInContext(js,b.ctx);const n=b.counts();const r=await vm.runInContext(js,b.ctx);assert.equal(r.state,'already-applied');assert.deepEqual(n,b.counts());
});
test('classification rejects missing, duplicate and unknown nodes before mutation',async()=>{
 for(const ids of [[],['n1'],['n1','n1','n2'],['n1','other']]){const c=classification();c.groups=[{...c.groups[0],nodeIds:ids}];await assert.rejects(createPlan(fixture(),c));}
});
test('overlapping groups and group edges stop automatic regrouping',async()=>{
 const c=classification();c.groups[1].x=0;await assert.rejects(createPlan(fixture(),c),/OVERLAPPING/);
 const s=fixture();s.connections[0].fromType='group';await assert.rejects(createPlan(s,classification()),/GROUP_EDGES/);
});
test('busy, changed assets, changed placement and unsaved state block stale plans without side effects',async()=>{
 const s=fixture(),p=await createPlan(s,classification());
 for(const change of [b=>b.s.generating=true,b=>b.s.edited=1,b=>b.s.nodes[0].target.findUrl='changed',b=>b.s.nodes[0].param.prompt='changed',b=>b.s.nodes[0].target.showUrl='changed',b=>b.s.nodes[0].data.flowCode='changed',b=>b.s.nodes[0].fromData={source:'changed'},b=>b.s.nodes[0].position.x++]){
  const b=browser(s);change(b);await assert.rejects(vm.runInContext('('+applyScript(p)+')()',b.ctx));assert.deepEqual(b.counts(),{moves:0,deletes:0});
 }
});
test('modified plan hash and node deletion after apply fail verification',async()=>{
 const s=fixture(),p=await createPlan(s,classification()),b=browser(s);const changed=clone(p);changed.positions[0].x++;
 await assert.rejects(vm.runInContext('('+applyScript(changed)+')()',b.ctx),/PLAN_CHANGED/);assert.equal(b.counts().moves,0);
 await vm.runInContext('('+applyScript(p)+')()',b.ctx);b.s.nodes.pop();await assert.rejects(verifyPlan(b.snapshot(),p));
});
test('original grouping containers can be replaced without deleting their members',async()=>{
 const s=fixture();s.groups=[{id:'old-group',label:'Old group',color:'#888888',nodeIds:['n1','n2'],position:{x:0,y:0},size:{width:700,height:500}}];
 const p=await createPlan(s,classification()),b=browser(s);await vm.runInContext('('+applyScript(p)+')()',b.ctx);assert.equal(b.s.nodes.length,2);assert.equal(b.counts().deletes,1);assert.equal(b.s.groups.length,2);
});
