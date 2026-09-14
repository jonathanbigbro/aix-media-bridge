import {request} from '../bridge/socket-client.mjs';
try{console.log(JSON.stringify(await request({op:'shutdown'})));}catch(e){console.error(e.message);process.exitCode=2;}
