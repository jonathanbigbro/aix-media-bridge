import test from 'node:test';
import assert from 'node:assert/strict';
import {scanBytes,auditFiles} from '../scripts/audit-release.mjs';
import {fileURLToPath} from 'node:url';
import {sanitize} from '../bridge/redact.mjs';
import {demoPng} from '../scripts/make-demo-reference.mjs';
import fs from 'node:fs/promises';
test('release scanner reports categories but never secret values',()=>{
 const token='sk-'+('secretCanary'.repeat(3)),email=['sample-user','private.test'].join('@'),path=['','Users','example-person','Desktop'].join('/');
 const result=scanBytes('synthetic.txt',Buffer.from([token,email,path].join('\n')));assert(result.some(x=>x.category==='credential'));assert(result.some(x=>x.category==='email'));assert(result.some(x=>x.category==='home-path'));assert(!JSON.stringify(result).includes(token));assert(!JSON.stringify(result).includes(email));
});
test('synthetic PNG contains no metadata chunks; appended data is rejected',()=>{assert.deepEqual(scanBytes('demo.png',demoPng()),[]);assert(scanBytes('demo.png',Buffer.concat([demoPng(),Buffer.from('canary')])).some(x=>x.category==='image-trailing-data'));});
test('network evidence drops credentials, headers, signed asset URLs and nested tokens',()=>{
 const secret='PRIVATE_CANARY',asset=['https:','','oss.aix.studio','output','private.png?signature='+secret].join('/');
 const input={requestHeaders:{Cookie:secret},responseBody:JSON.stringify({token:secret,canvasId:123456,canvasContent:JSON.stringify({target:{findUrl:asset}})})};const safe=sanitize(input),text=JSON.stringify(safe);assert(!text.includes(secret));assert(!text.includes('private.png'));assert(!text.includes('123456'));assert.deepEqual(sanitize(safe),safe);
});

test('structured account fields are blocked even when token formats are unknown',()=>{
 const result=scanBytes('accidental-record.json',Buffer.from(JSON.stringify({userId:Math.floor(1e6+42),email:['synthetic','private.test'].join('@'),token:'unrecognized-value'})));
 assert(result.filter(x=>x.category==='account-or-credential-field').length===3);
 assert(!JSON.stringify(result).includes('unrecognized-value'));
});
test('cookie dependency version is permitted but a credential value is rejected',()=>{
 const path='bridge/package-lock.json',record=v=>Buffer.from(JSON.stringify({packages:{example:{dependencies:{cookie:v}}}}));
 assert.deepEqual(scanBytes(path,record('^0.7.1')),[]);
 assert(scanBytes(path,record('private-session-value')).some(x=>x.category==='account-or-credential-field'));
});

test('only exact previously reviewed case video bytes may enter a release',async()=>{
 const path='examples/aix-story/aix-story.mp4',bytes=await fs.readFile(new URL('../'+path,import.meta.url));
 assert.deepEqual(scanBytes(path,bytes),[]);
 const changed=Buffer.from(bytes);changed[changed.length-1]^=1;
 assert(scanBytes(path,changed).some(x=>x.category==='reviewed-media-bytes-changed'));
 assert(scanBytes('unexpected.mp4',bytes).some(x=>x.category==='unreviewed-video'));
});
test('reviewed media also requires its pinned visual-review record',async()=>{
 const result=await auditFiles(fileURLToPath(new URL('..',import.meta.url)),['examples/aix-story/aix-story.mp4']);
 assert(result.findings.some(x=>x.category==='media-review-record-missing'));
});
