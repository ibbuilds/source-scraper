import {test,mock} from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {createXForYouSource,normalizeXPost,requestXForYou,X_PROVIDER_ENDPOINT,X_PROVIDER_APPROVAL,xForYouConfig} from "../packages/adapters/x-for-you.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {parseProject} from "../packages/core/project-config.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";

const credentials={apiKey:"synthetic-provider-key",accountSession:"synthetic-account-session",approved:true};
const source={id:"x-feed",adapter:"x-for-you",config:{accountId:"1234567890",pagesPerRun:1}};
const signal=()=>new AbortController().signal;
const post=(id:string,text="React motion toolkit",url="https://github.com/example/motion-kit")=>({
  id,text,author:{userName:"example"},createdAt:"2026-11-01T12:00:00Z",
  entities:{urls:url?[{expanded_url:url}]:[]},auth_token:"must-not-persist",account:{private:"must-not-persist"}
});
const page=(tweets:unknown[]=[],has_more=false,next_cursor?:string)=>({userId:source.config.accountId,tweets,has_more,next_cursor});

test("X source denies approval, missing credentials, overrides, undersized pages and cancellation before transport",async()=>{
  let calls=0;
  for(const c of [{...credentials,approved:false},{...credentials,apiKey:""},{...credentials,accountSession:"bad\nheader"}]){
    const adapter=createXForYouSource({credentials:()=>c,transport:async()=>{calls++;return page();}});
    await assert.rejects(adapter.collect({source,limit:100,signal:signal()}),/X_PROVIDER_(APPROVAL|CREDENTIALS)_REQUIRED/);
  }
  const adapter=createXForYouSource({credentials:()=>credentials,transport:async()=>{calls++;return page();}});
  await assert.rejects(adapter.collect({source:{...source,config:{...source.config,url:"https://other.invalid"}},limit:100,signal:signal()}),/X_FEED_CONFIG/);
  await assert.rejects(adapter.collect({source,limit:20,signal:signal()}),/X_FEED_PAGE_SIZE/);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(adapter.collect({source,limit:100,signal:aborted.signal}),/CANCELLED/);
  assert.equal(calls,0);
  assert.throws(()=>xForYouConfig({...source.config,pagesPerRun:11}),/1–10/);
});

test("X normalization preserves observed provenance, expanded links/media and redacts credentials without retaining raw account fields",()=>{
  const observed=normalizeXPost({...post("101","React motion https://t.co/short "+credentials.apiKey),
    extendedEntities:{media:[{media_url_https:"https://pbs.twimg.com/media/example.jpg"}]},
    entities:{urls:[{expanded_url:"https://github.com/example/motion-kit?utm_source=x"},{expanded_url:"https://x.com/example/status/999"},{expanded_url:"https://t.co/short"},{expanded_url:"http://127.0.0.1/private"}]}},[credentials.apiKey,credentials.accountSession]);
  assert.equal(observed.url,"https://x.com/example/status/101");
  assert.deepEqual(observed.urls,["https://github.com/example/motion-kit"]);
  assert.equal(observed.occurredAt,"2026-11-01T12:00:00.000Z");assert.equal(observed.media?.length,1);
  assert.equal(observed.attributes?.feedVerification,"provider-reported");
  assert.ok(!JSON.stringify(observed).includes(credentials.apiKey));
  assert.ok(!JSON.stringify(observed).includes("must-not-persist"));
});

test("bounded X windows save the next cursor, resume on a new run and do not charge beyond their configured budget",async()=>{
  const cursors:(string|undefined)[]=[];
  const adapter=createXForYouSource({credentials:()=>credentials,transport:async input=>{
    cursors.push(input.cursor);return page([post("101")],true,input.cursor?"next-two":"next-one");
  }});
  const firstSignal=signal(),first=await adapter.collect({source,limit:100,signal:firstSignal});
  assert.equal(first.hasMore,false);assert.equal(first.nextCursor,"next-one");
  await assert.rejects(adapter.collect({source,limit:100,signal:firstSignal,cursor:first.nextCursor}),/REQUEST_BUDGET/);
  await adapter.collect({source,limit:100,signal:signal(),cursor:first.nextCursor});
  assert.deepEqual(cursors,[undefined,"next-one"]);
});

for(const [name,body] of [
  ["account mismatch",{...page(),userId:"wrong"}],
  ["repeated cursor",page([],true,"repeat")],
  ["missing continuation",page([],true)],
  ["echoed credential cursor",page([],true,credentials.accountSession)],
  ["oversized page",page(Array.from({length:101},()=>post("101")))],
  ["non-numeric identity",page([post("unsafe")])],
  ["invalid hasMore",{...page(),has_more:"yes"}]
] as const)test("X provider rejects "+name+" without returning response data",async()=>{
  const adapter=createXForYouSource({credentials:()=>credentials,transport:async()=>body});
  await assert.rejects(adapter.collect({source,limit:100,signal:signal(),cursor:"repeat"}),/X_PROVIDER_/);
});

test("X transport failures are not retried and never include provider secrets or bodies",async()=>{
  let calls=0;
  const adapter=createXForYouSource({credentials:()=>credentials,transport:async()=>{calls++;throw Error("provider body "+credentials.accountSession);}});
  await assert.rejects(adapter.collect({source,limit:100,signal:signal()}),{message:"X_PROVIDER_REQUEST_FAILED"});
  assert.equal(calls,1);
});

