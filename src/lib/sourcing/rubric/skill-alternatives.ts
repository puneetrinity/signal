import { z } from 'zod';

import { skillUnicodeData as unicode } from './skill-unicode-data';

/** Unicode 16.0.0 NFKC + default lowercase, independent of browser/Node ICU.
 * No skill equivalences, transliteration, accent removal or title inference.
 */
export function normalizeSkillName(value: string): string {
  const points: number[] = [];
  const append = (cp: number): void => {
    if (cp >= 0xAC00 && cp <= 0xD7A3) {
      const s = cp - 0xAC00;
      append(0x1100 + Math.floor(s / 588));
      append(0x1161 + Math.floor((s % 588) / 28));
      if (s % 28) append(0x11A7 + s % 28);
    } else if (unicode.decomp[cp]) {
      for (const decomposed of unicode.decomp[cp]) append(decomposed);
    } else {
      points.push(cp);
      const ccc = unicode.ccc[cp] ?? 0;
      if (ccc) for (let i = points.length - 1; i > 0 && (unicode.ccc[points[i-1]!] ?? 0) > ccc; i--) {
        [points[i-1], points[i]] = [points[i]!, points[i-1]!];
      }
    }
  };
  for (const character of value) append(character.codePointAt(0)!);
  const composed: number[] = [];
  let starter = -1, previousClass = 0;
  for (const cp of points) {
    const ccc = unicode.ccc[cp] ?? 0;
    let combined: number | undefined;
    const lead = composed[starter]!;
    if (starter >= 0 && (previousClass === 0 || previousClass < ccc)) {
      if (lead >= 0x1100 && lead <= 0x1112 && cp >= 0x1161 && cp <= 0x1175)
        combined = 0xAC00 + (lead - 0x1100) * 588 + (cp - 0x1161) * 28;
      else if (lead >= 0xAC00 && lead <= 0xD7A3 && (lead - 0xAC00) % 28 === 0 && cp > 0x11A7 && cp <= 0x11C2)
        combined = lead + cp - 0x11A7;
      else combined = unicode.compose[lead + ',' + cp];
    }
    if (combined !== undefined) composed[starter] = combined;
    else {
      if (ccc === 0) starter = composed.length;
      composed.push(cp); previousClass = ccc;
    }
  }
  const inRanges = (cp: number, ranges: Array<[number, number]>) =>
    ranges.some(([from, to]) => cp >= from && cp <= to);
  const lowered: number[] = [];
  for (let i = 0; i < composed.length; i++) {
    const cp = composed[i]!;
    if (cp === 0x03A3) {
      let before = i-1, after = i+1;
      while (before >= 0 && inRanges(composed[before]!, unicode.ignorable)) before--;
      while (after < composed.length && inRanges(composed[after]!, unicode.ignorable)) after++;
      const final = before >= 0 && inRanges(composed[before]!, unicode.cased) &&
        !(after < composed.length && inRanges(composed[after]!, unicode.cased));
      lowered.push(final ? 0x03C2 : 0x03C3);
    } else lowered.push(...(unicode.lower[cp] ?? [cp]));
  }
  return lowered.map(cp => String.fromCodePoint(cp)).join('').trim().replace(/\s+/gu, ' ');
}

const skillName = z.string().min(1).max(120).refine(
  value => normalizeSkillName(value).length > 0 && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value),
  'Use a nonblank skill name without control characters',
);
export const acceptedSkillsShape = z.object({
  kind: z.literal('accepted_skills'),
  primary: skillName,
  alternatives: z.array(skillName).max(19),
}).strict();
export type AcceptedSkills = z.infer<typeof acceptedSkillsShape>;
export const approvedSkillNames = (value: AcceptedSkills): string[] =>
  [value.primary, ...value.alternatives].map(normalizeSkillName);

/** Blank editor lines are discarded only at the explicit save boundary. */
export function skillAlternativesFromEditor(value: string): string[] {
  return value.split(/\r?\n/u).map(name => name.trim()).filter(Boolean);
}
export function duplicateSkillNames(value: AcceptedSkills): boolean {
  const names = approvedSkillNames(value);
  return new Set(names).size !== names.length;
}
export function overlappingSkillCriteria(
  criteria: readonly { id: string; requirement: { kind: string } }[],
): string[] {
  const owners = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const criterion of criteria) {
    if (criterion.requirement.kind !== 'accepted_skills') continue;
    for (const name of approvedSkillNames(criterion.requirement as AcceptedSkills)) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== criterion.id) {
        conflicts.add(owner);
        conflicts.add(criterion.id);
      }
      owners.set(name, criterion.id);
    }
  }
  return [...conflicts];
}
