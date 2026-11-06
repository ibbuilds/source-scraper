import {test} from "node:test";import assert from "node:assert/strict";
import {collectResourceEvidence} from "../packages/connectors/resource-evidence.ts";
import {spawnSync} from "node:child_process";import {resolve} from "node:path";
const file=(content:string)=>({encoding:"base64",content:Buffer.from(content).toString("base64")});
test("public resource evidence reads bounded repository facts without issuing a quality verdict",async()=>{
 const calls:string[]=[];const data:Record<string,unknown>={
  "":{full_name:"org/ui",description:"UI components library",license:{spdx_id:"MIT"},private:false,topics:["ui-components"],archived:false,disabled:false},
  "/contents":[{name:"package.json"},{name:"tests"},{name:"src"}],"/readme":file("# UI library\n## Usage\n```js\nimport {Button} from 'ui'\n```\nExamples: https://example.org/demo"),"/contents/package.json":file(JSON.stringify({name:"ui",exports:"./src/index.js",scripts:{test:"node --test tests/*.test.js"}}))};
 const result=await collectResourceEvidence("https://github.com/org/ui",undefined,async(url,options)=>{calls.push(url);assert.ok(options.signal);assert.ok(options.maxBytes!<=300000);return {url,body:JSON.stringify(data[url.replace("https://api.github.com/repos/org/ui","")]),contentType:"application/json"};});
 assert.equal(result.status,"checked");assert.equal(result.repository?.openSource,true);assert.equal(result.package?.exports,true);assert.equal(result.evidence.length,3);assert.equal(calls.length,4);assert.equal("quality" in result,false);
});
test("missing license, archived sources and unsupported websites never become verified free output",async()=>{
 for(const info of [{license:{spdx_id:"NOASSERTION"}},{license:{spdx_id:"MIT"},archived:true}]){let calls=0;const result=await collectResourceEvidence("https://github.com/org/ui",undefined,async url=>{calls++;return {url,body:JSON.stringify({full_name:"org/ui",private:false,archived:false,disabled:false,...info}),contentType:"application/json"};});assert.equal(calls,1);assert.ok(result.reason);}
 const pending=await collectResourceEvidence("https://example.org/demo",undefined,async()=>{throw Error("No request allowed");});assert.equal(pending.status,"pending");assert.equal(pending.repository,undefined);
});
test("source errors and rate limits defer verification; cancellation is not recorded as success",async()=>{
 const deferred=await collectResourceEvidence("https://github.com/org/ui",undefined,async()=>{throw Error("Unusable public text response: HTTP 429");});assert.equal(deferred.status,"pending");assert.equal(deferred.retryAfterSeconds,3600);
 const abort=new AbortController();abort.abort();await assert.rejects(collectResourceEvidence("https://github.com/org/ui",abort.signal,async()=>{throw Error("cancelled");}),/cancelled/);
 await assert.rejects(collectResourceEvidence("https://secret@example.org/tool"),/INVALID_RESOURCE_URL/);
});

test("public homepage evidence requires the linked repository to identify that same homepage",async()=>{
 for(const homepage of ["https://tools.example/","https://unrelated.example/"]){
  const result=await collectResourceEvidence("https://tools.example/",undefined,async url=>{
   if(url==="https://tools.example/")return {url,body:'<a href="https://github.com/org/ui">Source code</a>',contentType:"text/html"};
   const suffix=url.replace("https://api.github.com/repos/org/ui","");const data:Record<string,unknown>={"":{full_name:"org/ui",private:false,archived:false,disabled:false,license:{spdx_id:"MIT"},homepage},"/contents":[],"/readme":file("# Usage\nPublic examples")};return {url,body:JSON.stringify(data[suffix]),contentType:"application/json"};
  });assert.equal(result.status,homepage.includes("unrelated")?"pending":"checked");assert.equal(result.url,"https://tools.example/");
 }
});

test("the packaged public CLI exposes evidence without a project, database, AI or account",()=>{
 const cli=resolve("dist/source-scraper.mjs"),run=(url:string)=>spawnSync(process.execPath,[cli,"resource-evidence","--url",url],{encoding:"utf8",timeout:5000});
 const result=run("https://example.org/tool");assert.equal(result.status,0,result.stderr);const data=JSON.parse(result.stdout);assert.equal(data.version,1);assert.equal(data.status,"pending");assert.equal(data.repository,undefined);assert.equal(run("file:///private-note.md").status,1);
});
