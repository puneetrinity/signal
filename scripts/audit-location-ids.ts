/**
 * Emit full candidate IDs where stored locationHint would be nulled by current parser.
 * Output: one ID per line, suitable for SQL IN clause.
 */

import { readFileSync, writeFileSync } from 'fs';
import { extractLocationFromSerpResult } from '@/lib/enrichment/hint-extraction';
import { locationHintQualityScore, normalizeHint } from '@/lib/sourcing/hint-sanitizer';

function parseCSV(text: string) {
  const lines = text.split('\n');
  const results: { id: string; searchTitle: string; searchSnippet: string; locationHint: string }[] = [];
  let i = 1;
  while (i < lines.length) {
    let line = lines[i];
    if (!line.trim()) { i++; continue; }
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

const csv = readFileSync('/tmp/location_audit_full.csv', 'utf-8');
const rows = parseCSV(csv);

const badIds: string[] = [];

for (const row of rows) {
  const stored = row.locationHint || null;
  if (!stored) continue;

  const reExtracted = extractLocationFromSerpResult(row.searchTitle || '', row.searchSnippet || '') ?? null;
  const normalizedProvider = normalizeHint(reExtracted ?? undefined) ?? null;
  const providerScore = locationHintQualityScore(normalizedProvider);
  const newLocation = providerScore > 0 ? normalizedProvider : null;

  // Only include rows where new parser produces null (clear garbage)
  if (newLocation === null && stored !== null) {
    badIds.push(row.id);
  }
}

// Write IDs file
writeFileSync('/tmp/location_cleanup_ids.txt', badIds.join('\n') + '\n');
console.log(`Total bad IDs: ${badIds.length}`);
