export function extractLocationFromSnippet(snippet: string): string | null {
  return null;
}
export function extractLocationFromSerpResult(title: string, snippet: string): string | null {
  return null;
}
export function extractNameFromTitle(title: string): string | null {
  return null;
}
export function extractCompanyFromHeadline(headline: string): string | null {
  return null;
}
export function extractAllHints(linkedinId: string, title: string, snippet: string): {
  nameHint: string | null;
  headlineHint: string | null;
  locationHint: string | null;
  companyHint: string | null;
} {
  return {
    nameHint: null,
    headlineHint: null,
    locationHint: null,
    companyHint: null,
  };
}
