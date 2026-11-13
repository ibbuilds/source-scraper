import {normalizeUrl,isXUrl} from "../core/url.ts";
import {fetchPublicMetadata} from "../connectors/metadata.ts";
import type {Processor,EntityDraft} from "../sdk/contracts.ts";

type MetadataResult=Awaited<ReturnType<typeof fetchPublicMetadata>>|null;
export const MAX_METADATA_ATTEMPTS=8;
export function metadataApplicable(draft:EntityDraft):draft is EntityDraft&{url:string}{
  try{if(!draft.url)return false;const url=new URL(draft.url);return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password&&!isXUrl(draft.url)&&url.hostname!=="t.co"&&!url.hostname.endsWith(".t.co");}catch{return false;}
}
/** One run owns at most 20 distinct fetches, four active; duplicate URLs share a promise. */
export function createPublicMetadataProcessor(fetchMetadata:typeof fetchPublicMetadata=fetchPublicMetadata):Processor{
  const sessions=new WeakMap<AbortSignal,{count:number;active:number;queue:Array<()=>void>;cache:Map<string,Promise<MetadataResult>>}>();
  return {id:"public-metadata",async run(context,_observation,previous){
    if(context.signal.aborted)throw Error("Processing aborted");
    let state=sessions.get(context.signal);
    if(!state){state={count:0,active:0,queue:[],cache:new Map()};sessions.set(context.signal,state);}
    const session=state;
    const schedule=(url:string):Promise<MetadataResult>=>new Promise((resolve,reject)=>{
      const start=()=>{
        if(context.signal.aborted){reject(Error("Processing aborted"));session.queue.shift()?.();return;}
        session.active++;
        void (async()=>{
          try{resolve(await fetchMetadata(url,context.signal));}
          catch(error){if(context.signal.aborted)reject(Error("Processing aborted"));else resolve(null);}
          finally{session.active--;session.queue.shift()?.();}
        })();
      };
      if(session.active<4)start();else session.queue.push(start);
    });
    // Reservation happens synchronously in input order before awaiting anything.
    // Completion timing cannot decide which unique URLs receive the request budget.
    const tasks=previous.map(async(draft):Promise<EntityDraft>=>{
      if(!metadataApplicable(draft))return draft;
      if(["complete","unavailable"].includes(String(draft.attributes?.metadataState))||Number(draft.attributes?.metadataRetryAt??0)>Date.now())return draft;
      let pending=session.cache.get(draft.url);
      if(!pending){
        if(session.count>=20)return {...draft,attributes:{...(draft.attributes??{}),metadataState:"pending"}};
        session.count++;pending=schedule(draft.url);session.cache.set(draft.url,pending);
      }
      const result=await pending;
      if(context.signal.aborted)throw Error("Processing aborted");
      const attempts=Math.min(MAX_METADATA_ATTEMPTS,Number(draft.attributes?.metadataAttempts??0)+1),exhausted=attempts>=MAX_METADATA_ATTEMPTS;
      if(!result)return {...draft,attributes:{...(draft.attributes??{}),metadataState:exhausted?"unavailable":"retry",metadataAttempts:attempts,metadataRetryAt:exhausted?null:Date.now()+Math.min(3600000,30000*2**Math.min(attempts-1,7)),metadataFailureReason:exhausted?"retry-budget-exhausted":"public-metadata-unavailable"},evidence:[...(draft.evidence||[]).filter(e=>e.signal!=="metadata-unavailable"),
        {signal:"metadata-unavailable",detail:exhausted?"Public metadata could not be verified after eight attempts; explicit retry is required":"Public metadata could not be verified; a bounded retry is queued"}]};
      const info=result.metadata;
      return {...draft,key:normalizeUrl(result.url),url:normalizeUrl(result.url),title:info.title||draft.title,
        attributes:{...(draft.attributes||{}),metadataState:"complete",metadataFailureReason:null,metadataRetryAt:null,metadataAttempts:attempts,observedResourceUrl:draft.url,canonicalUrl:normalizeUrl(result.url),
          ...(info.description?{description:info.description}:{}),...(info.license?{license:info.license}:{}),
          ...(info.access?{access:info.access}:{}),...(info.contentType?{contentType:info.contentType}:{})},
        evidence:[...(draft.evidence||[]).filter(e=>e.signal!=="metadata-unavailable"),
          ...(info.title?[{signal:"public-title",detail:"Public page title returned",confidence:0.9}]:[]),
          ...(info.license?[{signal:"license",detail:"Public license metadata: "+info.license,confidence:0.95}]:[])]};
    });
    // Do not release the engine's page/lock while sibling requests are still in flight.
    const settled=await Promise.allSettled(tasks),updated:EntityDraft[]=[];
    for(const item of settled){if(item.status==="rejected")throw item.reason;updated.push(item.value);}
    return updated;
  }};
}
