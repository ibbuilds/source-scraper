import {createHash,randomUUID} from "node:crypto";
import {acquireLock} from "./lock.ts";
import type {KnowledgeStore} from "../storage/knowledge.ts";
import type {ProjectDefinition,Observation,KnowledgeEntity} from "../sdk/contracts.ts";

export type RelevanceState="pertinent"|"irrelevant"|"uncertain";
export type TopicProfile={version:1;description?:string;includeTerms:string[];excludeTerms:string[];positiveExamples?:string[];negativeExamples?:string[];minimumLikes?:number};
export type TopicDecision={fingerprint:string;profileHash:string;state:RelevanceState;reason:string;wholePostReviewed:boolean;uncertainties:string[];evidence:Array<{kind:"text"|"visual"|"page";quote?:string;url?:string;note?:string}>};
const object=(v:unknown):v is Record<string,any>=>Boolean(v)&&typeof v==="object"&&!Array.isArray(v);
const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const topicHash=(v:unknown)=>createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
export function resourceTopicFingerprint(entity:KnowledgeEntity){const attributes={...entity.attributes};for(const name of ["metadataAttempts","metadataRetryAt"])delete attributes[name];return topicHash({key:entity.key,type:entity.type,title:entity.title,url:entity.url,attributes});}
const bounded=(v:unknown,min:number,max:number):v is string=>typeof v==="string"&&v.trim().length>=min&&v.length<=max;
export function topicProfile(input:unknown):TopicProfile{
 if(!object(input)||input.version!==1||Object.keys(input).some(k=>!["version","description","includeTerms","excludeTerms","positiveExamples","negativeExamples","minimumLikes"].includes(k)))throw Error("INVALID_TOPIC_PROFILE");
 for(const key of ["includeTerms","excludeTerms","positiveExamples","negativeExamples"]){const values=input[key];if(values===undefined&&["positiveExamples","negativeExamples"].includes(key))continue;if(!Array.isArray(values)||values.length>64||values.some(v=>!bounded(v,1,key.endsWith("Examples")?2000:128)))throw Error("INVALID_TOPIC_PROFILE");}
 if(input.description!==undefined&&!bounded(input.description,1,4000)||input.minimumLikes!==undefined&&(!Number.isSafeInteger(input.minimumLikes)||input.minimumLikes<0))throw Error("INVALID_TOPIC_PROFILE");
 return structuredClone(input) as TopicProfile;
}
export function ensureRelevance(store:KnowledgeStore){
 store.db.exec("CREATE TABLE IF NOT EXISTS kb_relevance_decisions(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,target TEXT NOT NULL,item_key TEXT NOT NULL,profile_hash TEXT NOT NULL,fingerprint TEXT NOT NULL,origin TEXT NOT NULL,record_json TEXT NOT NULL);CREATE INDEX IF NOT EXISTS kb_relevance_lookup ON kb_relevance_decisions(project_id,target,item_key,profile_hash,sequence DESC);CREATE TABLE IF NOT EXISTS kb_relevance_receipts(project_id TEXT NOT NULL,request_id TEXT NOT NULL,signature TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,request_id));");
}
function textOf(value:any):string{return typeof value==="string"?value:Array.isArray(value)?value.map(textOf).join(" "):object(value)?Object.values(value).map(textOf).join(" "):"";}
function matches(text:string,term:string){return new RegExp("(?:^|[^\\p{L}\\p{N}_])"+term.normalize("NFKC").replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?=$|[^\\p{L}\\p{N}_])","iu").test(text.normalize("NFKC"));}
function latest(store:KnowledgeStore,projectId:string,target:string,key:string,profileHash:string,fingerprint:string){
 const row=store.db.prepare("SELECT record_json FROM kb_relevance_decisions WHERE project_id=? AND target=? AND item_key=? AND profile_hash=? AND fingerprint=? ORDER BY CASE origin WHEN 'user-interface' THEN 0 ELSE 1 END,sequence DESC LIMIT 1").get(projectId,target,key,profileHash,fingerprint) as {record_json:string}|undefined;
 return row?JSON.parse(row.record_json):undefined;
}
export function relevanceEvidence(store:KnowledgeStore,project:ProjectDefinition,target:"observations"|"resources",key:string){
 if(target==="resources"){
  const detail=store.entityEvidence(project.id,key);if(!detail)throw Error("RESOURCE_NOT_FOUND");
  const attributes={...detail.entity.attributes};for(const name of ["metadataAttempts","metadataRetryAt"])delete attributes[name];
  const entity={...detail.entity,attributes};return {key,fingerprint:resourceTopicFingerprint(entity),entity,corpus:textOf([entity.title,attributes]),media:[] as string[],urls:entity.url?[entity.url]:[]};
 }
 const separator=key.indexOf(":");if(separator<1||separator===key.length-1)throw Error("INVALID_OBSERVATION_KEY");const parts=[key.slice(0,separator),key.slice(separator+1)];
 const source=project.sources.find(s=>s.id===parts[0]);if(!source)throw Error("SOURCE_NOT_REGISTERED");
 const row=store.db.prepare("SELECT observation_json FROM kb_observations WHERE project_id=? AND connection_id=? AND item_id=?").get(project.id,parts[0],parts[1]) as {observation_json:string|null}|undefined;
 if(!row?.observation_json)throw Error("OBSERVATION_EVIDENCE_UNAVAILABLE");const observation=JSON.parse(row.observation_json) as Observation;
 const attributes={...(observation.attributes??{})};delete attributes.metrics;
 return {key,sourceId:source.id,adapter:source.adapter,accountId:source.adapter==="x-for-you-local"?String(source.config.accountId??""):undefined,observation,fingerprint:topicHash({...observation,attributes}),corpus:textOf([observation.title,observation.text]),media:observation.media??[],urls:observation.urls??[]};
}
export function resourceRelevanceContext(store:KnowledgeStore,project:ProjectDefinition,input:unknown){
 const profileHash=topicHash(topicProfile(input));ensureRelevance(store);
 const rows=store.db.prepare("SELECT item_key,record_json FROM kb_relevance_decisions WHERE project_id=? AND target='resources' AND profile_hash=? ORDER BY CASE origin WHEN 'user-interface' THEN 0 ELSE 1 END,sequence DESC").all(project.id,profileHash) as {item_key:string;record_json:string}[];
 const relevance:Record<string,{state:RelevanceState;fingerprint:string;reason:string}>={};for(const row of rows)if(!relevance[row.item_key]){const r=JSON.parse(row.record_json),entity=store.getEntity(project.id,row.item_key);if(!entity||resourceTopicFingerprint(entity)!==r.fingerprint)continue;relevance[row.item_key]={state:r.state,fingerprint:r.fingerprint,reason:r.reason.slice(0,300)};}
 return {relevancePolicyHash:profileHash,relevance};
}
export function queryRelevance(store:KnowledgeStore,project:ProjectDefinition,input:any){
 const profile=topicProfile(input.profile),profileHash=topicHash(profile),target=input.target??"observations";
 if(!["observations","resources"].includes(target)||!Number.isInteger(input.limit??40)||(input.limit??40)<1||(input.limit??40)>100)throw Error("INVALID_RELEVANCE_QUERY");
 if(input.state!==undefined&&!["all","pertinent","irrelevant","uncertain"].includes(input.state))throw Error("INVALID_RELEVANCE_STATE");
 ensureRelevance(store);const sourceIds=input.sourceIds??project.sources.map(s=>s.id);if(!Array.isArray(sourceIds)||!sourceIds.length||sourceIds.some((id:string)=>!project.sources.some(s=>s.id===id)))throw Error("INVALID_SOURCE_SELECTION");
 if(input.keys!==undefined){
  if(!Array.isArray(input.keys)||!input.keys.length||input.keys.length>50||input.keys.some((k:unknown)=>!bounded(k,1,8000))||new Set(input.keys).size!==input.keys.length)throw Error("INVALID_RELEVANCE_KEYS");
  const records=input.keys.map((key:string)=>{const detail=relevanceEvidence(store,project,target,key);if(target==="observations"&&!sourceIds.includes(detail.sourceId!))throw Error("SOURCE_NOT_ALLOWED");return {...detail,decision:latest(store,project.id,target,key,profileHash,detail.fingerprint)};});
  return {schemaVersion:1,target,projectId:project.id,profile,profileHash,records,hasMore:false,likesQueued:0};
 }
 const scope=topicHash({target,profileHash,sourceIds,state:input.state??"all"});let cursor="";
 if(input.cursor!==undefined){if(!bounded(input.cursor,1,8000))throw Error("INVALID_RELEVANCE_CURSOR");const decoded=JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"));if(decoded.scope!==scope||typeof decoded.key!=="string")throw Error("RELEVANCE_CURSOR_CHANGED");cursor=decoded.key;}
 const keys=target==="resources"?store.db.prepare("SELECT entity_key key FROM kb_entities WHERE project_id=? AND entity_key>? ORDER BY entity_key LIMIT 1001").all(project.id,cursor) as {key:string}[]:store.db.prepare("SELECT connection_id||':'||item_id key FROM kb_observations WHERE project_id=? AND connection_id IN ("+sourceIds.map(()=>"?").join(",")+") AND (connection_id||':'||item_id)>? ORDER BY key LIMIT 1001").all(project.id,...sourceIds,cursor) as {key:string}[];
 const records:any[]=[];let last=cursor,examined=0;
 for(const row of keys.slice(0,1000)){last=row.key;examined++;const detail=relevanceEvidence(store,project,target,row.key),decision=latest(store,project.id,target,row.key,profileHash,detail.fingerprint),blocked=profile.excludeTerms.some(term=>matches(detail.corpus,term)),state=blocked?"irrelevant":decision?.state??"uncertain";
  if(input.state&&input.state!=="all"&&state!==input.state)continue;
  records.push({...detail,decision:decision??{state,reason:blocked?"An explicit exclusion matched":"Topic evidence needs review"},screening:{excluded:blocked,matchedTerms:profile.includeTerms.filter(term=>matches(detail.corpus,term))}});if(records.length>=(input.limit??40))break;
 }
 const hasMore=examined<keys.length;return {schemaVersion:1,target,projectId:project.id,profile,profileHash,records,examined,hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({scope,key:last})).toString("base64url"):undefined,reviewRequired:true,likesQueued:0};
}
function validateDecision(raw:unknown,detail:ReturnType<typeof relevanceEvidence>,profile:TopicProfile,profileHash:string):TopicDecision{
 if(!object(raw)||Object.keys(raw).some(k=>!["fingerprint","profileHash","state","reason","wholePostReviewed","uncertainties","evidence"].includes(k))||raw.fingerprint!==detail.fingerprint||raw.profileHash!==profileHash||!["pertinent","irrelevant","uncertain"].includes(raw.state)||!bounded(raw.reason,20,2000)||typeof raw.wholePostReviewed!=="boolean"||!Array.isArray(raw.uncertainties)||raw.uncertainties.length>20||raw.uncertainties.some((s:unknown)=>!bounded(s,1,1000))||!Array.isArray(raw.evidence)||raw.evidence.length>20)throw Error("INVALID_OR_STALE_RELEVANCE_DECISION");
 for(const e of raw.evidence){if(!object(e)||Object.keys(e).some(k=>!["kind","quote","url","note"].includes(k))||!["text","visual","page"].includes(e.kind))throw Error("INVALID_RELEVANCE_EVIDENCE");
  if(e.kind==="text"&&(!bounded(e.quote,3,4000)||!detail.corpus.includes(e.quote)))throw Error("TEXT_EVIDENCE_NOT_OBSERVED");
  if(e.kind==="visual"&&(!detail.media.includes(e.url)||!bounded(e.note,20,2000)))throw Error("VISUAL_EVIDENCE_NOT_OBSERVED");
  if(e.kind==="page"){let valid=false;try{const url=new URL(e.url);valid=url.protocol==="https:"&&detail.urls.some(base=>new URL(base).hostname===url.hostname)&&bounded(e.quote,20,4000);}catch{}if(!valid)throw Error("RESOURCE_EVIDENCE_NOT_RELATED");}
 }
 if(raw.state==="pertinent"&&(!raw.wholePostReviewed||raw.uncertainties.length||!raw.evidence.length||profile.excludeTerms.some(term=>matches(detail.corpus,term))))throw Error("TOPIC_NOT_ESTABLISHED");
 if(raw.state==="pertinent"&&detail.media.some(url=>!raw.evidence.some((e:any)=>e.kind==="visual"&&e.url===url)))throw Error("WHOLE_POST_VISUAL_REVIEW_REQUIRED");
 return structuredClone(raw) as TopicDecision;
}
export function recordRelevance(store:KnowledgeStore,project:ProjectDefinition,input:any){
 const profile=topicProfile(input.profile),profileHash=topicHash(profile),target=input.target??"observations",origin=input.origin??"agent-mcp";
 if(!["observations","resources"].includes(target)||!["user-interface","agent-mcp"].includes(origin)||!bounded(input.requestId,8,100)||!Array.isArray(input.items)||!input.items.length||input.items.length>50||new Set(input.items.map((i:any)=>i.key)).size!==input.items.length)throw Error("INVALID_RELEVANCE_BATCH");
 ensureRelevance(store);const signature=topicHash(input),release=acquireLock(store.file+".lock");
 try{store.db.exec("BEGIN IMMEDIATE");try{
  const prior=store.db.prepare("SELECT signature,result_json FROM kb_relevance_receipts WHERE project_id=? AND request_id=?").get(project.id,input.requestId) as {signature:string;result_json:string}|undefined;
  if(prior){if(prior.signature!==signature)throw Error("REQUEST_CONFLICT");store.db.exec("COMMIT");return {...JSON.parse(prior.result_json),replayed:true};}
  const records=input.items.map((item:any)=>{if(!bounded(item.key,1,8000))throw Error("INVALID_RELEVANCE_KEY");const detail=relevanceEvidence(store,project,target,item.key),review=validateDecision(item.review,detail,profile,profileHash),existing=latest(store,project.id,target,item.key,profileHash,detail.fingerprint);
   if(origin==="agent-mcp"&&existing?.origin==="user-interface")throw Error("EXPLICIT_USER_DECISION_EXISTS");return {id:randomUUID(),projectId:project.id,target,key:item.key,origin,...review,at:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()};});
  for(const record of records)store.db.prepare("INSERT INTO kb_relevance_decisions(id,project_id,target,item_key,profile_hash,fingerprint,origin,record_json) VALUES(?,?,?,?,?,?,?,?)").run(record.id,project.id,target,record.key,profileHash,record.fingerprint,origin,JSON.stringify(record));
  const result={projectId:project.id,target,profileHash,records,saved:records.length,likesQueued:0,humanReviewChanged:origin==="user-interface"};store.db.prepare("INSERT INTO kb_relevance_receipts VALUES(?,?,?,?)").run(project.id,input.requestId,signature,JSON.stringify(result));store.db.exec("COMMIT");return result;
 }catch(error){store.db.exec("ROLLBACK");throw error;}}finally{release();}
}
