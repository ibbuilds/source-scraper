import type {KnowledgeStore} from "../storage/knowledge.ts";
import type {KnowledgeEntity} from "../sdk/contracts.ts";
import type {compileCollectionFilters} from "../sdk/collection-filters.ts";

/** Filtering precedes paging. One streaming pass, including multi-page exports. */
export function createFilteredQuery(store:KnowledgeStore,projectId:string,
  filter:ReturnType<typeof compileCollectionFilters>,opts:{limit:number;offset:number;q?:string;type?:string;minScore?:number}){
  const report={version:1,profileHash:filter.hash,sourceIds:filter.sourceIds,evaluatedAt:filter.evaluatedAt,
    examined:0,matchedInScan:0,rejected:0,returned:0,completeScan:false,rejectionReasons:{} as Record<string,number>};
  function* records():IterableIterator<KnowledgeEntity>{
    for(const entity of store.iterateEntities(projectId,opts)){
      report.examined++;
      const decision=filter.match(entity,()=>store.filterObservations(projectId,entity.key));
      if(!decision.matched){report.rejected++;report.rejectionReasons[decision.reason]=(report.rejectionReasons[decision.reason]??0)+1;continue;}
      report.matchedInScan++;
      if(report.matchedInScan<=opts.offset)continue;
      report.returned++;
      yield entity;
      if(report.returned>=opts.limit)return;
    }
    report.completeScan=true;
  }
  return {records:records(),report};
}
