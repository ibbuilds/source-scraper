import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";

test("public agent assessments preserve human review and selected entity v1 exports",()=>{
  const root=mkdtempSync(join(tmpdir(),"ss-agent-cli-")),binary=resolve(dirname(fileURLToPath(import.meta.url)),"../dist/source-scraper.mjs");
  const invoke=(args:string[],success=true)=>{
    const result=spawnSync(process.execPath,[binary,...args],{encoding:"utf8"});
    if(success){assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
    assert.notEqual(result.status,0);return result.stderr;
  };
  try{
    invoke(["init","--dir",root]);const flags=["--config",join(root,"project.json")];
    invoke(["run",...flags]);const entities=invoke(["query",...flags]).records;
    const key=entities[0].key,detail=invoke(["inspect",...flags,"--key",key]);
    const assessment={evidenceFingerprint:detail.fingerprint,rubric:"Synthetic rubric",recommendation:"recommend",reasons:["Source evidence"],uncertainties:[],references:[],actor:"test",model:"simulated"};
    const recorded=invoke(["assessment-record",...flags,"--key",key,"--record-json",JSON.stringify(assessment)]).record;
    assert.equal(recorded.recordType,"agent-assessment");
    assert.equal(invoke(["inspect",...flags,"--key",key]).entity.review,"pending");
    const selected=invoke(["export",...flags,"--keys-json",JSON.stringify([key])]);
    assert.equal(selected.schemaVersion,1);assert.equal(selected.count,1);assert.ok(selected.records[0].provenance);
    assert.match(invoke(["export",...flags,"--keys-json",JSON.stringify([key,key])],false),/Invalid selected keys/);
    assert.match(invoke(["export",...flags,"--keys-json",JSON.stringify([key]),"--limit","1"],false),/without paging/);
    assert.match(invoke(["assessment-record",...flags,"--key",key,"--record-json",JSON.stringify({...assessment,recommendation:["recommend"]})],false),/Invalid recommendation/);
    assert.match(invoke(["assessment-record",...flags,"--key",key,"--record-json",JSON.stringify({...assessment,evidenceFingerprint:"stale"})],false),/STALE_EVIDENCE/);
    invoke(["review",...flags,"--key",key,"--decision","approved","--reason","Explicit synthetic human decision"]);
    const after=invoke(["assessment-list",...flags,"--key",key]);assert.equal(after.records[0].stale,true);
    assert.equal(invoke(["inspect",...flags,"--key",key]).entity.review,"approved");
  }finally{rmSync(root,{recursive:true,force:true});}
});
