try{await (await import('./job-run.mjs')).main();}
catch(e){console.log(JSON.stringify({state:'not-success-do-not-resubmit',error:e.message}));process.exitCode=2;}
