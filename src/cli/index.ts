#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import { LocalGitProvider } from '../providers/git/localGit.js';
import { ContributionCalculator } from '../pipeline/calculator.js';
import type { CalculatorOptions } from '../pipeline/calculator.js';
import type { RepositoryRef } from '../domain/types.js';
import { renderExplanation, renderSummary, toJson, displayName } from './report.js';

const exec = promisify(execFile);

interface CliOptions {
  readonly path: string;
  readonly json: boolean;
  readonly top: number;
  readonly since?: Date;
  readonly maxCommits?: number;
  readonly skipBlame: boolean;
  readonly explain?: string;
  readonly rev?: string;
}

const USAGE = `devmerit — analyze what developers actually left behind in a repository

Usage:
  devmerit analyze [path] [options]

Options:
  --json              Emit the full machine-readable report
  --top <n>           Developers to list in the summary (default 20)
  --since <date>      Only analyze commits at or after this ISO date
  --max-commits <n>   Cap the number of commits walked (large repositories)
  --rev <ref>         Revision or range to analyze (default HEAD)
  --no-blame          Skip git blame; faster, less accurate survival figures
  --explain <who>     Print the full score breakdown for one developer
  -h, --help          Show this help
`;

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
    console.log(USAGE);
    return 0;
  }

  const command = argv[0];
  if (command !== 'analyze') {
    console.error(`Unknown command: ${command}\n`);
    console.error(USAGE);
    return 2;
  }

  let options: CliOptions;
  try {
    options = parseArgs(argv.slice(1));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const repo = await describeRepository(options.path);
  const provider = new LocalGitProvider(
    options.rev === undefined ? { cwd: options.path } : { cwd: options.path, rev: options.rev },
  );

  const fetchOptions: Parameters<typeof provider.fetch>[1] = { skipBlame: options.skipBlame };
  if (options.since) Object.assign(fetchOptions, { since: options.since });
  if (options.maxCommits) Object.assign(fetchOptions, { maxCommits: options.maxCommits });

  const snapshot = await provider.fetch(repo, fetchOptions);
  if (snapshot.commits.length === 0) {
    console.error('No commits matched the given range.');
    return 1;
  }

  const calculatorOptions: CalculatorOptions = {};
  const report = new ContributionCalculator(calculatorOptions).calculate(snapshot);

  if (options.explain !== undefined) {
    const needle = options.explain.toLowerCase();
    const score = report.scores.find((s) =>
      [displayName(s), s.developer.email, s.developer.login, s.developer.name]
        .filter((v): v is string => typeof v === 'string')
        .some((v) => v.toLowerCase().includes(needle)),
    );
    if (!score) {
      console.error(`No developer matched "${options.explain}".`);
      return 1;
    }
    console.log(renderExplanation(score));
    return 0;
  }

  console.log(options.json ? toJson(report) : renderSummary(report, options.top));
  return 0;
}

export function parseArgs(args: readonly string[]): CliOptions {
  let path = '.';
  let json = false;
  let top = 20;
  let skipBlame = false;
  let since: Date | undefined;
  let maxCommits: number | undefined;
  let explain: string | undefined;
  let rev: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const next = (): string => {
      const value = args[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--json':
        json = true;
        break;
      case '--no-blame':
        skipBlame = true;
        break;
      case '--top':
        top = positiveInt(next(), arg);
        break;
      case '--max-commits':
        maxCommits = positiveInt(next(), arg);
        break;
      case '--since': {
        const value = next();
        since = new Date(value);
        if (Number.isNaN(since.getTime())) throw new Error(`Invalid date for --since: ${value}`);
        break;
      }
      case '--rev':
        rev = next();
        break;
      case '--explain':
        explain = next();
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        path = arg;
    }
  }

  const result: CliOptions = { path: resolve(path), json, top, skipBlame };
  return {
    ...result,
    ...(since ? { since } : {}),
    ...(maxCommits ? { maxCommits } : {}),
    ...(explain !== undefined ? { explain } : {}),
    ...(rev !== undefined ? { rev } : {}),
  };
}

function positiveInt(value: string, flag: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} expects a positive integer`);
  return n;
}

/** Derives owner/name from the origin remote so reports name the real project. */
async function describeRepository(cwd: string): Promise<RepositoryRef> {
  const fallback: RepositoryRef = { provider: 'git', owner: 'local', name: basename(cwd) };
  try {
    const { stdout } = await exec('git', ['remote', 'get-url', 'origin'], { cwd });
    const url = String(stdout).trim();
    const match = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    if (!match) return fallback;
    return { provider: 'git', owner: match[1]!, name: match[2]! };
  } catch {
    return fallback;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
