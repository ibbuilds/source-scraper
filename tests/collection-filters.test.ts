import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {parseCollectionFilters,compileCollectionFilters} from "../packages/sdk/collection-filters.ts";
import {parseProject} from "../packages/core/project-config.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {createFilteredQuery} from "../packages/core/query-filters.ts";

const sources=["alpha","beta"];
function match(profile:unknown,entity:unknown,mentions:Array<{sourceId:string;observation:unknown}>=[]){
  return compileCollectionFilters(sources,profile).match(entity,()=>mentions).matched;
}
test("literal word/phrase matching is Unicode-aware, configurable and independent of source hype",()=>{
  const filter={version:1,entity:{includeTerms:["UI","design system"],includeMode:"any"}};
  assert.equal(match(filter,{title:"Building tools"}),false,"UI must not match inside building");
  assert.equal(match(filter,{title:"UI toolkit"}),true);
  assert.equal(match(filter,{title:"A DESIGN   SYSTEM library"}),true);
  assert.equal(match(filter,{title:"Unrelated",attributes:{discoveryText:"UI design system"}}),false);
  assert.equal(match({version:1,entity:{includeTerms:["c++"]}},{title:"C++ toolkit"}),true,"terms are literals, not regex");
  assert.equal(match({version:1,entity:{includeTerms:["ui"],matchMode:"substring"}},{title:"building"}),true);
  assert.equal(match({version:1,entity:{fields:["attributes.Title","attributes.title"],includeTerms:["needle"]}},
    {title:"x",attributes:{Title:"other",title:"needle"}}),true,"field paths remain case-sensitive");
});
test("exclusions, all terms, domain boundaries, types and missing evidence are deterministic",()=>{
  const f={version:1,entity:{includeTerms:["react","forms"],includeMode:"all",excludeTerms:["giveaway"],
    allowedDomains:["EXAMPLE.org"],blockedDomains:["spam.example.org"],types:["web-resource"],requiredFields:["attributes.license"]}};
  const good={title:"React forms",type:"web-resource",url:"https://docs.example.org/form",attributes:{license:"MIT"}};
  assert.equal(match(f,good),true);
  for(const bad of [{...good,title:"React forms giveaway"},{...good,title:"React"},{...good,url:"https://example.org.evil.invalid/"},
    {...good,url:"https://spam.example.org/"},{...good,type:"x-inspiration"},{...good,attributes:{}}])assert.equal(match(f,bad),false);
  assert.equal(match({version:1,entity:{requiredFields:["attributes.zero","attributes.flag"]}},
    {attributes:{zero:0,flag:false}}),true,"false and zero are valid present data");
});
test("saved and request filters intersect and source conditions must match the same retained observation",()=>{
  const saved={version:1,sourceIds:["alpha"],observation:{includeTerms:["react"],excludeTerms:["giveaway"]}};
  const request={version:1,observation:{includeTerms:["forms"]}};
  const compiled=compileCollectionFilters(sources,saved,request);
  assert.equal(compiled.match({},()=>[
    {sourceId:"alpha",observation:{text:"react"}},{sourceId:"beta",observation:{text:"react forms"}}
  ]).matched,false);
  assert.equal(compiled.match({},()=>[{sourceId:"alpha",observation:{text:"React forms"}}]).matched,true);
  assert.throws(()=>compileCollectionFilters(sources,saved,{version:1,sourceIds:["beta"]}),/no common/);
  assert.deepEqual(saved.sourceIds,["alpha"],"compilation never mutates the saved profile");
});
test("invalid/unknown options fail closed and cannot read prototype paths or execute patterns",()=>{
  for(const value of [{version:2,entity:{includeTerms:["x"]}},{version:1},{version:1,sourceIds:[]},{version:1,sourceIds:["missing"]},
    {version:1,entity:{includeTerms:[""]}},{version:1,entity:{includeMode:"all"}},
    {version:1,entity:{includeTerms:["x"],regex:true}},{version:1,entity:{requiredFields:["attributes.__proto__.x"]}},
    {version:1,entity:{allowedDomains:["https://example.org"]}}])assert.throws(()=>parseCollectionFilters(value,sources),/INVALID_FILTER/);
});
test("query filtering precedes pagination, uses all active source snapshots, preserves evidence and supports CLI exports",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-filter-"));
  try{
    const source=join(root,"data.json"),config=join(root,"project.json"),db=join(root,".source-scraper.sqlite");
    const input=Array.from({length:603},(_,i)=>({id:String(i).padStart(4,"0"),type:"catalog-entry",
      title:i>=600?"Needle UI "+i:"Other "+i,attributes:{kind:"example"}}));
    writeFileSync(source,JSON.stringify(input));
    const raw={id:"filter-example",name:"Generic filter example",sources:[{id:"alpha",adapter:"json-snapshot",config:{path:source}}],
      pipeline:["observation-entity"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[],
      filters:{version:1,entity:{includeTerms:["needle"]}}};
    writeFileSync(config,JSON.stringify(raw));
    const project=parseProject(raw),run=await runProject(db,project,createDefaultRegistry(),{pageSize:100});
    assert.equal(run.observations,603);assert.equal(run.success,true);
    const store=new KnowledgeStore(db);
    try{
      const compiled=compileCollectionFilters(["alpha"],project.filters);
      const page=createFilteredQuery(store,project.id,compiled,{limit:1,offset:1});
      assert.deepEqual(Array.from(page.records).map(x=>x.key),["catalog-entry:0601"]);
      assert.equal(page.report.examined,602);
      assert.equal(store.listEntities(project.id,{limit:500}).length,500,"filtered-out evidence is retained");
      const obs=compileCollectionFilters(["alpha"],undefined,{version:1,observation:{includeTerms:["needle"]}});
      assert.equal(Array.from(createFilteredQuery(store,project.id,obs,{limit:10,offset:0}).records).length,3);
    }finally{store.close();}
    const binary=resolve("dist/source-scraper.mjs");
    const cli=(args:string[])=>{const r=spawnSync(process.execPath,[binary,...args],{encoding:"utf8",timeout:30000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
    assert.equal(cli(["query","--config",config,"--limit","1","--offset","1"]).records[0].key,"catalog-entry:0601");
    const narrowed=cli(["query","--config",config,"--filters-json",JSON.stringify({version:1,entity:{includeTerms:["0602"],fields:["key"]}})]);
    assert.deepEqual(narrowed.records.map((x:any)=>x.key),["catalog-entry:0602"]);
    assert.equal(cli(["export","--config",config,"--compact","true"]).count,3);
    const unfilteredConfig=join(root,"unfiltered-project.json");
    const {filters:_,...withoutPreset}=raw;writeFileSync(unfilteredConfig,JSON.stringify(withoutPreset));
    const exported=cli(["export","--config",unfilteredConfig,"--compact","true","--filters-json",JSON.stringify({version:1,entity:{includeTerms:["other"]}})]);
    assert.equal(exported.count,600,"filtered exports continue beyond a 500-row page");
    assert.equal(new Set(exported.records.map((x:any)=>x.key)).size,600);
    assert.deepEqual(JSON.parse(readFileSync(config,"utf8")),raw,"requests do not rewrite saved filters");
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("source matching sees more than the 50 mentions truncated by the evidence display",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-filter-mentions-"));
  try{
    const db=join(root,"store.sqlite"),registry=createDefaultRegistry();
    registry.sources.set("fixture",{id:"fixture",collect:async()=>({hasMore:false,
      observations:Array.from({length:61},(_,i)=>({id:String(i),type:"source-post",title:i===0?"needle":"other",
        urls:["https://example.org/shared"]}))})});
    const project=parseProject({id:"source-mentions",name:"Source snapshots",sources:[{id:"alpha",adapter:"fixture",config:{}}],
      pipeline:["linked-resources"],outputs:[]});
    await runProject(db,project,registry);
    const store=new KnowledgeStore(db);
    try{
      assert.equal(Array.from(store.filterObservations(project.id,"https://example.org/shared")).length,61);
      const filter=compileCollectionFilters(["alpha"],{version:1,observation:{includeTerms:["needle"]}});
      const records=Array.from(createFilteredQuery(store,project.id,filter,{limit:10,offset:0}).records);
      assert.equal(records.length,1);assert.equal(records[0].review,"pending");
    }finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("source selection contacts only registered selected sources, before any state writes on invalid input",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-filter-sources-"));
  try{
    const db=join(root,"store.sqlite"),calls:string[]=[],registry=createDefaultRegistry();
    registry.sources.set("probe",{id:"probe",collect:async c=>{calls.push(c.source.id);return {observations:[],hasMore:false};}});
    const project=parseProject({id:"source-scope",name:"Source selection",sources:sources.map(id=>({id,adapter:"probe",config:{}})),
      pipeline:["observation-entity"],outputs:[],filters:{version:1,sourceIds:["alpha"]}});
    await assert.rejects(runProject(db,project,registry,{sourceIds:["missing"]}),/INVALID_FILTER/);
    assert.equal(existsSync(db),false);
    await runProject(db,project,registry);assert.deepEqual(calls,["alpha"]);
  }finally{rmSync(root,{recursive:true,force:true});}
});
