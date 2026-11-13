import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject,processPendingProject} from "../packages/core/engine.ts";
import {createPublicMetadataProcessor} from "../packages/processors/public-metadata.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import type {ProjectDefinition} from "../packages/sdk/contracts.ts";
import type {EntityDraft} from "../packages/sdk/contracts.ts";

test("legacy X-only queue entries cannot starve an external resource or rewrite source evidence",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ss-legacy-queue-")),db=join(root,"state.sqlite"),input=join(root,"input.json");let fetches=0;
 try{writeFileSync(input,JSON.stringify([...Array.from({length:20},(_,i)=>({id:String(i).padStart(2,"0"),type:"x-inspiration",url:"https://x.com/example/status/"+(100+i)})),{id:"99",type:"web-resource",url:"https://example.org/tool"}]));
  const project:ProjectDefinition={id:"legacy-queue",name:"Legacy queue",sources:[{id:"local",adapter:"json-file",config:{path:input}}],pipeline:["observation-entity"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]},registry=createDefaultRegistry();await runProject(db,project,registry);
  let store=new KnowledgeStore(db);const before=store.listObservations(project.id).map(o=>({id:o.item_id,seen:o.last_seen}));store.db.prepare("INSERT OR IGNORE INTO kb_processing_queue SELECT project_id,connection_id,item_id,'public-metadata',0,? FROM kb_observations WHERE project_id=?").run(new Date().toISOString(),project.id);store.close();
  project.pipeline.push("public-metadata");registry.processors.set("public-metadata",createPublicMetadataProcessor(async url=>{fetches++;return {url,metadata:{title:"Verified resource"}};}));
  const first=await processPendingProject(db,project,registry);assert.equal(first.retiredTasks,20);assert.equal(first.completedUrls,1);assert.equal(first.pending,0);assert.equal(fetches,1);assert.ok(first.lastSuccessAt);
  const second=await processPendingProject(db,project,registry);assert.equal(second.attemptedUrls,0);assert.equal(second.lastSuccessAt,first.lastSuccessAt);
  store=new KnowledgeStore(db);try{assert.deepEqual(store.listObservations(project.id).map(o=>({id:o.item_id,seen:o.last_seen})),before);assert.equal(Number((store.db.prepare("SELECT COUNT(DISTINCT entity_key) total FROM kb_mentions WHERE project_id=? AND active=1").get(project.id) as {total:number}).total),21);}finally{store.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("unavailable metadata exhausts eight attempts and only explicit retry restarts it",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ss-metadata-budget-")),db=join(root,"state.sqlite"),input=join(root,"input.json");let attempts=0;
 try{const observation={id:"one",type:"web-resource",url:"https://example.org/tool",attributes:{}};writeFileSync(input,JSON.stringify([observation]));const project:ProjectDefinition={id:"retry-budget",name:"Retry budget",sources:[{id:"local",adapter:"json-file",config:{path:input}}],pipeline:["observation-entity"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]},registry=createDefaultRegistry();await runProject(db,project,registry);
  const processor=createPublicMetadataProcessor(async()=>{attempts++;throw Error("Unavailable fixture");});let draft:EntityDraft={key:"web-resource:one",type:"web-resource",url:observation.url,title:"Fixture",attributes:{}};
  for(let i=0;i<9;i++){draft={...draft,attributes:{...draft.attributes,metadataRetryAt:0}};draft=(await processor.run({project,source:project.sources[0],signal:new AbortController().signal},observation,[draft]))[0];}
  assert.equal(attempts,8);assert.equal(draft.attributes?.metadataState,"unavailable");
  const store=new KnowledgeStore(db);try{store.saveBatch(project.id,project.sources[0],[{observation,entities:[{draft,assessment:{category:"candidate",score:0,confidence:0,reasons:[]}}]}],undefined,"keyword");}finally{store.close();}
  project.pipeline.push("public-metadata");let retries=0;registry.processors.set("public-metadata",createPublicMetadataProcessor(async url=>{retries++;return {url,metadata:{title:"Recovered source"}};}));
  assert.equal((await processPendingProject(db,project,registry)).unavailableUrls,1);assert.equal(retries,0);
  const result=await processPendingProject(db,project,registry,new AbortController().signal,true);assert.equal(retries,1,JSON.stringify(result));assert.equal(result.completedUrls,1,JSON.stringify(result));assert.equal(result.unavailableUrls,0,JSON.stringify(result));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("saved score thresholds apply to query, export and resource inbox requests",()=>{
 const root=mkdtempSync(join(tmpdir(),"ss-score-policy-"));
 try{
  writeFileSync(join(root,"input.json"),JSON.stringify([{id:"one",type:"entry",text:"needle",url:"https://example.org/tool"}]));
  const config=join(root,"project.json");writeFileSync(config,JSON.stringify({id:"score-policy",name:"Score policy",sources:[{id:"local",adapter:"json-file",config:{path:"input.json"}}],pipeline:["extract-links"],evaluator:"keyword",policy:{includeKeywords:["needle"],excludeKeywords:[],minimumScore:80},outputs:[]}));
  const cli=(command:string,args:string[]=[],input?:string)=>{const r=spawnSync(process.execPath,[resolve("dist/source-scraper.mjs"),command,"--config",config,...args],{encoding:"utf8",input});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  cli("run");assert.equal(cli("query").count,0);assert.equal(cli("query",["--min-score","0"]).count,0);assert.equal(cli("export").count,0);
  assert.equal(cli("resource-batch",[],JSON.stringify({operation:"query",minScore:0})).total,0);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("X cycles share their page budget across configured connections",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ss-global-window-"));
 try{const registry=createDefaultRegistry();registry.sources.set("x-for-you-local",{id:"x-for-you-local",async collect({source,cursor}){const n=Number(cursor??0);return {observations:[{id:String(n),type:"entry",title:source.id}],nextCursor:String(n+1),hasMore:true};}});
  const project:ProjectDefinition={id:"shared-window",name:"Shared window",sources:[{id:"first",adapter:"x-for-you-local",config:{entityNamespace:"first"}},{id:"second",adapter:"x-for-you-local",config:{entityNamespace:"second"}}],pipeline:["observation-entity"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]};
  const result=await runProject(join(root,"state.sqlite"),project,registry,{maxPages:3,xCycle:true,cycleId:randomUUID()});assert.equal(result.runs.reduce((n,r)=>n+(r.pages??0),0),3);assert.equal(result.runs.length,2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test("enrichment beyond a run budget survives restart without refetching the source or changing its evidence time",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ss-pending-enrichment-")),db=join(root,"state.sqlite");let fetches=0,reads=0;
 try{const registry=createDefaultRegistry();registry.processors.set("public-metadata",createPublicMetadataProcessor(async url=>{fetches++;return {url,metadata:{title:"A verified title",description:"A reusable design resource with useful examples and documentation."}};}));
  registry.sources.set("x-for-you-local",{id:"x-for-you-local",async collect(){reads++;return {observations:[{id:"123",type:"x-post",url:"https://x.com/example/status/123",urls:Array.from({length:30},(_,i)=>"https://example.org/tool-"+i)}],hasMore:false};}});
  const project:ProjectDefinition={id:"pending-enrichment",name:"Pending enrichment",sources:[{id:"feed",adapter:"x-for-you-local",config:{accountId:"1"}}],pipeline:["x-discovery","public-metadata"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]};
  await runProject(db,project,registry,{xCycle:true});assert.equal(fetches,20);let store=new KnowledgeStore(db);const seen=store.listObservations(project.id)[0].last_seen;store.close();
  const result=await processPendingProject(db,project,registry);assert.equal(fetches,30);assert.equal(reads,1);assert.equal(result.pending,0);
  store=new KnowledgeStore(db);try{assert.equal(store.listEntities(project.id,{limit:100}).filter(e=>e.attributes.metadataState==="complete").length,30);assert.equal(store.listObservations(project.id)[0].last_seen,seen);}finally{store.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});


for(const column of ['observation_json','draft_json'])test('missing '+column+' is visibly blocked rather than retried forever',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ss-missing-evidence-')),db=join(root,'state.sqlite'),input=join(root,'input.json');let calls=0;
 try{writeFileSync(input,JSON.stringify([{id:'one',type:'web-resource',url:'https://example.org/tool'}]));const project:ProjectDefinition={id:'missing-evidence',name:'Missing evidence',sources:[{id:'local',adapter:'json-file',config:{path:input}}],pipeline:['observation-entity'],evaluator:'keyword',policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]},registry=createDefaultRegistry();await runProject(db,project,registry);let store=new KnowledgeStore(db);store.db.prepare("INSERT INTO kb_processing_queue SELECT project_id,connection_id,item_id,'public-metadata',0,? FROM kb_observations WHERE project_id=?").run(new Date().toISOString(),project.id);store.db.exec(column==='observation_json'?'UPDATE kb_observations SET observation_json=NULL;UPDATE kb_mentions SET observation_json=NULL;DELETE FROM kb_observation_versions':'UPDATE kb_mentions SET draft_json=NULL');store.close();project.pipeline.push('public-metadata');registry.processors.set('public-metadata',createPublicMetadataProcessor(async()=>{calls++;throw Error('must not fetch');}));const progress=await processPendingProject(db,project,registry);assert.equal(progress.blocked,1);assert.equal(progress.pending,0);assert.equal(calls,0);assert.equal((await processPendingProject(db,project,registry)).blocked,1);
 }finally{rmSync(root,{recursive:true,force:true});}
});
