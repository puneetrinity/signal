/**
 * Re-run location extraction on stored searchTitle/searchSnippet data.
 * Compares stored locationHint vs what current code would produce.
 *
 * Usage: npx tsx scripts/audit-location-extraction.ts < /tmp/location_audit_sample.csv
 */

import { readFileSync } from 'fs';
import { extractLocationFromSerpResult } from '@/lib/enrichment/hint-extraction';
import { locationHintQualityScore, normalizeHint } from '@/lib/sourcing/hint-sanitizer';

// Simple CSV parser: handles quoted fields with commas/newlines
function parseCSV(text: string): { id: string; searchTitle: string; searchSnippet: string; locationHint: string }[] {
  const lines = text.split('\n');
  const results: { id: string; searchTitle: string; searchSnippet: string; locationHint: string }[] = [];
  let i = 1; // skip header
  while (i < lines.length) {
    let line = lines[i];
    if (!line.trim()) { i++; continue; }
    // Accumulate lines if we're inside a quoted field
    while ((line.match(/"/g) || []).length % 2 !== 0 && i + 1 < lines.length) {
      i++;
      line += '\n' + lines[i];
    }
    const fields: string[] = [];
    let pos = 0;
    while (pos < line.length && fields.length < 4) {
      if (line[pos] === '"') {
        const end = line.indexOf('",', pos + 1);
        if (end === -1) {
          fields.push(line.slice(pos + 1, line.length - (line.endsWith('"') ? 1 : 0)));
          pos = line.length;
        } else {
          fields.push(line.slice(pos + 1, end));
          pos = end + 2;
        }
      } else {
        const end = line.indexOf(',', pos);
        if (end === -1 || fields.length === 3) {
          fields.push(line.slice(pos));
          pos = line.length;
        } else {
          fields.push(line.slice(pos, end));
          pos = end + 1;
        }
      }
    }
    if (fields.length >= 4) {
      results.push({
        id: fields[0].replace(/""/g, '"'),
        searchTitle: fields[1].replace(/""/g, '"'),
        searchSnippet: fields[2].replace(/""/g, '"'),
        locationHint: fields[3].replace(/""/g, '"'),
      });
    }
    i++;
  }
  return results;
}

const csvPath = process.argv[2] || '/tmp/location_audit_sample.csv';
const csv = readFileSync(csvPath, 'utf-8');
const rows = parseCSV(csv);

let total = 0;
let changed = 0;
let fixed = 0;   // was bad, now correct or null
let regressed = 0; // was good, now different

console.log('id | stored | reExtracted | storedScore | newScore | verdict');
console.log('---|--------|-------------|-------------|----------|--------');

for (const row of rows) {
  total++;
  const stored = row.locationHint || null;
  const reExtracted = extractLocationFromSerpResult(row.searchTitle || '', row.searchSnippet || '') ?? null;

  // Apply the same scored selection the new upsert code does
  const normalizedProvider = normalizeHint(reExtracted ?? undefined) ?? null;
  const providerScore = locationHintQualityScore(normalizedProvider);
  const newLocation = providerScore > 0 ? normalizedProvider : null;

  const storedScore = locationHintQualityScore(stored);
  const same = stored === newLocation;

  if (!same) {
    changed++;
    // Bad stored = score 0 or obviously wrong (title text)
    const wasBad = storedScore === 0;
    const nowBetter = (newLocation === null && wasBad) || (providerScore > storedScore);
    if (wasBad || nowBetter) fixed++;
    else if (storedScore > 0 && providerScore < storedScore) regressed++;

    console.log(
      `${row.id.slice(-8)} | ${(stored ?? 'null').padEnd(35)} | ${(newLocation ?? 'null').padEnd(35)} | ${storedScore} | ${providerScore} | ${wasBad ? 'FIXED' : nowBetter ? 'IMPROVED' : providerScore < storedScore ? 'REGRESSED' : 'CHANGED'}`
    );
  }
}

console.log('\n--- Summary ---');
console.log(`Total: ${total}`);
console.log(`Unchanged: ${total - changed}`);
console.log(`Changed: ${changed}`);
console.log(`  Fixed (bad→null or improved): ${fixed}`);
console.log(`  Regressed (good→worse): ${regressed}`);
console.log(`  Other changes: ${changed - fixed - regressed}`);
