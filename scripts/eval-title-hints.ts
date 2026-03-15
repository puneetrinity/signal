#!/usr/bin/env npx tsx
/**
 * Title Hint Extraction Evaluator
 *
 * Evaluates the accuracy of headline and company extraction from SERP titles.
 * Runs: extractHeadlineFromTitle() → extractCompanyFromHeadline()
 * and compares against gold labels.
 *
 * Metrics:
 *   - headline_accuracy, company_accuracy
 *   - false_headline_rate, false_company_rate
 *   - null_miss_rate
 *   - headline_partial_match_rate, company_partial_match_rate
 *
 * Usage:
 *   npx tsx scripts/eval-title-hints.ts
 *   npx tsx scripts/eval-title-hints.ts --verbose
 *   npx tsx scripts/eval-title-hints.ts --fixtures research/datasets/title-fixtures-adversarial.jsonl
 */

import * as fs from 'fs';
import * as readline from 'readline';

import {
  extractHeadlineFromTitle,
  extractCompanyFromHeadline,
} from '../src/lib/enrichment/hint-extraction';

// ---------- Types ----------

interface TitleFixture {
  id: string;
  linkedinId: string;
  caseType?: string;
  serp: {
    title: string;
    snippet: string;
    meta?: Record<string, unknown>;
  };
  gold: {
    headline: string | null;
    company: string | null;
  };
}

export interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

type Verdict = 'MATCH' | 'MISMATCH' | 'FALSE_POSITIVE' | 'MISS' | 'PARTIAL';

interface FieldResult {
  verdict: Verdict;
  rawExtracted: string | null;
  normalizedExtracted: string | null;
  normalizedGold: string | null;
}

interface FixtureResult {
  id: string;
  caseType: string | null;
  headline: FieldResult;
  company: FieldResult;
}

// ---------- Normalization ----------

function normalizeForComparison(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ---------- Verdict logic ----------

function computeVerdict(
  rawExtracted: string | null,
  gold: string | null,
): FieldResult {
  const normalizedExtracted = rawExtracted ? normalizeForComparison(rawExtracted) : null;
  const normalizedGold = gold ? normalizeForComparison(gold) : null;

  let verdict: Verdict;

  if (normalizedGold === null && normalizedExtracted === null) {
    verdict = 'MATCH';
  } else if (normalizedGold === null && normalizedExtracted !== null) {
    verdict = 'FALSE_POSITIVE';
  } else if (normalizedGold !== null && normalizedExtracted === null) {
    verdict = 'MISS';
  } else if (normalizedExtracted === normalizedGold) {
    verdict = 'MATCH';
  } else if (
    normalizedExtracted!.includes(normalizedGold!) ||
    normalizedGold!.includes(normalizedExtracted!)
  ) {
    verdict = 'PARTIAL';
  } else {
    verdict = 'MISMATCH';
  }

  return {
    verdict,
    rawExtracted,
    normalizedExtracted,
    normalizedGold,
  };
}

// ---------- Fixture loading ----------

async function loadFixtures(fixturePath: string): Promise<TitleFixture[]> {
  const fixtures: TitleFixture[] = [];
  const fileStream = fs.createReadStream(fixturePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) fixtures.push(JSON.parse(line));
  }
  return fixtures;
}

// ---------- Single fixture evaluation ----------

function evaluateFixture(fixture: TitleFixture): FixtureResult {
  const extractedHeadline = extractHeadlineFromTitle(fixture.serp.title);
  const extractedCompany = extractCompanyFromHeadline(extractedHeadline);

  return {
    id: fixture.id,
    caseType: fixture.caseType ?? null,
    headline: computeVerdict(extractedHeadline, fixture.gold.headline),
    company: computeVerdict(extractedCompany, fixture.gold.company),
  };
}

// ---------- Aggregate metrics ----------

