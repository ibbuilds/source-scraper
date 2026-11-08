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
    const ordinary=cli(["export","--config",unfilteredConfig,"--limit","550","--offset","25"]);
    assert.equal(ordinary.count,550,"unfiltered entity exports stream beyond one output batch");
    const reopened=new KnowledgeStore(db);
    try{
      const key=ordinary.records[0].key,known=reopened.getEntity(project.id,key)!;
      const detail=reopened.entityEvidence(project.id,key);
      const originalGet=reopened.getEntity.bind(reopened);let reads=0;
      reopened.getEntity=(...args)=>{reads++;return originalGet(...args);};
      assert.deepEqual(reopened.entityEvidence(project.id,key,known),detail);
      assert.equal(reads,0,"export evidence reuses the row already read from its snapshot");
      assert.throws(()=>reopened.entityEvidence(project.id,key,{...known,key:"wrong"}),/identity mismatch/);
    }finally{reopened.close();}

    assert.equal(ordinary.records[0].key,"catalog-entry:0025");assert.equal(ordinary.records.at(-1).key,"catalog-entry:0574");
    assert.ok(ordinary.records.every((row:any)=>row.provenance.mentions.length===1));
    const ndjson=spawnSync(process.execPath,[binary,"export","--config",unfilteredConfig,"--format","ndjson","--limit","550","--offset","25","--compact","true"],{encoding:"utf8",timeout:30000});
    assert.equal(ndjson.status,0,ndjson.stderr);
    assert.deepEqual(ndjson.stdout.trim().split("\n").map(line=>JSON.parse(line).record.key),ordinary.records.map((row:any)=>row.key));
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

test("numeric thresholds reject missing, coerced and non-finite counters; bounds are inclusive",()=>{
  const f={version:1,observation:{numericRanges:[{field:"attributes.metrics.likes",min:100,max:1000}]}};
  const check=(value:unknown)=>match(f,{},[{sourceId:"alpha",observation:{attributes:{metrics:{likes:value}}}}]);
  for(const value of [100,1000])assert.equal(check(value),true);
  for(const value of [99,1001,undefined,null,"500",false,NaN,Infinity])assert.equal(check(value),false);
  for(const range of [{field:"attributes.metrics.likes"},{field:"attributes.metrics.likes",min:"100"},
    {field:"attributes.metrics.likes",min:Infinity},{field:"attributes.metrics.likes",min:20,max:10},
    {field:"attributes.__proto__.likes",min:0}])assert.throws(()=>parseCollectionFilters({version:1,observation:{numericRanges:[range]}}),/INVALID_FILTER/);
});

test("date and rolling-age filters use one clock, explicit zones and the same supporting post as thresholds",()=>{
  const at=Date.parse("2026-11-02T12:00:00Z");
  const filter=compileCollectionFilters(sources,{version:1,entity:{types:["web-resource"],requiredFields:["url"]},
    observation:{dateRanges:[{field:"occurredAt",maxAgeDays:30}],numericRanges:[{field:"attributes.metrics.likes",min:100}]}},undefined,at);
  const entity={type:"web-resource",url:"https://example.org/tool"};
  const post=(occurredAt:unknown,likes=100)=>({sourceId:"alpha",observation:{occurredAt,attributes:{metrics:{likes}}}});
  assert.equal(filter.match(entity,()=>[post("2026-10-03T12:00:00Z")]).matched,true);
  assert.equal(filter.match(entity,()=>[post("2026-11-02T13:00:00+01:00")]).matched,true);
  for(const date of [undefined,"2026-11-01","bad","2026-02-30T12:00:00Z","2026-10-03T11:59:59Z","2026-11-02T12:00:01Z"])
    assert.equal(filter.match(entity,()=>[post(date)]).matched,false);
  assert.equal(filter.match(entity,()=>[post("2026-11-01T12:00:00Z",5),post("2026-09-01T12:00:00Z",1000)]).matched,false,"cannot borrow likes from an old post");
  const range=compileCollectionFilters(sources,{version:1,observation:{dateRanges:[{field:"occurredAt",from:"2026-10-01T00:00:00Z",to:"2026-10-31T23:59:59Z"}]}},undefined,at);
  assert.equal(range.match(entity,()=>[post("2026-10-31T23:59:59Z")]).matched,true);
  assert.equal(range.match(entity,()=>[post("2026-11-01T00:00:00Z")]).matched,false);
  for(const rule of [{field:"occurredAt"},{field:"occurredAt",maxAgeDays:0},{field:"occurredAt",maxAgeDays:"30"},
    {field:"occurredAt",from:"2026-02-30T00:00:00Z"},{field:"occurredAt",from:"2026-11-01T00:00:00"},
    {field:"occurredAt",from:"2026-11-01T00:00:00Z",to:"2026-10-01T00:00:00Z"}])
    assert.throws(()=>parseCollectionFilters({version:1,observation:{dateRanges:[rule]}}),/INVALID_FILTER/);
  assert.equal(filter.evaluatedAt,"2026-11-02T12:00:00.000Z");
});

