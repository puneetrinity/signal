import { describe, expect, it } from 'vitest';
import { calculateExperience, DAYS_PER_YEAR, experienceDisplay, experienceEligibility, type ExperienceEnvelope } from '../experience';
const asOf = '2025-01-01T00:00:00.000Z';
const exact = (years: number): ExperienceEnvelope => ({ version: 'recorded-experience-v1', asOf,
  status: 'measured', lowerDays: years * DAYS_PER_YEAR, upperDays: years * DAYS_PER_YEAR,
  display: `${years.toFixed(1)} years`, reason: 'recorded_intervals' });

describe('sealed recorded experience', () => {
  it.each(['T00:00:00','T12:34:56.123Z','T23:59:59+05:30'])('reads provider timestamps %s as validated calendar dates',suffix=>{
    const dates=[{start:'2017-01-01',end:'2025-01-01'}];
    expect(calculateExperience([{start:dates[0].start+suffix,end:dates[0].end+suffix}],asOf)).toEqual(calculateExperience(dates,asOf));
  });
  it.each(['2020-02-30T00:00:00','2020-01-01T24:00:00','2020-01-01T00:60:00','2020-01-01T00:00:00junk'])('refuses malformed timestamp %s',start=>{
    expect(calculateExperience([{start,ongoing:true}],asOf).status).toBe('incomplete');
  });
  it('does not discard people who manage internships',()=>{
    expect(calculateExperience([{title:'Internship Program Manager',start:'2020-01-01',end:'2022-01-01'}],asOf).lowerDays).toBe(731);
    expect(calculateExperience([{title:'Intern Relations Manager',start:'2020-01-01',end:'2022-01-01'}],asOf).lowerDays).toBe(731);
  });
  it('clips partial starts to the observation day and honors explicit end dates over current labels',()=>{
    expect(calculateExperience([{start:'2025',ongoing:true}],asOf)).toMatchObject({status:'measured',lowerDays:0});
    expect(calculateExperience([{start:'2024-12',ongoing:true}],asOf).status).toBe('bounded');
    expect(calculateExperience([{start:'2020-01-01',end:'2022-01-01T00:00:00',ongoing:true}],asOf).lowerDays).toBe(731);
  });
  it('unions concurrent employment and duplicate promotions rather than summing companies', () => {
    const roles = [{start:'2020-01-01',end:'2022-01-01'}, {start:'2021-01-01',end:'2023-01-01'}];
    expect(calculateExperience([...roles, roles[0]], asOf)).toMatchObject({status:'measured',lowerDays:1096,upperDays:1096});
  });
  it('excludes internships before union and missing-date checks, not International companies or roles', () => {
    expect(calculateExperience([{title:'Intern'}, {title:'International Account Executive',start:'2020-01-01',end:'2022-01-01'}], asOf).lowerDays).toBe(731);
    expect(calculateExperience([{title:'Software Engineering Intern',start:'2018-01-01',end:'2020-01-01'},
      {title:'Engineer',start:'2020-01-01',end:'2022-01-01'}], asOf).lowerDays).toBe(731);
    expect(calculateExperience([{employmentType:'internship'}], asOf)).toMatchObject({status:'measured',lowerDays:0,reason:'internships_only'});
  });
  it('missing history is not zero; partial job records prevent a complete total', () => {
    expect(calculateExperience([],asOf)).toMatchObject({status:'unavailable',lowerDays:null});
    expect(calculateExperience([{start:'2020-01-01',end:'2022-01-01'},{}],asOf)).toMatchObject({status:'incomplete',lowerDays:null});
    expect(calculateExperience([{start:'2020-01-01'}],asOf).status).toBe('incomplete');
  });
  it('uses only explicit ongoing marker and sealed as-of, no ambient clock', () => {
    expect(calculateExperience([{start:'2023-01-01',ongoing:true}],asOf).lowerDays).toBe(731);
    expect(() => calculateExperience([], '2025-02-30T00:00:00.000Z')).toThrow();
    expect(calculateExperience([{start:'2020-02-30',end:'2022-01-01'}],asOf).status).toBe('incomplete');
    expect(calculateExperience([{start:'2026-01-01',ongoing:true}],asOf).status).toBe('incomplete');
  });
  it('preserves uncertainty in month/year dates', () => {
    const value=calculateExperience([{start:'2019',end:'2025-01-01'}],asOf);
    expect(value.lowerDays).toBeLessThan(value.upperDays!);
    expect(value.status).toBe('bounded');
    expect(experienceEligibility(value,{minimum:6,maximum:10},['met'])).toBe('uncertain_boundary');
  });
  it('does not extend a pre-epoch interval to the Unix epoch', () => {
    expect(calculateExperience([{start:'1960-01-01',end:'1961-01-01'}],asOf)).toMatchObject({lowerDays:366,upperDays:366});
  });
  it.each([[3.99,'outside_experience_range'],[4,'wider'],[5.99,'wider'],[6,'in_range'],[10,'in_range'],[10.01,'wider'],[12,'wider'],[12.01,'outside_experience_range']] as const)
    ('classifies %s years without rounding', (years,expected) => {
      expect(experienceEligibility(exact(years),{minimum:6,maximum:10},['met','met'])).toBe(expected);
    });
  it('requires a nonempty all-met skill set only for the wider group', () => {
    for(const skills of [[],['unknown'],['met','unknown'],['not_met']] as const) {
      expect(experienceEligibility(exact(5),{minimum:6,maximum:10},skills)).toBe('wider_skills_not_established');
      expect(experienceEligibility(exact(8),{minimum:6,maximum:10},skills)).toBe('in_range');
    }
  });
  it('has no upper cap for minimum-only and no years restriction without a criterion', () => {
    expect(experienceEligibility(exact(30),{minimum:6},[])).toBe('in_range');
    expect(experienceEligibility(calculateExperience([],asOf),null,[])).toBe('unconstrained');
    expect(experienceEligibility(calculateExperience([],asOf),{minimum:6},['met'])).toBe('experience_unavailable');
  });
  it('displays a boundary qualifier, never the wrong eligibility band', () => {
    expect(experienceDisplay(exact(5.99),{minimum:6,maximum:10})).toBe('Below 6 years');
    expect(experienceDisplay(exact(10.01),{minimum:6,maximum:10})).toBe('Above 10 years');
  });
});
