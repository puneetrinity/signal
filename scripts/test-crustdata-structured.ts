/**
 * Plain test: verify the Crustdata structured-search adapter returns candidates
 * for a representative job spec, with richer hints (currentTitle, currentCompany).
 *
 * No DB, no Redis, no queue — just adapter → live Crustdata API → assertions.
 */
import { crustdataProvider } from '@/lib/search/providers/crustdata';
import type { StructuredJobSearchSpec } from '@/lib/search/providers/types';

const REQUIRED_KEY = 'CRUSTDATA_API_KEY';
if (!process.env[REQUIRED_KEY]) {
  console.error(`${REQUIRED_KEY} not set in env`);
  process.exit(1);
}

interface Case {
  label: string;
  spec: StructuredJobSearchSpec;
  expectMin: number;
}

const cases: Case[] = [
  {
    label: 'Senior Hadoop Developer + Bengaluru + skills OR (hadoop, spark, hive, hdfs)',
    spec: {
      title: 'Hadoop Developer',
      city: 'Bengaluru',
      country: 'IN',
      skills: ['hadoop', 'spark', 'hive', 'hdfs'],
      seniorityLevel: 'senior',
    },
    expectMin: 5,
  },
  {
    label: 'Frontend Developer + Pune + skills OR (react, typescript)',
    spec: {
      title: 'Frontend Developer',
      city: 'Pune',
      country: 'IN',
      skills: ['react', 'typescript'],
    },
    expectMin: 5,
  },
  {
    label: 'No-skills test: just title + city',
    spec: {
      title: 'Backend Developer',
      city: 'Hyderabad',
      country: 'IN',
      skills: [],
    },
    expectMin: 5,
  },
  {
    label: 'No-city test: country only',
    spec: {
      title: 'Data Scientist',
      city: null,
      country: 'IN',
      skills: ['python', 'machine learning'],
    },
    expectMin: 5,
  },
];

async function run() {
  console.log('=== Crustdata structured search test ===\n');
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    process.stdout.write(`[${c.label}] ... `);
    const start = Date.now();
    try {
      const results = await crustdataProvider.searchByJobSpec!(c.spec, 100);
      const elapsed = Date.now() - start;
      const enoughResults = results.length >= c.expectMin;
      const hasStructuredHints = results.some(
        (r) =>
          r.providerMeta &&
          ((r.providerMeta as Record<string, unknown>).currentTitle ||
            (r.providerMeta as Record<string, unknown>).currentCompany),
      );

      if (enoughResults) {
        console.log(`PASS (${results.length} results, ${elapsed}ms, structuredHints=${hasStructuredHints})`);
        passed++;
        // Show first 3 candidates with structured hints
        for (const r of results.slice(0, 3)) {
          const meta = (r.providerMeta ?? {}) as Record<string, unknown>;
          console.log(
            `   - ${r.name ?? r.title} | currentTitle="${meta.currentTitle ?? '(none)'}" | currentCompany="${meta.currentCompany ?? '(none)'}" | ${r.location ?? '(no loc)'}`,
          );
        }
      } else {
        console.log(`FAIL (only ${results.length} results, expected >= ${c.expectMin})`);
        failed++;
      }
    } catch (err) {
      console.log(`FAIL (error: ${err instanceof Error ? err.message : err})`);
      failed++;
    }
    console.log();
    // Crustdata rate-limit safety
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`=== Summary: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
