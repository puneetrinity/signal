#!/usr/bin/env npx tsx
/**
 * Signal Debug Agent
 *
 * Investigative agent that diagnoses why Signal ranked, enriched,
 * or bridged candidates the way it did.
 *
 * Usage:
 *   npx tsx scripts/signal-debug-agent.ts --request-id <id>
 *   npx tsx scripts/signal-debug-agent.ts --candidate-id <id>
 *   npx tsx scripts/signal-debug-agent.ts --external-job-id <id> --tenant-id <id>
 *   npx tsx scripts/signal-debug-agent.ts --request-id <id> --candidate-id <id> --question "why rank X above Y?"
 */

// ---- Railway read-only connection ----
// Must be set BEFORE any imports that trigger Prisma client initialization.

const RAILWAY_RO_URL = 'postgresql://signal_debug_ro:debugReadOnly2026!@crossover.proxy.rlwy.net:18271/railway';

if (process.argv.includes('--railway')) {
  process.env.DATABASE_URL = RAILWAY_RO_URL;
}

import { query, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { buildPrompt, type DebugAgentArgs } from './debug-agent/prompt';
import { allTools } from './debug-agent/tools';

// ---- CLI parsing ----

interface CliFlags extends DebugAgentArgs {
  railway?: boolean;
}

function parseArgs(): CliFlags {
  const args: CliFlags = {};
  const argv = process.argv.slice(2);

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--request-id':
        args.requestId = argv[++i];
        break;
      case '--candidate-id':
        args.candidateId = argv[++i];
        break;
      case '--external-job-id':
        args.externalJobId = argv[++i];
        break;
      case '--tenant-id':
        args.tenantId = argv[++i];
        break;
      case '--question':
        args.question = argv[++i];
        break;
      case '--railway':
        args.railway = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        console.error(`Unknown flag: ${argv[i]}`);
        printUsage();
        process.exit(1);
    }
  }

  return args;
}

function validate(args: CliFlags): void {
  const hasId = args.requestId || args.candidateId || args.externalJobId;
  if (!hasId) {
    console.error('Error: At least one ID flag is required.');
    printUsage();
    process.exit(1);
  }
  if (args.externalJobId && !args.tenantId) {
    console.error('Error: --tenant-id is required when using --external-job-id');
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`
Signal Debug Agent — investigate why Signal behaved a certain way.

Usage:
  npx tsx scripts/signal-debug-agent.ts --request-id <id>
  npx tsx scripts/signal-debug-agent.ts --candidate-id <id>
  npx tsx scripts/signal-debug-agent.ts --external-job-id <id> --tenant-id <id>

Flags:
  --request-id <id>        JobSourcingRequest UUID
  --candidate-id <id>      Candidate UUID
  --external-job-id <id>   External job ID (requires --tenant-id)
  --tenant-id <id>         Tenant UUID (required with --external-job-id)
  --question <text>        Supplementary question (requires at least one ID flag)
  --railway                Connect to Railway prod DB (read-only)
`);
}

// ---- Main ----

async function main() {
  const args = parseArgs();
  validate(args);

  if (args.railway) {
    console.log('Using Railway DB (read-only)');
  }

  const prompt = buildPrompt(args);

  console.log('Starting Signal Debug Agent...');
  console.log(`  Request ID: ${args.requestId ?? '-'}`);
  console.log(`  Candidate ID: ${args.candidateId ?? '-'}`);
  console.log(`  External Job ID: ${args.externalJobId ?? '-'}`);
  console.log(`  Question: ${args.question ?? '-'}`);
  console.log('');

  const signalTools = createSdkMcpServer({ name: 'signal-debug', tools: allTools });

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      allowedTools: [
        'Read', 'Grep', 'Glob',
        'mcp__signal-debug__get_request_results',
        'mcp__signal-debug__get_candidate_details',
        'mcp__signal-debug__get_request_candidate',
        'mcp__signal-debug__run_sql_readonly',
        'mcp__signal-debug__get_job_summary',
      ],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 30,
      mcpServers: { 'signal-debug': signalTools },
    },
  })) {
    if ('result' in message) {
      console.log('\n' + message.result);
    } else if (message.type === 'result') {
      console.error('\nAgent stopped unexpectedly:', JSON.stringify(message));
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
