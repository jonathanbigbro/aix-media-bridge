import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {ListRootsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {resolve, dirname} from 'node:path';

import {base,root} from './paths.mjs';
export {base,root} from './paths.mjs';
export const serverArgs = [
  resolve(base, 'node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),
  '--autoConnect', '--no-usage-statistics', '--no-performance-crux',
  '--redactNetworkHeaders', '--experimentalStructuredContent',
  '--no-category-performance', '--no-category-emulation',
  `--workspace=${root}`,
];
export async function connect() {
  const client = new Client({name:'aix-recon-local',version:'0.0.1'}, {capabilities:{roots:{listChanged:false}}});
  client.setRequestHandler(ListRootsRequestSchema, async()=>({roots:[{uri:pathToFileURL(root).href,name:'aix-recon'}]}));
  const transport = new StdioClientTransport({command:process.execPath,args:serverArgs,stderr:'pipe',env:{...process.env,CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS:'1'}});
  // Do not persist server stderr: it can contain inspected-page content.
  await client.connect(transport);
  transport.stderr?.resume();
  return client;
}
