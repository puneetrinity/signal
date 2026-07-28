import type { CrustdataProfileResponse } from "./crustdata-client";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const PUBLIC_EMAIL_IN_TEXT = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;
const PUBLIC_PHONE_IN_TEXT =
  /(?:\+\d[\d().\s-]{5,}\d|\(\d{2,4}\)[\s.-]\d{3,4}[\s.-]\d{3,4}|\b\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}\b|\b\d{5}[\s.-]\d{5}\b|\b\d{9,15}\b)/g;

export function redactPublicContactText(value: string): string {
  return value
    .replace(PUBLIC_EMAIL_IN_TEXT, "[redacted]")
    .replace(PUBLIC_PHONE_IN_TEXT, "[redacted]");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string"
    ? redactPublicContactText(value)
    : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map(redactPublicContactText);
  return values.length > 0 ? values : undefined;
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function projectLocation(value: unknown) {
  const source = record(value);
  if (!source) return undefined;
  const projected = compact({
    city: stringValue(source.city),
    state: stringValue(source.state),
    country: stringValue(source.country),
    continent: stringValue(source.continent),
    full_location: stringValue(source.full_location),
    raw: stringValue(source.raw),
  });
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectEmployment(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const projected = value
    .map((entry) => {
      const source = record(entry);
      if (!source) return null;
      return compact({
        company_name: stringValue(source.company_name),
        title: stringValue(source.title),
        seniority_level: stringValue(source.seniority_level),
        function_category: stringValue(source.function_category),
        start_date: stringValue(source.start_date),
        end_date: stringValue(source.end_date),
        description: stringValue(source.description),
        name: stringValue(source.name),
        years_at_company_raw: numberValue(source.years_at_company_raw),
        company_headquarters_country: stringValue(
          source.company_headquarters_country,
        ),
        company_industries: stringArray(source.company_industries),
        company_professional_network_industry: stringValue(
          source.company_professional_network_industry,
        ),
        company_type: stringValue(source.company_type),
        company_headcount_range: stringValue(source.company_headcount_range),
      });
    })
    .filter(
      (entry): entry is NonNullable<typeof entry> =>
        entry !== null && Object.keys(entry).length > 0,
    );
  return projected.length > 0 ? projected : undefined;
}

/**
 * Projects provider data into the public-profile contract.
 *
 * Contact availability, email, phone and unknown provider fields are omitted
 * by construction. Provider contact evidence has a separate restricted
 * lifecycle and must never ride the public profile outbox.
 */
export function projectPublicCrustdataProfile(
  value: unknown,
): CrustdataProfileResponse | null {
  const source = record(value);
  if (!source) return null;
  const metadata = record(source.metadata);
  const basic = record(source.basic_profile);
  const professional = record(source.professional_network);
  const professionalMetadata = record(professional?.metadata);
  const skills = record(source.skills);
  const experience = record(source.experience);
  const employment = record(experience?.employment_details);
  const education = record(source.education);
  const social = record(source.social_handles);
  const linkedin = record(social?.professional_network_identifier);
  const twitter = record(social?.twitter_identifier);
  const devPlatform = record(social?.dev_platform_identifier);

  const schools = Array.isArray(education?.schools)
    ? education.schools
        .map((entry) => {
          const school = record(entry);
          if (!school) return null;
          return compact({
            school: stringValue(school.school),
            degree: stringValue(school.degree),
            field_of_study: stringValue(school.field_of_study),
            start_year: numberValue(school.start_year),
            end_year: numberValue(school.end_year),
          });
        })
        .filter(
          (entry): entry is NonNullable<typeof entry> =>
            entry !== null && Object.keys(entry).length > 0,
        )
    : [];

  const certifications = Array.isArray(source.certifications)
    ? source.certifications
        .map((entry) => {
          const certification = record(entry);
          if (!certification) return null;
          return compact({
            name: stringValue(certification.name),
            issuing_organization: stringValue(
              certification.issuing_organization,
            ),
            issue_date: stringValue(certification.issue_date),
            expiration_date: stringValue(certification.expiration_date),
          });
        })
        .filter(
          (entry): entry is NonNullable<typeof entry> =>
            entry !== null && Object.keys(entry).length > 0,
        )
    : [];

  const honors = Array.isArray(source.honors)
    ? source.honors
        .map((entry) => {
          const honor = record(entry);
          if (!honor) return null;
          return compact({
            title: stringValue(honor.title),
            issuer: stringValue(honor.issuer),
            description: stringValue(honor.description),
          });
        })
        .filter(
          (entry): entry is NonNullable<typeof entry> =>
            entry !== null && Object.keys(entry).length > 0,
        )
    : [];

  const projected = compact({
    crustdata_person_id: numberValue(source.crustdata_person_id),
    metadata: metadata
      ? compact({ updated_at: stringValue(metadata.updated_at) })
      : undefined,
    basic_profile: basic
      ? compact({
          name: stringValue(basic.name),
          first_name: stringValue(basic.first_name),
          last_name: stringValue(basic.last_name),
          headline: stringValue(basic.headline),
          current_title: stringValue(basic.current_title),
          profile_picture_permalink: stringValue(
            basic.profile_picture_permalink,
          ),
          summary: stringValue(basic.summary),
          languages: stringArray(basic.languages),
          location: projectLocation(basic.location),
        })
      : undefined,
    professional_network: professional
      ? compact({
          connections: numberValue(professional.connections),
          followers: numberValue(professional.followers),
          open_to_cards: stringArray(professional.open_to_cards),
          profile_picture_permalink: stringValue(
            professional.profile_picture_permalink,
          ),
          location: projectLocation(professional.location),
          metadata: professionalMetadata
            ? compact({
                last_scraped_source: stringValue(
                  professionalMetadata.last_scraped_source,
                ),
              })
            : undefined,
        })
      : undefined,
    skills: skills
      ? compact({
          professional_network_skills: stringArray(
            skills.professional_network_skills,
          ),
        })
      : undefined,
    recently_changed_jobs: booleanValue(source.recently_changed_jobs),
    years_of_experience_raw: numberValue(source.years_of_experience_raw),
    experience: employment
      ? {
          employment_details: compact({
            current: projectEmployment(employment.current),
            past: projectEmployment(employment.past),
          }),
        }
      : undefined,
    education: schools.length > 0 ? { schools } : undefined,
    certifications: certifications.length > 0 ? certifications : undefined,
    honors: honors.length > 0 ? honors : undefined,
    social_handles: social
      ? compact({
          professional_network_identifier: linkedin
            ? compact({
                profile_url: stringValue(linkedin.profile_url),
              })
            : undefined,
          twitter_identifier: twitter
            ? compact({ slug: stringValue(twitter.slug) })
            : undefined,
          dev_platform_identifier: devPlatform
            ? compact({
                profile_url:
                  devPlatform.profile_url === null
                    ? null
                    : stringValue(devPlatform.profile_url),
              })
            : undefined,
        })
      : undefined,
  });

  return Object.keys(projected).length > 0
    ? (projected as CrustdataProfileResponse)
    : null;
}

const CONTACT_FLAG_KEYS: Record<
  string,
  "has_business_email" | "has_personal_email" | "has_phone_number"
> = {
  hasbusinessemail: "has_business_email",
  haspersonalemail: "has_personal_email",
  hasphonenumber: "has_phone_number",
};

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isContactValueKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized.includes("email") ||
    normalized.includes("phone") ||
    normalized.includes("mobile") ||
    normalized.includes("contact")
  );
}

