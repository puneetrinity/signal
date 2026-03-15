#!/usr/bin/env npx tsx
/**
 * Prod Sanity Check — Ambiguous Skill Context Guard
 *
 * Samples candidates that lack snapshots (text fallback path) and tests
 * whether the ambiguous-token guard correctly suppresses false positives
 * on production-shaped data.
 *
 * For each candidate: builds textBag from headlineHint + searchTitle + searchSnippet,
 * then checks each AMBIGUOUS_SKILL against hasRequiredContext().
 *
 * Reports:
 *   - How many candidates would have ambiguous skills accepted vs suppressed
 *   - Samples of accepted cases for manual review (the interesting ones)
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-skill-ambiguous-prod.ts
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-skill-ambiguous-prod.ts --limit 500
 */

import {
  AMBIGUOUS_SKILLS,
  hasRequiredContext,
  getSkillSurfaceForms,
} from '../src/lib/sourcing/jd-digest';

const SHORT_ALIAS_ALLOWLIST = new Set(['ts', 'js', 'go', 'pg', 'k8s']);

function buildSkillRegex(form: string): RegExp {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const needsLeadingBoundary = /^\w/.test(form);
  const needsTrailingBoundary = /\w$/.test(form);
  const prefix = needsLeadingBoundary ? '\\b' : '(?:^|[^a-z0-9])';
  const suffix = needsTrailingBoundary ? '\\b' : '(?=$|[^a-z0-9])';
  return new RegExp(`${prefix}${escaped}${suffix}`, 'i');
}

function detectSkillInText(skill: string, textBag: string): boolean {
  const forms = getSkillSurfaceForms(skill);
  const lowerBag = textBag.toLowerCase();
  for (const form of forms) {
    if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
    if (buildSkillRegex(form).test(lowerBag)) return true;
  }
  return false;
}

interface CandidateRow {
  id: string;
  headlineHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
}

interface AmbiguousHit {
  candidateId: string;
  skill: string;
  textBag: string;
  hasContext: boolean;
  textMatch: boolean;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 1000;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
  }
  return { limit };
}

async function main() {
  const { limit } = parseArgs();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // Sample candidates without a tech snapshot — these use text fallback for tech skill scoring.
    // Note: recency-biased sample (orderBy updatedAt desc), not random.
    const candidates = await prisma.candidate.findMany({
      where: {
        headlineHint: { not: null },
        intelligenceSnapshots: {
          none: { track: 'tech' },
        },
      },
      select: {
        id: true,
        headlineHint: true,
        searchTitle: true,
        searchSnippet: true,
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }) as CandidateRow[];

    console.log(`Sampled ${candidates.length} candidates (no snapshot, text fallback path)\n`);

    const ambiguousSkills = [...AMBIGUOUS_SKILLS];
    const hits: AmbiguousHit[] = [];
    let totalChecks = 0;
    let suppressedCount = 0;
    let acceptedCount = 0;
    let textMatchCount = 0;

    for (const c of candidates) {
      const textBag = [c.headlineHint, c.searchTitle, c.searchSnippet]
        .filter(Boolean)
        .join(' ');

      for (const skill of ambiguousSkills) {
        totalChecks++;
        const hasContext = hasRequiredContext(skill, textBag);
        const textMatch = detectSkillInText(skill, textBag);

        if (textMatch) {
          textMatchCount++;
          if (hasContext) {
            acceptedCount++;
            hits.push({ candidateId: c.id, skill, textBag, hasContext, textMatch });
          } else {
            suppressedCount++;
            hits.push({ candidateId: c.id, skill, textBag, hasContext, textMatch });
          }
        }
      }
    }

    // Summary
    console.log('--- Summary ---');
    console.log(`  Total checks:     ${totalChecks} (${candidates.length} candidates x ${ambiguousSkills.length} ambiguous skills)`);
    console.log(`  Text matches:     ${textMatchCount} (skill word found in text)`);
    console.log(`  Accepted:         ${acceptedCount} (tech context present → would count as skill match)`);
    console.log(`  Suppressed:       ${suppressedCount} (no tech context → guard blocked)`);
    if (textMatchCount > 0) {
      console.log(`  Suppression rate: ${((suppressedCount / textMatchCount) * 100).toFixed(1)}%`);
    }

    // Show suppressed samples (these are the wins — FPs we avoided)
    const suppressed = hits.filter(h => !h.hasContext).slice(0, 15);
    if (suppressed.length > 0) {
      console.log(`\n--- Suppressed Samples (FPs avoided, up to 15) ---`);
      for (const h of suppressed) {
        const preview = h.textBag.slice(0, 120).replace(/\n/g, ' ');
        console.log(`  BLOCKED "${h.skill}" — ${preview}...`);
      }
    }

    // Show accepted samples (these should be true positives — manual review)
    const accepted = hits.filter(h => h.hasContext).slice(0, 20);
    if (accepted.length > 0) {
      console.log(`\n--- Accepted Samples (should be true positives, up to 20) ---`);
      for (const h of accepted) {
        const preview = h.textBag.slice(0, 120).replace(/\n/g, ' ');
        console.log(`  ACCEPT  "${h.skill}" — ${preview}...`);
      }
    }

    // Per-skill breakdown
    console.log('\n--- Per Ambiguous Skill ---');
    for (const skill of ambiguousSkills) {
      const skillHits = hits.filter(h => h.skill === skill);
      const matched = skillHits.filter(h => h.textMatch).length;
      const acc = skillHits.filter(h => h.hasContext && h.textMatch).length;
      const sup = skillHits.filter(h => !h.hasContext && h.textMatch).length;
      if (matched > 0) {
        console.log(`  ${skill.padEnd(10)} matched=${matched} accepted=${acc} suppressed=${sup}`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
