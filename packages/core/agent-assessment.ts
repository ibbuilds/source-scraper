import {createHash,randomUUID} from "node:crypto";
import {acquireLock} from "./lock.ts";
import type {KnowledgeStore} from "../storage/knowledge.ts";

export function evidenceFingerprint(detail:{entity:unknown;mentions:unknown}):string{
  return createHash("sha256").update(JSON.stringify({entity:detail.entity,mentions:detail.mentions})).digest("hex");
}
export function recordAgentAssessment(store:KnowledgeStore,projectId:string,key:string,raw:string):unknown{
  if(Buffer.byteLength(raw,"utf8")>64000)throw Error("Agent assessment exceeds 64 KB");
  const value=JSON.parse(raw) as Record<string,unknown>;
  const allowed=["evidenceFingerprint","rubric","recommendation","reasons","uncertainties","references","actor","model"];
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))
    throw Error("Invalid agent assessment fields");
  for(const name of ["rubric","actor","model"]){
    if(typeof value[name]!=="string"||!(value[name] as string).trim()||(value[name] as string).length>8000)
      throw Error("Invalid agent assessment "+name);
  }
  if(typeof value.recommendation!=="string"||!["recommend","reject","needs-evidence"].includes(value.recommendation))throw Error("Invalid recommendation");
  for(const name of ["reasons","uncertainties"]){
    if(!Array.isArray(value[name])||(value[name] as unknown[]).length>30||
      (value[name] as unknown[]).some(s=>typeof s!=="string"||!s.trim()||s.length>2000))throw Error("Invalid "+name);
  }
  if(!(value.reasons as string[]).length)throw Error("Reasons required");
  if(!Array.isArray(value.references)||value.references.length>25)throw Error("Invalid reference revisions");
  for(const ref of value.references){
    if(!ref||typeof ref!=="object"||Object.keys(ref).some(k=>!["path","sha256"].includes(k))||
      typeof ref.path!=="string"||!ref.path||ref.path.length>1000||typeof ref.sha256!=="string"||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error("Invalid reference revision");
  }
  const release=acquireLock(store.file+".lock");
  try{
  const detail=store.entityEvidence(projectId,key);
  if(!detail)throw Error("Entity not found");
  if(value.evidenceFingerprint!==evidenceFingerprint(detail))throw Error("STALE_EVIDENCE");
  const record={schemaVersion:1,recordType:"agent-assessment",id:randomUUID(),projectId,key,
    ...value,actorAttestation:"reported",recordedAt:new Date().toISOString()};
  ensureTable(store);
  store.db.prepare("INSERT INTO kb_agent_assessments(id,project_id,entity_key,record_json) VALUES(?,?,?,?)")
    .run(record.id,projectId,key,JSON.stringify(record));
  return record;
  }finally{release();}
}
function ensureTable(store:KnowledgeStore):void{
  store.db.exec("CREATE TABLE IF NOT EXISTS kb_agent_assessments(sequence INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,project_id TEXT NOT NULL,entity_key TEXT NOT NULL,record_json TEXT NOT NULL,FOREIGN KEY(project_id,entity_key) REFERENCES kb_entities(project_id,entity_key));"+
    "CREATE INDEX IF NOT EXISTS kb_agent_lookup ON kb_agent_assessments(project_id,entity_key,sequence DESC)");
}
export function listAgentAssessments(store:KnowledgeStore,projectId:string,key:string,limit:number,offset:number):unknown[]{
  const exists=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_agent_assessments'").get();
  if(!exists)return [];
  const detail=store.entityEvidence(projectId,key);
  if(!detail)throw Error("Entity not found");
  const current=evidenceFingerprint(detail);
  return (store.db.prepare("SELECT record_json FROM kb_agent_assessments WHERE project_id=? AND entity_key=? ORDER BY sequence DESC LIMIT ? OFFSET ?")
    .all(projectId,key,limit,offset) as Array<{record_json:string}>).map(row=>{
      const record=JSON.parse(row.record_json);return {...record,stale:record.evidenceFingerprint!==current};
    });
}