test("fixed X HTTPS transport sends For You selector and rejects redirects, errors, large bodies and timeouts without retries",async()=>{
  for(const status of [200,302,401,429,500,"large","timeout","error"]){
    let calls=0,seenUrl="",seenBody="",seenHeaders:Record<string,unknown>={};
    const stub=mock.method(https,"request",((url:unknown,options:{headers:Record<string,unknown>},cb:(res:unknown)=>void)=>{
      calls++;seenUrl=String(url);seenHeaders=options.headers;
      const req=new EventEmitter() as EventEmitter&{end:(s:string)=>void;destroy:()=>void};
      req.destroy=()=>{};
      req.end=(body:string)=>{seenBody=body;queueMicrotask(()=>{
        if(status==="timeout"){req.emit("timeout");return;}
        if(status==="error"){req.emit("error",Error(credentials.accountSession));return;}
        const res=new PassThrough() as PassThrough&{statusCode:number;headers:Record<string,string>};
        res.statusCode=typeof status==="number"?status:200;res.headers={"content-type":"application/json",location:"https://other.invalid"};
        cb(res);res.end(status==="large"?"x".repeat(1_000_001):JSON.stringify(page()));
      });};return req;
    }) as typeof https.request);
    try{
      const pending=requestXForYou({...credentials,signal:signal(),cursor:"next-page"});
      if(status===200)await pending;else await assert.rejects(pending,/X_PROVIDER_/);
      assert.equal(calls,1);assert.equal(seenUrl,X_PROVIDER_ENDPOINT);
      assert.equal(seenHeaders.Authorization,"Bearer "+credentials.apiKey);
      assert.deepEqual(JSON.parse(seenBody),{auth_token:credentials.accountSession,following:false,cursor:"next-page"});
    }finally{stub.mock.restore();}
  }
});

test("X posts pass through real SQLite discovery, filters and deduplication while the bounded cursor continues across runs",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-x-e2e-")),db=join(root,"findings.sqlite");
  try{
    const cursors:(string|undefined)[]=[];
    const adapter=createXForYouSource({credentials:()=>credentials,transport:async input=>{
      cursors.push(input.cursor);
      return page([post("101"),post("102","React motion repeated evidence"),post("103","Sponsored React giveaway","https://example.org/ad"),post("104","Typography motion study","")],true,"next-"+cursors.length);
    }});
    const project=parseProject({id:"x-test",name:"X fixture research",sources:[source],pipeline:["x-discovery"],evaluator:"keyword",
      policy:{includeKeywords:["React","motion","typography"],excludeKeywords:["sponsored"],minimumScore:50},outputs:[]});
    const registry=createDefaultRegistry();registry.sources.set("x-for-you",adapter);
    const first=await runProject(db,project,registry);assert.equal(first.success,true,JSON.stringify(first));
    const second=await runProject(db,project,registry);assert.equal(second.success,true,JSON.stringify(second));
    assert.deepEqual(cursors,[undefined,"next-1"]);
    const store=new KnowledgeStore(db);
    try{
      const rows=store.listEntities(project.id);assert.equal(rows.length,3);
      assert.equal(rows.filter(e=>e.score>=50).length,2);
      assert.equal(store.getEntity(project.id,"https://github.com/example/motion-kit")?.observationCount,2);
      assert.equal(store.getEntity(project.id,"https://example.org/ad")?.score,0);
      assert.equal(store.getEntity(project.id,"x-inspiration:104")?.type,"x-inspiration");
      assert.ok(rows.every(e=>e.review==="pending"));
    }finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("packaged CLI advertises free local X capability and refuses collection without explicit local approval",()=>{
  const cli=process.env.SOURCE_SCRAPER_TEST_CLI||fileURLToPath(new URL("../dist/source-scraper.mjs",import.meta.url));
  const root=mkdtempSync(join(tmpdir(),"ss-x-cli-"));
  try{
    const config=join(root,"project.json");
    writeFileSync(config,JSON.stringify({id:"x-cli",name:"X CLI fixture",sources:[{...source,adapter:"x-for-you-local"}],pipeline:["x-discovery"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]}));
    const env={...process.env};delete env.SOURCE_SCRAPER_X_PROVIDER_APPROVED;delete env.SOURCE_SCRAPER_X_ACCOUNT_SESSION;delete env.SOURCE_SCRAPER_GETXAPI_API_KEY;
    const version=spawnSync(process.execPath,[cli,"version"],{encoding:"utf8",env});
    assert.ok(JSON.parse(version.stdout).capabilities.includes("x-for-you-local-v1"));
    const adapters=spawnSync(process.execPath,[cli,"adapters"],{encoding:"utf8",env});
    assert.ok(JSON.parse(adapters.stdout).sources.includes("x-for-you-local"));
    assert.ok(!JSON.parse(adapters.stdout).sources.includes("x-for-you"),"The retired paid source must never be registered");
    const run=spawnSync(process.execPath,[cli,"run","--config",config],{encoding:"utf8",env});
    assert.equal(run.status,1);assert.equal(JSON.parse(run.stdout).result.observations,0);
    assert.match(run.stdout,/X_LOCAL_APPROVAL_REQUIRED/);assert.notEqual(X_PROVIDER_APPROVAL,"");
  }finally{rmSync(root,{recursive:true,force:true});}
});
