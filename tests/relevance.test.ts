import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {runProject} from "../packages/core/engine.ts";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {queryRelevance,recordRelevance,resourceRelevanceContext} from "../packages/core/relevance.ts";
import {queryResources} from "../packages/core/resource-workflow.ts";
import type {ProjectDefinition} from "../packages/sdk/contracts.ts";

const profile={version:1,description:"Interface design resources",includeTerms:["UI"],excludeTerms:["politics"],minimumLikes:10};
async function fixture(work:(store:KnowledgeStore,project:ProjectDefinition)=>void){
 const root=mkdtempSync(join(tmpdir(),"ss-topic-")),input=join(root,"input.json");let store:KnowledgeStore|undefined;
 try{writeFileSync(input,JSON.stringify([
  {id:"100",type:"x-post",url:"https://x.com/designer/status/100",text:"UI composition and typography study",media:["https://pbs.twimg.com/media/example.jpg"],attributes:{metrics:{likes:100}}},
  {id:"200",type:"x-post",url:"https://x.com/designer/status/200",text:"A practical UI toolkit with examples",urls:["https://example.org/toolkit"]},
  {id:"300",type:"x-post",url:"https://x.com/news/status/300",text:"politics and unrelated news",attributes:{metrics:{likes:10000}}}
 ]));const project:ProjectDefinition={id:"topic-fixture",name:"Topic fixture",sources:[{id:"feed",adapter:"json-snapshot",config:{path:input}}],pipeline:["x-discovery"],evaluator:"keyword",policy:{includeKeywords:[],excludeKeywords:[],minimumScore:0},outputs:[]};
  const db=join(root,"state.sqlite");await runProject(db,project,createDefaultRegistry());store=new KnowledgeStore(db);work(store,project);
 }finally{store?.close();rmSync(root,{recursive:true,force:true});}
}
const review=(packet:any,detail:any,state="pertinent")=>({fingerprint:detail.fingerprint,profileHash:packet.profileHash,state,reason:"The complete observed post concerns interface design and its concrete use.",wholePostReviewed:true,uncertainties:[],evidence:[{kind:"text",quote:detail.observation?.text??detail.entity.attributes.discoveryText},...(detail.media??[]).map((url:string)=>({kind:"visual",url,note:"Reviewed the supplied composition, interface layout and type hierarchy."}))]});

test("all posts remain reviewable while only direct external links become resources",async()=>fixture((store,project)=>{
 const packet=queryRelevance(store,project,{profile,target:"observations"});assert.equal(packet.records.length,3);assert.equal(packet.records[0].decision.state,"uncertain");assert.equal(packet.records[2].decision.state,"irrelevant");assert.equal(store.listEntities(project.id).length,1);
}));
test("positive topic decisions require observed text, every supplied visual and the current fingerprint",async()=>fixture((store,project)=>{
 const packet=queryRelevance(store,project,{profile,target:"observations"}),detail=packet.records[0],good=review(packet,detail);
 const save=(value:any)=>recordRelevance(store,project,{profile,target:"observations",requestId:"topic-proof-001",items:[{key:detail.key,review:value}]});
 assert.throws(()=>save({...good,evidence:good.evidence.slice(0,1)}),/VISUAL/);
 assert.throws(()=>save({...good,fingerprint:"0".repeat(64)}),/STALE/);
 assert.throws(()=>save({...good,evidence:[{kind:"text",quote:"This was never in the post"}]}),/NOT_OBSERVED/);
 const saved=save(good);assert.equal(saved.saved,1);assert.equal(save(good).replayed,true);assert.equal(queryRelevance(store,project,{profile,target:"observations"}).records[0].decision.id,saved.records[0].id);
}));
test("AI cannot replace an explicit current human topic decision",async()=>fixture((store,project)=>{
 const packet=queryRelevance(store,project,{profile,target:"observations"}),detail=packet.records[1];recordRelevance(store,project,{profile,target:"observations",origin:"user-interface",requestId:"human-topic-001",items:[{key:detail.key,review:review(packet,detail,"irrelevant")}]});
 assert.throws(()=>recordRelevance(store,project,{profile,target:"observations",origin:"agent-mcp",requestId:"agent-topic-001",items:[{key:detail.key,review:review(packet,detail)}]}),/USER_DECISION/);
}));
test("topic review cursors do not skip undecided posts when the first page is reviewed",async()=>fixture((store,project)=>{
 const first=queryRelevance(store,project,{profile,state:"uncertain",limit:1});const detail=first.records[0];recordRelevance(store,project,{profile,requestId:"cursor-topic-01",items:[{key:detail.key,review:review(first,detail)}]});
 const next=queryRelevance(store,project,{profile,state:"uncertain",limit:1,cursor:first.nextCursor});assert.equal(next.records[0].observation!.id,"200");
 assert.throws(()=>queryRelevance(store,project,{profile:{...profile,description:"Changed topic"},cursor:first.nextCursor,state:"uncertain",limit:1}),/CURSOR_CHANGED/);
}));
test("resource irrelevance is separate from quality and an explicit human Keep remains authoritative",async()=>fixture((store,project)=>{
 const packet=queryRelevance(store,project,{profile,target:"resources"}),detail=packet.records[0];recordRelevance(store,project,{profile,target:"resources",requestId:"resource-topic-01",items:[{key:detail.key,review:review(packet,detail,"irrelevant")}]});
 const context=resourceRelevanceContext(store,project,profile),query=()=>queryResources(store,project.id,{context},()=>store.iterateEntities(project.id));assert.equal(query().total,0);
 store.reviewEntity(project.id,detail.key,"approved","I explicitly want to retain this resource");assert.equal(query().total,1);
}));
