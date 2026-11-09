import { describe, expect, it } from 'vitest';
import { LineageAnalyzer, reconcileWithBlame } from '../src/analysis/lineage.js';
import { makeDeveloperId } from '../src/domain/identity.js';
import { at, commit, devKey, file, snapshot } from './helpers.js';

describe('LineageAnalyzer', () => {
  it('credits code that survives over code that was thrown away', () => {
    const history = snapshot([
      commit('alice', 0, 'add core', [file('src/core.ts', 100, 0)]),
      commit('bob', 1, 'add scratch', [file('src/scratch.ts', 1000, 0)]),
      commit('bob', 40, 'delete scratch', [file('src/scratch.ts', 0, 900, 'modified')]),
    ]);

    const result = new LineageAnalyzer().analyze(history);
    const alice = result.byDeveloper.get(devKey('alice'))!;
    const bob = result.byDeveloper.get(devKey('bob'))!;

    expect(alice.survivalRate).toBe(1);
    expect(bob.survivalRate).toBeCloseTo(0.1, 2);
    // Bob wrote 10x the lines but Alice's smaller, older code weighs more.
    expect(alice.longevityWeightedLines).toBeGreaterThan(bob.longevityWeightedLines);
  });

  it('tracks the genealogy of code across successive authors', () => {
    // Alice writes 100 lines, Bob rewrites 80, Carol improves 30 more.
    const history = snapshot([
      commit('alice', 0, 'implement parser', [file('src/parser.ts', 100, 0)]),
      commit('bob', 10, 'rework parser', [file('src/parser.ts', 80, 80, 'modified')]),
      commit('carol', 20, 'improve parser', [file('src/parser.ts', 30, 30, 'modified')]),
    ]);

    const result = new LineageAnalyzer().analyze(history);
    const alice = result.byDeveloper.get(devKey('alice'))!;
    const bob = result.byDeveloper.get(devKey('bob'))!;
    const carol = result.byDeveloper.get(devKey('carol'))!;

    // Alice's initial contribution is reduced but never erased.
    expect(alice.survivingLines).toBeGreaterThan(0);
    expect(alice.linesReworkedByOthers).toBeGreaterThan(0);
    // Both later authors get credit for working on someone else's code.
    expect(bob.linesReworkedForOthers).toBeGreaterThan(0);
    expect(carol.linesReworkedForOthers).toBeGreaterThan(0);
    // Everyone still holds a share of the living file.
    expect(alice.survivingLines + bob.survivingLines + carol.survivingLines).toBeCloseTo(
      result.totalSurvivingLines,
      1,
    );
  });

  it('flags rewriting your own fresh code as churn, not as maintenance', () => {
    const history = snapshot([
      commit('dave', 0, 'add feature', [file('src/f.ts', 200, 0)]),
      commit('dave', 3, 'rewrite feature', [file('src/f.ts', 200, 200, 'modified')]),
    ]);

    const dave = new LineageAnalyzer({ selfChurnWindowDays: 14 })
      .analyze(history)
      .byDeveloper.get(devKey('dave'))!;

    expect(dave.selfChurnLines).toBeGreaterThan(150);
    expect(dave.linesReworkedForOthers).toBe(0);
  });

  it('does not count removing long-settled own code as churn', () => {
    const history = snapshot([
      commit('erin', 0, 'add feature', [file('src/f.ts', 200, 0)]),
      commit('erin', 200, 'remove obsolete feature', [file('src/f.ts', 0, 200, 'modified')]),
    ]);

    const erin = new LineageAnalyzer({ selfChurnWindowDays: 14 })
      .analyze(history)
      .byDeveloper.get(devKey('erin'))!;

    expect(erin.selfChurnLines).toBe(0);
  });

  it('carries lineage through a rename', () => {
    const history = snapshot([
      commit('alice', 0, 'add module', [file('src/old.ts', 100, 0)]),
      {
        ...commit('bob', 5, 'rename module', []),
        files: [
          { path: 'src/new.ts', previousPath: 'src/old.ts', kind: 'renamed', insertions: 0, deletions: 0, binary: false },
        ],
      },
      commit('bob', 6, 'tweak module', [file('src/new.ts', 10, 10, 'modified')]),
    ]);

    const result = new LineageAnalyzer().analyze(history);
    const alice = result.byDeveloper.get(devKey('alice'))!;
    // Alice keeps ownership of the renamed file's contents.
    expect(alice.survivingLines).toBeGreaterThan(80);
    expect(result.byDeveloper.get(devKey('bob'))!.linesReworkedForOthers).toBeGreaterThan(0);
  });

  it('prefers blame ground truth over the replay approximation', () => {
    const base = snapshot([commit('alice', 0, 'add core', [file('src/core.ts', 100, 0)])]);
    const withBlame = {
      ...base,
      blame: [
        {
          path: 'src/core.ts',
          commitSha: 'x',
          author: makeDeveloperId({ name: 'alice', email: 'alice@acme.test' }),
          authoredAt: at(0),
          lineCount: 42,
        },
      ],
    };

    const replayed = new LineageAnalyzer().analyze(withBlame);
    const reconciled = reconcileWithBlame(replayed, withBlame, at(400));

    expect(reconciled.byDeveloper.get(devKey('alice'))!.survivingLines).toBe(42);
    expect(reconciled.totalSurvivingLines).toBe(42);
  });
});
