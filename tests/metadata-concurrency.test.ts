import {test} from "node:test";
import assert from "node:assert/strict";
import {setImmediate as tick} from "node:timers/promises";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createPublicMetadataProcessor} from "../packages/processors/public-metadata.ts";
import {parseProject} from "../packages/core/project-config.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import type {EntityDraft} from "../packages/sdk/contracts.ts";
const project=parseProject({id:"metadata-parallel",name:"Metadata fixture",sources:[{id:"fixture",adapter:"fixture",config:{}}],pipeline:["linked-resources","public-metadata"],outputs:[]});
const drafts=Array.from({length:30},(_,i):EntityDraft=>({key:"https://example.org/"+i,url:"https://example.org/"+i,type:"web-resource",title:"Original "+i}));
const observation={id:"post",type:"source-post"};
const context=(signal:AbortSignal)=>({project,source:project.sources[0],signal});

test("metadata shares four slots and a 20-URL budget per run; out-of-order completion preserves output and duplicate identity",async()=>{
  let active=0,peak=0,calls=0;
  const gates:Array<()=>void>=[];
  const processor=createPublicMetadataProcessor(async url=>{
    calls++;active++;peak=Math.max(peak,active);
    await new Promise<void>(resolve=>gates.push(resolve));active--;
    return {url,metadata:{title:"Enriched "+new URL(url).pathname.slice(1)}};
  });
  const controller=new AbortController(),ctx=context(controller.signal);
  const first=Promise.resolve(processor.run(ctx,observation,drafts));
  const duplicate=Promise.resolve(processor.run(ctx,observation,[drafts[0]]));
  await tick();assert.equal(calls,4);assert.equal(active,4);
  for(let n=0;n<20;n++){assert.ok(gates.length);gates.pop()!();await tick();}
  const results=await first,dupe=await duplicate;
  assert.equal(calls,20);assert.equal(peak,4);assert.equal(active,0);
  assert.deepEqual(results.map(d=>d.key),drafts.map(d=>d.key));
  assert.deepEqual(results.map(d=>d.title),drafts.map((d,i)=>i<20?"Enriched "+i:d.title));
  assert.equal(dupe[0].title,"Enriched 0");
  const newRun=Promise.resolve(processor.run(context(new AbortController().signal),observation,[drafts[0]]));
  await tick();assert.equal(calls,21,"a new run never borrows stale metadata");gates.pop()!();await newRun;
});

test("metadata errors remain unavailable evidence and X URLs never enter the request pool",async()=>{
  let calls=0;const processor=createPublicMetadataProcessor(async()=>{calls++;throw Error("Public metadata unavailable");});
  const rows=await processor.run(context(new AbortController().signal),observation,[drafts[0],drafts[0],
    {key:"x",type:"web-resource",title:"Post",url:"https://x.com/example/status/1"}]);
  assert.equal(calls,1);assert.ok(rows[0].evidence?.some(e=>e.signal==="metadata-unavailable"));
  assert.ok(rows[1].evidence?.some(e=>e.signal==="metadata-unavailable"));assert.equal(rows[2].evidence,undefined);
});

test("a rejected metadata transformation waits for all siblings before releasing its caller",async()=>{
  let release:()=>void=()=>{};
  const processor=createPublicMetadataProcessor(async url=>{
    if(url.endsWith("/0"))return {url:"not a URL",metadata:{title:"invalid"}};
    await new Promise<void>(resolve=>release=resolve);return {url,metadata:{title:"ok"}};
  });
  let settled=false;
  const result=Promise.resolve(processor.run(context(new AbortController().signal),observation,drafts.slice(0,2)));
  const rejected=assert.rejects(result).then(()=>{settled=true;});
  await tick();assert.equal(settled,false,"a failed sibling cannot leave background requests running");
  release();await rejected;assert.equal(settled,true);
});

test("cancellation stops queued metadata, settles active work and never commits an incomplete page",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-metadata-cancel-")),db=join(root,"store.sqlite"),controller=new AbortController();
  let started=0,active=0;
  const processor=createPublicMetadataProcessor(async(url,signal)=>{
    started++;active++;
    try{await new Promise<void>((_resolve,reject)=>signal!.addEventListener("abort",()=>reject(Error("cancelled")),{once:true}));}
    finally{active--;}
    return {url,metadata:{}};
  });
  const registry=createDefaultRegistry();registry.processors.set("public-metadata",processor);
  registry.sources.set("fixture",{id:"fixture",async collect(){return {hasMore:false,observations:[{...observation,urls:drafts.map(d=>d.url!)}]};}});
  try{
    const pending=runProject(db,project,registry,{signal:controller.signal});
    await tick();assert.equal(started,4);controller.abort();const result=await pending;
    assert.equal(result.success,false);assert.equal(result.observations,0);assert.equal(started,4);assert.equal(active,0);
    const store=new KnowledgeStore(db);try{assert.equal(store.db.prepare("SELECT COUNT(*) n FROM kb_observations").get()?.n,0);assert.equal(store.cursor(project.id,"fixture"),undefined);}finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
