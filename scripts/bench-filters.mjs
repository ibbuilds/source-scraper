/** Offline end-to-end paged ingestion + complete streaming filter scans. */
import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join} from 'node:path';
import {runProject} from '../packages/core/engine.ts';
import {createDefaultRegistry} from '../packages/core/extensions.ts';
import {parseProject} from '../packages/core/project-config.ts';
import {KnowledgeStore} from '../packages/storage/knowledge.ts';
import {compileCollectionFilters} from '../packages/sdk/collection-filters.ts';
import {createFilteredQuery} from '../packages/core/query-filters.ts';
const count=Number(process.argv[2]||100000);
if(!Number.isInteger(count)||count<1000||count>500000)throw Error('Use 1000–500000 synthetic records');
const root=mkdtempSync(join(tmpdir(),'ss-scale-')),db=join(root,'scale.sqlite');
const at=Date.parse('2026-11-02T12:00:00Z'),registry=createDefaultRegistry();
registry.sources.set('synthetic-batch',{id:'synthetic-batch',async collect({cursor,limit}){
 const start=Number(cursor||0),end=Math.min(start+limit,count);
 return {observations:Array.from({length:end-start},(_,n)=>{const i=start+n;return {
  id:String(i),type:'source-post',text:i%2?'Other topic':'Design system components',
  url:'https://example.org/post/'+i,urls:['https://tools.example.org/tool/'+i],
  occurredAt:new Date(at-(i%90)*86400000).toISOString(),attributes:{metrics:{likes:i%1000,reposts:i%100}}};}),
  hasMore:end<count,...(end<count?{nextCursor:String(end)}:{})};
}});
const project=parseProject({id:'scale-filter',name:'Synthetic scale',sources:[{id:'bulk-feed',adapter:'synthetic-batch',config:{}}],pipeline:['linked-resources'],outputs:[]});
try{
 const start=performance.now(),collected=await runProject(db,project,registry,{pageSize:500,maxPages:1000});
 const ingestionMs=performance.now()-start;
 if(!collected.success||collected.observations!==count||collected.newEntities!==count)throw Error('Incomplete batch ingestion');
 const store=new KnowledgeStore(db),queries=[];
 try{
  const profiles=[['links',{version:1,entity:{types:['web-resource'],requiredFields:['url']}}],
   ['topic',{version:1,entity:{types:['web-resource'],requiredFields:['url']},observation:{includeTerms:['design system']}}]];
  if(process.argv.includes('--thresholds'))profiles.push(['topic-date-engagement',{version:1,entity:{types:['web-resource'],requiredFields:['url']},observation:{includeTerms:['design system'],numericRanges:[{field:'attributes.metrics.likes',min:100},{field:'attributes.metrics.reposts',min:10}],dateRanges:[{field:'occurredAt',maxAgeDays:30}]}}]);
  for(const [name,profile] of profiles){
   const times=[];let expected=0;
   for(let i=0;i<count;i++)if(name==='links'||i%2===0&&(name==='topic'||i%1000>=100&&i%100>=10&&i%90<=30))expected++;
   for(let n=0;n<3;n++){
    const filter=compileCollectionFilters(['bulk-feed'],profile,undefined,at),start=performance.now();
    const query=createFilteredQuery(store,project.id,filter,{limit:count+1,offset:0});let returned=0;
    for(const row of query.records){if(!row.url)throw Error('Non-link passed');returned++;}
    times.push(Math.round((performance.now()-start)*100)/100);
    if(returned!==expected||query.report.examined!==count||!query.report.completeScan)throw Error('Wrong filter results');
   }
   queries.push({name,expected,samplesMs:times,medianMs:times.toSorted((a,b)=>a-b)[1]});
  }
 }finally{store.close();}
 console.log(JSON.stringify({count,node:process.version,platform:process.platform,cpu:cpus()[0]?.model,batchSize:500,ingestionMs:Math.round(ingestionMs),observations:collected.observations,entities:collected.newEntities,queries,rssMiB:Math.round(process.memoryUsage().rss/1048576),dbMiB:Math.round(statSync(db).size/1048576),networkRequests:0}));
}finally{rmSync(root,{recursive:true,force:true});}
