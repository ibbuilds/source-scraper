/** Compare a saved decision packet with independent held-out human labels. */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
export function calibrateTopic(labels,packet){
 if(labels?.schemaVersion!==1||labels.split!=="held-out"||labels.labelOrigin!=="human"||!Array.isArray(labels.records)||!labels.records.length||labels.records.length>10000||!/^([a-f0-9]{64})$/.test(labels.profileHash)||labels.profileHash!==packet?.profileHash||!Array.isArray(packet.records))throw Error("Independent held-out human labels and a matching profile are required");
 const predictions=new Map(packet.records.map(r=>[r.key,r])),seen=new Set(),counts={truePositive:0,falsePositive:0,trueNegative:0,falseNegative:0,uncertainPositive:0,uncertainNegative:0};
 for(const label of labels.records){
  if(!label||typeof label.key!=="string"||seen.has(label.key)||!["pertinent","irrelevant"].includes(label.state)||!/^[a-f0-9]{64}$/.test(label.fingerprint))throw Error("INVALID_CALIBRATION_LABEL");seen.add(label.key);
  const prediction=predictions.get(label.key);if(!prediction||prediction.fingerprint!==label.fingerprint)throw Error("MISSING_OR_STALE_CALIBRATION_EVIDENCE");
  const state=prediction.decision?.state??"uncertain";if(!["pertinent","irrelevant","uncertain"].includes(state))throw Error("INVALID_CALIBRATION_DECISION");
  counts[state==="uncertain"?(label.state==="pertinent"?"uncertainPositive":"uncertainNegative"):state==="pertinent"?(label.state==="pertinent"?"truePositive":"falsePositive"):(label.state==="irrelevant"?"trueNegative":"falseNegative")]++;
 }
 const ratio=(n,d)=>d?n/d:null,positives=counts.truePositive+counts.falseNegative+counts.uncertainPositive,automatic=counts.truePositive+counts.falsePositive,uncertain=counts.uncertainPositive+counts.uncertainNegative;
 return {schemaVersion:1,profileHash:labels.profileHash,sample:labels.records.length,counts,precision:ratio(counts.truePositive,automatic),recall:ratio(counts.truePositive,positives),coverage:ratio(labels.records.length-uncertain,labels.records.length),reviewLoad:uncertain,omittedRelevant:counts.falseNegative,guaranteedAccuracy:false,notice:"Recall includes abstained positives as not automatically recovered. Do not tune prompts/examples on this held-out set or treat model confidence as calibrated probability."};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length!==4)throw Error("Usage: node scripts/calibrate-topic.mjs human-labels.json decision-packet.json");console.log(JSON.stringify(calibrateTopic(JSON.parse(readFileSync(process.argv[2],"utf8")),JSON.parse(readFileSync(process.argv[3],"utf8"))),null,2));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
