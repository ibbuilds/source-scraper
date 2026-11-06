import {fetchPublicText} from "./public-http.ts";
import {githubRepoPath,parseGithubMetadata} from "./metadata.ts";

export interface PublicResourceEvidence {
 version:1;url:string;checkedAt:string;status:"checked"|"pending";
 reason?:string;retryAfterSeconds?:number;
 repository?:{url:string;name:string;description:string;topics:string[];license:string;openSource:boolean;archived:boolean;disabled:boolean;homepage:string};
 rootEntries?:string[];readme?:string;
 package?:{name:string;description:string;main:string;module:string;exports:boolean;bin:boolean;workspaces:boolean;testScript:string};
 evidence:Array<{url:string;quote:string}>;
}
type Fetcher=typeof fetchPublicText;
/** Public evidence only. No model, session, executable evaluation or quality verdict. */
export async function collectResourceEvidence(raw:string,signal?:AbortSignal,fetcher:Fetcher=fetchPublicText):Promise<PublicResourceEvidence>{
 const parsed=new URL(raw);if(!["https:","http:"].includes(parsed.protocol)||parsed.username||parsed.password)throw Error("INVALID_RESOURCE_URL");
 const result:PublicResourceEvidence={version:1,url:raw,checkedAt:new Date().toISOString(),status:"pending",evidence:[]};
 const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000);
 let repo=githubRepoPath(raw),linkedInfo:any;
 if(!repo&&parsed.protocol==="https:"&&parsed.pathname==="/"){
  try{
   const page=await fetcher(raw,{accept:"text/html",types:["text/html"],maxBytes:120000,signal:deadline});
   const links=[...new Set([...page.body.matchAll(/href\s*=\s*["'](https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/?["']/gi)].map(m=>m[1]))].slice(0,2);
   for(const link of links){const candidate=githubRepoPath(link)!;const r=await fetcher(`https://api.github.com/repos/${candidate.owner}/${candidate.repo}`,{accept:"application/vnd.github+json",types:["application/json","application/vnd.github+json"],maxBytes:300000,signal:deadline});const info=JSON.parse(r.body);let homepage:URL;try{homepage=new URL(info.homepage);}catch{continue;}if(homepage.protocol==="https:"&&homepage.hostname.replace(/^www\./,"")===parsed.hostname.replace(/^www\./,"")&&homepage.pathname==="/"){repo=candidate;linkedInfo=info;result.evidence.push({url:raw,quote:`Public homepage links to ${link}; the repository identifies this same homepage.`});break;}}
  }catch(error){if(signal?.aborted)throw Error("Public resource verification cancelled");result.reason="Public source evidence incomplete; verification deferred";result.retryAfterSeconds=/HTTP 40[34]|HTTP 429/.test(String(error))?3600:600;return result;}
 }
 if(!repo||githubRepoPath(raw)&&parsed.pathname.split("/").filter(Boolean).length!==2){result.reason="Public source needs direct reusable-output and access verification; no repository-root or verified homepage relationship available";return result;}
 const endpoint=`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
 const get=async(path:string)=>{const r=await fetcher(endpoint+path,{accept:"application/vnd.github+json",types:["application/json","application/vnd.github+json"],maxBytes:300000,signal:deadline});return JSON.parse(r.body);};
 const text=(x:unknown,max=1500)=>typeof x==="string"?x.slice(0,max):"";
 const content=(x:any)=>{if(x?.encoding!=="base64"||typeof x.content!=="string"||x.content.length>400000)throw Error("PUBLIC_CONTENT_UNAVAILABLE");return Buffer.from(x.content,"base64").toString("utf8").slice(0,30000);};
 try{
  const info=linkedInfo??await get(""),metadata=parseGithubMetadata(info);
  if(info.private!==false||typeof info.archived!=="boolean"||typeof info.disabled!=="boolean"||typeof info.full_name!=="string")throw Error("PUBLIC_REPOSITORY_STATE_UNVERIFIED");
  result.repository={url:`https://github.com/${repo.owner}/${repo.repo}`,name:text(info.full_name,300),description:text(info.description),topics:Array.isArray(info.topics)?info.topics.filter((t:unknown)=>typeof t==="string").slice(0,50):[],license:metadata.license??"",openSource:metadata.access==="open_source",archived:info.archived===true,disabled:info.disabled===true,homepage:text(info.homepage)};
  result.evidence.push({url:endpoint,quote:`Public repository ${result.repository.name}; license ${result.repository.license||"not verified"}; archived=${result.repository.archived}; disabled=${result.repository.disabled}`});
  if(!result.repository.openSource||result.repository.archived||result.repository.disabled){result.reason="Open-source access and active repository evidence required";result.status="checked";return result;}
  const entries=await get("/contents");if(!Array.isArray(entries)||entries.length>2000)throw Error("PUBLIC_CONTENT_UNAVAILABLE");
  result.rootEntries=entries.map(e=>text(e?.name,200)).filter(Boolean);
  result.readme=content(await get("/readme"));
  result.evidence.push({url:result.repository.url+"#readme",quote:result.readme.replace(/\s+/g," ").slice(0,800)});
  if(result.rootEntries.includes("package.json")){
   const p=JSON.parse(content(await get("/contents/package.json"))),scripts=p.scripts&&typeof p.scripts==="object"?p.scripts:{};
   const tests=Object.entries(scripts).filter(([key,value])=>/^test(?::|$)/.test(key)&&typeof value==="string").map(([,value])=>value).join("; ");
   result.package={name:text(p.name,200),description:text(p.description),main:text(p.main,500),module:text(p.module,500),exports:Boolean(p.exports),bin:Boolean(p.bin),workspaces:Array.isArray(p.workspaces)?p.workspaces.length>0:Boolean(p.workspaces?.packages?.length),testScript:text(tests,1500)};
   result.evidence.push({url:result.repository.url+"/blob/HEAD/package.json",quote:`Package ${result.package.name}; exports=${result.package.exports}; main=${result.package.main}; module=${result.package.module}; workspaces=${result.package.workspaces}; test command=${result.package.testScript}`});
  }
  result.status="checked";return result;
 }catch(error){
  if(signal?.aborted)throw Error("Public resource verification cancelled");
  const message=error instanceof Error?error.message:"Public evidence unavailable";
  result.reason=/HTTP 40[34]|HTTP 429/.test(message)?"Public source access/rate limit; verification deferred":"Public source evidence incomplete; verification deferred";
  result.retryAfterSeconds=/HTTP 40[34]|HTTP 429/.test(message)?3600:600;
  return result;
 }
}
