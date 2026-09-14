import {assertSupportedNode} from '../bridge/node-version.mjs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {root,base,ensureState} from '../bridge/paths.mjs';
if(process.platform!=='darwin'){console.error('This release supports macOS only.');process.exit(2);}
assertSupportedNode();
function run(command,args,options={}){const r=spawnSync(command,args,{cwd:root,stdio:'inherit',...options});if(r.error||r.status!==0){console.error('SETUP_FAILED: '+command);process.exit(r.status||2);}}
run('swiftc',['--version']);
run('python3',['-c','import sys; assert sys.version_info >= (3, 9), "Python 3.9+ is required"']);
run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:base});
run('swiftc',['bridge/probe-video.swift','-o','bridge/probe-video']);
run('swiftc',['scripts/probe-video-frames.swift','-o','bridge/probe-video-frames']);
run('swiftc',['resolve/review-video.swift','-o','bridge/review-video']);
run('swiftc',['resolve/probe-audio.swift','-o','bridge/probe-audio']);
await ensureState();
console.log('Setup complete. Run npm run doctor, then npm run bridge in a dedicated terminal.');
