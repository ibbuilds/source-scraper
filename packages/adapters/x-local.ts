import {xMetrics} from "./x-metrics.ts";
import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {homedir} from "node:os";
import {isAbsolute,join} from "node:path";
import {X_LOCAL_WORKER as worker} from "./x-local-worker.ts";
import {createMcpStdioSource} from "./mcp-stdio.ts";
import {normalizeUrl,isXUrl,safeHostname} from "../core/url.ts";
import type {JsonRecord,SourceAdapter,SourceContext,ObservationPage} from "../sdk/contracts.ts";

export function xLocalConfig(config:JsonRecord):{accountId:string;pagesPerRun:number}{
  if(Object.keys(config).some(k=>!["accountId","pagesPerRun"].includes(k))||typeof config.accountId!=="string"||!/^\d{1,30}$/.test(config.accountId))throw Error("X_LOCAL_CONFIG: supply a numeric accountId; no credentials or commands in manifests");
  const pages=config.pagesPerRun??1;
  if(!Number.isInteger(pages)||Number(pages)<1||Number(pages)>10)throw Error("X_LOCAL_CONFIG: pagesPerRun must be 1–10");
  return {accountId:config.accountId,pagesPerRun:Number(pages)};
}
export function workerPath():string{
  let root=process.env.LOCALAPPDATA||join(homedir(),".local","share");
  for(const folder of ["SourceScraper","runtime","workers"]){
    root=join(root,folder);
    if(existsSync(root)){if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory())throw Error("X_LOCAL_WORKER_PATH");}
    else mkdirSync(root,{mode:0o700});
  }
  const digest=createHash("sha256").update(worker).digest("hex"),path=join(root,digest+".py");
  if(!existsSync(path))writeFileSync(path,worker,{flag:"wx",mode:0o600});
  if(lstatSync(path).isSymbolicLink()||createHash("sha256").update(readFileSync(path)).digest("hex")!==digest)throw Error("X_LOCAL_WORKER_CHANGED");
  return path;
}
const safeWorkerErrors=new Set(["X_LOCAL_SESSION_REQUIRED","X_LOCAL_LIBRARY_VERSION",
  "X_LOCAL_DESTINATION_DENIED","X_LOCAL_OPERATION_DENIED","X_LOCAL_ACCOUNT_MISMATCH",
  "X_LOCAL_PAGE_OVERFLOW","X_LOCAL_INPUT_LIMIT","X_LOCAL_METHOD_DENIED","X_LOCAL_READ_FAILED","X_LOCAL_TIMEOUT","X_LOCAL_TRANSPORT_FAILED","X_LOCAL_RUNTIME_UNAVAILABLE",
  ...Array.from({length:300},(_,i)=>"X_LOCAL_HTTP_"+(i+300))]);
