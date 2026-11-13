import {KnowledgeStore} from "../storage/knowledge.ts";
import {validateObservation,validateEntity,validateAssessment} from "./project-config.ts";
import type {ProjectDefinition,Registry} from "../sdk/contracts.ts";

/** Runs under the caller's writer lock. No source adapter or account action. */
export async function drainPendingProcessing(store:KnowledgeStore,project:ProjectDefinition,registry:Registry,signal:AbortSignal,sourceIds:readonly string[]){
 if(!project.pipeline.includes("public-metadata"))return {processed:0,pending:0};
 const migration="metadata-queue-v1:"+project.id;
 if(!store.db.prepare("SELECT 1 FROM kb_migration_state WHERE name=?").get(migration)){
  store.db.exec("BEGIN IMMEDIATE");try{
   store.db.prepare("INSERT OR IGNORE INTO kb_processing_queue SELECT DISTINCT m.project_id,m.connection_id,m.item_id,'public-metadata',0,? FROM kb_mentions m WHERE m.project_id=? AND m.active=1 AND m.draft_json IS NOT NULL AND json_extract(m.draft_json,'$.url') IS NOT NULL AND json_extract(m.draft_json,'$.attributes.canonicalUrl') IS NULL AND json_extract(m.draft_json,'$.attributes.metadataState') IS NULL").run(new Date().toISOString(),project.id);
   store.db.prepare("INSERT INTO kb_migration_state VALUES(?,'1')").run(migration);store.db.exec("COMMIT");
  }catch(error){store.db.exec("ROLLBACK");throw error;}
 }
 const sources=new Map(project.sources.filter(s=>sourceIds.includes(s.id)).map(s=>[s.id,s]));
 if(!sources.size)return {processed:0,pending:0};
 const placeholders=[...sources].map(()=>"?").join(",");
 const rows=store.db.prepare("SELECT q.connection_id,q.item_id,o.observation_json FROM kb_processing_queue q JOIN kb_observations o ON o.project_id=q.project_id AND o.connection_id=q.connection_id AND o.item_id=q.item_id WHERE q.project_id=? AND q.processor_id='public-metadata' AND q.next_at<=? AND o.observation_json IS NOT NULL AND q.connection_id IN ("+placeholders+") ORDER BY q.next_at,q.updated_at,q.connection_id,q.item_id LIMIT 20").all(project.id,Date.now(),...sources.keys()) as {connection_id:string;item_id:string;observation_json:string|null}[];
 let processed=0;
 for(const row of rows){
  signal.throwIfAborted();const source=sources.get(row.connection_id);if(!source||!row.observation_json)continue;
  const observation=validateObservation(JSON.parse(row.observation_json)),drafts=store.retainedDrafts(project.id,source.id,observation);if(!drafts)continue;
  const context={project,source,signal},updated=await registry.processors.get("public-metadata")!.run(context,observation,drafts);
  const entities=[];for(const raw of updated){const draft=validateEntity(raw,project.entitySchemas);entities.push({draft,assessment:validateAssessment(await registry.evaluators.get(project.evaluator)!.assess(context,observation,draft))});}
  signal.throwIfAborted();store.saveBatch(project.id,source,[{observation,entities}],store.cursor(project.id,source.id),project.evaluator,project.watch?.rules??[],false,undefined,true);processed++;
 }
 return {processed,pending:Number((store.db.prepare("SELECT COUNT(*) total FROM kb_processing_queue WHERE project_id=?").get(project.id) as {total:number}).total)};
}
