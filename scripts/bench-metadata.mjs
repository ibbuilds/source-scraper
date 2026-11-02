/** Fixed 60ms response latency, real metadata pipeline/parser, no DNS/network. */
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runProject} from '../packages/core/engine.ts';
import {createDefaultRegistry} from '../packages/core/extensions.ts';
import {parseProject} from '../packages/core/project-config.ts';
import {KnowledgeStore} from '../packages/storage/knowledge.ts';
const root=mkdtempSync(join(tmpdir(),'ss-metadata-bench-')),original=https.request,rows=[];
let calls=0,active=0,peak=0;
https.request=(url,options,callback)=>{
 const req=new EventEmitter();let timer;
 req.end=()=>{calls++;active++;peak=Math.max(peak,active);timer=setTimeout(()=>{
  const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'text/html'};callback(response);
  response.end('<title>Public resource '+url.pathname+'</title><meta name="description" content="Synthetic public metadata">');active--;
 },60);};
 req.destroy=error=>{clearTimeout(timer);active--;if(error)req.emit('error',error);};return req;
};syncBuiltinESMExports();
try{
 for(let n=0;n<3;n++){
  calls=0;active=0;peak=0;const registry=createDefaultRegistry();
  registry.sources.set('metadata-fixture',{id:'metadata-fixture',async collect(){return {hasMore:false,observations:[{id:'one',type:'source-post',url:'https://example.org/post',urls:Array.from({length:20},(_,i)=>'https://93.184.216.34/tool/'+i)}]};}});
  const project=parseProject({id:'metadata-performance',name:'Synthetic metadata',sources:[{id:'local',adapter:'metadata-fixture',config:{}}],pipeline:['linked-resources','public-metadata'],outputs:[]}),db=join(root,n+'.sqlite');
  const start=performance.now(),r=await runProject(db,project,registry);const elapsed=performance.now()-start;
  if(!r.success||r.newEntities!==20||calls!==20||active!==0)throw Error('Metadata budget or work changed');
  const store=new KnowledgeStore(db);try{const entities=store.listEntities(project.id,{limit:100});if(entities.length!==20||entities.some(e=>!e.title.startsWith('Public resource')||e.attributes.description!=='Synthetic public metadata'))throw Error('Metadata missing');}finally{store.close();}
  rows.push({ms:Number(elapsed.toFixed(2)),requests:calls,peakInFlight:peak,entities:20});
 }
 console.log(JSON.stringify({node:process.version,simulatedResponseLatencyMs:60,actualNetworkRequests:0,samples:rows,medianMs:rows.map(r=>r.ms).toSorted((a,b)=>a-b)[1]}));
}finally{https.request=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
