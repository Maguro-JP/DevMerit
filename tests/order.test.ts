import { describe, expect, it } from 'vitest';
import { orderCommitsForReplay } from '../src/analysis/order.js';
import { LineageAnalyzer } from '../src/analysis/lineage.js';
import { at, commit, devKey, file, snapshot } from './helpers.js';

/** Chains commits by parent link while giving them all the same timestamp. */
function chain(specs: readonly ReturnType<typeof commit>[]): ReturnType<typeof commit>[] {
  return specs.map((c, i) => ({
    ...c,
    authoredAt: at(0),
    parents: i === 0 ? [] : [specs[i - 1]!.sha],
  }));
}

describe('orderCommitsForReplay', () => {
  it('follows parent links when timestamps tie', () => {
    const history = chain([
      commit('alice', 0, 'first', []),
      commit('bob', 0, 'second', []),
      commit('carol', 0, 'third', []),
    ]);

    // Providers such as `git log` hand back newest-first.
    const ordered = orderCommitsForReplay([...history].reverse());
    expect(ordered.map((c) => c.message)).toEqual(['first', 'second', 'third']);
  });

  it('treats commits with parents outside the set as roots', () => {
    const truncated = [{ ...commit('alice', 1, 'later', []), parents: ['unknown-sha'] }];
    expect(orderCommitsForReplay(truncated)).toHaveLength(1);
  });

  it('keeps lineage intact when a whole history shares one timestamp', () => {
    const history = chain([
      commit('alice', 0, 'feat: add core', [file('src/core.ts', 40, 0)]),
      commit('bob', 0, 'fix: rewrite core', [file('src/core.ts', 40, 40, 'modified')]),
    ]);

    const result = new LineageAnalyzer().analyze(snapshot([...history].reverse()));
    // Without a topological order Bob's deletions land on an empty file and
    // his maintenance work vanishes.
    expect(result.byDeveloper.get(devKey('bob'))!.linesReworkedForOthers).toBeCloseTo(40, 0);
    expect(result.byDeveloper.get(devKey('alice'))!.linesReworkedByOthers).toBeCloseTo(40, 0);
  });
});
