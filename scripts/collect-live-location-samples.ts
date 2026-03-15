#!/usr/bin/env npx tsx
/**
 * Live Location Sample Collector
 *
 * Pulls a sample of candidates from DB, runs one live Serper query each,
 * and saves raw SERP data as fixture JSONL for offline evaluation.
 *
 * Budget-capped: hard limit on total queries. Never used inside eval loops.
 *
 * Usage:
 *   SERPER_API_KEY=xxx npx tsx scripts/collect-live-location-samples.ts --limit 50
 *   SERPER_API_KEY=xxx npx tsx scripts/collect-live-location-samples.ts --limit 50 --output research/datasets/location-fixtures-sampled.jsonl
 *
 * Flow:
 *   1. Run this script (burns N Serper credits)
 *   2. Inspect output for failures/interesting cases
 *   3. Manually curate into core/prod/adversarial fixtures
 *   4. Run offline eval many times for free
 */

import * as fs from 'fs';

// ---------- Types ----------

interface SampleCandidate {
  linkedinId: string;
  name: string | null;
  locationHint: string | null;
  searchTitle: string | null;
  searchSnippet: string | null;
}

interface CollectedFixture {
  id: string;
  linkedinId: string;
  serp: {
    title: string;
    snippet: string;
    meta?: Record<string, unknown>;
  };
  gold: {
    locationText: string | null;
    city: string | null;
    countryCode: string | null;
    source: string;
  };
  _raw: {
    dbLocationHint: string | null;
    dbSearchTitle: string | null;
    dbSearchSnippet: string | null;
    liveTitle: string | null;
    liveSnippet: string | null;
  };
}

// ---------- Serper query ----------

async function serperSearch(query: string): Promise<{
  organic: Array<{ title?: string; link?: string; snippet?: string; position?: number }>;
  knowledgeGraph?: Record<string, unknown>;
  answerBox?: Record<string, unknown>;
} | null> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    console.error('SERPER_API_KEY not set');
    return null;
  }

  const url = process.env.SERPER_URL || 'https://google.serper.dev/search';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: 5, hl: 'en' }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      console.error(`Serper HTTP ${resp.status}: ${await resp.text()}`);
      return null;
    }

    return await resp.json() as Awaited<ReturnType<typeof serperSearch>> & object;
  } catch (err) {
    console.error('Serper request failed:', err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------- DB query ----------

async function sampleCandidatesFromDb(limit: number): Promise<SampleCandidate[]> {
  // Dynamic import to avoid loading prisma at module level
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // Get candidates that have SERP data but missing or low-quality locationHint
    const rows = await prisma.$queryRawUnsafe<SampleCandidate[]>(`
      SELECT
        "linkedinId",
        "name",
        "locationHint",
        "searchTitle",
        "searchSnippet"
      FROM "candidates"
      WHERE "searchSnippet" IS NOT NULL
        AND "searchSnippet" != ''
        AND ("locationHint" IS NULL OR "locationHint" = '')
      ORDER BY RANDOM()
      LIMIT ${limit}
    `);
    return rows;
  } finally {
    await prisma.$disconnect();
  }
}

// ---------- CLI ----------

function parseArgs(): { limit: number; output: string; dbOnly: boolean } {
  const args = process.argv.slice(2);
  let limit = 50;
  let output = 'research/datasets/location-fixtures-sampled.jsonl';
  let dbOnly = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[++i], 10);
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
    else if (args[i] === '--db-only') dbOnly = true;
  }

  if (limit > 200) {
    console.error('Hard cap: --limit must be <= 200 to protect Serper credits');
    process.exit(1);
  }

  return { limit, output, dbOnly };
}

// ---------- Main ----------

async function main() {
  const { limit, output, dbOnly } = parseArgs();

  console.log(`Sampling ${limit} candidates from DB...`);
  const candidates = await sampleCandidatesFromDb(limit);
  console.log(`Got ${candidates.length} candidates`);

  if (candidates.length === 0) {
    console.log('No candidates found');
    return;
  }

  const fixtures: CollectedFixture[] = [];
  let queriesMade = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const id = `sampled_${String(i + 1).padStart(3, '0')}`;

    if (dbOnly) {
      // Use existing DB data only, no live Serper
      fixtures.push({
        id,
        linkedinId: c.linkedinId,
        serp: {
          title: c.searchTitle || '',
          snippet: c.searchSnippet || '',
        },
        gold: {
          locationText: null,
          city: null,
          countryCode: null,
          source: 'needs_labeling',
        },
        _raw: {
          dbLocationHint: c.locationHint,
          dbSearchTitle: c.searchTitle,
          dbSearchSnippet: c.searchSnippet,
          liveTitle: null,
          liveSnippet: null,
        },
      });
      continue;
    }

    // Live Serper query
    const query = `site:linkedin.com/in/${c.linkedinId}`;
    console.log(`[${i + 1}/${candidates.length}] Querying: ${c.linkedinId}`);

    const result = await serperSearch(query);
    queriesMade++;

    if (!result || !result.organic?.length) {
      console.log(`  No results`);
      continue;
    }

    // Find the matching LinkedIn profile result
    const profileResult = result.organic.find(r =>
      r.link?.includes(`/in/${c.linkedinId}`)
    );

    if (!profileResult) {
      console.log(`  No matching profile in results`);
      continue;
    }

    const meta: Record<string, unknown> = {};
    if (result.knowledgeGraph) meta.knowledgeGraph = result.knowledgeGraph;
    if (result.answerBox) meta.answerBox = result.answerBox;

    fixtures.push({
      id,
      linkedinId: c.linkedinId,
      serp: {
        title: profileResult.title || '',
        snippet: profileResult.snippet || '',
        ...(Object.keys(meta).length > 0 ? { meta } : {}),
      },
      gold: {
        locationText: null,
        city: null,
        countryCode: null,
        source: 'needs_labeling',
      },
      _raw: {
        dbLocationHint: c.locationHint,
        dbSearchTitle: c.searchTitle,
        dbSearchSnippet: c.searchSnippet,
        liveTitle: profileResult.title || null,
        liveSnippet: profileResult.snippet || null,
      },
    });

    // Respect rate limits
    if (i < candidates.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // Write output
  const lines = fixtures.map(f => JSON.stringify(f));
  fs.writeFileSync(output, lines.join('\n') + '\n');

  console.log(`\nDone.`);
  console.log(`  Candidates sampled: ${candidates.length}`);
  console.log(`  Serper queries made: ${queriesMade}`);
  console.log(`  Fixtures collected: ${fixtures.length}`);
  console.log(`  Output: ${output}`);
  console.log(`\nNext: inspect output, label gold values, curate into core/prod/adversarial.`);
}

main().catch(err => {
  console.error('Collector failed:', err);
  process.exit(1);
});
