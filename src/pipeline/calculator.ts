import type { ActivitySnapshot } from '../domain/types.js';
import type { MetricsOptions, RepositoryMetrics } from '../analysis/metrics.js';
import { computeMetrics } from '../analysis/metrics.js';
import type { DeveloperScore, ScoringAlgorithm } from '../scoring/algorithm.js';
import { BalancedV1 } from '../scoring/algorithms/balancedV1.js';

export interface ContributionReport {
  readonly repository: RepositoryMetrics['repository'];
  readonly generatedAt: Date;
  readonly algorithm: ScoringAlgorithm['info'];
  /** Developers ranked by score, highest first. */
  readonly scores: readonly DeveloperScore[];
  readonly metrics: RepositoryMetrics;
}

export interface CalculatorOptions extends MetricsOptions {
  readonly algorithm?: ScoringAlgorithm;
  /** Developers with fewer commits than this are dropped from the report. */
  readonly minCommits?: number;
}

/**
 * The pipeline named in the DevMerit design:
 * activity → analysis → metrics → scoring → developer contribution.
 *
 * Each stage is independently testable and replaceable; in particular the
 * scoring stage is a plain strategy object, so improving the model never means
 * touching data collection.
 */
export class ContributionCalculator {
  readonly #algorithm: ScoringAlgorithm;
  readonly #options: CalculatorOptions;

  constructor(options: CalculatorOptions = {}) {
    this.#algorithm = options.algorithm ?? new BalancedV1();
    this.#options = options;
  }

  /** Scores a snapshot that has already been fetched. */
  calculate(snapshot: ActivitySnapshot): ContributionReport {
    const metrics = computeMetrics(snapshot, this.#options);
    const context = { repository: metrics };
    const minCommits = this.#options.minCommits ?? 1;

    const scores = metrics.developers
      .filter((d) => d.commitCount >= minCommits || d.collaboration.reviewsGiven > 0)
      .map((d) => this.#algorithm.score(d, context))
      .sort((a, b) => b.total - a.total);

    return {
      repository: metrics.repository,
      generatedAt: new Date(),
      algorithm: this.#algorithm.info,
      scores,
      metrics,
    };
  }

  /**
   * Runs several algorithms over one snapshot, so their rankings can be
   * compared. Metrics are computed once and shared.
   */
  static compare(
    snapshot: ActivitySnapshot,
    algorithms: readonly ScoringAlgorithm[],
    options: MetricsOptions = {},
  ): readonly ContributionReport[] {
    const metrics = computeMetrics(snapshot, options);
    const context = { repository: metrics };
    return algorithms.map((algorithm) => ({
      repository: metrics.repository,
      generatedAt: new Date(),
      algorithm: algorithm.info,
      scores: metrics.developers
        .map((d) => algorithm.score(d, context))
        .sort((a, b) => b.total - a.total),
      metrics,
    }));
  }
}
