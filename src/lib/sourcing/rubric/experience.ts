/** Governed recorded employment only. No wall clock, provider total or score input. */
export const EXPERIENCE_VERSION = 'recorded-experience-v1' as const;
const DAY = 86_400_000;
export const DAYS_PER_YEAR = 365.2425;
export interface EmploymentInterval {
  title?: string;
  employmentType?: string;
  start?: string | null;
  end?: string | null;
  ongoing?: boolean;
}
export interface ExperienceEnvelope {
  version: typeof EXPERIENCE_VERSION;
  asOf: string;
  status: 'measured' | 'bounded' | 'incomplete' | 'unavailable';
  lowerDays: number | null;
  upperDays: number | null;
  display: string;
  reason: 'recorded_intervals' | 'no_history' | 'invalid_or_missing_dates' | 'internships_only';
}
type Bounds = readonly [number, number];

function utcDay(year: number, month: number, day: number): number | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY;
}

/** Partial dates are intervals, never silently January 1 or the first of a month. */
function dateBounds(raw: string | null | undefined): Bounds | null {
  if (typeof raw !== 'string') return null;
  // Provider employment timestamps describe calendar dates, not instants to
  // shift into another day. Validate the entire suffix before taking the date.
  const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))?$/.exec(raw);
  if (timestamp) {
    if (Number(timestamp[2]) > 23 || Number(timestamp[3]) > 59 || Number(timestamp[4]) > 59 ||
        Number(timestamp[6] ?? 0) > 23 || Number(timestamp[7] ?? 0) > 59) return null;
    raw = timestamp[1];
  }
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2] ?? 1), day = Number(match[3] ?? 1);
  const lo = utcDay(year, month, day);
  if (lo === null) return null;
  if (match[3]) return [lo, lo];
  const lastMonth = match[2] ? month : 12;
  const lastDay = new Date(Date.UTC(year, lastMonth, 0)).getUTCDate();
  const hi = utcDay(year, lastMonth, lastDay);
  return hi === null ? null : [lo, hi];
}

export function isInternship(role: EmploymentInterval): boolean {
  return /^(?:intern|internship)$/i.test(role.employmentType?.trim() ?? '') ||
    /(?:^(?:intern|internship)(?:\s*[-–—:]\s*.+)?$|(?:^|\s)(?:intern|internship)$|\((?:intern|internship)\)$)/i.test(role.title?.trim() ?? '');
}

function unionDays(intervals: Bounds[]): number {
  const sorted = intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!sorted.length) return 0;
  let total = 0, [start, end] = sorted[0]!;
  for (const [a, b] of sorted.slice(1)) {
    if (a > end) { total += end - start; start = a; end = b; }
    else { start = Math.min(start, a); end = Math.max(end, b); }
  }
  return total + end - start;
}

export function calculateExperience(roles: readonly EmploymentInterval[], asOf: string): ExperienceEnvelope {
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(asOf) ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== asOf.slice(0, 10)) {
    throw Error('RUBRIC_INVALID_AS_OF');
  }
  if (roles.length > 500) throw Error('RUBRIC_EXPERIENCE_TOO_LARGE');
  const now = Math.floor(instant / DAY);
  const base = { version: EXPERIENCE_VERSION, asOf };
  const unknown = (status: 'incomplete' | 'unavailable', reason: ExperienceEnvelope['reason']): ExperienceEnvelope =>
    ({ ...base, status, reason, lowerDays: null, upperDays: null, display: 'Experience not available' });
  if (!roles.length) return unknown('unavailable', 'no_history');
  const qualifying = roles.filter(role => !isInternship(role));
  // Recorded internships are evidence of zero qualifying employment, not absent history.
  if (!qualifying.length) return { ...base, status: 'measured', reason: 'internships_only', lowerDays: 0, upperDays: 0, display: '0.0 years' };
  const inner: Bounds[] = [], outer: Bounds[] = [];
  for (const role of qualifying) {
    const start = dateBounds(role.start);
    const end = role.end ? dateBounds(role.end) : role.ongoing === true ? [now, now] as const : null;
    if (!start || !end || start[0] > now || end[0] > now || start[0] > end[1]) {
      return unknown('incomplete', 'invalid_or_missing_dates');
    }
    const clippedEnd: Bounds = [Math.min(end[0], now), Math.min(end[1], now)];
    const clippedStart: Bounds = [start[0], Math.min(start[1], now)];
    outer.push([start[0], clippedEnd[1]]);
    inner.push([clippedStart[1], Math.max(clippedStart[1], clippedEnd[0])]);
  }
  const lowerDays = unionDays(inner), upperDays = unionDays(outer);
  const lower = (lowerDays / DAYS_PER_YEAR).toFixed(1), upper = (upperDays / DAYS_PER_YEAR).toFixed(1);
  return { ...base, status: lowerDays === upperDays ? 'measured' : 'bounded', reason: 'recorded_intervals', lowerDays, upperDays,
    display: lowerDays === upperDays ? `${lower} years` : `Approximately ${lower}–${upper} years` };
}

