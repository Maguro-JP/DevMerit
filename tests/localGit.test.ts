import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalGitProvider, parseNumstatLine, parseRawLine, parseRenamePath } from '../src/providers/git/localGit.js';
import { PathFilter, DEFAULT_EXCLUDES } from '../src/providers/pathFilter.js';
import { ContributionCalculator } from '../src/pipeline/calculator.js';
import { REPO } from './helpers.js';

describe('numstat and raw parsing', () => {
  it('reads insertions, deletions and binary markers', () => {
    expect(parseNumstatLine('12\t3\tsrc/a.ts')).toMatchObject({
      path: 'src/a.ts',
      insertions: 12,
      deletions: 3,
      binary: false,
    });
    expect(parseNumstatLine('-\t-\tassets/logo.png')).toMatchObject({ binary: true, insertions: 0 });
    expect(parseNumstatLine('')).toBeUndefined();
  });

  it('unpacks both rename spellings git uses', () => {
    expect(parseRenamePath('src/{old => new}/file.ts')).toEqual({
      from: 'src/old/file.ts',
      to: 'src/new/file.ts',
    });
    expect(parseRenamePath('old.ts => new.ts')).toEqual({ from: 'old.ts', to: 'new.ts' });
    expect(parseRenamePath('plain.ts')).toBeUndefined();
  });

  it('reads file status from raw diff lines', () => {
    expect(parseRawLine(':000000 100644 0000000 1234567 A\tsrc/new.ts')).toEqual({
      path: 'src/new.ts',
      kind: 'added',
    });
    expect(parseRawLine(':100644 000000 1234567 0000000 D\tsrc/gone.ts')).toEqual({
      path: 'src/gone.ts',
      kind: 'deleted',
    });
    expect(parseRawLine(':100644 100644 a b R096\tsrc/old.ts\tsrc/new.ts')).toEqual({
      path: 'src/new.ts',
      kind: 'renamed',
    });
  });
});

describe('PathFilter', () => {
  it('drops generated and vendored paths', () => {
    const filter = new PathFilter(DEFAULT_EXCLUDES);
    expect(filter.excludes('package-lock.json')).toBe(true);
    expect(filter.excludes('web/node_modules/lib/index.js')).toBe(true);
    expect(filter.excludes('src/app.min.js')).toBe(true);
    expect(filter.excludes('src/app.ts')).toBe(false);
  });
});

describe('LocalGitProvider (integration)', () => {
  let dir: string;

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  };
  const write = (path: string, body: string): void => {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  };
  const commit = (name: string, email: string, message: string): void => {
    git('add', '-A');
    execFileSync('git', ['commit', '-m', message], {
      cwd: dir,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
      },
    });
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'devmerit-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');

    write('src/core.ts', Array.from({ length: 40 }, (_, i) => `const a${i} = ${i};`).join('\n'));
    commit('Alice', 'alice@example.com', 'feat: add core');

    write('package-lock.json', '{"lockfileVersion": 3}');
    commit('Alice', 'alice@example.com', 'chore: add lockfile');

    write('src/core.ts', Array.from({ length: 40 }, (_, i) => `const b${i} = ${i * 2};`).join('\n'));
    write('tests/core.test.ts', 'test("core", () => {});');
    commit('Bob', 'bob@example.com', 'fix: correct core arithmetic and cover it');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads commits, authors, diffstats and blame from a real repository', async () => {
    const snapshot = await new LocalGitProvider({ cwd: dir }).fetch(REPO);

    expect(snapshot.commits).toHaveLength(3);
    const authors = new Set(snapshot.commits.map((c) => c.author.email));
    expect(authors).toEqual(new Set(['alice@example.com', 'bob@example.com']));

    const feature = snapshot.commits.find((c) => c.message.startsWith('feat:'))!;
    expect(feature.files[0]).toMatchObject({ path: 'src/core.ts', kind: 'added', insertions: 40 });

    // Lockfiles are excluded from analysis entirely.
    const lockCommit = snapshot.commits.find((c) => c.message.includes('lockfile'))!;
    expect(lockCommit.files).toHaveLength(0);

    expect(snapshot.blame.length).toBeGreaterThan(0);
    expect(snapshot.blame.some((b) => b.path === 'src/core.ts')).toBe(true);
  });

  it('produces an explainable report end to end', async () => {
    const snapshot = await new LocalGitProvider({ cwd: dir }).fetch(REPO);
    const report = new ContributionCalculator().calculate(snapshot);

    expect(report.scores.length).toBe(2);
    for (const score of report.scores) {
      expect(score.components.length).toBeGreaterThan(0);
      expect(score.total).toBeGreaterThan(0);
    }
    // Bob rewrote Alice's file, so he is credited for maintenance work.
    const bob = report.scores.find((s) => s.developer.email === 'bob@example.com')!;
    expect(bob.byDimension.maintenance ?? 0).toBeGreaterThan(0);
  });
});
