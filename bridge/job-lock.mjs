import {AsyncLocalStorage} from 'node:async_hooks';
import {resolve} from 'node:path';
import {acquireLock,readJson,writeAtomic} from './job-config.mjs';

const mutations=new AsyncLocalStorage();
const key=ctx=>resolve(ctx.dir);
export async function assertJobOwner(ctx,token){
 const owner=await readJson(resolve(ctx.dir,'.lock'));
 if(!token||owner?.token!==token)throw new Error('JOB_LOCK_REQUIRED');
 try{process.kill(owner.pid,0);}catch{throw new Error('JOB_LOCK_OWNER_NOT_RUNNING');}
 return owner;
}
// .lock is the CLI's workflow ownership. .mutation.lock serializes actual
// read/modify/write operations across CLI and daemon processes. The CLI never
// holds the latter while waiting for a daemon RPC. A timed-out RPC keeps its
// own mutation lock until it unwinds, even if the CLI releases workflow ownership.
export async function withJobMutation(ctx,fn){
 const active=mutations.getStore();
 if(active?.key===key(ctx)){
  if(ctx.lockToken&&ctx.lockToken!==active.ownerToken)throw new Error('JOB_LOCK_REQUIRED');
  await assertJobMutation(ctx);return fn();
 }
 let workflow,mutation;
 try{
  const ownerToken=ctx.lockToken||(workflow=await acquireLock(resolve(ctx.dir,'.lock'))).owner.token;
  await assertJobOwner(ctx,ownerToken);
  mutation=await acquireLock(resolve(ctx.dir,'.mutation.lock'));
  await assertJobOwner(ctx,ownerToken);
  return await mutations.run({key:key(ctx),ownerToken,mutationToken:mutation.owner.token},fn);
 }finally{await mutation?.release();await workflow?.release();}
}
export async function assertJobMutation(ctx){
 const active=mutations.getStore();
 if(active?.key!==key(ctx))throw new Error('JOB_MUTATION_LOCK_REQUIRED');
 if(ctx.lockToken&&ctx.lockToken!==active.ownerToken)throw new Error('JOB_LOCK_REQUIRED');
 const owner=await readJson(resolve(ctx.dir,'.mutation.lock'));
 if(owner?.token!==active.mutationToken||owner?.pid!==process.pid)throw new Error('JOB_MUTATION_LOCK_REQUIRED');
 await assertJobOwner(ctx,active.ownerToken);
}
export async function writeJobJson(ctx,path,value){
 await assertJobMutation(ctx);await writeAtomic(path,value);
}
