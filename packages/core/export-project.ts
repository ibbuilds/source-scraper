import {acquireLock} from "./lock.ts";
import {KnowledgeStore} from "../storage/knowledge.ts";
import type {KnowledgeEntity,ProjectDefinition,Registry} from "../sdk/contracts.ts";

/** Export only user-configured destinations, never touch the original References.md. */
export async function exportProject(dbPath:string,project:ProjectDefinition,
  registry:Registry,vaultPath?:string,options:{localOnly?:boolean}={}):Promise<Array<{output:string;result:unknown}>>{
  const release=acquireLock(dbPath+".lock");
  let store:KnowledgeStore|undefined;
  try{
    store=new KnowledgeStore(dbPath);
    // One ordered snapshot: never repeatedly sort/skip every preceding page.
    // Output adapters still receive their existing complete-array contract.
    store.db.exec("BEGIN");
    const filtered:KnowledgeEntity[]=[];
    try{
      for(const item of store.iterateEntities(project.id)){
        if(item.review!=="rejected"&&item.score>=project.policy.minimumScore)filtered.push(item);
      }
      store.db.exec("COMMIT");
    }catch(error){store.db.exec("ROLLBACK");throw error;}
    // Store is closed before adapters run, but the process-wide collector lock
    // remains held through all filesystem writes.
    store.close();store=undefined;
    const results:Array<{output:string;result:unknown}>=[];
    for(const output of project.outputs){
      const adapter=registry.outputs.get(output.adapter);
      if(!adapter)throw new Error("Output adapter not registered: "+output.adapter);
      if(options.localOnly&&adapter.offline!==true){
        results.push({output:output.id,result:{skipped:true,reason:"Explicit export required for this output"}});
        continue;
      }
      const result=await adapter.export({
        project,outputId:output.id,records:filtered,config:output.config,databasePath:dbPath,vaultPath
      });
      results.push({output:output.id,result});
    }
    return results;
  }finally{
    try{store?.close();}finally{release();}
  }
}
