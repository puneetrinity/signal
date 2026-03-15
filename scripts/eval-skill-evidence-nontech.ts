#!/usr/bin/env npx tsx
/**
 * Skill Evidence Evaluator — Non-Tech Track
 *
 * Tests the text fallback skill matching path for non-tech skills
 * (sales, customer success, marketing, operations) against gold-labeled fixtures.
 *
 * Mirrors eval-skill-evidence-tech.ts but focused on business/GTM language.
 *
 * Gold labels per skill:
 *   explicit      — skill named directly in text → expect: detected
 *   inferred      — skill implied but not named  → expect: not detected
 *   absent        — no evidence                  → expect: not detected
 *   false_positive — word present but wrong meaning → expect: not detected (ideal)
 *
 * Usage:
 *   npx tsx scripts/eval-skill-evidence-nontech.ts
 *   npx tsx scripts/eval-skill-evidence-nontech.ts --verbose
 *   npx tsx scripts/eval-skill-evidence-nontech.ts --file research/datasets/skill-evidence-nontech-adversarial.jsonl
 */

import { readFileSync } from 'fs';
import { getSkillSurfaceForms, canonicalizeSkill, hasRequiredContext, detectNontechConcept } from '../src/lib/sourcing/jd-digest';

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
  const canonical = canonicalizeSkill(skill);
  // Ambiguous skills require nearby tech context — same guard as ranking.ts
  if (!hasRequiredContext(canonical, textBag)) return false;

  // Try non-tech concept rule first (combinatorial bucket match)
  const conceptResult = detectNontechConcept(canonical, textBag);
  if (conceptResult === 'match') return true;
  if (conceptResult === 'exclude') return false;
  // 'no_match' or undefined → fall through to alias regex

  // Standard alias regex matching
  const forms = getSkillSurfaceForms(skill);
  const lowerBag = textBag.toLowerCase();
  for (const form of forms) {
    if (form.length <= 2 && /^[a-z]+$/.test(form) && !SHORT_ALIAS_ALLOWLIST.has(form)) continue;
    if (buildSkillRegex(form).test(lowerBag)) return true;
  }
  return false;
}

interface Fixture {
  id: string;
  headline: string;
  snippet: string;
  target_skills: string[];
  gold: Record<string, 'explicit' | 'inferred' | 'absent' | 'false_positive'>;
  note?: string;
}

interface SkillResult {
  fixtureId: string;
  skill: string;
  gold: string;
  detected: boolean;
  correct: boolean;
}

function expectedDetection(gold: string): boolean {
  return gold === 'explicit';
}

function parseArgs() {
  const args = process.argv.slice(2);
  let verbose = false;
  let file: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--verbose') verbose = true;
    else if (args[i] === '--file' && args[i + 1]) file = args[++i];
  }

  return { verbose, file };
}

function loadFixtures(path: string): Fixture[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main() {
  const { verbose, file } = parseArgs();
  const files = file
    ? [file]
    : [
        'research/datasets/skill-evidence-nontech-core.jsonl',
        'research/datasets/skill-evidence-nontech-adversarial.jsonl',
      ];

  const allResults: SkillResult[] = [];

  for (const filepath of files) {
    const fixtures = loadFixtures(filepath);
    console.log(`\n=== ${filepath} (${fixtures.length} fixtures) ===\n`);

    for (const fx of fixtures) {
      const textBag = [fx.headline, fx.snippet].filter(Boolean).join(' ');

      for (const skill of fx.target_skills) {
        const gold = fx.gold[skill];
        if (!gold) {
          console.warn(`  WARN: ${fx.id} missing gold label for "${skill}"`);
          continue;
        }

        const detected = detectSkillInText(skill, textBag);
        const expected = expectedDetection(gold);
        const correct = detected === expected;

        allResults.push({ fixtureId: fx.id, skill, gold, detected, correct });

        if (verbose || !correct) {
          const icon = correct ? 'OK' : 'MISS';
          const detail = `detected=${detected} expected=${expected} gold=${gold}`;
          console.log(`  ${icon.padEnd(4)} ${fx.id} "${skill}" — ${detail}${fx.note ? ` [${fx.note}]` : ''}`);
        }
      }
    }
  }

  // Aggregate metrics
  const total = allResults.length;
  const correct = allResults.filter((r) => r.correct).length;
  const accuracy = total > 0 ? ((correct / total) * 100).toFixed(1) : '0';

  const detected = allResults.filter((r) => r.detected);
  const truePositives = detected.filter((r) => r.gold === 'explicit').length;
  const falsePositives = detected.filter((r) => r.gold !== 'explicit').length;
  const precision = detected.length > 0 ? ((truePositives / detected.length) * 100).toFixed(1) : 'N/A';

  const explicits = allResults.filter((r) => r.gold === 'explicit');
  const explicitDetected = explicits.filter((r) => r.detected).length;
  const recall = explicits.length > 0 ? ((explicitDetected / explicits.length) * 100).toFixed(1) : 'N/A';

  const negatives = allResults.filter((r) => r.gold !== 'explicit');
  const falseDetections = negatives.filter((r) => r.detected).length;
  const fpRate = negatives.length > 0 ? ((falseDetections / negatives.length) * 100).toFixed(1) : 'N/A';

  // Per-gold-label breakdown
  const byGold: Record<string, { total: number; detected: number; correct: number }> = {};
  for (const r of allResults) {
    if (!byGold[r.gold]) byGold[r.gold] = { total: 0, detected: 0, correct: 0 };
    byGold[r.gold].total++;
    if (r.detected) byGold[r.gold].detected++;
    if (r.correct) byGold[r.gold].correct++;
  }

  console.log('\n--- Aggregate Results ---');
  console.log(`  Total skill checks:  ${total}`);
  console.log(`  Correct:             ${correct} (${accuracy}%)`);
  console.log(`  Precision:           ${precision}% (${truePositives}/${detected.length} detections were explicit)`);
  console.log(`  Recall:              ${recall}% (${explicitDetected}/${explicits.length} explicits detected)`);
  console.log(`  FP rate:             ${fpRate}% (${falseDetections}/${negatives.length} non-explicit wrongly detected)`);

  console.log('\n--- Per Gold Label ---');
  for (const [label, stats] of Object.entries(byGold)) {
    const correctPct = stats.total > 0 ? ((stats.correct / stats.total) * 100).toFixed(0) : '0';
    console.log(`  ${label.padEnd(15)} total=${stats.total} detected=${stats.detected} correct=${stats.correct} (${correctPct}%)`);
  }

  // Misses summary
  const misses = allResults.filter((r) => !r.correct);
  if (misses.length > 0) {
    console.log(`\n--- Misses (${misses.length}) ---`);
    for (const m of misses) {
      const kind = m.detected ? 'FALSE_POS' : 'MISSED';
      console.log(`  ${kind.padEnd(10)} ${m.fixtureId} "${m.skill}" gold=${m.gold}`);
    }
  }
}

main();
