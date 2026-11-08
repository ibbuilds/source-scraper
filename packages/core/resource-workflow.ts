import {createHash,randomUUID} from "node:crypto";
import type {KnowledgeStore} from "../storage/knowledge.ts";
import type {KnowledgeEntity} from "../sdk/contracts.ts";
import {acquireLock} from "./lock.ts";
import {evidenceFingerprint} from "./agent-assessment.ts";
export type Decision="pending"|"approved"|"rejected";
export type QualitySummary={state:"qualified"|"pending"|"excluded";category:string;entityUpdatedAt:string;at:string;reason:string};
export type ResourceContext={qualityPolicyHash?:string;qualifications?:Record<string,QualitySummary>;aliases?:Record<string,string>;rejected?:string[];reviews?:Record<string,Decision>;assessments?:Record<string,{decision:"recommended"|"pending"|"discarded";at:string;utility:string}>};
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function resourceIdentity(raw:string){const u=new URL(raw);if(!["http:","https:"].includes(u.protocol)||u.username||u.password)throw Error("INVALID_RESOURCE_URL");u.protocol="https:";u.hash="";u.hostname=u.hostname.toLowerCase();for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k)||["fbclid","gclid","ref_src","ref_url"].includes(k.toLowerCase()))u.searchParams.delete(k);u.searchParams.sort();u.pathname=u.pathname.replace(/\/+$/,"")||"/";return u.toString();}
function identity(url:string,c:ResourceContext){let id=resourceIdentity(url);const seen=new Set<string>();while(c.aliases?.[id]){if(seen.has(id))throw Error("ALIAS_CYCLE");seen.add(id);id=resourceIdentity(c.aliases[id]);}return id;}
function tables(s:KnowledgeStore){s.db.exec("CREATE TABLE IF NOT EXISTS kb_resource_selections(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,created_at TEXT NOT NULL,context_hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS kb_resource_selection_rows(selection_id TEXT NOT NULL,position INTEGER NOT NULL,entity_key TEXT NOT NULL,updated_at TEXT NOT NULL,review TEXT NOT NULL,PRIMARY KEY(selection_id,position));CREATE TABLE IF NOT EXISTS kb_resource_review_receipts(project_id TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,request_id));");}
function context(raw:unknown):ResourceContext{const c=(raw??{}) as ResourceContext;if(!c||typeof c!=="object"||Array.isArray(c)||Object.keys(c).some(k=>!["aliases","rejected","reviews","assessments","qualifications","qualityPolicyHash"].includes(k)))throw Error("INVALID_RESOURCE_CONTEXT");if(c.qualityPolicyHash!==undefined&&!/^[a-f0-9]{64}$/.test(c.qualityPolicyHash))throw Error("INVALID_RESOURCE_CONTEXT");if(c.rejected&&(!Array.isArray(c.rejected)||c.rejected.some(x=>typeof x!=="string")))throw Error("INVALID_RESOURCE_CONTEXT");for(const map of [c.aliases,c.reviews,c.assessments,c.qualifications])if(map&&(typeof map!=="object"||Array.isArray(map)))throw Error("INVALID_RESOURCE_CONTEXT");for(const [k,v] of Object.entries(c.aliases??{})){resourceIdentity(k);resourceIdentity(v);}for(const [k,v] of Object.entries(c.reviews??{})){resourceIdentity(k);if(!["pending","approved","rejected"].includes(v))throw Error("INVALID_RESOURCE_REVIEW");}for(const [k,v] of Object.entries(c.assessments??{})){resourceIdentity(k);if(!v||!["recommended","pending","discarded"].includes(v.decision)||typeof v.at!=="string"||typeof v.utility!=="string")throw Error("INVALID_RESOURCE_CONTEXT");}for(const [k,v] of Object.entries(c.qualifications??{})){resourceIdentity(k);if(!v||!["qualified","pending","excluded"].includes(v.state)||typeof v.category!=="string"||typeof v.entityUpdatedAt!=="string"||typeof v.at!=="string"||typeof v.reason!=="string")throw Error("INVALID_RESOURCE_QUALITY");}return c;}
const validDecision=(v:unknown):v is Decision=>["pending","approved","rejected"].includes(String(v));
const effective=(e:KnowledgeEntity,c:ResourceContext)=>c.reviews?.[identity(e.url!,c)]??e.review;
function quality(e:KnowledgeEntity,c:ResourceContext){const saved=c.qualifications?.[identity(e.url!,c)];return saved&&saved.entityUpdatedAt===e.updatedAt?saved:{state:"pending" as const,category:saved?.category??"",reason:saved?"Resource changed; review again":"Not evaluated",stale:Boolean(saved)};}
function compact(e:KnowledgeEntity,c:ResourceContext){const a=e.attributes,attributes:Record<string,unknown>={};for(const k of ["description","access","license","discoveryPost","author","metrics","publishedAt"])if(a[k]!==undefined)attributes[k]=typeof a[k]==="string"?String(a[k]).slice(0,1500):a[k];const saved=c.assessments?.[identity(e.url!,c)],resourceAssessment=saved&&e.updatedAt>saved.at?{...saved,decision:"pending",stale:true}:saved;return {...e,attributes,review:effective(e,c),revision:hash([e.updatedAt,e.review]),resourceAssessment,...(c.qualifications?{resourceQuality:quality(e,c)}:{})};}
/** Query once, page the stable selection by indexed position; no full catalogue in the UI. */
export function queryResources(s:KnowledgeStore,projectId:string,input:any,candidates:()=>Iterable<KnowledgeEntity>){
 const c=context(input.context),limit=input.limit??40,offset=input.offset??0;
 if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0)throw Error("INVALID_RESOURCE_PAGE");
 if(input.review!==undefined&&input.review!=="all"&&!validDecision(input.review))throw Error("INVALID_RESOURCE_REVIEW");
 if(input.quality!==undefined&&!["all","qualified","pending","excluded"].includes(input.quality))throw Error("INVALID_RESOURCE_QUALITY");
 tables(s);let selectionId=input.selectionId;
 if(selectionId!==undefined&&typeof selectionId!=="string")throw Error("INVALID_SELECTION");
 if(!selectionId){
  selectionId=randomUUID();const release=acquireLock(s.file+".lock");
  try{s.db.exec("BEGIN IMMEDIATE");try{
   const expired=s.db.prepare("SELECT id FROM kb_resource_selections WHERE project_id=? ORDER BY created_at DESC LIMIT -1 OFFSET 15").all(projectId) as {id:string}[];
   for(const old of expired){s.db.prepare("DELETE FROM kb_resource_selection_rows WHERE selection_id=?").run(old.id);s.db.prepare("DELETE FROM kb_resource_selections WHERE id=?").run(old.id);}
   s.db.prepare("INSERT INTO kb_resource_selections VALUES(?,?,?,?)").run(selectionId,projectId,new Date().toISOString(),hash(c));
   const insert=s.db.prepare("INSERT INTO kb_resource_selection_rows VALUES(?,?,?,?,?)"),seen=new Set<string>(),rejected=new Set((c.rejected??[]).map(url=>identity(url,c)));let n=0;
   for(const e of candidates()){
    if(e.type!=="web-resource"||!e.url)continue;const id=identity(e.url,c),review=effective(e,c),isRejected=rejected.has(id)||review==="rejected";
    if(input.review==="rejected"?!isRejected:isRejected)continue;
    if(input.review&&input.review!=="all"&&input.review!=="rejected"&&review!==input.review)continue;
    if(input.quality&&input.quality!=="all"&&quality(e,c).state!==input.quality)continue;
    if(input.evaluation&&input.evaluation!=="all"){const saved=c.assessments?.[id],evaluation=saved&&e.updatedAt>saved.at?"pending":saved?.decision??"pending";if(evaluation!==input.evaluation)continue;}
    const q=String(input.search??"").toLowerCase().trim();if(q&&![e.title,e.url,String(e.attributes.description??"")].some(v=>v.toLowerCase().includes(q)))continue;
    if(seen.has(id))continue;seen.add(id);insert.run(selectionId,n++,e.key,e.updatedAt,e.review);
   }
   s.db.exec("COMMIT");
  }catch(e){s.db.exec("ROLLBACK");throw e;}}finally{release();}
 }
 const selection=s.db.prepare("SELECT * FROM kb_resource_selections WHERE id=? AND project_id=?").get(selectionId,projectId) as {context_hash:string}|undefined;
 if(!selection)throw Error("SELECTION_EXPIRED: refresh resources");if(selection.context_hash!==hash(c))throw Error("SELECTION_CHANGED: refresh resources");
 const total=Number((s.db.prepare("SELECT COUNT(*) total FROM kb_resource_selection_rows WHERE selection_id=?").get(selectionId) as {total:number}).total);
 const rows=s.db.prepare("SELECT entity_key FROM kb_resource_selection_rows WHERE selection_id=? ORDER BY position LIMIT ? OFFSET ?").all(selectionId,limit,offset) as {entity_key:string}[];
 const records=rows.flatMap(r=>{const e=s.getEntity(projectId,r.entity_key);if(e&&input.quality&&input.quality!=="all"&&quality(e,c).state!==input.quality)throw Error("SELECTION_CHANGED: quality evidence changed; refresh resources");return e?[compact(e,c)]:[];});
 return {schemaVersion:1,dataset:"entities",projectId,selectionId,total,offset,limit,records,hasMore:offset+rows.length<total};
}
export function inspectResources(s:KnowledgeStore,projectId:string,keys:unknown,matches:(entity:KnowledgeEntity)=>boolean=()=>true){
 if(!Array.isArray(keys)||!keys.length||keys.length>50||keys.some(k=>typeof k!=="string"||!k||k.length>4000)||new Set(keys).size!==keys.length)throw Error("Select 1â€“50 resource keys for evidence");
 return {projectId,records:keys.map(key=>{const data=s.entityEvidence(projectId,key);return data?{key,...data,fingerprint:evidenceFingerprint(data),profileMatched:matches(data.entity)}:{key,error:"NOT_FOUND"};})};
}
/** One lock and transaction for a whole decision, with durable replay receipts. */
export function reviewResources(s:KnowledgeStore,projectId:string,input:any){
 tables(s);if(typeof input.requestId!=="string"||!/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestId))throw Error("REQUEST_ID_REQUIRED");
 const signature=hash(input),release=acquireLock(s.file+".lock");
 try{s.db.exec("BEGIN IMMEDIATE");try{
  const prior=s.db.prepare("SELECT signature,result_json FROM kb_resource_review_receipts WHERE project_id=? AND request_id=?").get(projectId,input.requestId) as {signature:string;result_json:string}|undefined;
  if(prior){if(prior.signature!==signature)throw Error("REQUEST_CONFLICT");s.db.exec("COMMIT");return {...JSON.parse(prior.result_json),replayed:true};}
  let changes=input.changes as {key:string;decision:Decision;reason?:string;updatedAt?:string;review?:string;revision?:string}[];
  if(input.selectionId){
   if(changes!==undefined||!validDecision(input.decision))throw Error("INVALID_SELECTION_DECISION");
   const selection=s.db.prepare("SELECT context_hash FROM kb_resource_selections WHERE id=? AND project_id=?").get(input.selectionId,projectId) as {context_hash:string}|undefined;
   if(!selection)throw Error("SELECTION_EXPIRED");if(selection.context_hash!==hash(context(input.context)))throw Error("SELECTION_CHANGED");
   changes=(s.db.prepare("SELECT entity_key,updated_at,review FROM kb_resource_selection_rows WHERE selection_id=? ORDER BY position LIMIT 5001").all(input.selectionId) as any[]).map(r=>({key:r.entity_key,updatedAt:r.updated_at,review:r.review,decision:input.decision,reason:input.reason}));
  }
  if(!Array.isArray(changes)||!changes.length||changes.length>5000||new Set(changes.map(c=>c.key)).size!==changes.length)throw Error("Select 1â€“5,000 resources; narrow the filters for a larger result set");
  for(const c of changes)if(typeof c.key!=="string"||!c.key||c.key.length>4000||!validDecision(c.decision)||c.reason!==undefined&&(typeof c.reason!=="string"||c.reason.length>1000))throw Error("INVALID_BATCH_REVIEW");
  const insert=s.db.prepare("INSERT INTO kb_reviews(project_id,entity_key,decision,reason,reviewed_at) VALUES(?,?,?,?,?)"),records:any[]=[];
  for(const c of changes){const e=s.getEntity(projectId,c.key);if(!e||e.type!=="web-resource"||!e.url){records.push({key:c.key,error:"RESOURCE_NOT_FOUND"});continue;}
   if((c.updatedAt!==undefined&&(c.updatedAt!==e.updatedAt||c.review!==e.review))||(c.revision!==undefined&&c.revision!==hash([e.updatedAt,e.review]))){records.push({key:c.key,error:"STALE_RESOURCE"});continue;}
   insert.run(projectId,c.key,c.decision,c.reason?.trim()||`User marked this resource ${c.decision}.`,new Date().toISOString());
   const data=s.entityEvidence(projectId,c.key)!;records.push({key:c.key,url:e.url,decision:c.decision,fingerprint:evidenceFingerprint(data)});
  }
  const result={projectId,requestId:input.requestId,committedAt:new Date().toISOString(),records,saved:records.filter(r=>!r.error).length,failed:records.filter(r=>r.error).length,notesCreated:0};
  const json=JSON.stringify(result);s.db.prepare("INSERT INTO kb_resource_review_receipts VALUES(?,?,?,?)").run(projectId,input.requestId,signature,json);s.db.exec("COMMIT");return result;
 }catch(e){s.db.exec("ROLLBACK");throw e;}}finally{release();}
}
