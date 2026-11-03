import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {KnowledgeStore} from "../packages/storage/knowledge.ts";
import {runProject} from "../packages/core/engine.ts";
import {exportProject} from "../packages/core/export-project.ts";
import {createDefaultRegistry} from "../packages/core/extensions.ts";
import {parseProject} from "../packages/core/project-config.ts";

test("paged hydration preserves ranking, filters, latest decisions and all evidence counts",async()=>{
 const root=mkdtempSync(join(tmpdir(),"ss-hydration-")),db=join(root,"db.sqlite"),registry=createDefaultRegistry();
 const count=1005;
 registry.sources.set("fixture",{id:"fixture",async collect({cursor,limit}){
  const start=Number(cursor||0),end=Math.min(count,start+limit);
  return {observations:Array.from({length:end-start},(_,i)=>({id:String(start+i),type:(start+i)%2?"odd":"even",title:"Item "+(start+i)})),hasMore:end<count,...(end<count?{nextCursor:String(end)}:{})};
 }});
 const project=parseProject({id:"pages",name:"Pages",sources:[{id:"local",adapter:"fixture",config:{}}],pipeline:["observation-entity"],outputs:[{id:"capture",adapter:"capture",config:{}}]});
 try{
  for(const id of ["pages","other"]){const result=await runProject(db,{...project,id},registry,{pageSize:500,maxPages:10});assert.equal(result.success,true);}
  const store=new KnowledgeStore(db);let expected;
  try{
   const rows=Array.from(store.iterateEntities(project.id));
   for(let i=0;i<rows.length;i++)store.db.prepare("UPDATE kb_assessments SET score=? WHERE project_id=? AND entity_key=?").run(i%7*10,project.id,rows[i].key);
   store.db.prepare("DELETE FROM kb_assessments WHERE project_id=? AND entity_key=?").run(project.id,rows[0].key);
   store.reviewEntity(project.id,rows[1].key,"approved","First decision");store.reviewEntity(project.id,rows[1].key,"rejected","Latest decision");
   for(const opts of [{},{type:"even"},{q:"Item 1"},{minScore:30},{type:"odd",q:"Item",minScore:20},{q:"%"},{minScore:99}]){
    const all=Array.from(store.iterateEntities(project.id,opts));
    for(const offset of [0,97,500,1000,1100])assert.deepEqual(store.listEntities(project.id,{...opts,limit:100,offset}),all.slice(offset,offset+100));
   }
   expected=Array.from(store.iterateEntities(project.id)).filter(row=>row.review!=="rejected"&&row.score>=project.policy.minimumScore);
  }finally{store.close();}
  let calls=0;registry.outputs.set("capture",{id:"capture",offline:true,async export({records}){calls++;assert.deepEqual(records,expected);return {count:records.length};}});
  await exportProject(db,project,registry);assert.equal(calls,1);assert.ok(expected.length>500);
 }finally{rmSync(root,{recursive:true,force:true});}
});
