import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore The deployment helper is intentionally plain Node.js.
import {releasePlan} from '../scripts/release-policy.mjs';
const a='a'.repeat(40), b='b'.repeat(40);
test('release policy never moves a published tag or fails maintenance on an unchanged version',()=>{
 assert.equal(releasePlan({testedSha:a,mainSha:a}).publish,true);
 assert.equal(releasePlan({testedSha:a,mainSha:b}).publish,false);
 assert.equal(releasePlan({testedSha:a,mainSha:a,tagSha:a,releaseExists:true}).publish,false);
 assert.equal(releasePlan({testedSha:a,mainSha:a,tagSha:b,releaseExists:true}).publish,false);
 assert.equal(releasePlan({testedSha:a,mainSha:a,tagSha:a,releaseExists:false}).publish,true);
 assert.throws(()=>releasePlan({testedSha:a,mainSha:a,tagSha:b}),/new version/);
 assert.throws(()=>releasePlan({testedSha:a,mainSha:a,releaseExists:true}),/without its tag/);
 assert.throws(()=>releasePlan({testedSha:'main',mainSha:a}),/Invalid/);
});
