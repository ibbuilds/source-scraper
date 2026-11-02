import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync,writeFileSync,statSync,createReadStream} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {runProject} from '../packages/core/engine.ts';
import {parseProject} from '../packages/core/project-config.ts';
import {createDefaultRegistry} from '../packages/core/extensions.ts';
import {KnowledgeStore} from '../packages/storage/knowledge.ts';
const count=Number(process.argv[2]||100000),binary=resolve(process.argv[3]||'dist/source-scraper.mjs');
if(!Number.isSafeInteger(count)||count<1000||count>100000)throw Error('Use 1000–100000 links');
const posts=Math.ceil(count/10),root=mkdtempSync(join(tmpdir(),'ss-export-scale-')),db=join(root,'.source-scraper.sqlite'),config=join(root,'project.json'),registry=createDefaultRegistry();
registry.sources.set('paged-fixture',{id:'paged-fixture',async collect({cursor,limit}){
 const start=Number(cursor||0),end=Math.min(posts,start+limit);
 return {hasMore:end<posts,...(end<posts?{nextCursor:String(end)}:{}),observations:Array.from({length:end-start},(_,n)=>{const i=start+n;return {
  id:String(i),type:'source-post',title:'Published resources '+i,text:'Design system resources',url:'https://example.org/post/'+i,occurredAt:'2026-11-01T12:00:00Z',
  urls:Array.from({length:Math.min(10,count-i*10)},(_,k)=>'https://tools.example.org/resource/'+String(i*10+k).padStart(6,'0')),attributes:{likes:i%1000}};})};
}});
const project=parseProject({id:'export-scale',name:'Isolated export scale',sources:[{id:'local',adapter:'paged-fixture',config:{}}],pipeline:['linked-resources'],outputs:[]});
writeFileSync(config,JSON.stringify(project));
try{
 const start=performance.now(),r=await runProject(db,project,registry,{pageSize:500,maxPages:1000}),ingestionMs=performance.now()-start;
 if(!r.success||r.newEntities!==count||r.observations!==posts)throw Error('Lost links at ingestion');
 const ingestionRssMiB=Math.round(process.memoryUsage().rss/1048576),samples=[];
 for(const compact of (process.argv.includes("--only-evidence")?[false]:[true,false])){
  for(let n=0;n<3;n++){
   const out=join(root,'out-'+compact+'-'+n+'.ndjson'),started=performance.now();
   const child=spawnSync(process.execPath,[resolve('scripts/measure-cli.mjs'),binary,'export','--config',config,'--format','ndjson','--compact',String(compact),'--limit',String(count),'--out',out],{encoding:'utf8',timeout:120000,maxBuffer:1000000});
   const ms=performance.now()-started;if(child.status!==0)throw Error(child.stderr+' '+child.error);
   const summary=JSON.parse(child.stdout);if(summary.count!==count)throw Error('Export incomplete');
   const metrics=child.stderr.trim().split('\n').map(l=>{try{return JSON.parse(l);}catch{return null;}}).find(r=>r?.benchmarkCliPeakRssMiB);
   if(!metrics)throw Error('Missing child memory measurement');
   let lines=0;const keys=new Set();
   for await(const line of createInterface({input:createReadStream(out),crlfDelay:Infinity})){
    const row=JSON.parse(line).record;const key='https://tools.example.org/resource/'+String(lines).padStart(6,'0');
    if(row.key!==key||row.url!==key||!compact&&row.provenance.mentions.length!==1)throw Error('Wrong order, identity or provenance');
    keys.add(row.key);lines++;
   }
   if(lines!==count||keys.size!==count)throw Error('Duplicates or missing records');
   samples.push({compact,ms:Number(ms.toFixed(2)),bytes:statSync(out).size,...metrics});rmSync(out);
  }
 }
 const store=new KnowledgeStore(db);let retained;try{retained=Object.fromEntries(['kb_entities','kb_observations','kb_mentions'].map(t=>[t,Number(store.db.prepare('SELECT COUNT(*) n FROM '+t).get().n)]));}finally{store.close();}
 console.log(JSON.stringify({node:process.version,platform:process.platform,cpu:cpus()[0]?.model,posts,links:count,linksPerPost:10,ingestionMs:Number(ingestionMs.toFixed(2)),ingestionRssMiB,samples,retained,dbMiB:Math.round(statSync(db).size/1048576),networkRequests:0}));
}finally{rmSync(root,{recursive:true,force:true});}
