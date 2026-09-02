import type { DeveloperId } from '../domain/types.js';
import type { DeveloperMetrics, RepositoryMetrics } from '../analysis/metrics.js';

/** The facet of contribution a score line belongs to. */
export type ScoreDimension =
  | 'feature'
  | 'bugfix'
  | 'quality'
  | 'testing'
  | 'documentation'
  | 'maintenance'
  | 'review'
  | 'collaboration'
  | 'longevity'
  | 'penalty';

/**
 * One line of a score, always carrying the reasoning that produced it.
 *
 * DevMerit scores are never a bare number: every point a developer holds must
 * be traceable to a statement a human can check against the repository.
 */
export interface ScoreComponent {
  readonly dimension: ScoreDimension;
  /** Short label, e.g. "Long-term maintained code". */
  readonly label: string;
  /** Signed points. Negative values are dampeners, shown as such. */
  readonly points: number;
  /** Sentence explaining how the points arose. */
  readonly explanation: string;
  /** Raw metric values behind the line, for auditing and UI drill-down. */
  readonly evidence: Readonly<Record<string, number | string>>;
  /** 0..1 — how much the underlying signal can be trusted. */
  readonly confidence: number;
}

export interface DeveloperScore {
  readonly developer: DeveloperId;
  readonly total: number;
  readonly components: readonly ScoreComponent[];
  /** Point totals per dimension, derived from `components`. */
  readonly byDimension: Readonly<Partial<Record<ScoreDimension, number>>>;
  /** Notes worth showing next to the score (gaming signals, low data, ...). */
  readonly caveats: readonly string[];
  readonly algorithm: AlgorithmInfo;
}

export interface AlgorithmInfo {
  readonly id: string;
  readonly version: string;
  readonly description: string;
}

/** Repository-wide facts an algorithm may normalise against. */
export interface ScoringContext {
  readonly repository: RepositoryMetrics;
}

/**
 * A swappable scoring strategy.
 *
 * Algorithms are pure functions of `DeveloperMetrics` plus repository context,
 * which makes it possible to run several against one snapshot and compare
 * their rankings — the intended path for improving the model over time.
 */
export interface ScoringAlgorithm {
  readonly info: AlgorithmInfo;
  score(metrics: DeveloperMetrics, context: ScoringContext): DeveloperScore;
}

/** Assembles a `DeveloperScore` from components, deriving totals consistently. */
export function buildScore(
  developer: DeveloperId,
  components: readonly ScoreComponent[],
  algorithm: AlgorithmInfo,
  caveats: readonly string[] = [],
): DeveloperScore {
  const meaningful = components.filter((c) => Math.abs(c.points) >= 0.5);
  const byDimension: Partial<Record<ScoreDimension, number>> = {};
  let total = 0;
  for (const c of meaningful) {
    byDimension[c.dimension] = round((byDimension[c.dimension] ?? 0) + c.points);
    total += c.points;
  }
  return {
    developer,
    total: round(total),
    components: [...meaningful].sort((a, b) => b.points - a.points),
    byDimension,
    caveats,
    algorithm,
  };
}

export function round(value: number): number {
  return Math.round(value * 10) / 10;
}
