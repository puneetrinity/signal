#!/usr/bin/env npx tsx
/**
 * AutoResearch Runner
 *
 * Loads a program definition (JSON), generates search space samples,
 * calls the named evaluator, and saves experiment results.
 *
 * Usage:
 *   npx tsx scripts/research-runner.ts --program research/programs/enrichment-location-hints.json
 *   npx tsx scripts/research-runner.ts --program <path> --verbose
 *   npx tsx scripts/research-runner.ts --program <path> --seed 42
 *
 * Evaluators are resolved by convention: evaluator "location-hints" → scripts/eval-{name}.ts
 * Each evaluator must export: async function run(config): Promise<EvalResult>
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// ---------- Types ----------

interface ResearchProgram {
  name: string;
  evaluator: string;
  objective: string;
  maximize: boolean;
  constraints: Record<string, { max?: number; min?: number } | number>;
  searchSpace: Record<string, unknown[]>;
  budget: {
    iterations: number;
  };
  config?: Record<string, unknown>;
  seed?: number;
}

interface EvalResult {
  objective: number;
  metrics: Record<string, number>;
  artifacts?: Record<string, unknown>;
}

interface ExperimentRecord {
  programName: string;
  runId: string;
  timestamp: string;
  gitCommitSha: string | null;
  seed: number;
  config: Record<string, unknown>;
  objective: number;
  metrics: Record<string, number>;
  artifactsPath: string | null;
  durationMs: number;
  isValid: boolean;
  wasBestSoFar: boolean;
  isFinalBest: boolean;
}

// ---------- Helpers ----------

function getGitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function generateSessionId(): string {
  return crypto.randomBytes(4).toString('hex');
}

// ---------- Seeded PRNG (mulberry32) ----------

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Search space enumeration ----------

function generateGridConfigs(searchSpace: Record<string, unknown[]>): Record<string, unknown>[] {
  const keys = Object.keys(searchSpace);
  if (keys.length === 0) return [{}];

  const configs: Record<string, unknown>[] = [];

  function recurse(index: number, current: Record<string, unknown>) {
    if (index === keys.length) {
      configs.push({ ...current });
      return;
    }
    const key = keys[index];
    for (const value of searchSpace[key]) {
      current[key] = value;
      recurse(index + 1, current);
    }
  }

  recurse(0, {});
  return configs;
}

function sampleConfigs(
  configs: Record<string, unknown>[],
  budget: number,
  rng: () => number,
): Record<string, unknown>[] {
  if (configs.length <= budget) return configs;
  // Fisher-Yates shuffle with seeded RNG, take first `budget`
  const shuffled = [...configs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, budget);
}

// ---------- Constraint checking ----------

function checkConstraints(
  constraints: ResearchProgram['constraints'],
  metrics: Record<string, number>,
  verbose: boolean,
): boolean {
  for (const [key, constraint] of Object.entries(constraints)) {
    const actual = metrics[key];
    if (actual === undefined) continue;
    // Bare number = legacy max-only shorthand
    if (typeof constraint === 'number') {
      if (actual > constraint) {
        if (verbose) console.log(`  Constraint violated: ${key}=${actual} > ${constraint}`);
        return false;
      }
    } else {
      if (constraint.max !== undefined && actual > constraint.max) {
        if (verbose) console.log(`  Constraint violated: ${key}=${actual} > max ${constraint.max}`);
        return false;
      }
      if (constraint.min !== undefined && actual < constraint.min) {
        if (verbose) console.log(`  Constraint violated: ${key}=${actual} < min ${constraint.min}`);
        return false;
      }
    }
  }
  return true;
}

// ---------- Evaluator resolution ----------

async function loadEvaluator(
  evaluatorName: string,
): Promise<(config: Record<string, unknown>) => Promise<EvalResult>> {
  const modulePath = path.resolve(`scripts/eval-${evaluatorName}.ts`);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Evaluator not found: ${modulePath}`);
  }
  const mod = await import(modulePath);
  if (typeof mod.run !== 'function') {
    throw new Error(`Evaluator "${evaluatorName}" does not export a run() function`);
  }
  return mod.run;
}

// ---------- CLI ----------

function parseArgs(): { programPath: string; verbose: boolean; seed: number | null } {
  const args = process.argv.slice(2);
  let programPath = '';
  let verbose = false;
  let seed: number | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--program' && args[i + 1]) programPath = args[++i];
    else if (args[i] === '--verbose' || args[i] === '-v') verbose = true;
    else if (args[i] === '--seed' && args[i + 1]) seed = parseInt(args[++i], 10);
  }

  if (!programPath) {
    console.error('Usage: npx tsx scripts/research-runner.ts --program <path> [--verbose] [--seed N]');
    process.exit(1);
  }

  return { programPath, verbose, seed };
}

// ---------- Main ----------

async function main() {
  const { programPath, verbose, seed: cliSeed } = parseArgs();

  // Load program
  const program: ResearchProgram = JSON.parse(fs.readFileSync(programPath, 'utf-8'));
  console.log(`\n=== AutoResearch: ${program.name} ===`);
  console.log(`Evaluator: ${program.evaluator}`);
  console.log(`Objective: ${program.objective} (${program.maximize ? 'maximize' : 'minimize'})`);

  // Resolve seed: CLI > program > random
  const seed = cliSeed ?? program.seed ?? (crypto.randomBytes(4).readUInt32BE(0));
  const rng = mulberry32(seed);
  console.log(`Seed: ${seed}`);

  // Load evaluator
  const evaluate = await loadEvaluator(program.evaluator);

  // Generate configs from search space
  const hasSearchSpace = Object.keys(program.searchSpace).length > 0;
  let configs: Record<string, unknown>[];

  if (hasSearchSpace) {
    const grid = generateGridConfigs(program.searchSpace);
    configs = sampleConfigs(grid, program.budget.iterations, rng);
    console.log(
      `Search space: ${grid.length} total, running ${configs.length} ` +
      `(budget: ${program.budget.iterations})`,
    );
  } else {
    configs = [{}];
    console.log('No search space — running baseline evaluation');
  }

  // Merge program-level config into each generated config
  if (program.config) {
    configs = configs.map(c => ({ ...program.config, ...c }));
  }

  // Ensure output dir
  const experimentsDir = 'research/experiments';
  fs.mkdirSync(experimentsDir, { recursive: true });

  const gitSha = getGitSha();
  const sessionId = generateSessionId();
  const records: ExperimentRecord[] = [];
  let bestValidObjective = program.maximize ? -Infinity : Infinity;

  // Run experiments
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    const runId = `${sessionId}-${String(i).padStart(3, '0')}`;

    if (verbose) {
      console.log(`\n[${i + 1}/${configs.length}] Config: ${JSON.stringify(config)}`);
    }

    const startTime = Date.now();
    const result = await evaluate(config);
    const durationMs = Date.now() - startTime;

    const isValid = checkConstraints(program.constraints, result.metrics, verbose);

    // Track best valid run
    const isBetter = program.maximize
      ? result.objective > bestValidObjective
      : result.objective < bestValidObjective;

    if (isBetter && isValid) {
      bestValidObjective = result.objective;
    }

    const record: ExperimentRecord = {
      programName: program.name,
      runId,
      timestamp: new Date().toISOString(),
      gitCommitSha: gitSha,
      seed,
      config,
      objective: result.objective,
      metrics: result.metrics,
      artifactsPath: null,
      durationMs,
      isValid,
      wasBestSoFar: isBetter && isValid,
      isFinalBest: false, // set in post-processing
    };

    // Save artifacts
    if (result.artifacts) {
      const artifactsPath = path.join(experimentsDir, `${runId}-artifacts.json`);
      fs.writeFileSync(artifactsPath, JSON.stringify(result.artifacts, null, 2));
      record.artifactsPath = artifactsPath;
    }

    records.push(record);

    if (verbose) {
      const validTag = isValid ? '' : ' [INVALID]';
      console.log(`  Objective: ${result.objective.toFixed(4)} | Duration: ${durationMs}ms${validTag}`);
    } else {
      process.stdout.write(isValid ? '.' : 'x');
    }
  }

  if (!verbose && configs.length > 1) console.log();

  // Post-process: mark final best (single winner among valid runs)
  const validRecords = records.filter(r => r.isValid);
  const sortedValid = [...validRecords].sort((a, b) =>
    program.maximize ? b.objective - a.objective : a.objective - b.objective,
  );
  if (sortedValid.length > 0) {
    sortedValid[0].isFinalBest = true;
  }

  // Save experiment records
  const recordsPath = path.join(experimentsDir, `${sessionId}-records.json`);
  fs.writeFileSync(recordsPath, JSON.stringify(records, null, 2));

  // Print results
  console.log('\n=== Results ===');
  console.log(`Experiments: ${records.length} (${validRecords.length} valid)`);

  const finalBest = sortedValid[0];
  if (finalBest) {
    console.log(`Best valid objective: ${finalBest.objective.toFixed(4)}`);
    if (hasSearchSpace) {
      console.log(`Best valid config: ${JSON.stringify(finalBest.config, null, 2)}`);
    }
  } else {
    console.log('No valid runs (all violated constraints)');
  }

  // Leaderboard (show all, mark invalid)
  const sortedAll = [...records].sort((a, b) =>
    program.maximize ? b.objective - a.objective : a.objective - b.objective,
  );

  if (sortedAll.length > 1) {
    console.log('\n--- Leaderboard ---');
    for (const r of sortedAll.slice(0, 10)) {
      const markers = [
        r.isFinalBest ? ' *BEST*' : '',
        !r.isValid ? ' [INVALID]' : '',
      ].join('');
      console.log(`  ${r.objective.toFixed(4)} | ${JSON.stringify(r.config)}${markers}`);
    }
  }

  // Best valid metrics
  if (finalBest) {
    console.log('\n--- Metrics (best valid) ---');
    for (const [key, value] of Object.entries(finalBest.metrics)) {
      const display = typeof value === 'number'
        ? (Number.isInteger(value) ? String(value) : value.toFixed(4))
        : String(value);
      console.log(`  ${key}: ${display}`);
    }
  }

  console.log(`\nRecords saved to: ${recordsPath}`);
  if (finalBest?.artifactsPath) {
    console.log(`Artifacts saved to: ${finalBest.artifactsPath}`);
  }
}

main().catch(err => {
  console.error('Research runner failed:', err);
  process.exit(1);
});
