import {KnowledgeStore} from "../storage/knowledge.ts";
import {validateObservation,validateEntity,validateAssessment} from "./project-config.ts";
import {metadataApplicable} from "../processors/public-metadata.ts";
import type {ProjectDefinition,Registry} from "../sdk/contracts.ts";

export type ProcessingProgress={processed:number;pending:number;retiredTasks:number;attemptedUrls:number;completedUrls:number;retryingUrls:number;unavailableUrls:number;blocked:number;oldestPendingObservationAt?:string;lastRunAt?:string;lastSuccessAt?:string};
/** Runs under the caller's writer lock. No source adapter or account action. */
export async function drainPendingProcessing(store:KnowledgeStore,project:ProjectDefinition,registry:Registry,signal:AbortSignal,sourceIds:readonly string[],retryFailed=false):Promise<ProcessingProgress>{
 const empty={processed:0,pending:0,retiredTasks:0,attemptedUrls:0,completedUrls:0,retryingUrls:0,unavailableUrls:0,blocked:0};
 if(!project.pipeline.includes("public-metadata"))return empty;
 const now=new Date().toISOString();
 store.db.exec("CREATE TABLE IF NOT EXISTS kb_processing_summary(project_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS kb_processing_blocked(project_id TEXT NOT NULL,connection_id TEXT NOT NULL,item_id TEXT NOT NULL,reason TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,connection_id,item_id));");
 store.db.function("ss_metadata_candidate",{deterministic:true},(raw)=>{try{return typeof raw==="string"&&metadataApplicable(JSON.parse(raw))?1:0;}catch{return 0;}});
 const eligible="EXISTS(SELECT 1 FROM kb_mentions m WHERE m.project_id=q.project_id AND m.connection_id=q.connection_id AND m.item_id=q.item_id AND m.active=1 AND m.draft_json IS NOT NULL AND ss_metadata_candidate(m.draft_json)=1 AND COALESCE(json_extract(m.draft_json,'$.attributes.metadataState'),'pending') IN ('pending','retry'))";
 const snapshot="EXISTS(SELECT 1 FROM kb_observations o WHERE o.project_id=q.project_id AND o.connection_id=q.connection_id AND o.item_id=q.item_id AND o.observation_json IS NOT NULL)";
 const migration="metadata-queue-v2:"+project.id;let retiredTasks=0;
 store.db.exec("BEGIN IMMEDIATE");try{
  store.db.prepare("INSERT INTO kb_processing_blocked SELECT q.project_id,q.connection_id,q.item_id,'retained-draft-evidence-unavailable',? FROM kb_processing_queue q WHERE q.project_id=? AND q.processor_id='public-metadata' AND NOT EXISTS(SELECT 1 FROM kb_mentions m WHERE m.project_id=q.project_id AND m.connection_id=q.connection_id AND m.item_id=q.item_id AND m.active=1 AND m.draft_json IS NOT NULL) ON CONFLICT(project_id,connection_id,item_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at").run(now,project.id);
  store.db.prepare("INSERT INTO kb_processing_blocked SELECT q.project_id,q.connection_id,q.item_id,'observation-evidence-unavailable',? FROM kb_processing_queue q WHERE q.project_id=? AND q.processor_id='public-metadata' AND "+eligible+" AND NOT "+snapshot+" ON CONFLICT(project_id,connection_id,item_id) DO UPDATE SET reason=excluded.reason,updated_at=excluded.updated_at").run(now,project.id);
  retiredTasks=Number(store.db.prepare("DELETE FROM kb_processing_queue AS q WHERE q.project_id=? AND q.processor_id='public-metadata' AND (NOT "+eligible+" OR NOT "+snapshot+")").run(project.id).changes);
  if(!store.db.prepare("SELECT 1 FROM kb_migration_state WHERE name=?").get(migration)){
   store.db.prepare("INSERT OR IGNORE INTO kb_processing_queue SELECT DISTINCT m.project_id,m.connection_id,m.item_id,'public-metadata',COALESCE(json_extract(m.draft_json,'$.attributes.metadataRetryAt'),0),? FROM kb_mentions m JOIN kb_observations o ON o.project_id=m.project_id AND o.connection_id=m.connection_id AND o.item_id=m.item_id WHERE m.project_id=? AND m.active=1 AND o.observation_json IS NOT NULL AND ss_metadata_candidate(m.draft_json)=1 AND json_extract(m.draft_json,'$.attributes.canonicalUrl') IS NULL AND COALESCE(json_extract(m.draft_json,'$.attributes.metadataState'),'pending') IN ('pending','retry')").run(now,project.id);
   store.db.prepare("INSERT INTO kb_migration_state VALUES(?,'1')").run(migration);
  }
  if(retryFailed)store.db.prepare("INSERT OR IGNORE INTO kb_processing_queue SELECT DISTINCT m.project_id,m.connection_id,m.item_id,'public-metadata',0,? FROM kb_mentions m JOIN kb_observations o ON o.project_id=m.project_id AND o.connection_id=m.connection_id AND o.item_id=m.item_id WHERE m.project_id=? AND m.active=1 AND o.observation_json IS NOT NULL AND ss_metadata_candidate(m.draft_json)=1 AND json_extract(m.draft_json,'$.attributes.metadataState')='unavailable' ORDER BY m.connection_id,m.item_id LIMIT 20").run(now,project.id);
  store.db.exec("COMMIT");
 }catch(error){store.db.exec("ROLLBACK");throw error;}
 const sources=new Map(project.sources.filter(s=>sourceIds.includes(s.id)).map(s=>[s.id,s]));
 if(!sources.size)return {...empty,retiredTasks};
 const placeholders=[...sources].map(()=>"?").join(",");
 const rows=store.db.prepare("SELECT q.connection_id,q.item_id,o.observation_json FROM kb_processing_queue q JOIN kb_observations o ON o.project_id=q.project_id AND o.connection_id=q.connection_id AND o.item_id=q.item_id WHERE q.project_id=? AND q.processor_id='public-metadata' AND q.next_at<=? AND o.observation_json IS NOT NULL AND q.connection_id IN ("+placeholders+") ORDER BY "+(retryFailed?"CASE WHEN EXISTS(SELECT 1 FROM kb_mentions failed WHERE failed.project_id=q.project_id AND failed.connection_id=q.connection_id AND failed.item_id=q.item_id AND failed.active=1 AND json_extract(failed.draft_json,'$.attributes.metadataState')='unavailable') THEN 0 ELSE 1 END,":"")+"q.next_at,q.updated_at,q.connection_id,q.item_id LIMIT 20").all(project.id,Date.now(),...sources.keys()) as {connection_id:string;item_id:string;observation_json:string}[];
 let processed=0;const attempted=new Set<string>(),completed=new Set<string>(),retrying=new Set<string>();
 for(const row of rows){
  signal.throwIfAborted();const source=sources.get(row.connection_id)!;
  const observation=validateObservation(JSON.parse(row.observation_json)),retained=store.retainedDrafts(project.id,source.id,observation);
  if(!retained){store.db.exec("BEGIN IMMEDIATE");try{store.db.prepare("INSERT OR REPLACE INTO kb_processing_blocked VALUES(?,?,?,'retained-draft-evidence-unavailable',?)").run(project.id,source.id,row.item_id,now);store.db.prepare("DELETE FROM kb_processing_queue WHERE project_id=? AND connection_id=? AND item_id=?").run(project.id,source.id,row.item_id);store.db.exec("COMMIT");}catch(error){store.db.exec("ROLLBACK");throw error;}continue;}
  const drafts=retained.map(d=>retryFailed&&d.attributes?.metadataState==="unavailable"?{...d,attributes:{...d.attributes,metadataState:"pending",metadataAttempts:0,metadataRetryAt:null}}:d);
  const context={project,source,signal},updated=await registry.processors.get("public-metadata")!.run(context,observation,drafts);
  const entities=[];for(const [index,raw] of updated.entries()){
   const draft=validateEntity(raw,project.entitySchemas),previous=drafts[index];
   if(previous?.url&&Number(draft.attributes?.metadataAttempts??0)>Number(previous.attributes?.metadataAttempts??0))attempted.add(previous.url);
   if(previous?.url&&draft.attributes?.metadataState==="complete"&&previous.attributes?.metadataState!=="complete")completed.add(previous.url);
   if(previous?.url&&draft.attributes?.metadataState==="retry")retrying.add(previous.url);
   entities.push({draft,assessment:validateAssessment(await registry.evaluators.get(project.evaluator)!.assess(context,observation,draft))});
  }
  signal.throwIfAborted();store.saveBatch(project.id,source,[{observation,entities}],store.cursor(project.id,source.id),project.evaluator,project.watch?.rules??[],false,undefined,true);
  store.db.prepare("DELETE FROM kb_processing_blocked WHERE project_id=? AND connection_id=? AND item_id=?").run(project.id,source.id,row.item_id);processed++;
 }
 const queue=store.db.prepare("SELECT COUNT(*) pending,MIN(o.first_seen) oldest FROM kb_processing_queue q JOIN kb_observations o ON o.project_id=q.project_id AND o.connection_id=q.connection_id AND o.item_id=q.item_id WHERE q.project_id=?").get(project.id) as {pending:number;oldest:string|null};
 const prior=store.db.prepare("SELECT record_json FROM kb_processing_summary WHERE project_id=?").get(project.id) as {record_json:string}|undefined;
 const unavailable=store.db.prepare("SELECT COUNT(DISTINCT entity_key) total FROM kb_mentions WHERE project_id=? AND active=1 AND json_extract(draft_json,'$.attributes.metadataState')='unavailable'").get(project.id) as {total:number};
 const blocked=store.db.prepare("SELECT COUNT(*) total FROM kb_processing_blocked WHERE project_id=?").get(project.id) as {total:number};
 const lastSuccessAt=completed.size?now:prior?JSON.parse(prior.record_json).lastSuccessAt:undefined;
 const result:ProcessingProgress={processed,pending:Number(queue.pending),retiredTasks,attemptedUrls:attempted.size,completedUrls:completed.size,retryingUrls:retrying.size,unavailableUrls:Number(unavailable.total),blocked:Number(blocked.total),...(queue.oldest?{oldestPendingObservationAt:queue.oldest}:{}),lastRunAt:now,...(lastSuccessAt?{lastSuccessAt}:{})};
 store.db.prepare("INSERT INTO kb_processing_summary VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET record_json=excluded.record_json").run(project.id,JSON.stringify(result));return result;
}
