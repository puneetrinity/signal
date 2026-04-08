import { PrismaClient } from '@prisma/client';
import { extractAllHints, extractNameFromSlug } from '../src/lib/enrichment/hint-extraction';

const prisma = new PrismaClient();

async function main() {
  const candidates = await prisma.candidate.findMany({
    where: {
      nameHint: null
    }
  });

  console.log(`Found ${candidates.length} candidates missing nameHint...`);

  let updated = 0;
  for (const c of candidates) {
    let nameHint: string | null = null;
    
    if (c.searchTitle || c.searchSnippet) {
      const extracted = extractAllHints(c.linkedinId, c.searchTitle || '', c.searchSnippet || '');
      if (extracted.nameHint) {
        nameHint = extracted.nameHint;
      }
    }
    
    // Fall back to linkedinId slug
    if (!nameHint) {
      nameHint = extractNameFromSlug(c.linkedinId);
    }

    if (nameHint) {
      await prisma.candidate.update({
        where: { id: c.id },
        data: { nameHint }
      });
      updated++;
    }
  }

  console.log(`Successfully backfilled nameHint for ${updated} candidates.`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
