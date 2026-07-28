import { describe, expect, it } from "vitest";
import {
  projectPublicCrustdataProfile,
  redactContactIdentities,
  redactSearchMetaContactValues,
} from "../public-profile-redaction";

describe("public profile contact boundary", () => {
  it("projects only public profile fields and drops nested contact sentinels", () => {
    const projected = projectPublicCrustdataProfile({
      crustdata_person_id: 123,
      unknown_provider_field: "drop-me",
      contact: {
        has_personal_email: true,
        personal_email: "top@example.com",
      },
      basic_profile: {
        name: "Alice Example",
        headline: "Backend Engineer",
        summary: "Contact nested@example.com or +1-415-555-0123",
        profile_picture_permalink: "https://images.example/alice.jpg",
        email: "nested@example.com",
        location: {
          city: "Bengaluru",
          phone_number: "+91-0000000000",
        },
      },
      experience: {
        employment_details: {
          current: [
            {
              title: "Staff Engineer",
              company_name: "Acme",
              description: "Call 9876543210",
              business_email_verified: true,
              contact_info: {
                email: "work@example.com",
              },
            },
          ],
        },
      },
      social_handles: {
        professional_network_identifier: {
          profile_url: "https://linkedin.com/in/alice",
          email: "social@example.com",
        },
        phone: "+91-1111111111",
      },
    });

    expect(projected).toMatchObject({
      crustdata_person_id: 123,
      basic_profile: {
        name: "Alice Example",
        headline: "Backend Engineer",
        profile_picture_permalink: "https://images.example/alice.jpg",
        location: { city: "Bengaluru" },
      },
      experience: {
        employment_details: {
          current: [
            {
              title: "Staff Engineer",
              company_name: "Acme",
            },
          ],
        },
      },
      social_handles: {
        professional_network_identifier: {
          profile_url: "https://linkedin.com/in/alice",
        },
      },
    });
    const serialized = JSON.stringify(projected);
    for (const sentinel of [
      "top@example.com",
      "nested@example.com",
      "+91-0000000000",
      "work@example.com",
      "social@example.com",
      "+91-1111111111",
      "+1-415-555-0123",
      "9876543210",
      "drop-me",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    expect(projected).not.toHaveProperty("contact");
    expect(serialized).toContain("[redacted]");
  });

  it("redacts legacy contact values while retaining availability flags", () => {
    const sanitized = redactSearchMetaContactValues({
      crustdata: {
        emails: ["alice@example.com"],
        contact: {
          has_personal_email: true,
          personal_email: "alice@example.com",
          nested: {
            phone_number: "+91-0000000000",
          },
        },
        emailAddress: "alias@example.com",
        most_probable_work_email: "probable@example.com",
        phoneNumber: "+91-1111111111",
        contactInfo: {
          value: "contact@example.com",
        },
        basic_profile: {
          headline: "Backend Engineer",
          summary: "Write to prose@example.com for details",
        },
      },
    });

    expect(sanitized).toEqual({
      crustdata: {
        contact: {
          has_personal_email: true,
        },
        basic_profile: {
          headline: "Backend Engineer",
        },
      },
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/@example\.com|\+91-/);
  });

  it("keeps contact identities out of pre-shortlist sourcing results", () => {
    expect(
      redactContactIdentities([
        { platform: "linkedin", platformId: "alice" },
        { platform: "email", platformId: "alice@example.com" },
        { platform: " Phone ", platformId: "+91-0000000000" },
        { platform: "github", platformId: "alice-dev" },
      ]),
    ).toEqual([
      { platform: "linkedin", platformId: "alice" },
      { platform: "github", platformId: "alice-dev" },
    ]);
  });
});
