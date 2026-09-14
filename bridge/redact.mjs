import {createHash} from 'node:crypto';
const fingerprint = v => createHash('sha256').update(String(v)).digest('hex').slice(0,12);
const alias = (domain,v) => `<${domain}_${fingerprint(v)}>`;
const secret = /authorization|cookie|password|secret|(?:access|refresh)?token|credential|api[_-]?key|bearer|accesskeyid|signature|^policy$/i;
const entity = /^(.*UserId|.*TeamId|.*CanvasId|canvasInfoId|userId|teamId|canvasId|sessionId|messageId|requestId|clientId|taskId|fileKey|orgId)$/i;
const scrubIds = value => value.replace(/\b(?:session_[\w-]+|req_[\w-]+|user_\d+|(?:image|input|video|text|upload|audio|group|connection|conn|edge)-[a-f0-9]{8,})\b/gi,m=>alias('ENTITY',m));
export const sameNodeIdentity=(actual,expected)=>!!actual&&!!expected&&sanitize(actual)===sanitize(expected);
export function normalizeMcpData(data) {
  // evaluate_script places JSON inside a message even in structured-content mode.
  const match=data?.message?.match(/^Script ran on page and returned:\n```json\n([\s\S]*)\n```$/);
  if(match) {try{return {evaluation:JSON.parse(match[1])};}catch{throw new Error('INVALID_EVALUATION_JSON');}}
  return data;
}
export function sanitize(value, key='') {
  if (secret.test(key) || /^(requestHeaders|responseHeaders|headers)$/i.test(key)) return '[OMITTED]';
  if (value == null) return value;
  if(typeof value==='string'&&/^<[A-Z]+_[a-f0-9]{12}>$/.test(value)) return value;
  if(typeof value==='string' && value && /^(fileName|filePath|thumbnailPath)$/.test(key)) return alias(key==='fileName'?'FILEBASENAME':'ASSETPATH',value);
  if (entity.test(key) && value !== '') return alias(key.toUpperCase(),value);
  if (Array.isArray(value)) return value.map(v=>sanitize(v,key));
  if (typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,k)]));
  if (typeof value==='number') return key==='id'&&value>10000 ? alias('ID',value) : value;
  if (typeof value!=='string') return value;
  if (/^[\[{]/.test(value.trim())) {try {return JSON.stringify(sanitize(JSON.parse(value)));}catch{}}
  if (/^https?:\/\//.test(value)) {
    try {const u=new URL(value);const path=u.pathname.replace(/%3C([A-Z]+_[a-f0-9]{12})%3E/gi,'<$1>');if(/<ASSET_[a-f0-9]{12}>/.test(path))return u.origin+path;if(u.hostname==='oss.aix.studio') return `${u.origin}/<ASSET_${fingerprint(u.pathname)}>${u.pathname.match(/\.[a-z0-9]+$/i)?.[0]||''}`; return u.origin+scrubIds(path);}catch{}
  }
  if (/^(?:session|req|image|input|video|text)-?[_\d]/.test(value)) return alias('ENTITY',value);
  if (key==='nodeId' && /^\d+$/.test(value)) return value; // workflow node numbers are definitions.
  if (key==='id' && /^\d{5,}$/.test(value)) return alias('ID',value);
  return scrubIds(value.replace(/https?:\/\/oss\.aix\.studio\/[^\s"<>]+/g,m=>sanitize(m)));
}
