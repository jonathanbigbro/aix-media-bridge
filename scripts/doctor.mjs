import {assertSupportedNode,supportsNode,minimumNodeVersion} from '../bridge/node-version.mjs';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {base,stateDir,socketPath,downloadsDir} from '../bridge/paths.mjs';
import {request} from '../bridge/socket-client.mjs';
assertSupportedNode();
const sourceVersion=JSON.parse(await fs.readFile(new URL('../package.json',import.meta.url),'utf8')).version;
const checks={macOS:process.platform==='darwin',nodeVersionSupported:supportsNode(),swift:spawnSync('swiftc',['--version'],{stdio:'ignore'}).status===0};
checks.python39OrNewer=spawnSync('python3',['-c','import sys; sys.exit(0 if sys.version_info >= (3, 9) else 2)'],{stdio:'ignore'}).status===0;
for(const [name,path] of [['dependencies',resolve(base,'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js')],['videoDecoder',resolve(base,'probe-video')],['frameExtractor',resolve(base,'probe-video-frames')],['pixelReviewer',resolve(base,'review-video')],['audioDecoder',resolve(base,'probe-audio')]])checks[name]=await fs.access(path).then(()=>true,()=>false);
let bridge={state:'not-running'};try{await fs.access(socketPath);bridge=await request({op:'health'});}catch(e){if(e.code!=='ENOENT')bridge={state:'unavailable',reason:e.message};}
let chrome;
if(process.argv.includes('--live'))try{chrome=await request({op:'pages'});if(!chrome.pages?.length)chrome={state:'needs-attention',reason:'OPEN_AIX_CANVAS_IN_CHROME'};}catch(e){chrome={state:'needs-attention',reason:e.message};}
console.log(JSON.stringify({sourceVersion,node:{actual:process.versions.node,minimum:minimumNodeVersion},checks,bridge,...chrome?{chrome}:{},runtime:{stateDirectory:stateDir,downloadsDirectory:downloadsDir},instructions:'Open AIX /AixCanvas in Chrome and allow its requested remote-debugging connection. Keep the AIX interface in Simplified Chinese. Runtime files stay local.'},null,2));
if(Object.values(checks).some(x=>!x)||chrome?.state==='needs-attention')process.exitCode=2;
