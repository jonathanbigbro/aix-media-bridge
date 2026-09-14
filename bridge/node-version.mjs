export const minimumNodeVersion='22.12.0';
export function supportsNode(version=process.versions.node){
 const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(version);
 if(!match)return false;
 const [major,minor,patch]=match.slice(1).map(Number);
 return major>22||major===22&&(minor>12||minor===12&&patch>=0);
}
export function assertSupportedNode(version=process.versions.node){
 if(!supportsNode(version))throw new Error(`Node.js >=${minimumNodeVersion} is required; found ${version}. Upgrade Node before installing dependencies or starting the bridge.`);
}
