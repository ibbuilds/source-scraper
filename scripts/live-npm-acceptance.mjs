/**
 * Real public-source acceptance: reads npm's documented, unauthenticated
 * HTTPS package search endpoint. Never reads a personal vault or X session.
 * Reports only counts and schema checks; all fixtures live in a temp DB.
 */
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {existsSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";

const binary=resolve("dist/source-scraper.mjs");
const projectFile=resolve("examples/npm-react-ui/project.json");
const project=JSON.parse(readFileSync(projectFile,"utf8"));
assert.equal(project.id,"npm-react-ui-discovery");
assert.deepEqual(project.outputs,[],"The acceptance test must not invoke any output adapter");
assert.equal(project.sources.length,1);
assert.equal(project.sources[0].adapter,"public-json");
assert.equal(new URL(project.sources[0].config.url).hostname,"registry.npmjs.org");
if(!existsSync(binary))throw Error("Build the standalone CLI first");

const tmp=mkdtempSync(join(tmpdir(),"source-scraper-public-live-"));
const db=join(tmp,"live.sqlite"),exportFile=join(tmp,"export.json");
function invoke(args){
  const r=spawnSync(process.execPath,[binary,...args],{
    encoding:"utf8",timeout:90000,maxBuffer:4000000
  });
  if(r.error)throw r.error;
  assert.equal(r.status,0,
    "CLI failed: "+args.join(" ")+"\n"+String(r.stderr).slice(0,1500));
  try{return JSON.parse(r.stdout);}
  catch{throw Error("CLI returned invalid JSON: "+String(r.stdout).slice(0,700));}
}
const flags=["--config",projectFile,"--db",db];
try{
  const valid=invoke(["validate","--config",projectFile]);
  assert.equal(valid.valid,true);
  assert.equal(existsSync(db),false,"Validation must be read-only");
  const result=invoke(["run",...flags,"--page-size","3","--max-pages","10"]);
  assert.equal(result.result.success,true,
    "Public npm feed must finish successfully without an empty/partial run");
  const observed=result.result.observations;
  assert.ok(observed>=1&&observed<=8,
    "Unexpected number of real npm results: "+observed);
  assert.equal(existsSync(db),true,"The real run must persist an actual SQLite file");

  const found=invoke(["query",...flags,"--dataset","observations","--limit","30"]);
  assert.equal(found.schemaVersion,1);
  assert.equal(found.dataset,"observations");
  assert.equal(found.count,observed);
  const names=new Set();
  for(const entry of found.records){
    assert.ok(entry.itemId&&entry.connectionId==="npm-public-search");
    const observation=entry.observation;
    assert.equal(observation.type,"npm-package");
    assert.ok(typeof observation.id==="string"&&observation.id.length>0);
    assert.equal(observation.id,entry.itemId);
    assert.ok(typeof observation.title==="string"&&observation.title.length>0);
    assert.ok(observation.attributes&&typeof observation.attributes==="object");
    if(observation.url){
      const host=new URL(observation.url).hostname;
      assert.equal(host,"www.npmjs.com",
        "Observations must retain their canonical public package page");
    }
    names.add(observation.id);
  }
  assert.equal(names.size,observed,"Live source IDs must be unique");

  const entities=invoke(["query",...flags,"--dataset","entities","--limit","30"]);
  assert.equal(entities.schemaVersion,1);
  assert.equal(entities.count,observed);
  for(const entity of entities.records){
    assert.equal(entity.projectId,project.id);
    assert.equal(entity.type,"npm-package");
    assert.ok(entity.key.startsWith("@npm-registry:npm-package:"));
    assert.ok(Number.isFinite(entity.score)&&entity.score>=0&&entity.score<=100);
    assert.equal(entity.review,"pending");
    assert.equal(entity.observationCount,1);
  }

  const receipt=invoke(["export",...flags,"--out",exportFile]);
  assert.equal(receipt.count,entities.count);
  const exported=JSON.parse(readFileSync(exportFile,"utf8"));
  assert.equal(exported.schemaVersion,1);
  assert.equal(exported.projectId,project.id);
  assert.equal(exported.count,observed);
  assert.ok(exported.records.every(item=>
    item.provenance?.mentions?.length===1&&item.provenance?.mentionsTruncated===false),
  "Real source provenance is missing from the JSON export");

  // Approval is explicitly applied only to this disposable test DB.
  const selected=entities.records[0];
  const approved=invoke(["review",...flags,"--key",selected.key,
    "--decision","approved","--reason","Public-source test only; license not independently verified"]);
  assert.equal(approved.entity.review,"approved");
  const replay=invoke(["reprocess",...flags]);
  assert.ok(replay.result.reassessed>=observed);
  const reviewed=invoke(["inspect",...flags,"--key",selected.key]);
  assert.equal(reviewed.entity.review,"approved",
    "Offline reprocessing must not overwrite a human decision");
  assert.ok(reviewed.mentions.length>=1);

  // Do not print source content, author metadata or any environment secrets.
  console.log(JSON.stringify({
    source:"npm public registry search",sourceHost:"registry.npmjs.org",
    realNetwork:true,personalCredentialsUsed:false,
    projectId:project.id,observations:observed,distinctEntities:entities.count,
    versionedJson:exported.schemaVersion,
    provenanceVerified:true,manualReviewSurvivedOfflineReplay:true,
    obisidianVaultWrites:0,externalOutputDeliveries:0
  }));
}finally{rmSync(tmp,{recursive:true,force:true});}
