import {test} from "node:test";
import assert from "node:assert/strict";
import {createXLocalSource,xLocalConfig} from "../packages/adapters/x-local.ts";
import {X_LOCAL_WORKER} from "../packages/adapters/x-local-worker.ts";
import type {SourceContext,ObservationPage} from "../packages/sdk/contracts.ts";

const source={id:"local-x",adapter:"x-for-you-local",config:{accountId:"1234567890",pagesPerRun:1}};
const observed={id:"101",type:"x-post",title:"React motion",text:"React motion",url:"https://x.com/example/status/101",
  urls:["https://example.org/tool","https://t.co/short","http://127.0.0.1/private"],attributes:{metrics:{likes:120,reposts:20,replies:5,quotes:2,views:9000,private:999},author:"example",private:"must-not-persist"}};
async function environment(work:()=>Promise<void>){
  const values={SOURCE_SCRAPER_X_LOCAL_APPROVED:"local-read-only",SOURCE_SCRAPER_X_ACCOUNT_SESSION:"synthetic-account-session",SOURCE_SCRAPER_X_CSRF:"synthetic-csrf-value",SOURCE_SCRAPER_X_PYTHON:process.execPath};
  const prior=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));Object.assign(process.env,values);
  try{await work();}finally{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
const context=():SourceContext=>({source,limit:100,signal:new AbortController().signal});

test("free X source rejects missing session, missing grant, unsafe config and small pages before launching anything",async()=>environment(async()=>{
  let calls=0;
  const adapter=createXLocalSource({workerPath:()=>"fixed-worker.py",collect:async()=>{calls++;return {observations:[],hasMore:false};}});
  delete process.env.SOURCE_SCRAPER_X_LOCAL_APPROVED;await assert.rejects(adapter.collect(context()),/APPROVAL_REQUIRED/);
  process.env.SOURCE_SCRAPER_X_LOCAL_APPROVED="local-read-only";
  delete process.env.SOURCE_SCRAPER_X_CSRF;await assert.rejects(adapter.collect(context()),/SESSION_REQUIRED/);
  process.env.SOURCE_SCRAPER_X_CSRF="synthetic-csrf-value";
  await assert.rejects(adapter.collect({...context(),limit:20}),/PAGE_SIZE/);
  assert.throws(()=>xLocalConfig({...source.config,command:"arbitrary"}),/CONFIG/);
  assert.equal(calls,0);
}));

test("free X uses the fixed worker/tool with only account-session environment, never a commercial API key or arbitrary command",async()=>environment(async()=>{
  let received:SourceContext|undefined;
  const adapter=createXLocalSource({workerPath:()=>"fixed-worker.py",collect:async c=>{received=c;return {observations:[observed],hasMore:true,nextCursor:"continue"};}});
  const result=await adapter.collect(context());
  assert.equal(received?.source.config.command,process.execPath);
  assert.deepEqual(received?.source.config.args,["-I","fixed-worker.py"]);
  assert.equal(received?.source.config.tool,"read_x_for_you");
  assert.deepEqual(received?.source.config.passEnv,["SOURCE_SCRAPER_X_ACCOUNT_SESSION","SOURCE_SCRAPER_X_CSRF"]);
  assert.equal(result.hasMore,false);assert.equal(result.nextCursor,"continue");
  assert.deepEqual(result.observations[0].urls,["https://example.org/tool"]);
  assert.equal(result.observations[0].attributes?.collector,"twifork");
  assert.deepEqual(result.observations[0].attributes?.metrics,{likes:120,reposts:20,replies:5,quotes:2,views:9000,engagements:147});
  assert.ok(!JSON.stringify(result).includes("must-not-persist"));
}));

test("free X retains continuation across bounded windows and removes secret echoes",async()=>environment(async()=>{
  const cursors:(string|undefined)[]=[];
  const adapter=createXLocalSource({workerPath:()=>"worker.py",collect:async c=>{cursors.push(c.cursor);return {
    observations:[{...observed,text:"React synthetic-account-session"}],hasMore:true,nextCursor:"after-"+cursors.length};}});
  const firstContext=context(),first=await adapter.collect(firstContext);
  assert.equal(first.hasMore,false);assert.match(first.observations[0].text!,/redacted/);
  await assert.rejects(adapter.collect({...firstContext,cursor:first.nextCursor}),/WINDOW_COMPLETE/);
  await adapter.collect({...context(),cursor:first.nextCursor});assert.deepEqual(cursors,[undefined,"after-1"]);
}));

test("free X refuses credential cursors, mismatched posts and private-library error bodies",async()=>environment(async()=>{
  for(const value of [
    {observations:[{...observed,url:"https://other.invalid/status/101"}],hasMore:false},
    {observations:[observed],hasMore:true,nextCursor:"synthetic-account-session"}
  ] as ObservationPage[]){
    const adapter=createXLocalSource({workerPath:()=>"worker.py",collect:async()=>value});
    await assert.rejects(adapter.collect(context()),/X_LOCAL_/);
  }
  const adapter=createXLocalSource({workerPath:()=>"worker.py",collect:async()=>{throw Error("synthetic-account-session");}});
  await assert.rejects(adapter.collect(context()),error=>!String(error).includes("synthetic-account-session"));
  assert.ok(X_LOCAL_WORKER.includes("client.get_timeline("));assert.ok(!X_LOCAL_WORKER.includes("client.get_latest_timeline("));
}));

 test("X counter normalization never promotes unknown counters to zero or accepts private fields",async()=>{
 const {xMetrics}=await import("../packages/adapters/x-metrics.ts");
 assert.deepEqual(xMetrics({likes:0,reposts:1,replies:2,quotes:3,views:50,private:100}),{likes:0,reposts:1,replies:2,quotes:3,views:50,engagements:6});
 for(const value of ["100",null,NaN,Infinity,-1,true,2**54])assert.deepEqual(xMetrics({likes:value}),{});
 assert.deepEqual(xMetrics({likes:100}),{likes:100});
});


test("runtime cycles override one-page manifests, resume commits and reset EOF for fresh posts",async()=>environment(async()=>{
  const {mkdtempSync,rmSync}=await import("node:fs"),{join}=await import("node:path"),{tmpdir}=await import("node:os");
  const {runProject}=await import("../packages/core/engine.ts"),{createDefaultRegistry}=await import("../packages/core/extensions.ts"),{KnowledgeStore}=await import("../packages/storage/knowledge.ts");
  const {createPublicMetadataProcessor}=await import("../packages/processors/public-metadata.ts");
  const root=mkdtempSync(join(tmpdir(),"ss-x-cycle-")),db=join(root,"data.sqlite"),cursors:Array<string|undefined>=[];
  const post=(id:string)=>({...observed,id,url:"https://x.com/example/status/"+id,urls:["https://example.org/tool/"+id]});
  let calls=0,metadata=0;
  const pages=[{observations:[post("101")],hasMore:true,nextCursor:"a"},{observations:[post("101"),post("102")],hasMore:true,nextCursor:"b"},{observations:[],hasMore:true,nextCursor:"empty-cursor"},{observations:[post("103")],hasMore:false}];
  // This fixture replaces the worker; it must not depend on a host runtime directory.
  const adapter=createXLocalSource({workerPath:()=>"fixed-worker.py",collect:async c=>{cursors.push(c.cursor);return pages[calls++];}});
  const registry=createDefaultRegistry();registry.sources.set("x-for-you-local",adapter);
  registry.processors.set("public-metadata",createPublicMetadataProcessor(async url=>{metadata++;return {url,metadata:{title:"Exportable tool",access:"free"}};}));
  const project={id:"cycle-test",name:"Cycle test",sources:[source],pipeline:["x-discovery","public-metadata"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]};
  try{
    const first=await runProject(db,project,registry,{xCycle:true,maxPages:1});assert.equal(first.runs[0].endReason,"work-limit");
    const next=await runProject(db,project,registry,{xCycle:true,maxPages:10});assert.equal(next.runs[0].pages,2);assert.equal(next.runs[0].endReason,"end-of-window");
    const final=await runProject(db,project,registry,{xCycle:true,maxPages:10});assert.equal(final.observations,1);assert.deepEqual(cursors,[undefined,"a","b",undefined]);assert.equal(metadata,3,"unchanged committed post does not repeat metadata fetches");
    const store=new KnowledgeStore(db);try{assert.equal(store.listEntities(project.id).length,3);}finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
}));


test("only validated 429 read delays cross the adapter boundary, never arbitrary error fields",async()=>environment(async()=>{
 for(const [message,delay,expected] of [['X_LOCAL_HTTP_429',1600,1600],['X_LOCAL_HTTP_429',-1,undefined],['X_LOCAL_HTTP_429','900',undefined],['X_LOCAL_HTTP_401',900,undefined]] as const){
  const adapter=createXLocalSource({workerPath:()=>"worker.py",collect:async()=>{throw Object.assign(Error(message),{retryAfterSeconds:delay,secret:'synthetic-account-session'});}});
  await assert.rejects(adapter.collect(context()),e=>{assert.ok(e instanceof Error);assert.equal((e as Error&{retryAfterSeconds?:number}).retryAfterSeconds,expected);assert.equal((e as Error&{secret?:string}).secret,undefined);assert.ok(!String(e).includes('synthetic-account-session'));return true;});
 }
}));