export type ExperienceEligibility = 'in_range' | 'wider' | 'unconstrained' | 'outside_experience_range' |
  'experience_unavailable' | 'uncertain_boundary' | 'wider_skills_not_established';
export interface ExperienceRange { minimum: number; maximum?: number }

export function experienceEligibility(experience: ExperienceEnvelope, range: ExperienceRange | null,
  mustHaveSkills: readonly ('met' | 'not_met' | 'unknown')[]): ExperienceEligibility {
  if (!range) return 'unconstrained';
  const { minimum: a, maximum: b = Infinity } = range;
  if (!Number.isFinite(a) || a < 0 || a > 80 || (range.maximum !== undefined && (!Number.isFinite(b) || b < a || b > 80))) {
    throw Error('RUBRIC_INVALID_EXPERIENCE_RANGE');
  }
  if (!['measured', 'bounded'].includes(experience.status) || experience.lowerDays === null || experience.upperDays === null) return 'experience_unavailable';
  const lo = experience.lowerDays, hi = experience.upperDays;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 0 || hi < lo) throw Error('RUBRIC_INVALID_EXPERIENCE_ENVELOPE');
  // Integer day totals versus the exact decimal year scale; never classify rounded display years.
  const compare = (days: number, years: number) => days * 10_000 - years * 3_652_425;
  const band = (days: number): string => {
    if (compare(days, a) >= 0 && compare(days, b) <= 0) return 'in_range';
    if (compare(days, Math.max(0, a - 2)) >= 0 && compare(days, a) < 0) return 'lower';
    if (compare(days, b) > 0 && compare(days, b + 2) <= 0) return 'upper';
    return compare(days, a) < 0 ? 'below' : 'above';
  };
  const lowBand = band(lo), highBand = band(hi);
  if (lowBand !== highBand) return 'uncertain_boundary';
  if (lowBand === 'in_range') return 'in_range';
  if (lowBand === 'below' || lowBand === 'above') return 'outside_experience_range';
  return mustHaveSkills.length > 0 && mustHaveSkills.every(state => state === 'met') ? 'wider' : 'wider_skills_not_established';
}

/** Avoid displaying 6.0 on a 5.99-year wider candidate. */
export function experienceDisplay(experience: ExperienceEnvelope, range: ExperienceRange | null): string {
  if (!range || !['measured', 'bounded'].includes(experience.status) || experience.lowerDays === null || experience.upperDays === null) return experience.display;
  const lo = experience.lowerDays / DAYS_PER_YEAR, hi = experience.upperDays / DAYS_PER_YEAR;
  if (hi < range.minimum && Number(hi.toFixed(1)) >= range.minimum) return `Below ${range.minimum} years`;
  if (range.maximum !== undefined && lo > range.maximum && Number(lo.toFixed(1)) <= range.maximum) return `Above ${range.maximum} years`;
  return experience.display;
}
