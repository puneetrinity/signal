/** No URL coercion or legacy default at a paid/public boundary. */
export function isPublicAcquisitionIdentity(value: {
  identityKind?: unknown;
  privateCandidateRef?: unknown;
  linkedinUrl?: unknown;
  linkedinId?: unknown;
}): value is { identityKind: 'linkedin'; privateCandidateRef: null; linkedinUrl: string; linkedinId: string } {
  if (value.identityKind !== 'linkedin' || value.privateCandidateRef !== null ||
      typeof value.linkedinUrl !== 'string' || typeof value.linkedinId !== 'string' ||
      !value.linkedinId.trim()) return false;
  try {
    const url = new URL(value.linkedinUrl);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'linkedin.com' || url.hostname.endsWith('.linkedin.com')) &&
      /^\/(in|pub)\/[^/\s]+\/?$/.test(url.pathname) && !url.search && !url.hash;
  } catch { return false; }
}
