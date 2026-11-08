/** Public collection-filter contract v1. Mirrored by the independent Obsidian client. */
import {createHash} from "node:crypto";

export interface NumericRange {field:string;min?:number;max?:number}
export interface DateRange {field:string;from?:string;to?:string;maxAgeDays?:number}
export interface FilterClause {
  numericRanges?:NumericRange[];
  dateRanges?:DateRange[];
  fields?:string[];
  includeTerms?:string[];
  excludeTerms?:string[];
  includeMode?:"any"|"all";
  matchMode?:"word"|"substring";
  types?:string[];
  allowedDomains?:string[];
  blockedDomains?:string[];
  requiredFields?:string[];
}
export interface CollectionFilters {
  version:1;
  sourceIds?:string[];
  observation?:FilterClause;
  entity?:FilterClause;
}
const textList={type:"array",items:{type:"string",minLength:1,maxLength:100},minItems:1,maxItems:60};
const numericRangeSchema={type:"array",minItems:1,maxItems:16,items:{type:"object",additionalProperties:false,required:["field"],properties:{field:{type:"string",minLength:1,maxLength:100},min:{type:"number"},max:{type:"number"}}}};
const dateRangeSchema={type:"array",minItems:1,maxItems:16,items:{type:"object",additionalProperties:false,required:["field"],properties:{field:{type:"string",minLength:1,maxLength:100},from:{type:"string",maxLength:40},to:{type:"string",maxLength:40},maxAgeDays:{type:"number",exclusiveMinimum:0,maximum:36500}}}};
const clauseSchema={type:"object",additionalProperties:false,minProperties:1,properties:{
  numericRanges:numericRangeSchema,dateRanges:dateRangeSchema,
  fields:{...textList,maxItems:16},includeTerms:textList,excludeTerms:textList,
  includeMode:{type:"string",enum:["any","all"]},matchMode:{type:"string",enum:["word","substring"]},
  types:textList,allowedDomains:textList,blockedDomains:textList,requiredFields:{...textList,maxItems:16}
}};
export const COLLECTION_FILTER_SCHEMA={type:"object",additionalProperties:false,required:["version"],properties:{
  version:{type:"integer",const:1},sourceIds:{...textList,maxItems:30},observation:clauseSchema,entity:clauseSchema
}};
const normalize=(s:string)=>s.normalize("NFKC").toLowerCase().replace(/\s+/gu," ").trim();
function object(value:unknown,label:string):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("INVALID_FILTER: "+label+" must be an object");
  return value as Record<string,unknown>;
}
function exactKeys(value:Record<string,unknown>,allowed:readonly string[]):void{
  if(Object.keys(value).some(k=>!allowed.includes(k)))throw Error("INVALID_FILTER: unknown field");
}
function strings(value:unknown,name:string,max=60,sensitive=false):string[]{
  if(!Array.isArray(value)||!value.length||value.length>max||value.some(x=>typeof x!=="string"||!x.trim()||x.length>100))
    throw Error("INVALID_FILTER: "+name+" must be a nonempty bounded text list");
  const result:string[]=[],seen=new Set<string>();
  for(const raw of value as string[]){const item=raw.trim(),key=sensitive?item:normalize(item);if(!seen.has(key)){seen.add(key);result.push(item);}}
  return result;
}
function field(value:string,scope:"entity"|"observation"):string{
  const parts=value.split(".");
  const roots=scope==="entity"?["key","type","title","url","category","score","confidence","review"]:
    ["id","type","title","text","url","urls","media","occurredAt"];
  if(parts.length>8||parts.some(p=>!p||["__proto__","prototype","constructor"].includes(p)||!/^[\p{L}\p{N}_-]+$/u.test(p))||
    !(parts[0]==="attributes"&&parts.length>1||parts.length===1&&roots.includes(parts[0])))
    throw Error("INVALID_FILTER: unsupported "+scope+" field path");
  return value;
}
function domain(value:string):string{
  if(/[\s/:@?#*]/u.test(value))throw Error("INVALID_FILTER: use a hostname, without a scheme, port or wildcard");
  let host:string;
  try{host=new URL("https://"+value).hostname.toLowerCase().replace(/\.$/,"");}catch{throw Error("INVALID_FILTER: hostname");}
  if(!host||host.startsWith("."))throw Error("INVALID_FILTER: hostname");
  return host;
}
/** Explicit timezone and a real calendar date; never parse a local ambiguous date. */
function timestamp(value:unknown):number{
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))return NaN;
  const day=value.slice(0,10),calendar=Date.parse(day+"T00:00:00Z"),time=Date.parse(value);
  return Number.isFinite(calendar)&&new Date(calendar).toISOString().slice(0,10)===day?time:NaN;
}
export function parseCollectionFilters(value:unknown,sourceIds?:readonly string[]):CollectionFilters{
  const raw=object(value,"profile");exactKeys(raw,["version","sourceIds","observation","entity"]);
  if(raw.version!==1)throw Error("INVALID_FILTER: unsupported version");
  const result:CollectionFilters={version:1};
  if(raw.sourceIds!==undefined){
    result.sourceIds=strings(raw.sourceIds,"sourceIds",30);
    if(result.sourceIds.some(id=>!/^[a-z][a-z0-9_-]{1,63}$/.test(id)||sourceIds&&!sourceIds.includes(id)))
      throw Error("INVALID_FILTER: source is not registered in this project");
  }
  for(const scope of ["observation","entity"] as const){
    if(raw[scope]===undefined)continue;
    const input=object(raw[scope],scope);exactKeys(input,["fields","includeTerms","excludeTerms","includeMode","matchMode","types","allowedDomains","blockedDomains","requiredFields","numericRanges","dateRanges"]);
    const clause:FilterClause={};
    for(const key of ["includeTerms","excludeTerms","types","allowedDomains","blockedDomains"] as const){
      if(input[key]!==undefined)clause[key]=strings(input[key],key);
    }
    for(const key of ["fields","requiredFields"] as const){
      if(input[key]!==undefined)clause[key]=strings(input[key],key,16,true).map(p=>field(p,scope));
    }
    for(const kind of ["numericRanges","dateRanges"] as const){
      if(input[kind]===undefined)continue;
      const entries=input[kind];
      if(!Array.isArray(entries)||!entries.length||entries.length>16)throw Error("INVALID_FILTER: bounded nonempty ranges required");
      const parsed=entries.map(entry=>{
        const range=object(entry,kind);exactKeys(range,kind==="numericRanges"?["field","min","max"]:["field","from","to","maxAgeDays"]);
        if(typeof range.field!=="string"||range.field.length>100)throw Error("INVALID_FILTER: range field");
        const path=field(range.field,scope);
        if(kind==="numericRanges"){
          for(const key of ["min","max"])if(range[key]!==undefined&&(typeof range[key]!=="number"||!Number.isFinite(range[key])))throw Error("INVALID_FILTER: finite numeric bounds required");
          if(range.min===undefined&&range.max===undefined||Number(range.min)>Number(range.max))throw Error("INVALID_FILTER: numeric range bounds");
          return {field:path,...(range.min===undefined?{}:{min:range.min as number}),...(range.max===undefined?{}:{max:range.max as number})};
        }
        for(const key of ["from","to"])if(range[key]!==undefined&&!Number.isFinite(timestamp(range[key])))throw Error("INVALID_FILTER: timestamp needs ISO date and timezone");
        if(range.maxAgeDays!==undefined&&(typeof range.maxAgeDays!=="number"||!Number.isFinite(range.maxAgeDays)||range.maxAgeDays<=0||range.maxAgeDays>36500))throw Error("INVALID_FILTER: maxAgeDays must be 0 < days <= 36500");
        if(range.from===undefined&&range.to===undefined&&range.maxAgeDays===undefined||timestamp(range.from)>timestamp(range.to))throw Error("INVALID_FILTER: date range bounds");
        return {field:path,...(range.from===undefined?{}:{from:new Date(timestamp(range.from)).toISOString()}),...(range.to===undefined?{}:{to:new Date(timestamp(range.to)).toISOString()}),...(range.maxAgeDays===undefined?{}:{maxAgeDays:range.maxAgeDays as number})};
      });
      if(kind==="numericRanges")clause.numericRanges=parsed as NumericRange[];else clause.dateRanges=parsed as DateRange[];
    }
    if(clause.types?.some(t=>!/^[a-z][a-z0-9_-]{1,63}$/.test(t)))throw Error("INVALID_FILTER: type");
    for(const key of ["allowedDomains","blockedDomains"] as const)if(clause[key])clause[key]=clause[key]!.map(domain);
    if(input.includeMode!==undefined){if(!["any","all"].includes(String(input.includeMode)))throw Error("INVALID_FILTER: includeMode");clause.includeMode=input.includeMode as "any"|"all";}
    if(input.matchMode!==undefined){if(!["word","substring"].includes(String(input.matchMode)))throw Error("INVALID_FILTER: matchMode");clause.matchMode=input.matchMode as "word"|"substring";}
    if(![clause.includeTerms,clause.excludeTerms,clause.types,clause.allowedDomains,clause.blockedDomains,clause.requiredFields,clause.numericRanges,clause.dateRanges].some(x=>x?.length))
      throw Error("INVALID_FILTER: a clause needs a condition, not only matching options");
    result[scope]=clause;
  }
  if(!result.sourceIds&&!result.observation&&!result.entity)throw Error("INVALID_FILTER: profile has no conditions");
  if(Buffer.byteLength(JSON.stringify(result),"utf8")>12000)throw Error("INVALID_FILTER: profile exceeds 12 KB");
  return result;
}
function read(value:unknown,path:string):unknown{
  let current=value;
  for(const part of path.split(".")){
    if(!current||typeof current!=="object"||Array.isArray(current)||!Object.hasOwn(current,part))return undefined;
    current=(current as Record<string,unknown>)[part];
  }
  return current;
}
function values(value:unknown):string[]{
  if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")return [normalize(String(value))];
  return Array.isArray(value)?value.slice(0,500).flatMap(x=>typeof x==="string"||typeof x==="number"||typeof x==="boolean"?[normalize(String(x))]:[]):[];
}
function present(value:unknown):boolean{
  return value!==undefined&&value!==null&&(typeof value!=="string"||Boolean(value.trim()))&&(!Array.isArray(value)||value.length>0);
}
type Decision={matched:boolean;reason:string};
function compileClause(clause:FilterClause,scope:"entity"|"observation",at:number):(input:unknown)=>Decision{
  const fields=clause.fields??(scope==="entity"?["title","attributes.description"]:["title","text"]);
  const pattern=(term:string)=>{
    const literal=normalize(term);if(clause.matchMode==="substring")return (v:string)=>v.includes(literal);
    const escaped=literal.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const regex=new RegExp("(?:^|[^\\p{L}\\p{N}_])"+escaped+"(?=$|[^\\p{L}\\p{N}_])","u");
    return (v:string)=>regex.test(v);
  };
  const include=(clause.includeTerms??[]).map(pattern),exclude=(clause.excludeTerms??[]).map(pattern);
  const dates=(clause.dateRanges??[]).map(range=>({field:range.field,
    from:Math.max(range.from===undefined?-Infinity:timestamp(range.from),range.maxAgeDays===undefined?-Infinity:at-range.maxAgeDays*86400000),
    to:Math.min(range.to===undefined?Infinity:timestamp(range.to),range.maxAgeDays===undefined?Infinity:at)}));
  const matchesDomain=(host:string,list:readonly string[])=>list.some(d=>host===d||host.endsWith("."+d));
  return input=>{
    if(clause.types&&!clause.types.includes(String(read(input,"type"))))return {matched:false,reason:scope+":type"};
    for(const path of clause.requiredFields??[])if(!present(read(input,path)))return {matched:false,reason:scope+":missing-field:"+path};
    for(const range of clause.numericRanges??[]){
      const value=read(input,range.field);
      if(typeof value!=="number"||!Number.isFinite(value))return {matched:false,reason:scope+":missing-number:"+range.field};
      if(range.min!==undefined&&value<range.min||range.max!==undefined&&value>range.max)return {matched:false,reason:scope+":numeric-range:"+range.field};
    }
    for(const range of dates){
      const time=timestamp(read(input,range.field));
      if(!Number.isFinite(time))return {matched:false,reason:scope+":missing-date:"+range.field};
      if(time<range.from||time>range.to)return {matched:false,reason:scope+":date-range:"+range.field};
    }
    if(clause.allowedDomains||clause.blockedDomains){
      let host="";try{host=new URL(String(read(input,"url"))).hostname.toLowerCase().replace(/\.$/,"");}catch{/* Missing URLs do not satisfy an allowlist. */}
      if(clause.blockedDomains&&matchesDomain(host,clause.blockedDomains))return {matched:false,reason:scope+":blocked-domain"};
      if(clause.allowedDomains&&!matchesDomain(host,clause.allowedDomains))return {matched:false,reason:scope+":allowed-domain"};
    }
    const corpus=fields.flatMap(path=>values(read(input,path)));
    if(exclude.some(test=>corpus.some(test)))return {matched:false,reason:scope+":exclude-term"};
    if(include.length&&!(clause.includeMode==="all"?include.every(test=>corpus.some(test)):include.some(test=>corpus.some(test))))
      return {matched:false,reason:scope+":include-term"};
    return {matched:true,reason:"matched"};
  };
}
export function compileCollectionFilters(sources:readonly string[],saved?:unknown,request?:unknown,at=Date.now(),additional?:unknown){
  if(!Number.isFinite(at))throw Error("INVALID_FILTER: evaluation time");
  const profiles=[saved,request,additional].filter(x=>x!==undefined).map(x=>parseCollectionFilters(x,sources));
  const sourceIds=sources.filter(id=>profiles.every(p=>!p.sourceIds||p.sourceIds.includes(id)));
  if(!sourceIds.length&&profiles.some(p=>p.sourceIds))throw Error("INVALID_FILTER: source selections have no common registered source");
  const entity=profiles.flatMap(p=>p.entity?[compileClause(p.entity,"entity",at)]:[]);
  const observation=profiles.flatMap(p=>p.observation?[compileClause(p.observation,"observation",at)]:[]);
  return {active:profiles.length>0,sourceIds,evaluatedAt:new Date(at).toISOString(),
    hash:createHash("sha256").update(JSON.stringify(profiles)).digest("hex"),
    match(input:unknown,observations:()=>Iterable<{sourceId:string;observation:unknown}>):Decision{
      for(const test of entity){const decision=test(input);if(!decision.matched)return decision;}
      if(observation.length||sourceIds.length!==sources.length){
        for(const mention of observations())if(sourceIds.includes(mention.sourceId)&&observation.every(test=>test(mention.observation).matched))
          return {matched:true,reason:"matched"};
        return {matched:false,reason:"source:no-matching-observation"};
      }
      return {matched:true,reason:"matched"};
    }
  };
}

export function usesThresholdFilters(profile?:CollectionFilters):boolean{
  return Boolean(profile&&[profile.entity,profile.observation].some(c=>c?.numericRanges||c?.dateRanges));
}
