import type {JsonRecord} from "../sdk/contracts.ts";

/** Preserve observed counters only. An unavailable counter is never invented as zero. */
export function xMetrics(raw:unknown):JsonRecord{
  const input=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:{};
  const metrics:JsonRecord={};
  for(const key of ["likes","reposts","replies","quotes","views"]){
    const value=input[key];
    if(typeof value==="number"&&Number.isSafeInteger(value)&&value>=0)metrics[key]=value;
  }
  const counts=["likes","reposts","replies","quotes"].map(key=>metrics[key]);
  if(counts.every(v=>typeof v==="number")){
    const sum=(counts as number[]).reduce((a,b)=>a+b,0);
    if(Number.isSafeInteger(sum))metrics.engagements=sum;
  }
  return metrics;
}
