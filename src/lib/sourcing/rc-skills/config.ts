/** Read only the gate until enabled. Never inspect credentials on a dark path. */
export function rcSkillsEnabled(env: Readonly<Record<string,string|undefined>> = process.env): boolean {
  const raw=env.RC_SKILLS_ENABLED;
  if(raw!==undefined && raw!=='true' && raw!=='false') throw Error('RC_CONFIGURATION_INVALID');
  return raw==='true';
}
export const RC_LIMITS = Object.freeze({
  newlyPurchased:300, concurrencyPerRun:10, directConcurrencyPerRun:20, sharedRequestsPerMinute:450,
  dispatchDeadlineMs:300_000, timeoutMs:10_000, responseBytes:1_048_576,
  maxSkills:500, skillCharacters:500, horizonDays:1095,
});