function retainedContactFlags(value: unknown): Record<string, boolean> {
  const source = record(value);
  if (!source) return {};
  const flags: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(source)) {
    const canonical = CONTACT_FLAG_KEYS[normalizedKey(key)];
    if (canonical && typeof entry === "boolean") {
      flags[canonical] = entry;
    }
  }
  return flags;
}

const EMAIL_IN_TEXT = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function redactContactValues(value: unknown): unknown {
  if (typeof value === "string" && EMAIL_IN_TEXT.test(value)) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map(redactContactValues)
      .filter((entry) => entry !== undefined);
  }
  const source = record(value);
  if (!source) return value;
  const entries: Array<[string, unknown]> = [];
  for (const [key, entry] of Object.entries(source)) {
    const normalized = normalizedKey(key);
    if (normalized === "contact" || normalized === "contacts") {
      const flags = retainedContactFlags(entry);
      if (Object.keys(flags).length > 0) entries.push([key, flags]);
      continue;
    }
    if (isContactValueKey(key)) continue;
    const redacted = redactContactValues(entry);
    if (redacted !== undefined) entries.push([key, redacted]);
  }
  return Object.fromEntries(entries);
}

/**
 * Historical Signal rows may contain provider contact values in searchMeta.
 * Results may retain non-sensitive availability flags, never raw values.
 */
export function redactSearchMetaContactValues(
  searchMeta: unknown,
): Record<string, unknown> | null {
  const source = record(searchMeta);
  return source
    ? (redactContactValues(source) as Record<string, unknown>)
    : null;
}

/**
 * Sourcing results may disclose that contact data exists, but actual contact
 * identifiers are released only by the shortlist-authorized contact endpoint.
 */
export function redactContactIdentities<
  T extends { platform: string },
>(identities: T[]): T[] {
  return identities.filter((identity) => {
    const platform = identity.platform.trim().toLowerCase();
    return platform !== "email" && platform !== "phone";
  });
}