test("date and engagement CLI filters select links in bulk without deleting raw observations",async()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-thresholds-"));
  try{
    const source=join(root,"data.json"),config=join(root,"project.json"),db=join(root,".source-scraper.sqlite");
    const input=Array.from({length:1200},(_,i)=>({id:String(i),type:"source-post",text:"Design system",
      url:"https://example.org/post/"+i,urls:["https://example.org/tool/"+i],
      occurredAt:i%3===0?"2026-10-15T12:00:00Z":"2026-09-01T12:00:00Z",
      attributes:i%2===0?{metrics:{likes:150}}:{}}));
    writeFileSync(source,JSON.stringify(input));
    const profile={version:1,entity:{types:["web-resource"],requiredFields:["url"]},observation:{includeTerms:["design system"],
      numericRanges:[{field:"attributes.metrics.likes",min:100}],dateRanges:[{field:"occurredAt",from:"2026-10-01T00:00:00Z",to:"2026-10-31T23:59:59Z"}]}};
    writeFileSync(config,JSON.stringify({id:"threshold-example",name:"Threshold example",sources:[{id:"alpha",adapter:"json-snapshot",config:{path:source}}],pipeline:["linked-resources"],outputs:[],filters:profile}));
    assert.equal((await runProject(db,parseProject(JSON.parse(readFileSync(config,"utf8"))),createDefaultRegistry(),{pageSize:500})).success,true);
    const result=spawnSync(process.execPath,[resolve("dist/source-scraper.mjs"),"query","--config",config,"--limit","500"],{encoding:"utf8",timeout:30000});
    assert.equal(result.status,0,result.stderr);const parsed=JSON.parse(result.stdout);
    assert.equal(parsed.count,200);assert.equal(parsed.filtering.examined,1200);assert.equal(parsed.filtering.completeScan,true);
    assert.ok(parsed.records.every((r:any)=>r.type==="web-resource"&&Number(r.url.split("/").pop())%6===0));
    const store=new KnowledgeStore(db);try{assert.equal(store.db.prepare("SELECT COUNT(*) count FROM kb_observations").get()?.count,1200);}finally{store.close();}
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("source filter lookup uses an entity/active/order index instead of scanning the whole project's mentions",()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-filter-index-"));
  const store=new KnowledgeStore(join(root,"store.sqlite"));
  try{
    let plan:Record<string,unknown>[]=[];
    const receiver={prepareCached(sql:string){return {iterate(...args:unknown[]){
      plan=store.db.prepare("EXPLAIN QUERY PLAN "+sql).all(...args as never[]) as Record<string,unknown>[];return [];
    }};}};
    KnowledgeStore.prototype.filterObservations.call(receiver as unknown as KnowledgeStore,"test-project","https://example.org/tool").next();
    const details=plan.map(row=>String(row.detail)).join("\n");
    assert.match(details,/kb_filter_mentions.*project_id=\? AND entity_key=\? AND active=\?/);
    assert.doesNotMatch(details,/SCAN m|TEMP B-TREE/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test("saved, runtime and candidate screening intersect at one clock and one supporting observation",()=>{
 const at=Date.parse("2026-11-07T00:00:00Z"),saved={version:1,observation:{includeTerms:["UI"]}},runtime={version:1,entity:{includeTerms:["design"]}},screen={version:1,observation:{includeTerms:["free"]}};
 const filter=compileCollectionFilters(sources,saved,runtime,at,screen);
 assert.equal(filter.evaluatedAt,"2026-11-07T00:00:00.000Z");
 assert.equal(filter.match({title:"Design resource"},()=>[{sourceId:"alpha",observation:{text:"UI resource"}},{sourceId:"alpha",observation:{text:"Free resource"}}]).matched,false);
 assert.equal(filter.match({title:"Design resource"},()=>[{sourceId:"alpha",observation:{text:"Free UI resource"}}]).matched,true);
 assert.equal(filter.match({title:"Unrelated"},()=>[{sourceId:"alpha",observation:{text:"Free UI resource"}}]).matched,false);
});
