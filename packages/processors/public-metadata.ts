import {normalizeUrl,isXUrl} from "../core/url.ts";
import {fetchPublicMetadata} from "../connectors/metadata.ts";
import type {Processor,EntityDraft} from "../sdk/contracts.ts";

type MetadataResult=Awaited<ReturnType<typeof fetchPublicMetadata>>|null;
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
      if(!draft.url||isXUrl(draft.url)||new URL(draft.url).hostname==="t.co")return draft;
      let pending=session.cache.get(draft.url);
      if(!pending){
        if(session.count>=20)return draft;
        session.count++;pending=schedule(draft.url);session.cache.set(draft.url,pending);
      }
      const result=await pending;
      if(context.signal.aborted)throw Error("Processing aborted");
      if(!result)return {...draft,evidence:[...(draft.evidence||[]),
        {signal:"metadata-unavailable",detail:"Public metadata could not be verified"}]};
      const info=result.metadata;
      return {...draft,key:normalizeUrl(result.url),url:normalizeUrl(result.url),title:info.title||draft.title,
        attributes:{...(draft.attributes||{}),
          ...(info.description?{description:info.description}:{}),...(info.license?{license:info.license}:{}),
          ...(info.access?{access:info.access}:{}),...(info.contentType?{contentType:info.contentType}:{})},
        evidence:[...(draft.evidence||[]),
          ...(info.title?[{signal:"public-title",detail:"Public page title returned",confidence:0.9}]:[]),
          ...(info.license?[{signal:"license",detail:"Public license metadata: "+info.license,confidence:0.95}]:[])]};
    });
    // Do not release the engine's page/lock while sibling requests are still in flight.
    const settled=await Promise.allSettled(tasks),updated:EntityDraft[]=[];
    for(const item of settled){if(item.status==="rejected")throw item.reason;updated.push(item.value);}
    return updated;
  }};
}