function computeMetrics(results: FixtureResult[]) {
  const total = results.length;

  // Headline metrics
  const withGoldHeadline = results.filter(r => r.headline.normalizedGold !== null);
  const headlineMatchesWithGold = withGoldHeadline.filter(r => r.headline.verdict === 'MATCH').length;
  const headlineFPs = results.filter(r => r.headline.verdict === 'FALSE_POSITIVE').length;
  const headlineMisses = results.filter(r => r.headline.verdict === 'MISS').length;
  const headlinePartials = results.filter(r => r.headline.verdict === 'PARTIAL').length;
  const headlineMismatches = results.filter(r => r.headline.verdict === 'MISMATCH').length;

  // Company metrics (independent of headline)
  const withGoldCompany = results.filter(r => r.company.normalizedGold !== null);
  const companyMatchesWithGold = withGoldCompany.filter(r => r.company.verdict === 'MATCH').length;
  const companyFPs = results.filter(r => r.company.verdict === 'FALSE_POSITIVE').length;
  const companyPartials = results.filter(r => r.company.verdict === 'PARTIAL').length;
  const companyMismatches = results.filter(r => r.company.verdict === 'MISMATCH').length;

  const headline_accuracy = withGoldHeadline.length > 0
    ? headlineMatchesWithGold / withGoldHeadline.length : 1;
  const company_accuracy = withGoldCompany.length > 0
    ? companyMatchesWithGold / withGoldCompany.length : 1;
  const false_headline_rate = total > 0 ? headlineFPs / total : 0;
  const false_company_rate = total > 0 ? companyFPs / total : 0;
  const null_miss_rate = withGoldHeadline.length > 0
    ? headlineMisses / withGoldHeadline.length : 0;
  const headline_partial_match_rate = withGoldHeadline.length > 0
    ? headlinePartials / withGoldHeadline.length : 0;
  const company_partial_match_rate = withGoldCompany.length > 0
    ? companyPartials / withGoldCompany.length : 0;

  const metrics: Record<string, number> = {
    total,
    headline_accuracy,
    company_accuracy,
    false_headline_rate,
    false_company_rate,
    null_miss_rate,
    headline_partial_match_rate,
    company_partial_match_rate,
    headline_matches: headlineMatchesWithGold,
    headline_with_gold: withGoldHeadline.length,
    headline_fps: headlineFPs,
    headline_misses: headlineMisses,
    headline_partials: headlinePartials,
    headline_mismatches: headlineMismatches,
    company_matches: companyMatchesWithGold,
    company_with_gold: withGoldCompany.length,
    company_fps: companyFPs,
    company_partials: companyPartials,
    company_mismatches: companyMismatches,
  };

  // Collect failures
  const headlineFailures = results.filter(r =>
    r.headline.verdict !== 'MATCH',
  );
  const companyFailures = results.filter(r =>
    r.company.verdict !== 'MATCH',
  );

  return { metrics, headlineFailures, companyFailures };
}

// ---------- Evaluator entry point (called by research-runner) ----------

export async function run(config: Record<string, unknown> = {}): Promise<EvalResult> {
  const fixturePath = (config.fixturePath as string) || 'research/datasets/title-fixtures-core.jsonl';
  const fixtures = await loadFixtures(fixturePath);
  const results = fixtures.map(evaluateFixture);
  const { metrics, headlineFailures, companyFailures } = computeMetrics(results);

  const objective =
    metrics.headline_accuracy +
    0.25 * metrics.company_accuracy -
    metrics.false_headline_rate -
    0.5 * metrics.null_miss_rate;

  return {
    objective,
    metrics,
    artifacts: {
      headlineFailures: headlineFailures.map(r => ({
        id: r.id,
        caseType: r.caseType,
        headline: r.headline,
      })),
      companyFailures: companyFailures.map(r => ({
        id: r.id,
        caseType: r.caseType,
        company: r.company,
      })),
      allResults: results,
    },
  };
}

// ---------- CLI mode ----------

