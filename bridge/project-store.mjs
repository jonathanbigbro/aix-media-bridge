import {resolve} from 'node:path';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {stateDir,ensureState} from './paths.mjs';

export function validateKey(key){if(typeof key!=='string'||!/^[a-z][a-z0-9_-]{0,47}$/.test(key))throw new Error('INVALID_PROJECT_KEY');return key;}
export function validateName(name){if(typeof name!=='string'||name.trim()!==name||name.length<1||name.length>80||/[\x00-\x1f]/.test(name))throw new Error('INVALID_PROJECT_NAME');return name;}
export const projectPath=key=>resolve(stateDir,'projects',validateKey(key)+'.json');
export async function readProject(key){try{return JSON.parse(await fs.readFile(projectPath(key),'utf8'));}catch(e){if(e.code==='ENOENT')throw new Error('PROJECT_NOT_BOUND_USE_PROJECT_BIND_OR_CREATE');throw e;}}
export async function listProjects(){await ensureState();const out=[];for(const name of await fs.readdir(resolve(stateDir,'projects'))){if(name.endsWith('.json'))out.push(await readProject(name.slice(0,-5)));}return out;}
export async function writeProject(key,value){
  validateKey(key);validateName(value.name);
  if(!/^<CANVASID_[a-f0-9]{12}>$/.test(value.canvasIdAlias))throw new Error('INVALID_CANVAS_ALIAS');
  await ensureState();const path=projectPath(key),temp=path+'.'+randomUUID()+'.tmp';
  const f=await fs.open(temp,'wx',0o600);try{await f.writeFile(JSON.stringify({schemaVersion:1,key,...value},null,2)+'\n');await f.sync();}finally{await f.close();}
  try{await fs.link(temp,path);}catch(e){if(e.code!=='EEXIST')throw e;const old=await readProject(key);if(old.canvasIdAlias!==value.canvasIdAlias||old.name!==value.name)throw new Error('PROJECT_KEY_ALREADY_BOUND');}finally{await fs.unlink(temp);}
  return readProject(key);
}
