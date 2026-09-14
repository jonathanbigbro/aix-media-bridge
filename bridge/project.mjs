import {request} from './socket-client.mjs';
import {listProjects,validateKey,validateName} from './project-store.mjs';
try{
  const [mode,...rest]=process.argv.slice(2),args={operation:'project:'+mode};
  if(!['inspect','list','bind','create','open','select','pages'].includes(mode))throw new Error('USE_PROJECT_INSPECT_LIST_BIND_CREATE_OPEN_SELECT');
  if(rest.length%2)throw new Error('EXPECTED_--key_VALUE_--name_VALUE');
  for(let i=0;i<rest.length;i+=2){const option=rest[i];if(!['--key','--name','--page'].includes(option)||option.slice(2) in args)throw new Error('UNKNOWN_OR_DUPLICATE_PROJECT_OPTION');args[option.slice(2)]=rest[i+1];}
  if(mode==='pages'){if(rest.length)throw new Error('PAGES_TAKES_NO_OPTIONS');console.log(JSON.stringify(await request({op:'pages'})));}
  else if(mode==='list'){if(rest.length)throw new Error('LIST_TAKES_NO_OPTIONS');console.log(JSON.stringify({projects:await listProjects()}));}
  else{
    if(mode==='inspect'&&rest.some((x,i)=>i%2===0&&x!=='--page'))throw new Error('INSPECT_TAKES_NO_OPTIONS');
    if(mode!=='inspect')validateKey(args.key);
    if(['create','select','pages'].includes(mode))validateName(args.name);
    else if(args.name!==undefined)throw new Error('NAME_ONLY_FOR_CREATE_OR_SELECT');
    const pageId=args.page===undefined?undefined:Number(args.page);if(pageId!==undefined&&!Number.isSafeInteger(pageId))throw new Error('INVALID_PAGE_ID');delete args.page;await request({op:'bind',...(pageId===undefined?{}:{pageId})});
    console.log(JSON.stringify(await request({op:'flow',args})));
  }
}catch(e){console.log(JSON.stringify({state:'not-completed',error:e.message}));process.exitCode=2;}
