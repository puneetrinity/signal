import { describe, expect, it } from 'vitest';
import { briefPayloadSchema, createRankingContract, rankingContractSchema, rankingHash, type Criterion } from '../contracts';
import { normalizeSkillName, skillAlternativesFromEditor } from '../skill-alternatives';
import { adaptProfile } from '../evidence';
import { scoreEvidence } from '../score';
import fixtures from '../../../../../research/fixtures/approved-skills-v1.json';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const asOf = '2026-10-08T00:00:00.000Z';
const skill = (primary = 'AWS', alternatives: string[] = ['Amazon Web Services'], n = 1): Criterion => ({
  id: id(n), label: primary, subject: 'skill', class: 'must_have',
  requirement: { kind: 'accepted_skills', primary, alternatives },
  use: 'assessment', evidenceKinds: ['profile_evidence'], provenance: { kind: 'recruiter_edit' },
});
const payload = (criteria = [skill()]) => ({ schemaVersion: 3, compilerVersion: 3, taxonomyVersion: 3, criteria });
const contract = (criteria = [skill()]) => createRankingContract(id(50), 'a'.repeat(64), payload(criteria));
const evidence = (skills: string[]) => adaptProfile({
  candidateId: 'synthetic-person', organizationRef: '1', sourceVersion: 'synthetic-v1', observedAt: asOf,
  profile: { skills: { professional_network_skills: skills } },
});
describe('approved skill names, never a hidden taxonomy', () => {
  it.each(fixtures.normalization)('uses Unicode 16 for $input', ({input,expected}) => {
    expect(normalizeSkillName(input)).toBe(expected);
  });
  it('uses approved equivalents and awards a criterion only once', () => {
    for (const skills of [['AWS'], ['Amazon Web Services'], ['AWS', 'Amazon Web Services']]) {
      expect(scoreEvidence(contract(), evidence(skills), asOf)).toMatchObject({ N: 3, D: 3, L: 3_000_000 });
    }
  });
  it.each([['AWS', 'Amazon Web Services'], ['Node.js', 'NodeJS'], ['Java', 'JavaScript'], ['C', 'C++']])(
    'does not invent %s = %s', (primary, candidate) => {
      expect(scoreEvidence(contract([skill(primary, [])]), evidence([candidate]), asOf).N).toBe(0);
    },
  );
  it('allows literal non-tech compound skill names without inference', () => {
    expect(scoreEvidence(contract([skill('Research and Development', [])]), evidence(['research and development']), asOf).N).toBe(3);
    expect(scoreEvidence(contract([skill('Research and Development', [])]), evidence(['Research', 'Development']), asOf).N).toBe(0);
  });
  it('normalizes Unicode/whitespace, not punctuation or accents', () => {
    expect(normalizeSkillName(' ＡＷＳ  ')).toBe('aws');
    expect(normalizeSkillName('Cafe\u0301')).toBe('café');
    expect(normalizeSkillName('C++')).not.toBe(normalizeSkillName('C'));
    expect(skillAlternativesFromEditor(' Amazon Web Services\n\n Amazon AWS \n')).toEqual(['Amazon Web Services', 'Amazon AWS']);
  });
  it('refuses blanks, controls, normalized duplicate names and more than 20', () => {
    for (const aliases of [[''], ['\t'], ['AWS'], ['ＡＷＳ'], ['Amazon\u200bAWS'], Array.from({length:20}, (_,i)=>'alias'+i)]) {
      expect(briefPayloadSchema.safeParse(payload([skill('AWS', aliases)])).success).toBe(false);
    }
    expect(briefPayloadSchema.safeParse(payload([skill('AWS', Array.from({length:19},(_,i)=>'alias'+i))])).success).toBe(true);
  });
  it('refuses overlaps across different skill criteria and wrong subjects', () => {
    expect(briefPayloadSchema.safeParse(payload([skill(), skill('Cloud', ['amazon web services'], 2)])).success).toBe(false);
    expect(briefPayloadSchema.safeParse(payload([{...skill(),subject:'domain'}])).success).toBe(false);
  });
  it('checks protected text in alternatives as well as labels', () => {
    expect(briefPayloadSchema.safeParse(payload([skill('AWS',['young'])])).success).toBe(false);
  });
  it('enforces evidence permissions and missing is unknown', () => {
    const limited = contract([{...skill(), evidenceKinds:['verified_document']}]);
    expect(scoreEvidence(limited, evidence(['AWS']), asOf).N).toBe(0);
    expect(scoreEvidence(contract(), evidence([]), asOf).assessments[0].state).toBe('unknown');
  });
  it('rejects mixed tuples even with a recomputed valid hash', () => {
    const {contractHash: _ignored, ...body} = contract();
    const changed = {...body, localMatchVersion:'rubric-local-match-v3'};
    expect(rankingContractSchema.safeParse({...changed, contractHash:rankingHash(changed)}).success).toBe(false);
  });
  it('keeps historical alias behavior separate and forbids silent shape upgrades', () => {
    const oldPayload = {schemaVersion:2,compilerVersion:2,taxonomyVersion:2,criteria:[
      {...skill('Node.js', []),requirement:{kind:'text',value:'Node.js'}},
    ]};
    const old = createRankingContract(id(50),'a'.repeat(64),oldPayload);
    expect(old.policyVersion).toBe('rubric-range-v1');
    expect(scoreEvidence(old,evidence(['NodeJS']),asOf).N).toBe(3);
    expect(briefPayloadSchema.safeParse({...oldPayload,criteria:[skill()]}).success).toBe(false);
    expect(briefPayloadSchema.safeParse({...oldPayload,schemaVersion:3,compilerVersion:3,taxonomyVersion:3}).success).toBe(false);
  });
  it('approved names change contract hash; source display does not change score', () => {
    expect(contract().contractHash).not.toBe(contract([skill('AWS',[])]).contractHash);
    const e=evidence(['AWS']);
    expect(scoreEvidence(contract(), {...e,presentationSource:'pool'},asOf)).toEqual(
      scoreEvidence(contract(), {...e,presentationSource:'discovered'},asOf));
  });
});
