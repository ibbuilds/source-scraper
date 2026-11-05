import {performance} from "node:perf_hooks";
import {mkdtempSync,rmSync} from "node:fs";import {tmpdir} from "node:os";import {join} from "node:path";
import {runProject} from "../packages/core/engine.ts";import {createDefaultRegistry} from "../packages/core/extensions.ts";import {createPublicMetadataProcessor} from "../packages/processors/public-metadata.ts";
const times=[];let count=0;
for(let sample=0;sample<4;sample++){
 const root=mkdtempSync(join(tmpdir(),"ss-cycle-bench-")),db=join(root,"data.sqlite");
 const project={id:"cycle-bench",name:"Synthetic measured metadata latency",sources:[{id:"feed",adapter:"x-for-you-local",config:{accountId:"123"}}],pipeline:["x-discovery","public-metadata"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]};
 const registry=createDefaultRegistry();registry.sources.set("x-for-you-local",{id:"x-for-you-local",async collect(){return {hasMore:false,observations:Array.from({length:100},(_,i)=>({id:String(i+1),type:"x-post",text:"Resource",url:`https://x.com/test/status/${i+1}`,urls:i<40?[`https://example.org/tool/${i}`]:[]}))};}});
 registry.processors.set("public-metadata",createPublicMetadataProcessor(async url=>{await new Promise(r=>setTimeout(r,15));return {url,metadata:{title:"Reusable tool",description:"Synthetic bounded public metadata fetch",access:"free"}};}));
 try{const start=performance.now();const r=await runProject(db,project,registry,{xCycle:true});times.push(Math.round(performance.now()-start));count=r.observations;}finally{rmSync(root,{recursive:true,force:true});}
}
console.log(JSON.stringify({kind:"synthetic",node:process.version,postsPerRun:count,metadataRequestsPerRun:20,samplesMs:times,medianMs:[...times].sort((a,b)=>a-b)[2]}));
