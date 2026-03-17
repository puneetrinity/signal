/**
 * SQL validation and result truncation for the Signal Debug Agent.
 * Pure functions — no DB access.
 */

export function validateSql(raw: string): { valid: true; query: string } | { valid: false; error: string } {
  let q = raw.trim();

  // Strip one trailing semicolon
  if (q.endsWith(';')) {
    q = q.slice(0, -1).trim();
  }

  // Reject internal semicolons
  if (q.includes(';')) {
    return { valid: false, error: 'Multiple statements not allowed (internal semicolon detected)' };
  }

  // Require starts with SELECT or WITH
  const upper = q.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return { valid: false, error: 'Query must start with SELECT or WITH' };
  }

  // Reject mutation keywords (word-boundary match)
  const BLOCKED_KEYWORDS = [
    'INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'CREATE',
    'TRUNCATE', 'GRANT', 'REVOKE', 'COPY',
  ];
  for (const kw of BLOCKED_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(q)) {
      return { valid: false, error: `Blocked keyword: ${kw}` };
    }
  }

  // Reject Postgres file functions
  const BLOCKED_FUNCTIONS = [
    'pg_read_file', 'pg_read_binary_file', 'lo_export', 'pg_ls_dir', 'pg_stat_file',
  ];
  for (const fn of BLOCKED_FUNCTIONS) {
    if (q.toLowerCase().includes(fn)) {
      return { valid: false, error: `Blocked function: ${fn}` };
    }
  }

  // Reject SQL comments
  if (q.includes('--') || q.includes('/*')) {
    return { valid: false, error: 'SQL comments not allowed' };
  }

  // Append LIMIT 100 if no LIMIT clause
  if (!/\bLIMIT\b/i.test(q)) {
    q = `${q} LIMIT 100`;
  }

  return { valid: true, query: q };
}

export function truncateResults(
  rows: Record<string, unknown>[],
  maxRows = 100,
  maxCellChars = 2000,
): { rows: Record<string, unknown>[]; truncated: boolean } {
  const truncated = rows.length > maxRows;
  const limited = rows.slice(0, maxRows);

  const cleaned = limited.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string' && v.length > maxCellChars) {
        out[k] = v.slice(0, maxCellChars) + '…';
      } else {
        out[k] = v;
      }
    }
    return out;
  });

  return { rows: cleaned, truncated };
}

// ---- Smoke tests (run directly: npx tsx scripts/debug-agent/sql-validator.ts) ----
if (process.argv[1]?.endsWith('sql-validator.ts')) {
  const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

  // Valid queries
  const r1 = validateSql('SELECT * FROM candidates');
  assert(r1.valid && r1.query === 'SELECT * FROM candidates LIMIT 100', 'basic select');

  const r2 = validateSql('  SELECT 1;  ');
  assert(r2.valid && r2.query === 'SELECT 1 LIMIT 100', 'trim + trailing semi');

  const r3 = validateSql('WITH cte AS (SELECT 1) SELECT * FROM cte LIMIT 10');
  assert(r3.valid && r3.query.includes('LIMIT 10'), 'WITH + existing LIMIT preserved');

  // Blocked queries
  const r4 = validateSql('DELETE FROM candidates');
  assert(!r4.valid, 'reject DELETE');

  const r5 = validateSql('SELECT 1; DROP TABLE candidates');
  assert(!r5.valid, 'reject multi-statement');

  const r6 = validateSql("SELECT pg_read_file('/etc/passwd')");
  assert(!r6.valid, 'reject pg_read_file');

  const r7 = validateSql('SELECT * FROM candidates -- comment');
  assert(!r7.valid, 'reject comments');

  const r8 = validateSql('EXPLAIN ANALYZE SELECT 1');
  assert(!r8.valid, 'reject EXPLAIN (not SELECT/WITH)');

  // Truncation
  const bigRows = Array.from({ length: 150 }, (_, i) => ({ id: i, long: 'x'.repeat(3000) }));
  const tr = truncateResults(bigRows);
  assert(tr.truncated, 'truncation flag');
  assert(tr.rows.length === 100, 'row limit');
  assert((tr.rows[0].long as string).length <= 2001, 'cell truncation');

  console.log('All sql-validator smoke tests passed');
}