async function main() {
  const args = process.argv.slice(2);
  let fixturePath = 'research/datasets/title-fixtures-core.jsonl';
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--fixtures' || args[i] === '--fixture') && args[i + 1]) {
      fixturePath = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    }
  }

  const result = await run({ fixturePath });

  console.log('\n=== Title Hint Evaluation ===\n');
  console.log(`Objective: ${result.objective.toFixed(4)}`);
  console.log(
    `Headline accuracy: ${(result.metrics.headline_accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.headline_matches}/${result.metrics.headline_with_gold})`,
  );
  console.log(
    `Company accuracy: ${(result.metrics.company_accuracy * 100).toFixed(1)}%` +
    ` (${result.metrics.company_matches}/${result.metrics.company_with_gold})`,
  );
  console.log(`False headline rate: ${(result.metrics.false_headline_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.headline_fps})`);
  console.log(`False company rate: ${(result.metrics.false_company_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.company_fps})`);
  console.log(`Null miss rate: ${(result.metrics.null_miss_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.headline_misses})`);
  console.log(`Headline partial: ${(result.metrics.headline_partial_match_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.headline_partials})`);
  console.log(`Company partial: ${(result.metrics.company_partial_match_rate * 100).toFixed(1)}%` +
    ` (${result.metrics.company_partials})`);

  // Headline failures grouped by verdict
  const hf = result.artifacts?.headlineFailures as Array<{
    id: string; caseType: string | null; headline: FieldResult;
  }>;
  if (hf.length > 0) {
    const byVerdict = new Map<string, typeof hf>();
    for (const f of hf) {
      const v = f.headline.verdict;
      if (!byVerdict.has(v)) byVerdict.set(v, []);
      byVerdict.get(v)!.push(f);
    }
    console.log(`\n--- Headline Failures (${hf.length}) ---`);
    for (const [verdict, items] of byVerdict) {
      console.log(`\n  ${verdict} (${items.length}):`);
      for (const f of items) {
        const caseTag = f.caseType ? ` [${f.caseType}]` : '';
        console.log(
          `    ${f.id}${caseTag}: ` +
          `raw="${f.headline.rawExtracted}" ` +
          `norm="${f.headline.normalizedExtracted}" ` +
          `gold="${f.headline.normalizedGold}"`,
        );
      }
    }
  }

  // Company failures grouped by verdict
  const cf = result.artifacts?.companyFailures as Array<{
    id: string; caseType: string | null; company: FieldResult;
  }>;
  if (cf.length > 0) {
    const byVerdict = new Map<string, typeof cf>();
    for (const f of cf) {
      const v = f.company.verdict;
      if (!byVerdict.has(v)) byVerdict.set(v, []);
      byVerdict.get(v)!.push(f);
    }
    console.log(`\n--- Company Failures (${cf.length}) ---`);
    for (const [verdict, items] of byVerdict) {
      console.log(`\n  ${verdict} (${items.length}):`);
      for (const f of items) {
        const caseTag = f.caseType ? ` [${f.caseType}]` : '';
        console.log(
          `    ${f.id}${caseTag}: ` +
          `raw="${f.company.rawExtracted}" ` +
          `norm="${f.company.normalizedExtracted}" ` +
          `gold="${f.company.normalizedGold}"`,
        );
      }
    }
  }

  // Verbose: all results
  if (verbose) {
    const allResults = result.artifacts?.allResults as FixtureResult[];
    console.log('\n--- All Results ---');
    for (const r of allResults) {
      const hOk = r.headline.verdict === 'MATCH';
      const cOk = r.company.verdict === 'MATCH';
      const mark = hOk && cOk ? 'OK' : 'FAIL';
      const caseTag = r.caseType ? ` [${r.caseType}]` : '';
      console.log(
        `  [${mark}] ${r.id}${caseTag}:` +
        ` headline=${r.headline.verdict}` +
        ` raw="${r.headline.rawExtracted}"` +
        ` gold="${r.headline.normalizedGold}"` +
        ` | company=${r.company.verdict}` +
        ` raw="${r.company.rawExtracted}"` +
        ` gold="${r.company.normalizedGold}"`,
      );
    }
  }
}

if (process.argv[1]?.includes('eval-title-hints')) {
  main().catch(err => {
    console.error('Eval failed:', err);
    process.exit(1);
  });
}
