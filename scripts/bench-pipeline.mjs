/** Reproducible isolated pipeline benchmark. Never reads the personal vault/session. */
import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,statSync} from 'node:fs';
import {tmpdir,cpus} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runProject,reprocessProject} from '../packages/core/engine.ts';
import {createDefaultRegistry} from '../packages/core/extensions.ts';
import {parseProject} from '../packages/core/project-config.ts';
import {KnowledgeStore} from '../packages/storage/knowledge.ts';
const count=Number(process.argv[2]||20000),binary=resolve(process.argv[3]||'dist/source-scraper.mjs');
if(!Number.isSafeInteger(count)||count<1000||count>100000)throw Error('Use 1000–100000 records');
const root=mkdtempSync(join(tmpdir(),'ss-pipeline-')),db=join(root,'.source-scraper.sqlite'),config=join(root,'project.json');
const result={count,node:process.version,cpu:cpus()[0]?.model,platform:process.platform,cli:binary,phases:{},networkRequests:0};
let changed=false;
const registry=createDefaultRegistry();
registry.sources.set('synthetic-page',{id:'synthetic-page',async collect({cursor,limit}){
 const start=Number(cursor||0),end=Math.min(count,start+limit);
 return {observations:Array.from({length:end-start},(_,n)=>{const i=n+start;return {id:String(i),type:'source-post',title:'Post '+i,text:i%2?'Other topic':'Design system components',url:'https://example.org/post/'+i,urls:['https://tools.example.org/resource/'+String(i).padStart(6,'0')],occurredAt:'2026-11-01T12:00:00Z',attributes:{likes:i%1000,version:changed&&i===0?2:1}};}),hasMore:end<count,...(end<count?{nextCursor:String(end)}:{})};
}});
const project=parseProject({id:'pipeline-benchmark',name:'Isolated pipeline benchmark',sources:[{id:'local',adapter:'synthetic-page',config:{}}],pipeline:['linked-resources'],outputs:[]});
writeFileSync(config,JSON.stringify(project));
function time(name,fn,repeats=3){const samples=[];let value;for(let i=0;i<repeats;i++){const start=performance.now();value=fn(i);samples.push(Number((performance.now()-start).toFixed(2)));}result.phases[name]={samplesMs:samples,medianMs:samples.toSorted((a,b)=>a-b)[Math.floor(samples.length/2)]};return value;}
async function asyncTime(name,fn){const start=performance.now();const value=await fn();result.phases[name]={ms:Number((performance.now()-start).toFixed(2))};return value;}
function cli(args){const r=spawnSync(process.execPath,[binary,...args],{encoding:'utf8',timeout:120000,maxBuffer:8_000_000});if(r.status!==0)throw Error('CLI failed '+r.stderr+' '+r.error);return JSON.parse(r.stdout);}
function counts(store){return Object.fromEntries(['kb_observations','kb_entities','kb_observation_versions','kb_entity_versions','kb_mentions'].map(t=>[t,Number(store.db.prepare('SELECT COUNT(*) n FROM '+t).get().n)]));}
try{
 for(const name of ['initial','unchanged']){
  const r=await asyncTime(name,()=>runProject(db,project,registry,{pageSize:500,maxPages:1000}));
  if(!r.success||r.observations!==count||r.newEntities!==(name==='initial'?count:0))throw Error('Wrong ingestion count');
  result.phases[name].observations=r.observations;
 }
 changed=true;const edited=await asyncTime('oneChangedObservation',()=>runProject(db,project,registry,{pageSize:500,maxPages:1000}));
 if(!edited.success||edited.newEntities!==0)throw Error('Changed replay created entities');
 let store=time('open',()=>new KnowledgeStore(db),1);
 try{
  const c=counts(store);if(c.kb_entities!==count||c.kb_observation_versions!==count+1||c.kb_entity_versions!==count)throw Error('Replay history changed incorrectly');result.retainedCounts=c;
  for(const offset of [0,count-100])time('queryOffset'+offset,()=>{const rows=store.listEntities(project.id,{limit:100,offset});if(rows.length!==100)throw Error('Page lost records');return rows;});
  time('inspect100',()=>{for(let i=0;i<100;i++)if(!store.entityEvidence(project.id,'https://tools.example.org/resource/'+String(i).padStart(6,'0')))throw Error('Lost evidence');});
 }finally{store.close();}
 const replay=await asyncTime('offlineReprocess',()=>reprocessProject(db,project,registry));if(replay.entities!==count||replay.reassessed!==count)throw Error('Incomplete reassessment');
 time('cliVersion',()=>cli(['version']));
 for(const [name,format,compact,filtered] of [['exportJson','json',true,false],['exportNdjson','ndjson',true,false],['exportEvidence','json',false,false],['exportFiltered','json',true,true]]){
  const samples=[];let bytes=0;
  for(let i=0;i<3;i++){
   const path=join(root,name+i+'.'+format),args=['export','--config',config,'--format',format,'--out',path,'--limit',String(count),'--compact',String(compact)];
   if(filtered)args.push('--filters-json',JSON.stringify({version:1,observation:{includeTerms:['design system']}}));
   const start=performance.now(),summary=cli(args);samples.push(Number((performance.now()-start).toFixed(2)));
   const expected=filtered?Math.ceil(count/2):count;if(summary.count!==expected)throw Error('Wrong export count');
   const raw=readFileSync(path,'utf8'),rows=format==='json'?JSON.parse(raw).records:raw.trim().split('\n').map(l=>JSON.parse(l).record);
   if(rows.length!==expected||new Set(rows.map(r=>r.key)).size!==expected||rows.some(r=>!r.url)||!compact&&rows.some(r=>r.provenance.mentions.length!==1))throw Error('Wrong exported identities/evidence');
   bytes=statSync(path).size;rmSync(path);
  }
  result.phases[name]={samplesMs:samples,medianMs:samples.toSorted((a,b)=>a-b)[1],bytes};
 }
 result.rssMiB=Math.round(process.memoryUsage().rss/1048576);result.processPeakRssMiB=Math.round(process.resourceUsage().maxRSS/1024);result.dbMiB=Math.round(statSync(db).size/1048576);
 console.log(JSON.stringify(result));
}finally{rmSync(root,{recursive:true,force:true});}
