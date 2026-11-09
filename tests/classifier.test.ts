import { describe, expect, it } from 'vitest';
import { classifyCommit } from '../src/analysis/classifier.js';
import { commit, file } from './helpers.js';

describe('classifyCommit', () => {
  it('reads conventional commit types', () => {
    expect(classifyCommit(commit('a', 0, 'feat(api): add pagination', [file('src/api.ts', 40, 2)])).category)
      .toBe('feature');
    expect(classifyCommit(commit('a', 0, 'fix: off-by-one in cursor', [file('src/api.ts', 2, 2, 'modified')])).category)
      .toBe('bugfix');
  });

  it('classifies from the diff shape when the message says nothing', () => {
    const tests = classifyCommit(
      commit('a', 0, 'update', [file('tests/api.test.ts', 120, 0), file('src/api.ts', 3, 1, 'modified')]),
    );
    expect(tests.category).toBe('test');
    expect(tests.evidence.join(' ')).toMatch(/test files/);
  });

  it('recognises deletion work as removal, not as damage', () => {
    const result = classifyCommit(
      commit('a', 0, 'drop the legacy exporter', [file('src/legacy.ts', 0, 400, 'deleted')]),
    );
    expect(result.category).toBe('removal');
    expect(result.confidence).toBeGreaterThan(0.4);
  });

  it('spots restructuring from balanced insert/delete volume', () => {
    const result = classifyCommit(
      commit('a', 0, 'move helpers around', [file('src/a.ts', 60, 55, 'modified')]),
    );
    expect(result.category).toBe('refactor');
  });

  it('marks merges and reports unknown honestly', () => {
    const merge = { ...commit('a', 0, 'Merge branch main', []), parents: ['p1', 'p2'] };
    expect(classifyCommit(merge).category).toBe('merge');

    const vague = classifyCommit(commit('a', 0, 'wip', []));
    expect(vague.category).toBe('unknown');
    expect(vague.confidence).toBe(0);
  });
});
