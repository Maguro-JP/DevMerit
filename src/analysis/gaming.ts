import type { Commit } from '../domain/types.js';
import type { DeveloperLineage } from './lineage.js';

/**
 * Signals that a developer's raw activity is inflated rather than valuable.
 *
 * Every field is a ratio in 0..1 so that scoring algorithms can combine them
 * without knowing repository scale. These are *dampeners*, not accusations:
 * they reduce the credit volume earns, and are always reported alongside the
 * score so a human can judge the call.
 */
export interface GamingSignals {
  readonly developerKey: string;
  /** Share of commits that change almost nothing and say almost nothing. */
  readonly trivialCommitRatio: number;
  /** Share of commits that look like one change sliced into many pushes. */
  readonly fragmentedCommitRatio: number;
  /** Own work removed again within the churn window, over lines added. */
  readonly selfChurnRatio: number;
  /** Share of commits whose changes are dominated by comment/blank lines. */
  readonly lowSubstanceRatio: number;
  /** Share of commits that revert or are reverted. */
  readonly revertRatio: number;
  /** 0..1 composite; 0 means nothing suspicious. */
  readonly suspicionScore: number;
  readonly notes: readonly string[];
}

export interface GamingOptions {
  /** A commit at or below this many changed lines is a candidate for trivial. */
  readonly trivialLineThreshold?: number;
  /** Commits by one author to the same file within this window look fragmented. */
  readonly fragmentWindowMinutes?: number;
}

const REVERT_RE = /^revert\b/i;

export function detectGaming(
  commits: readonly Commit[],
  lineage: ReadonlyMap<string, DeveloperLineage>,
  options: GamingOptions = {},
): Map<string, GamingSignals> {
  const trivialThreshold = options.trivialLineThreshold ?? 2;
  const fragmentWindowMs = (options.fragmentWindowMinutes ?? 30) * 60_000;

  interface Acc {
    commits: number;
    trivial: number;
    fragmented: number;
    reverts: number;
    lowSubstance: number;
    /** path -> last commit time, for fragment detection. */
    lastTouch: Map<string, number>;
  }
  const acc = new Map<string, Acc>();
  const get = (key: string): Acc => {
    const found = acc.get(key);
    if (found) return found;
    const created: Acc = {
      commits: 0,
      trivial: 0,
      fragmented: 0,
      reverts: 0,
      lowSubstance: 0,
      lastTouch: new Map(),
    };
    acc.set(key, created);
    return created;
  };

  const ordered = [...commits].sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime());
  for (const commit of ordered) {
    if (commit.parents.length > 1) continue;
    const a = get(commit.author.key);
    a.commits += 1;

    const changed = commit.files.reduce((n, f) => n + f.insertions + f.deletions, 0);
    const subject = commit.message.split('\n', 1)[0]?.trim() ?? '';
    if (changed <= trivialThreshold && subject.length <= 15) a.trivial += 1;
    if (REVERT_RE.test(subject)) a.reverts += 1;

    const at = commit.authoredAt.getTime();
    let fragment = false;
    for (const file of commit.files) {
      const last = a.lastTouch.get(file.path);
      if (last !== undefined && at - last <= fragmentWindowMs && changed <= 20) fragment = true;
      a.lastTouch.set(file.path, at);
    }
    if (fragment) a.fragmented += 1;

    // Whitespace/comment-only padding shows up as many touched files with a
    // handful of lines each and no deletions at all.
    if (commit.files.length >= 5 && changed <= commit.files.length * 2 && changed > 0) {
      a.lowSubstance += 1;
    }
  }

  const out = new Map<string, GamingSignals>();
  for (const [developerKey, a] of acc) {
    const line = lineage.get(developerKey);
    const selfChurnRatio =
      line && line.linesAdded > 0 ? clamp(line.selfChurnLines / line.linesAdded) : 0;
    const trivialCommitRatio = ratio(a.trivial, a.commits);
    const fragmentedCommitRatio = ratio(a.fragmented, a.commits);
    const lowSubstanceRatio = ratio(a.lowSubstance, a.commits);
    const revertRatio = ratio(a.reverts, a.commits);

    const notes: string[] = [];
    if (trivialCommitRatio > 0.3) notes.push(`${pct(trivialCommitRatio)} of commits are trivial one-liners`);
    if (fragmentedCommitRatio > 0.3) notes.push(`${pct(fragmentedCommitRatio)} of commits re-touch a file minutes later`);
    if (selfChurnRatio > 0.3) notes.push(`${pct(selfChurnRatio)} of added lines were rewritten by the same author soon after`);
    if (lowSubstanceRatio > 0.2) notes.push(`${pct(lowSubstanceRatio)} of commits spread a few lines over many files`);

    // Weighted so that no single noisy signal can condemn a developer; the
    // dominant term is self-churn, the clearest volume-inflation tell.
    const suspicionScore = clamp(
      0.4 * selfChurnRatio +
        0.25 * trivialCommitRatio +
        0.2 * fragmentedCommitRatio +
        0.15 * lowSubstanceRatio,
    );

    out.set(developerKey, {
      developerKey,
      trivialCommitRatio,
      fragmentedCommitRatio,
      selfChurnRatio,
      lowSubstanceRatio,
      revertRatio,
      suspicionScore: round(suspicionScore),
      notes,
    });
  }
  return out;
}

function ratio(part: number, whole: number): number {
  return whole > 0 ? round(part / whole) : 0;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
