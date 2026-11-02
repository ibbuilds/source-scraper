import {test} from "node:test";
import assert from "node:assert/strict";
import {createMcpStdioSource} from "../packages/adapters/mcp-stdio.ts";

const context=(message:string)=>({source:{id:"fixed-worker",adapter:"mcp-stdio",config:{command:"node",protocol:"legacy",
  tool:"read_x_for_you",args:["-e",`
    require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const request=JSON.parse(line);if(!('id' in request))return;
      const result=request.method==='initialize'?{protocolVersion:'2025-11-25'}:{tools:[{name:'read_x_for_you'}]};
      console.log(JSON.stringify({jsonrpc:'2.0',id:request.id,...(request.method==='tools/call'?
        {error:{code:-32000,message:${JSON.stringify(message)}}}:{result})}));
    });`] }},limit:100,signal:new AbortController().signal});

test("fixed worker errors survive the stdio boundary only when explicitly allowlisted",async()=>{
  const generic=createMcpStdioSource(),trusted=createMcpStdioSource(new Set(["X_LOCAL_HTTP_403"]));
  await assert.rejects(generic.collect(context("X_LOCAL_HTTP_403")),error=>
    String(error).includes("-32000")&&!String(error).includes("X_LOCAL_HTTP_403"));
  await assert.rejects(trusted.collect(context("X_LOCAL_HTTP_403")),/X_LOCAL_HTTP_403/);
  for(const message of ["private-session-body","X_LOCAL_HTTP_403 private-session-body","X_LOCAL_SECRET_ABC123"]){
    await assert.rejects(trusted.collect(context(message)),error=>
      String(error).includes("-32000")&&!String(error).includes(message));
  }
});
