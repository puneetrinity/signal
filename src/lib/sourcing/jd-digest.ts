export interface JdDigestParsed {
  topSkills: string[];
  seniorityLevel: string | null;
  domain: string | null;
  roleFamily: string | null;
}

export interface JobRequirements {
  topSkills: string[];
  seniorityLevel: string | null;
  domain: string | null;
  roleFamily: string | null;
  location: string | null;
  experienceYears: number | null;
  education: string | null;
}

export function parseJdDigest(jdDigest: string): JdDigestParsed {
  // Try JSON first (VantaHire generates JSON via AI)
  try {
    const parsed = JSON.parse(jdDigest);
    return {
      topSkills: Array.isArray(parsed.topSkills)
        ? parsed.topSkills.map((s: unknown) => String(s).trim()).filter(Boolean)
        : [],
      seniorityLevel: parsed.seniorityLevel ? String(parsed.seniorityLevel) : null,
      domain: parsed.domain ? String(parsed.domain) : null,
      roleFamily: parsed.roleFamily ? String(parsed.roleFamily) : null,
    };
  } catch {
    // Fallback: semicolon/comma-delimited keywords
    const tokens = jdDigest
      .split(/[;,]/)
      .map((t) => t.trim())
      .filter(Boolean);
    return {
      topSkills: tokens,
      seniorityLevel: null,
      domain: null,
      roleFamily: null,
    };
  }
}

export function buildJobRequirements(jobContext: {
  jdDigest: string;
  location?: string;
  experienceYears?: number;
  education?: string;
}): JobRequirements {
  const parsed = parseJdDigest(jobContext.jdDigest);
  return {
    ...parsed,
    location: jobContext.location ?? null,
    experienceYears: jobContext.experienceYears ?? null,
    education: jobContext.education ?? null,
  };
}
