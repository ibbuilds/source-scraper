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
