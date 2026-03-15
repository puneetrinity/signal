#!/usr/bin/env npx tsx
/**
 * Prod Sanity Check — Non-Tech Concept Rules
 *
 * Samples candidates without tech snapshots and tests the non-tech concept
 * rules (enterprise sales, stakeholder management, pipeline management)
 * plus alias matches on real production data.
 *
 * Searches for candidates whose text contains probe words, then checks
 * whether concept rules and alias matching produce clean results.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-skill-nontech-prod.ts
 *   DATABASE_URL="postgresql://..." npx tsx scripts/audit-skill-nontech-prod.ts --limit 500
 */

import {
  getSkillSurfaceForms,
  canonicalizeSkill,
  detectNontechConcept,
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

function detectSkillInText(skill: string, textBag: string): { detected: boolean; method: string } {
  const canonical = canonicalizeSkill(skill);

  // Concept rule first
  const conceptResult = detectNontechConcept(canonical, textBag);
  if (conceptResult === 'match') return { detected: true, method: 'concept_rule' };
  if (conceptResult === 'exclude') return { detected: false, method: 'concept_excluded' };

  // Alias regex fallback
  const forms = getSkillSurfaceForms(skill);
  const lowerBag = textBag.toLowerCase();
  for (const form of forms) {
    if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
    if (buildSkillRegex(form).test(lowerBag)) return { detected: true, method: `alias:${form}` };
  }
  return { detected: false, method: 'no_match' };
}

interface CandidateRow {
  id: string;
  roleType: string | null;
  headlineHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
}

// Probe words to find candidates likely to trigger concept rules
const PROBE_WORDS = [
  'enterprise', 'account manager', 'relationship manager', 'client manager',
  'key accounts', 'pipeline', 'forecasting', 'customer success',
  'stakeholder', 'strategic sales', 'b2b sales',
];

const TARGET_SKILLS = [
  'enterprise sales',
  'stakeholder management',
  'pipeline management',
  'customer success',
  'consultative selling',
];

function parseArgs() {
  const args = process.argv.slice(2);
  let limit = 200;
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
    // Probe-biased sanity sample: non-tech candidates whose text contains probe words.
    // Scoped to non-tech roleTypes to avoid unenriched tech candidates contaminating results.
    // NOT a production-quality rate estimate — intentionally biased toward trigger words.
    // Exclude known tech roleTypes; explicitly include null + non-tech types.
    // With --probe flag, additionally filter to rows containing probe words.
    // Without --probe, sample all non-tech candidates for broader coverage.
    const TECH_ROLE_TYPES = ['engineer', 'data_scientist', 'researcher'];
    const useProbe = process.argv.includes('--probe');
    const andClauses: any[] = [
      {
        OR: [
          { roleType: null },
          { roleType: { notIn: TECH_ROLE_TYPES } },
        ],
      },
    ];
    if (useProbe) {
      andClauses.push({
        OR: PROBE_WORDS.map(word => ({
          OR: [
            { headlineHint: { contains: word, mode: 'insensitive' as const } },
            { searchTitle: { contains: word, mode: 'insensitive' as const } },
            { searchSnippet: { contains: word, mode: 'insensitive' as const } },
          ],
        })),
      });
    }
    const candidates = await prisma.candidate.findMany({
      where: {
        headlineHint: { not: null },
        intelligenceSnapshots: { none: { track: 'tech' } },
        AND: andClauses,
      },
      select: {
        id: true,
        roleType: true,
        headlineHint: true,
        searchTitle: true,
        searchSnippet: true,
      },
      take: limit,
      orderBy: { updatedAt: 'desc' },
    }) as CandidateRow[];

    console.log(`Sanity sample: ${candidates.length} non-tech candidates`);
    console.log(`  roleType filter: excludes ${TECH_ROLE_TYPES.join(', ')}`);
    console.log(`  probe filter: ${useProbe ? 'ON (biased toward probe words)' : 'OFF (all non-tech candidates)'}`);
    console.log(`  NOTE: This is a sanity audit, not a production rate estimate.\n`);

    interface Hit {
      candidateId: string;
      roleType: string | null;
      skill: string;
      method: string;
      textPreview: string;
    }

    const conceptMatches: Hit[] = [];
    const aliasMatches: Hit[] = [];
    const excludedMatches: Hit[] = [];
    let totalChecks = 0;

    for (const c of candidates) {
      const textBag = [c.headlineHint, c.searchTitle, c.searchSnippet]
        .filter(Boolean)
        .join(' ');

      for (const skill of TARGET_SKILLS) {
        totalChecks++;
        const result = detectSkillInText(skill, textBag);
        const preview = textBag.slice(0, 120).replace(/\n/g, ' ');

        if (result.detected && result.method === 'concept_rule') {
          conceptMatches.push({ candidateId: c.id, roleType: c.roleType, skill, method: result.method, textPreview: preview });
        } else if (result.detected) {
          aliasMatches.push({ candidateId: c.id, roleType: c.roleType, skill, method: result.method, textPreview: preview });
        } else if (result.method === 'concept_excluded') {
          excludedMatches.push({ candidateId: c.id, roleType: c.roleType, skill, method: result.method, textPreview: preview });
        }
      }
    }

    // Summary
    console.log('--- Summary ---');
    console.log(`  Total checks:       ${totalChecks} (${candidates.length} candidates x ${TARGET_SKILLS.length} skills)`);
    console.log(`  Concept matches:    ${conceptMatches.length}`);
    console.log(`  Alias matches:      ${aliasMatches.length}`);
    console.log(`  Concept excluded:   ${excludedMatches.length}`);
    console.log(`  Total detected:     ${conceptMatches.length + aliasMatches.length}`);

    // Per-skill breakdown
    console.log('\n--- Per Skill ---');
    for (const skill of TARGET_SKILLS) {
      const concept = conceptMatches.filter(h => h.skill === skill).length;
      const alias = aliasMatches.filter(h => h.skill === skill).length;
      const excluded = excludedMatches.filter(h => h.skill === skill).length;
      if (concept + alias + excluded > 0) {
        console.log(`  ${skill.padEnd(25)} concept=${concept} alias=${alias} excluded=${excluded}`);
      }
    }

    // Concept match samples (for manual review — are these real?)
    if (conceptMatches.length > 0) {
      console.log(`\n--- Concept Rule Matches (up to 20) ---`);
      for (const h of conceptMatches.slice(0, 20)) {
        console.log(`  CONCEPT "${h.skill}" [${h.roleType}] — ${h.textPreview}...`);
      }
    }

    // Alias match samples
    if (aliasMatches.length > 0) {
      console.log(`\n--- Alias Matches (up to 15) ---`);
      for (const h of aliasMatches.slice(0, 15)) {
        console.log(`  ALIAS   "${h.skill}" [${h.roleType}|${h.method}] — ${h.textPreview}...`);
      }
    }

    // Excluded samples (concept rule negative guard fired)
    if (excludedMatches.length > 0) {
      console.log(`\n--- Excluded by Negative Guard (up to 10) ---`);
      for (const h of excludedMatches.slice(0, 10)) {
        console.log(`  EXCLUDE "${h.skill}" [${h.roleType}] — ${h.textPreview}...`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);
