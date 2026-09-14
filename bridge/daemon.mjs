import net from 'node:net';
import fs from 'node:fs/promises';
import {resolve} from 'node:path';
import {assertSupportedNode} from './node-version.mjs';
import {base,stateDir,socketPath,ensureState} from './paths.mjs';
import {sanitize} from './redact.mjs';
import {createDaemonOperations} from './daemon-operations.mjs';

assertSupportedNode();
const {connect}=await import('./transport.mjs');
process.umask(0o077);
await ensureState();
try{await fs.lstat(socketPath);throw new Error('BRIDGE_SOCKET_EXISTS_USE_DOCTOR');}catch(e){if(e.code!=='ENOENT')throw e;}
const version=JSON.parse(await fs.readFile(resolve(base,'package.json'),'utf8')).version;
const client=await connect();
let stopping=false;
const {dispatch}=createDaemonOperations({client,version,onShutdown:()=>stop()});
let chain=Promise.resolve();
const server=net.createServer(c=>{
  let buffer='';c.setEncoding('utf8');c.on('error',()=>{});
  c.on('data',part=>{buffer+=part;if(buffer.length>1024*1024){c.end(JSON.stringify({error:'REQUEST_TOO_LARGE'})+'\n');return;}if(!buffer.includes('\n'))return;c.pause();chain=chain.then(async()=>{try{const q=JSON.parse(buffer.split('\n')[0]);c.end(JSON.stringify(sanitize(await dispatch(q)))+'\n');}catch(e){c.end(JSON.stringify({error:sanitize(e.message)})+'\n');}});});
});
server.on('error',async e=>{console.error(e.code==='EADDRINUSE'?'BRIDGE_ALREADY_RUNNING':e.code);await client.close();process.exitCode=2;});
server.listen(socketPath,async()=>{
  await fs.writeFile(resolve(stateDir,'daemon.json'),JSON.stringify({pid:process.pid,version,startedAt:new Date().toISOString()})+'\n',{mode:0o600});
  console.log(JSON.stringify({state:'bridge-ready',version,chromeAuthorization:'AIX commands may require Chrome Allow'}));
});
async function stop(){if(stopping)return;stopping=true;server.close();await client.close();await fs.unlink(socketPath).catch(()=>{});await fs.unlink(resolve(stateDir,'daemon.json')).catch(()=>{});process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