const localWorkerSource=createMcpStdioSource(safeWorkerErrors);
export function createXLocalSource(options:{collect?:(context:SourceContext)=>Promise<ObservationPage>;workerPath?:()=>string}={}):SourceAdapter{
  const budgets=new WeakMap<AbortSignal,Map<string,number>>();
  return {id:"x-for-you-local",async collect(context){
    const {source,cursor,limit,signal}=context,{accountId,pagesPerRun}=xLocalConfig(source.config);
    if(signal.aborted)throw Error("X_LOCAL_CANCELLED");
    if(process.env.SOURCE_SCRAPER_X_LOCAL_APPROVED!=="local-read-only")throw Error("X_LOCAL_APPROVAL_REQUIRED");
    const token=process.env.SOURCE_SCRAPER_X_ACCOUNT_SESSION,csrf=process.env.SOURCE_SCRAPER_X_CSRF,python=process.env.SOURCE_SCRAPER_X_PYTHON;
    if(!token||!csrf||[token,csrf].some(s=>s.length>8192||/[^\x21-\x7e]/.test(s)))throw Error("X_LOCAL_SESSION_REQUIRED");
    if(!python||!isAbsolute(python)||!existsSync(python))throw Error("X_LOCAL_PYTHON_REQUIRED");
    if(!Number.isInteger(limit)||limit<100||limit>500)throw Error("X_LOCAL_PAGE_SIZE: use 100–500");
    if(cursor!==undefined&&(!cursor||cursor.length>4000||/[\u0000-\u001f]/.test(cursor)||[token,csrf].some(s=>cursor.includes(s))))throw Error("X_LOCAL_CURSOR_INVALID");
    let used=budgets.get(signal);if(!used){used=new Map();budgets.set(signal,used);}
    const budget=context.pageBudget??pagesPerRun;
    if(!Number.isInteger(budget)||budget<1||budget>1000)throw Error("X_LOCAL_CONFIG: invalid runtime page budget");
    const count=used.get(source.id)??0;if(count>=budget)throw Error("X_LOCAL_WINDOW_COMPLETE");used.set(source.id,count+1);
    let page:ObservationPage;
    try{page=await (options.collect??localWorkerSource.collect.bind(localWorkerSource))({...context,source:{id:source.id,adapter:"mcp-stdio",config:{
      command:python,args:["-I",(options.workerPath??workerPath)()],tool:"read_x_for_you",protocol:"legacy",
      arguments:{accountId},passEnv:["SOURCE_SCRAPER_X_ACCOUNT_SESSION","SOURCE_SCRAPER_X_CSRF"],timeoutMs:30000}}});}
    catch(error){
      const code=error instanceof Error?/X_LOCAL_[A-Z0-9_]+/.exec(error.message)?.[0]:undefined;
      if(!code&&error instanceof Error){
        if(/timed out|timeout/i.test(error.message))throw Error("X_LOCAL_TIMEOUT");
        if(/process could not start/i.test(error.message))throw Error("X_LOCAL_RUNTIME_UNAVAILABLE");
        if(/server ended|transport failed/i.test(error.message))throw Error("X_LOCAL_TRANSPORT_FAILED");
      }
      throw Error(code&&safeWorkerErrors.has(code)?code:"X_LOCAL_READ_FAILED: check local session/runtime; no automatic login, challenge bypass or paid fallback");
    }
    const clean=(s:string)=>[token,csrf].reduce((value,secret)=>value.split(secret).join("[redacted]"),s);
    const observations=page.observations.map(item=>{
      const original=new URL(item.url||"");
      if(item.type!=="x-post"||!/^\d{1,30}$/.test(item.id)||original.protocol!=="https:"||original.hostname!=="x.com"||original.search||original.hash||!/^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,30}$/.test(original.pathname)||!original.pathname.endsWith("/status/"+item.id))throw Error("X_LOCAL_POST_INVALID");
      const urls=(item.urls||[]).flatMap(value=>{try{const normalized=normalizeUrl(value),host=safeHostname(normalized);return isXUrl(normalized)||host==="t.co"||[token,csrf].some(s=>normalized.includes(s))?[]:[normalized];}catch{return [];}});
      const media=(item.media||[]).filter(value=>{try{return new URL(value).protocol==="https:"&&["pbs.twimg.com","video.twimg.com"].includes(new URL(value).hostname)&&![token,csrf].some(secret=>value.includes(secret));}catch{return false;}});
      return {...item,title:clean(item.title||"X post"),text:clean(item.text||""),urls,media,
        attributes:{author:clean(String(item.attributes?.author||"")),collector:"twifork",feed:"for-you",liveVerification:"not-attested-by-code",mediaEvidenceComplete:item.attributes?.mediaEvidenceComplete===true&&media.length===item.attributes?.mediaCount,metrics:xMetrics(item.attributes?.metrics)}};
    });
    if(page.nextCursor&&([token,csrf].some(s=>page.nextCursor!.includes(s))||page.nextCursor.length>4000||/[\u0000-\u001f]/.test(page.nextCursor)))throw Error("X_LOCAL_CURSOR_INVALID");
    const exhausted=!page.hasMore||page.observations.length===0;
    return {observations,nextCursor:exhausted?undefined:page.nextCursor,hasMore:!exhausted&&count+1<budget,
      stopReason:exhausted?"end-of-window":count+1>=budget?"work-limit":undefined};
  }};
}
export const xLocalSource=createXLocalSource();
