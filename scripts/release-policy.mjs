/** Immutable release decisions, shared by CI and offline regression tests. */
export function releasePlan({testedSha, mainSha, tagSha = null, releaseExists = false}) {
  for (const [label, value] of Object.entries({testedSha, mainSha, ...(tagSha ? {tagSha} : {})})) {
    if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw Error(`Invalid ${label}`);
  }
  if (releaseExists && !tagSha) throw Error('Release exists without its tag');
  if (mainSha !== testedSha) return {publish:false, reason:'A newer main commit must pass CI first'};
  if (tagSha && tagSha !== testedSha) {
    if (!releaseExists) throw Error('Existing tag differs from the tested commit; choose a new version');
    return {publish:false, reason:'Published version is immutable; increment the version for a new release'};
  }
  return {publish:!releaseExists, reason:releaseExists ? 'This tested commit is already published' : 'Publish the tested commit'};
}
