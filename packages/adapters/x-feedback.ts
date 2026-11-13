import {spawn} from "node:child_process";
import {isAbsolute} from "node:path";
import {existsSync} from "node:fs";
import {workerPath} from "./x-local.ts";
/** Fixed first-party operations; cookies are passed only into the existing isolated worker. */
export async function xFeedback(accountId:string,postId:string,operation:"inspect_x_like"|"like_x_post",signal:AbortSignal,expected?:{postTextHash:string;directUrl?:string;resourceMemory:string;resourceUrl?:string;target?:"post";decisionId?:string;profileHash?:string}):Promise<{accountId:string;postId:string;favorited?:boolean;requested?:boolean}>{
  if(process.env.SOURCE_SCRAPER_X_LIKES_APPROVED!=="local-likes-only")throw Error("X_LOCAL_LIKES_APPROVAL_REQUIRED");
  if(!/^\d{1,30}$/.test(accountId)||!/^\d{1,30}$/.test(postId))throw Error("X_LOCAL_POST_INVALID");
  const python=process.env.SOURCE_SCRAPER_X_PYTHON;
  if(!python||!isAbsolute(python)||!existsSync(python))throw Error("X_LOCAL_PYTHON_REQUIRED");
  if(!process.env.SOURCE_SCRAPER_X_ACCOUNT_SESSION||!process.env.SOURCE_SCRAPER_X_CSRF)throw Error("X_LOCAL_SESSION_REQUIRED");
  if(operation==="like_x_post"&&(!expected||!/^[a-f0-9]{64}$/.test(expected.postTextHash)||!isAbsolute(expected.resourceMemory)||(expected.target==="post"?(!expected.decisionId||expected.decisionId.length>100||!/^[a-f0-9]{64}$/.test(expected.profileHash??"")):(!/^https?:\/\//.test(expected.directUrl??"")||!/^https:\/\//.test(expected.resourceUrl??"")))))throw Error("X_LOCAL_POST_SNAPSHOT_REQUIRED");
  signal.throwIfAborted();
  const env:NodeJS.ProcessEnv={};for(const k of ["SYSTEMROOT","WINDIR","TEMP","TMP","LOCALAPPDATA","USERPROFILE","SOURCE_SCRAPER_X_ACCOUNT_SESSION","SOURCE_SCRAPER_X_CSRF","SOURCE_SCRAPER_X_LIKES_APPROVED"])if(process.env[k])env[k]=process.env[k];
  return new Promise((resolve,reject)=>{
    const child=spawn(python,["-I",workerPath()],{env,windowsHide:true,shell:false,stdio:["pipe","pipe","pipe"]});
    let data="",error:Error|undefined;
    const stop=()=>{error=Error("X_LOCAL_LIKE_UNCERTAIN");child.kill();};
    const timeout=setTimeout(stop,30000);signal.addEventListener("abort",stop,{once:true});
    child.stdout.on("data",(b:Buffer)=>{data+=b.toString("utf8");if(Buffer.byteLength(data)>32000)stop();});child.stderr.on("data",()=>{});
    child.on("error",()=>{error=Error("X_LOCAL_WORKER_FAILED");});
    child.on("close",()=>{clearTimeout(timeout);signal.removeEventListener("abort",stop);if(error){reject(error);return;}try{
      const r=JSON.parse(data.trim());if(r.error){const code=r.error.message;throw Error(/^X_LOCAL_[A-Z0-9_]+$/.test(code)?code:"X_LOCAL_LIKE_UNCERTAIN");}
      const value=r.result?.structuredContent;if(value?.accountId!==accountId||value?.postId!==postId)throw Error("X_LOCAL_ACCOUNT_MISMATCH");resolve(value);
    }catch(e){reject(e instanceof Error?e:Error("X_LOCAL_LIKE_UNCERTAIN"));}});
    child.stdin.on("error",()=>{error=Error("X_LOCAL_LIKE_UNCERTAIN");});
    child.stdin.end(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:operation,arguments:{accountId,postId,...expected}}})+"\n");
  });
}
