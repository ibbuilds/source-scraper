import https from "node:https";
import {normalizeUrl,isXUrl,safeHostname} from "../core/url.ts";
import {validateObservation} from "../core/project-config.ts";
import type {Observation,SourceAdapter,JsonRecord} from "../sdk/contracts.ts";

export const X_PROVIDER_ENDPOINT="https://api.getxapi.com/twitter/user/home_timeline";
export const X_PROVIDER_APPROVAL="getxapi-session-disclosure-and-paid-requests";
const MAX_BYTES=1_000_000;
export interface XCredentials {apiKey:string;accountSession:string;approved:boolean}
export interface XRequest extends XCredentials {cursor?:string;signal:AbortSignal}
export type XTransport=(request:XRequest)=>Promise<unknown>;
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("X_PROVIDER_INVALID_RESPONSE");
  return value as Record<string,unknown>;
}
export function xForYouConfig(config:JsonRecord):{accountId:string;pagesPerRun:number}{
  if(Object.keys(config).some(k=>!["accountId","pagesPerRun"].includes(k))||
    typeof config.accountId!=="string"||!/^\d{1,30}$/.test(config.accountId))
    throw Error("X_FEED_CONFIG: supply accountId; credentials and endpoint overrides are forbidden");
  const pagesPerRun=config.pagesPerRun??1;
  if(!Number.isInteger(pagesPerRun)||Number(pagesPerRun)<1||Number(pagesPerRun)>10)
    throw Error("X_FEED_CONFIG: pagesPerRun must be 1–10");
  return {accountId:config.accountId,pagesPerRun:Number(pagesPerRun)};
}
export function xEnvironmentCredentials():XCredentials{return {
  apiKey:process.env.SOURCE_SCRAPER_GETXAPI_API_KEY||"",
  accountSession:process.env.SOURCE_SCRAPER_X_ACCOUNT_SESSION||"",
  approved:process.env.SOURCE_SCRAPER_X_PROVIDER_APPROVED===X_PROVIDER_APPROVAL
};}
function checkCredentials(value:XCredentials):void{
  if(!value.approved)throw Error("X_PROVIDER_APPROVAL_REQUIRED: GetXAPI receives the X account session and charges for requests");
  if([value.apiKey,value.accountSession].some(v=>!v||v.length>8192||/[^\x21-\x7e]/.test(v)))
    throw Error("X_PROVIDER_CREDENTIALS_REQUIRED: configure credentials locally in the process environment");
}
/** Fixed-origin, no-redirect, no-retry request. Neither provider bodies nor transport errors escape. */
export async function requestXForYou(input:XRequest):Promise<unknown>{
  checkCredentials(input);
  if(input.signal.aborted)throw Error("X_PROVIDER_CANCELLED");
  return new Promise((resolve,reject)=>{
    let done=false;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    const fail=(code:string)=>{if(!done){done=true;if(deadline)clearTimeout(deadline);reject(Error(code));}};
    const body=JSON.stringify({auth_token:input.accountSession,following:false,...(input.cursor?{cursor:input.cursor}:{})});
    const req=https.request(X_PROVIDER_ENDPOINT,{method:"POST",signal:input.signal,timeout:12000,
      headers:{Authorization:"Bearer "+input.apiKey,"Content-Type":"application/json","Accept":"application/json",
        "Accept-Encoding":"identity","Content-Length":Buffer.byteLength(body)}},res=>{
      const status=res.statusCode||0;
      if(status!==200){res.resume();fail("X_PROVIDER_HTTP_"+status);return;}
      const type=String(res.headers["content-type"]||"").split(";")[0].trim().toLowerCase();
      if(type!=="application/json"){res.resume();fail("X_PROVIDER_INVALID_CONTENT_TYPE");return;}
      let size=0;const parts:Buffer[]=[];
      res.on("data",(part:Buffer)=>{size+=part.length;if(size>MAX_BYTES){fail("X_PROVIDER_RESPONSE_LIMIT");req.destroy();}else parts.push(part);});
      res.on("error",()=>fail("X_PROVIDER_RESPONSE_INTERRUPTED"));
      res.on("aborted",()=>fail("X_PROVIDER_RESPONSE_INTERRUPTED"));
      res.on("end",()=>{
        if(done)return;
        try{const value:unknown=JSON.parse(Buffer.concat(parts).toString("utf8"));done=true;if(deadline)clearTimeout(deadline);resolve(value);}
        catch{fail("X_PROVIDER_INVALID_JSON");}
      });
    });
    req.on("error",()=>fail(input.signal.aborted?"X_PROVIDER_CANCELLED":"X_PROVIDER_UNREACHABLE"));
    req.on("timeout",()=>{fail("X_PROVIDER_TIMEOUT");req.destroy();});
    deadline=setTimeout(()=>{fail("X_PROVIDER_TIMEOUT");req.destroy();},12000);
    req.end(body);
  });
}
function publicLink(value:unknown):string|undefined{
  if(typeof value!=="string"||value.length>3000)return undefined;
  try{
    const url=normalizeUrl(value),host=safeHostname(url);
    if(isXUrl(url)||host==="t.co"||host.endsWith(".t.co"))return undefined;
    return url;
  }catch{return undefined;}
}
/** Allowlist fields rather than storing provider objects, credentials or private account metadata. */
export function normalizeXPost(raw:unknown,secrets:readonly string[]=[]):Observation{
  const post=object(raw),author=object(post.author);
  if(typeof post.id!=="string"||!/^\d{1,30}$/.test(post.id)||typeof author.userName!=="string"||
    !/^[A-Za-z0-9_]{1,15}$/.test(author.userName)||typeof post.text!=="string"||post.text.length>20000)
    throw Error("X_PROVIDER_INVALID_POST");
  const clean=(value:string)=>secrets.reduce((s,secret)=>secret?s.split(secret).join("[redacted]"):s,value);
  const urls=new Set<string>();
  // Expanded links are evidence supplied by the provider, not redirect requests.
  const entities=post.entities&&typeof post.entities==="object"?post.entities as Record<string,unknown>:{};
  const links=[...(Array.isArray(entities.urls)?entities.urls:[]),...(Array.isArray(post.urls)?post.urls:[])];
  for(const rawLink of links.slice(0,100)){
    const link=typeof rawLink==="string"?rawLink:rawLink&&typeof rawLink==="object"?
      (rawLink as Record<string,unknown>).expanded_url??(rawLink as Record<string,unknown>).expandedUrl:undefined;
    const url=publicLink(link);if(url&&!secrets.some(s=>s&&url.includes(s)))urls.add(url);
  }
  for(const match of post.text.matchAll(/https?:\/\/[^\s<>"']+/gi)){
    const url=publicLink(match[0].replace(/[),.;!?\]}]+$/,""));
    if(url&&!secrets.some(s=>s&&url.includes(s)))urls.add(url);
    if(urls.size>=100)break;
  }
  const extended=post.extendedEntities&&typeof post.extendedEntities==="object"?post.extendedEntities as Record<string,unknown>:{};
  const mediaRows=[...(Array.isArray(extended.media)?extended.media:[]),...(Array.isArray(entities.media)?entities.media:[])];
  const media=new Set<string>();
  for(const row of mediaRows.slice(0,100)){
    const value=row&&typeof row==="object"?(row as Record<string,unknown>).media_url_https:undefined;
    if(typeof value==="string")try{
      const url=normalizeUrl(value);if(new URL(url).hostname==="pbs.twimg.com"&&!secrets.some(s=>s&&url.includes(s)))media.add(url);
    }catch{/* Ignore unusable media. */}
  }
  const date=post.createdAt??post.created_at;
  const occurredAt=typeof date==="string"&&Number.isFinite(Date.parse(date))?new Date(date).toISOString():undefined;
  return validateObservation({id:post.id,type:"x-post",title:clean(post.text).slice(0,180)||"X post "+post.id,
    text:clean(post.text),url:"https://x.com/"+author.userName+"/status/"+post.id,urls:[...urls].slice(0,100),media:[...media],occurredAt,
    attributes:{author:clean(author.userName),provider:"getxapi",feed:"for-you",feedVerification:"provider-reported"}});
}
/** A run samples a bounded window; a saved provider cursor resumes the next window. */
export function createXForYouSource(options:{credentials?:()=>XCredentials;transport?:XTransport}={}):SourceAdapter{
  const budgets=new WeakMap<AbortSignal,Map<string,number>>();
  return {id:"x-for-you",async collect({source,cursor,limit,signal}){
    const {accountId,pagesPerRun}=xForYouConfig(source.config);
    if(!Number.isInteger(limit)||limit<100||limit>500)throw Error("X_FEED_PAGE_SIZE: use 100–500; provider pages cannot be safely truncated");
    if(cursor!==undefined&&(typeof cursor!=="string"||!cursor||cursor.length>4000||/[\u0000-\u001f]/.test(cursor)))throw Error("X_FEED_INVALID_CURSOR");
    if(signal.aborted)throw Error("X_PROVIDER_CANCELLED");
    const credentials=(options.credentials??xEnvironmentCredentials)();checkCredentials(credentials);
    let used=budgets.get(signal);if(!used){used=new Map();budgets.set(signal,used);}
    const count=used.get(source.id)??0;
    if(count>=pagesPerRun)throw Error("X_PROVIDER_REQUEST_BUDGET_REACHED");
    used.set(source.id,count+1);
    let raw:unknown;
    try{raw=await (options.transport??requestXForYou)({...credentials,cursor,signal});}
    catch(error){
      const code=error instanceof Error&&/^X_PROVIDER_[A-Z_]+(?:_\d{3})?$/.test(error.message)?error.message:"X_PROVIDER_REQUEST_FAILED";
      throw Error(code);
    }
    if(signal.aborted)throw Error("X_PROVIDER_CANCELLED");
    const page=object(raw);
    if(page.userId!==accountId)throw Error("X_PROVIDER_ACCOUNT_MISMATCH");
    if(!Array.isArray(page.tweets)||page.tweets.length>100||typeof page.has_more!=="boolean")throw Error("X_PROVIDER_INVALID_PAGE");
    let nextCursor:string|undefined;
    if(page.has_more){
      const continuation=page.next_cursor;
      if(typeof continuation!=="string"||!continuation||continuation.length>4000||
        continuation===cursor||/[\u0000-\u001f]/.test(continuation)||
        [credentials.apiKey,credentials.accountSession].some(s=>continuation.includes(s)))throw Error("X_PROVIDER_INVALID_CURSOR");
      nextCursor=continuation;
    }
    const observations=page.tweets.map(post=>normalizeXPost(post,[credentials.apiKey,credentials.accountSession]));
    return {observations,nextCursor,hasMore:page.has_more&&count+1<pagesPerRun};
  }};
}
export const xForYouSource=createXForYouSource();
