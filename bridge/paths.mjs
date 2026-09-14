import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {homedir} from 'node:os';
import fs from 'node:fs/promises';

export const base=dirname(fileURLToPath(import.meta.url));
export const root=resolve(base,'..');
export const stateDir=resolve(process.env.AIX_STATE_DIR||resolve(root,'.aix'));
export const socketPath=resolve(base,'.bridge.sock');
export const downloadsDir=resolve(process.env.AIX_DOWNLOAD_DIR||resolve(homedir(),'Downloads'));
export async function ensureState(){
  await fs.mkdir(stateDir,{recursive:true,mode:0o700});
  for(const directory of ['logs','pipes','projects'])await fs.mkdir(resolve(stateDir,directory),{recursive:true,mode:0o700});
}
