export const PREMIUM_SCHOOLS = new Set([
  'mit',
  'massachusetts institute of technology',
  'stanford',
  'stanford university',
  'harvard',
  'harvard university',
  'caltech',
  'california institute of technology',
  'oxford',
  'university of oxford',
  'cambridge',
  'university of cambridge',
  'princeton',
  'princeton university',
  'yale',
  'yale university',
  'berkeley',
  'uc berkeley',
  'university of california berkeley',
  'cmu',
  'carnegie mellon university',
  'iit',
  'indian institute of technology',
  'iim',
  'indian institute of management',
  'bits pilani',
  'birla institute of technology and science',
  'isb',
  'indian school of business',
  'waterloo',
  'university of waterloo',
  'tsinghua',
  'tsinghua university',
  'nus',
  'national university of singapore',
  'eth zurich',
]);

const TECH_DEGREES = new Set([
  'computer science',
  'cs',
  'software engineering',
  'electrical engineering',
  'ee',
  'electronics',
  'ece',
  'mathematics',
  'physics',
  'statistics',
  'data science',
  'information technology',
  'it',
  'b.tech',
  'btech',
  'b.e.',
  'm.tech',
  'mtech',
  'ms',
]);

const BUSINESS_DEGREES = new Set([
  'business',
  'business administration',
  'mba',
  'management',
  'marketing',
  'finance',
  'economics',
  'bba',
  'b.com',
  'accounting',
  'commerce',
]);

export function getSchoolTier(schoolName: string | null | undefined): 'premium' | 'decent' | 'unknown' {
  if (!schoolName) return 'unknown';
  const norm = schoolName.toLowerCase();
  
  for (const premium of PREMIUM_SCHOOLS) {
    if (norm.includes(premium)) {
      return 'premium';
    }
  }
  
  if (norm.length > 3) {
    return 'decent'; // If it's a real school name but not premium
  }
  
  return 'unknown';
}

export function isDegreeRelevant(degree: string | null | undefined, field: string | null | undefined, track: 'tech' | 'non_tech' | 'blended'): boolean {
  if (!degree && !field) return false;
  
  const text = `${degree || ''} ${field || ''}`.toLowerCase();
  
  if (track === 'tech' || track === 'blended') {
    for (const tech of TECH_DEGREES) {
      if (text.includes(tech)) return true;
    }
  }
  
  if (track === 'non_tech' || track === 'blended') {
    for (const biz of BUSINESS_DEGREES) {
      if (text.includes(biz)) return true;
    }
  }
  
  return false;
}
