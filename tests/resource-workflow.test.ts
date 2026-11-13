import {test} from "node:test";import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";import {join} from "node:path";import {tmpdir} from "node:os";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";import {queryResources,reviewResources,inspectResources} from "../packages/core/resource-workflow.ts";
const project={id:"resources",name:"Resources",sources:[],pipeline:[],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]};
function fixture(work:(s:KnowledgeStore,add:(key:string,url?:string)=>void)=>void){const root=mkdtempSync(join(tmpdir(),"ss-resources-")),s=new KnowledgeStore(join(root,"data.sqlite"));try{s.saveProject(project);const insert=s.db.prepare("INSERT INTO kb_entities VALUES(?,?,?,?,?,?,?,?)");const add=(key:string,url="https://example.org/"+key)=>insert.run(project.id,key,"web-resource","Design resource "+key,url,JSON.stringify({description:"Reusable UI resource",access:"open_source"}),"2026-01-01","2026-01-01");work(s,(k,u)=>{add(k,u);});}finally{s.close();rmSync(root,{recursive:true,force:true});}}
const query=(s:KnowledgeStore,input:any={})=>queryResources(s,project.id,input,()=>s.iterateEntities(project.id));
test("10,000-resource inbox returns one compact page and pages the same stable selection without rescanning",()=>fixture((s,add)=>{
 s.db.exec("BEGIN");for(let i=0;i<10000;i++)add(String(i).padStart(5,"0"));s.db.exec("COMMIT");const p=query(s,{review:"pending",limit:40});assert.equal(p.total,10000);assert.equal(p.records.length,40);add("new");
 const next=queryResources(s,project.id,{selectionId:p.selectionId,limit:40,offset:40},()=>{throw Error("Paging must not rescan candidates");});assert.equal(next.total,10000);assert.equal(next.records.length,40);assert.notEqual(next.records[0].key,p.records[0].key);assert.equal(query(s).total,10001);
}));
test("canonical aliases and user rejections precede pagination, and can be explicitly restored",()=>fixture((s,add)=>{
 add("one","http://example.org/tool?utm_source=x");add("two","https://example.org/tool");add("three","https://short.example/tool");add("other");
 const context={aliases:{"https://short.example/tool":"https://example.org/tool"},rejected:["https://example.org/tool"]};assert.equal(query(s,{context}).total,1);assert.equal(query(s,{context,review:"rejected"}).total,1);assert.equal(query(s,{context:{...context,rejected:[]}}).total,2);
}));
test("current AI discards leave ordinary results but preserve an explicit human Keep",()=>fixture((s,add)=>{
 add("a");add("b");const context={assessments:{"https://example.org/a":{decision:"discarded",at:"2099-01-01",utility:"Not relevant to this profile"}}};
 assert.equal(query(s,{context}).total,1);assert.equal(query(s,{context,evaluation:"discarded"}).total,1);
 s.reviewEntity(project.id,"a","approved","An explicit user choice");assert.equal(query(s,{context}).total,2);
 assert.equal(s.getEntity(project.id,"a")!.review,"approved");
}));

test("one transaction records a whole selection; replay never duplicates history",()=>fixture((s,add)=>{
 for(let i=0;i<500;i++)add("r"+i);const p=query(s),request={selectionId:p.selectionId,decision:"approved",requestId:"fixture-review-001"};const receipt=reviewResources(s,project.id,request);assert.equal(receipt.saved,500);assert.equal(receipt.failed,0);const before=Number((s.db.prepare("SELECT count(*) n FROM kb_reviews").get() as any).n);assert.equal(reviewResources(s,project.id,request).replayed,true);assert.equal(Number((s.db.prepare("SELECT count(*) n FROM kb_reviews").get() as any).n),before);assert.throws(()=>reviewResources(s,project.id,{...request,decision:"rejected"}),/CONFLICT/);
}));
test("stale resources are reported rather than silently overwritten, and new matches stay outside the submitted selection",()=>fixture((s,add)=>{
 add("a");add("b");const p=query(s);add("c");s.db.prepare("UPDATE kb_entities SET updated_at='newer' WHERE entity_key='a'").run();const result=reviewResources(s,project.id,{selectionId:p.selectionId,decision:"rejected",requestId:"fixture-stale-001"});assert.equal(result.saved,1);assert.equal(result.failed,1);assert.equal(s.getEntity(project.id,"a")!.review,"pending");assert.equal(s.getEntity(project.id,"c")!.review,"pending");
}));
test("invalid mixed decisions fail before any write; a changed human context invalidates an old selection",()=>fixture((s,add)=>{
 add("a");add("b");assert.throws(()=>reviewResources(s,project.id,{requestId:"invalid-mixed-01",changes:[{key:"a",decision:"approved"},{key:"b",decision:"bad"}]}),/INVALID/);assert.equal(s.getEntity(project.id,"a")!.review,"pending");const p=query(s);assert.throws(()=>reviewResources(s,project.id,{requestId:"changed-context-01",selectionId:p.selectionId,decision:"approved",context:{rejected:["https://example.org/a"]}}),/CHANGED/);
}));
test("evidence batches preserve distinct fingerprints and report missing resources",()=>fixture((s,add)=>{add("a");add("b");const p=inspectResources(s,project.id,["a","b","missing"],()=>false);assert.equal(p.records.length,3);assert.ok("fingerprint" in p.records[0]);assert.equal((p.records[0] as any).profileMatched,false);assert.equal((p.records[2] as any).error,"NOT_FOUND");assert.throws(()=>inspectResources(s,project.id,["a","a"]));}));

