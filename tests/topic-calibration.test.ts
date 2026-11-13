import {test} from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error Build-free reporting script has no declaration file.
import {calibrateTopic} from "../scripts/calibrate-topic.mjs";
test("held-out reporting counts abstentions as review work and never inflates recall",()=>{
 const profileHash="a".repeat(64),fingerprint="b".repeat(64),labels={schemaVersion:1,split:"held-out",labelOrigin:"human",profileHash,records:[{key:"one",fingerprint,state:"pertinent"},{key:"two",fingerprint,state:"pertinent"},{key:"three",fingerprint,state:"irrelevant"}]},packet={profileHash,records:[{key:"one",fingerprint,decision:{state:"pertinent"}},{key:"two",fingerprint,decision:{state:"uncertain"}},{key:"three",fingerprint,decision:{state:"pertinent"}}]};
 const report=calibrateTopic(labels,packet);assert.equal(report.precision,0.5);assert.equal(report.recall,0.5);assert.equal(report.reviewLoad,1);assert.equal(report.guaranteedAccuracy,false);
 assert.throws(()=>calibrateTopic({...labels,labelOrigin:"agent"},packet),/human/);assert.throws(()=>calibrateTopic({...labels,records:[labels.records[0],labels.records[0]]},packet),/INVALID/);assert.throws(()=>calibrateTopic(labels,{...packet,records:packet.records.slice(1)}),/STALE/);
});
