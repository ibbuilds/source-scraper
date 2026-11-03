import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {runProject} from '../packages/core/engine.ts';
import {exportProject} from '../packages/core/export-project.ts';
import {KnowledgeStore} from '../packages/storage/knowledge.ts';
import {createDefaultRegistry} from '../packages/core/extensions.ts';
import {parseProject} from '../packages/core/project-config.ts';
const count=Number(process.argv[2]||20000);
if(!Number.isSafeInteger(count)||count<1000||count>100000)throw Error('Use 1000-100000 records');
const root=mkdtempSync(join(tmpdir(),'ss-output-bench-')),db=join(root,'db.sqlite');
const registry=createDefaultRegistry();
registry.sources.set('synthetic',{id:'synthetic',async collect({cursor,limit}){const start=Number(cursor||0),end=Math.min(count,start+limit);return {observations:Array.from({length:end-start},(_,n)=>({id:String(start+n),type:'record',title:'Resource '+(start+n),attributes:{index:start+n}})),hasMore:end<count,...(end<count?{nextCursor:String(end)}:{})};}});
const project=parseProject({id:'output-benchmark',name:'Output benchmark',sources:[{id:'local',adapter:'synthetic',config:{}}],pipeline:['observation-entity'],outputs:[{id:'verify',adapter:'verify',config:{}}]});
const result={count,node:process.version,cpu:cpus()[0]?.model,phases:{}};
let expected;
registry.outputs.set('verify',{id:'verify',offline:true,async export({records}){if(records.length!==count||records.some((r,i)=>r.key!==expected[i].key||r.observationCount!==expected[i].observationCount||r.review!==expected[i].review))throw Error('Output lost identity, order or provenance');return {entities:records.length};}});
try{
 const run=await runProject(db,project,registry,{pageSize:500,maxPages:1000});if(!run.success||run.newEntities!==count)throw Error('Incomplete seed');
 const store=new KnowledgeStore(db);try{
  expected=Array.from(store.iterateEntities(project.id));
  for(const offset of [0,count-100]){const samples=[];for(let n=0;n<5;n++){const start=performance.now();const rows=store.listEntities(project.id,{limit:100,offset});samples.push(performance.now()-start);if(JSON.stringify(rows)!==JSON.stringify(expected.slice(offset,offset+100)))throw Error('Page changed');}result.phases['query'+offset]=samples;}
 }finally{store.close();}
 result.phases.output=[];for(let n=0;n<3;n++){const start=performance.now();await exportProject(db,project,registry);result.phases.output.push(performance.now()-start);}
 result.peakRssMiB=process.resourceUsage().maxRSS/1024;console.log(JSON.stringify(result));
}finally{rmSync(root,{recursive:true,force:true});}