test("explicit checked resources also carry a revision guard",()=>fixture((s,add)=>{add("a");const p=query(s);s.reviewEntity(project.id,"a","rejected","A newer explicit decision");const r=reviewResources(s,project.id,{requestId:"stale-checkbox-01",changes:[{key:"a",decision:"approved",revision:p.records[0].revision}]});assert.equal(r.saved,0);assert.equal(r.failed,1);assert.equal(s.getEntity(project.id,"a")!.review,"rejected");}));

test("quality filters precede pagination, preserve raw inventory, and never infer quality from Keep or AI recommendations",()=>fixture((s,add)=>{
 for(let i=0;i<120;i++)add("q"+i);
 s.reviewEntity(project.id,"q0","approved","Keep is separate from qualification");
 const qualifications=Object.fromEntries([41,81].map(i=>["https://example.org/q"+i,{state:"qualified",category:"research",entityUpdatedAt:"2026-01-01",at:"2026-01-02",reason:"Evidence reviewed"}]));
 const context={qualifications};const p=query(s,{context,quality:"qualified",limit:1});
 assert.equal(p.total,2);assert.equal(p.records.length,1);assert.equal(p.records[0].resourceQuality?.state,"qualified");
 assert.equal(query(s,{context,quality:"pending"}).total,118);assert.equal(query(s,{context,quality:"all"}).total,120);
 const next=queryResources(s,project.id,{context,quality:"qualified",selectionId:p.selectionId,offset:1,limit:1},()=>{throw Error("Must not rescan");});assert.equal(next.records.length,1);
 s.db.prepare("UPDATE kb_entities SET updated_at='2026-01-03' WHERE entity_key='q41'").run();
 assert.equal(query(s,{context,quality:"qualified"}).total,1);
 assert.throws(()=>query(s,{context,quality:"invalid"}),/INVALID_RESOURCE_QUALITY/);
 assert.throws(()=>query(s,{context:{qualifications:{"https://example.org/x":{state:"invalid"}}}}),/INVALID_RESOURCE_QUALITY/);
}));

test("failed qualifications are automatically discarded from every ordinary view, including All and Kept",()=>fixture((s,add)=>{
 for(let i=0;i<100;i++)add("admission-"+i);s.reviewEntity(project.id,"admission-0","approved","Keep does not override admission");
 const qualifications=Object.fromEntries(Array.from({length:25},(_,i)=>["https://example.org/admission-"+i,{state:"excluded",category:"tools",entityUpdatedAt:"2026-01-01",at:"2026-01-02",reason:"Paid core fails free-access rule"}]));
 const context={qualifications};assert.equal(query(s,{context,quality:"all"}).total,75);assert.equal(query(s,{context}).total,75);assert.equal(query(s,{context,quality:"all",review:"approved"}).total,0);
 assert.equal(query(s,{context,quality:"excluded"}).total,25);
 assert.equal([...s.iterateEntities(project.id)].length,100);assert.equal(s.getEntity(project.id,"admission-0")!.review,"approved");assert.equal(s.getEntity(project.id,"admission-1")!.review,"pending");
}));
