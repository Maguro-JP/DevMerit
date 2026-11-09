import { describe, expect, it } from 'vitest';
import { ContributionCalculator } from '../src/pipeline/calculator.js';
import { BalancedV1 } from '../src/scoring/algorithms/balancedV1.js';
import { computeMetrics } from '../src/analysis/metrics.js';
import { makeDeveloperId } from '../src/domain/identity.js';
import type { PullRequest } from '../src/domain/types.js';
import { at, commit, devKey, file, snapshot } from './helpers.js';

function scoreOf(report: ReturnType<ContributionCalculator['calculate']>, name: string): number {
  return report.scores.find((s) => s.developer.key === devKey(name))?.total ?? 0;
}

describe('BalancedV1 scoring', () => {
  it('ranks lasting value above sheer volume', () => {
    // Volumey writes 20x the lines, but almost none of it survives.
    const commits = [commit('lasting', 0, 'feat: add scheduler core', [file('src/scheduler.ts', 100, 0)])];
    for (let i = 0; i < 10; i += 1) {
      commits.push(commit('volumey', i, `feat: add module ${i}`, [file(`src/mod${i}.ts`, 200, 0)]));
    }
    for (let i = 0; i < 10; i += 1) {
      commits.push(commit('volumey', 60 + i, `chore: drop module ${i}`, [file(`src/mod${i}.ts`, 0, 195, 'modified')]));
    }

    const report = new ContributionCalculator().calculate(snapshot(commits));
    expect(scoreOf(report, 'lasting')).toBeGreaterThan(scoreOf(report, 'volumey'));
  });

  it('does not penalise deleting code', () => {
    const keeper = snapshot([
      commit('alice', 0, 'feat: add engine', [file('src/engine.ts', 400, 0)]),
      commit('bob', 100, 'chore: nothing much', [file('src/notes.md', 5, 0)]),
    ]);
    const cleaner = snapshot([
      commit('alice', 0, 'feat: add engine', [file('src/engine.ts', 400, 0)]),
      commit('bob', 100, 'refactor: remove duplicated engine paths', [
        file('src/engine.ts', 20, 220, 'modified'),
      ]),
    ]);

    const before = new ContributionCalculator().calculate(keeper);
    const after = new ContributionCalculator().calculate(cleaner);
    expect(scoreOf(after, 'bob')).toBeGreaterThan(scoreOf(before, 'bob'));
  });

  it('dampens commit-splitting and self-churn instead of rewarding them', () => {
    const honest = [commit('honest', 0, 'feat: add importer', [file('src/importer.ts', 300, 0)])];

    const gamer = [];
    for (let i = 0; i < 40; i += 1) {
      // Same file, minutes apart, tiny diffs, immediately rewritten.
      const c = commit('gamer', 0, 'update', [file('src/spam.ts', 8, 6, 'modified')]);
      gamer.push({ ...c, authoredAt: new Date(at(0).getTime() + i * 60_000) });
    }

    const report = new ContributionCalculator().calculate(snapshot([...honest, ...gamer]));
    const gamerScore = report.scores.find((s) => s.developer.key === devKey('gamer'))!;

    expect(gamerScore.components.some((c) => c.dimension === 'penalty')).toBe(true);
    expect(scoreOf(report, 'gamer')).toBeLessThan(scoreOf(report, 'honest'));
  });

  it('credits reviewing other people’s code', () => {
    const base = snapshot([
      commit('author', 0, 'feat: add thing', [file('src/thing.ts', 120, 0)]),
      commit('reviewer', 1, 'fix: correct edge case', [file('src/thing.ts', 4, 4, 'modified')]),
    ]);
    const pr: PullRequest = {
      id: 'pr1',
      number: 1,
      title: 'Add thing',
      author: makeDeveloperId({ name: 'author', email: 'author@acme.test' }),
      state: 'merged',
      createdAt: at(0),
      mergedAt: at(1),
      commitShas: [],
      closesIssues: [],
      reviews: [
        {
          id: 'r1',
          reviewer: makeDeveloperId({ name: 'reviewer', email: 'reviewer@acme.test' }),
          verdict: 'changes_requested',
          submittedAt: at(1),
          commentCount: 7,
          bodyLength: 400,
        },
      ],
    };

    const withReview = new ContributionCalculator().calculate({ ...base, pullRequests: [pr] });
    const withoutReview = new ContributionCalculator().calculate(base);
    expect(scoreOf(withReview, 'reviewer')).toBeGreaterThan(scoreOf(withoutReview, 'reviewer'));

    const reviewComponent = withReview.scores
      .find((s) => s.developer.key === devKey('reviewer'))!
      .components.find((c) => c.dimension === 'review');
    expect(reviewComponent?.explanation).toContain('substantive reviews');
  });

  it('explains every point it awards', () => {
    const report = new ContributionCalculator().calculate(
      snapshot([
        commit('alice', 0, 'feat: add core', [file('src/core.ts', 200, 0)]),
        commit('alice', 5, 'test: cover core', [file('tests/core.test.ts', 150, 0)]),
      ]),
    );
    const alice = report.scores[0]!;

    expect(alice.total).toBeGreaterThan(0);
    const recomputed = alice.components.reduce((n, c) => n + c.points, 0);
    expect(recomputed).toBeCloseTo(alice.total, 0);
    for (const component of alice.components) {
      expect(component.explanation.length).toBeGreaterThan(20);
      expect(Object.keys(component.evidence).length).toBeGreaterThan(0);
      expect(component.confidence).toBeGreaterThan(0);
    }
  });

  it('excludes bots by default', () => {
    const history = snapshot([
      commit('alice', 0, 'feat: add core', [file('src/core.ts', 50, 0)]),
      {
        ...commit('bot', 1, 'chore(deps): bump lodash', [file('src/deps.ts', 5000, 0)]),
        author: makeDeveloperId({ name: 'dependabot[bot]', email: 'bot@users.noreply.github.com', login: 'dependabot[bot]' }),
      },
    ]);
    const report = new ContributionCalculator().calculate(history);
    expect(report.scores.map((s) => s.developer.key)).not.toContain('login:dependabot[bot]');
  });

  it('can compare several algorithms over one snapshot', () => {
    const history = snapshot([commit('alice', 0, 'feat: add core', [file('src/core.ts', 100, 0)])]);
    const reports = ContributionCalculator.compare(history, [
      new BalancedV1(),
      new BalancedV1({ longevity: 0, feature: 40 }),
    ]);

    expect(reports).toHaveLength(2);
    expect(reports[0]!.scores[0]!.total).not.toBe(reports[1]!.scores[0]!.total);
  });

  it('warns when a score rests on very little data', () => {
    const report = new ContributionCalculator().calculate(
      snapshot([commit('alice', 0, 'feat: tiny', [file('src/a.ts', 3, 0)])]),
    );
    expect(report.scores[0]!.caveats.join(' ')).toMatch(/Fewer than 5 commits/);
  });
});

describe('computeMetrics', () => {
  it('separates work on your own code from work on other people’s', () => {
    const metrics = computeMetrics(
      snapshot([
        commit('alice', 0, 'feat: add core', [file('src/core.ts', 100, 0)]),
        commit('bob', 5, 'fix: correct core', [file('src/core.ts', 10, 10, 'modified')]),
      ]),
    );
    const bob = metrics.developers.find((d) => d.developer.key === devKey('bob'))!;
    const alice = metrics.developers.find((d) => d.developer.key === devKey('alice'))!;

    expect(bob.filesTouchedFromOthers).toBe(1);
    expect(alice.filesTouchedFromOthers).toBe(0);
    expect(bob.collaboration.collaborators).toBe(1);
  });
});
