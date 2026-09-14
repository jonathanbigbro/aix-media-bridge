import {resolve} from 'node:path';
import {readJson} from './job-config.mjs';
import {blockedState,diagnoseGenerations} from './generation-validation.mjs';

// Used unchanged by CLI, daemon job dispatch and direct media operations.
// No browser request/bind, lock acquisition, invalidation or write is allowed.
export async function readJobStatus(ctx){
 const ledger=await readJson(ctx.ledgerPath),observedAt=new Date().toISOString();
 const parameterValidation=await diagnoseGenerations(ctx,ledger);
 const storedResult=await readJson(resolve(ctx.dir,'result.json'));
 const result=parameterValidation.blocked&&storedResult?{...storedResult,state:blockedState,storedState:storedResult.state,diagnosticOnly:true}:storedResult;
 return {state:parameterValidation.blocked?blockedState:ledger?.phase||'not-started',observedPhase:ledger?.phase||'not-started',observedAt,readOnly:true,browserAccessed:false,ledger,parameterValidation,result,page:null,remote:[],consistency:'local snapshot; concurrent progress may be newer; this is not completion acceptance'};
}
