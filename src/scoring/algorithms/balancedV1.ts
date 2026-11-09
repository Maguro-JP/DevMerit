import type { DeveloperMetrics } from '../../analysis/metrics.js';
import type {
  AlgorithmInfo,
  DeveloperScore,
  ScoreComponent,
  ScoringAlgorithm,
  ScoringContext,
} from '../algorithm.js';
import { buildScore } from '../algorithm.js';

/**
 * Weights for `BalancedV1`. Exposed so that a project can retune the model
 * without forking the algorithm, and so experiments can sweep them.
 */
export interface BalancedV1Weights {
  readonly feature: number;
  readonly bugfix: number;
  readonly refactor: number;
  readonly removal: number;
  readonly testing: number;
  readonly documentation: number;
  readonly maintenance: number;
  readonly review: number;
  readonly collaboration: number;
  readonly longevity: number;
  /** Fraction of earned points a fully suspicious profile can lose (0..1). */
  readonly maxGamingPenalty: number;
}

export const DEFAULT_WEIGHTS: BalancedV1Weights = {
  feature: 14,
  bugfix: 16,
  refactor: 12,
  removal: 10,
  testing: 12,
  documentation: 5,
  maintenance: 10,
  review: 9,
  collaboration: 6,
  longevity: 18,
  maxGamingPenalty: 0.5,
};

/**
 * DevMerit's baseline scoring model.
 *
 * Three properties define it:
 *
 * 1. **Volume never scores directly.** Every line-based term is fed through a
 *    logarithm and gated on survival, so writing more code cannot by itself
 *    raise a score; code that lasts can.
 * 2. **Removal is credited, not punished.** Deleting code and reworking other
 *    people's code are positive terms, because both are how a codebase gets
 *    better.
 * 3. **Every point is explained.** Each component carries a sentence and the
 *    raw numbers behind it, so a score can always be audited.
 *
 * It is deliberately a *baseline*: a second algorithm can be dropped in beside
 * it and compared on the same metrics.
 */
export class BalancedV1 implements ScoringAlgorithm {
  readonly info: AlgorithmInfo = {
    id: 'balanced',
    version: '1.0.0',
    description:
      'Survival-weighted contribution model: intent-classified work, long-term code impact, ' +
      'maintenance and review credit, with volume-inflation dampening.',
  };

  readonly #w: BalancedV1Weights;

  constructor(weights: Partial<BalancedV1Weights> = {}) {
    this.#w = { ...DEFAULT_WEIGHTS, ...weights };
  }

  score(metrics: DeveloperMetrics, context: ScoringContext): DeveloperScore {
    const w = this.#w;
    const { lineage, gaming, weightedCategory: cat, collaboration: collab } = metrics;
    const components: ScoreComponent[] = [];

    // Survival gate: work that was thrown away counts for less, work that stuck
    // counts for more.
    //
    // Code that other people later reworked counts as survived: it lived long
    // enough to be built upon, and being succeeded is not a demerit. Code the
    // author deleted again themselves does not count, which is precisely what
    // separates a real contribution from write-then-delete volume. The gate
    // never reaches zero — shipping something later replaced is still work.
    const creditedSurvival =
      lineage.linesAdded > 0
        ? Math.min(1, (lineage.survivingLines + lineage.linesReworkedByOthers) / lineage.linesAdded)
        : 0;
    const survival = 0.2 + 0.8 * creditedSurvival;

    components.push({
      dimension: 'feature',
      label: 'Feature development',
      points: w.feature * diminish(cat.feature) * survival,
      explanation:
        `${fmt(cat.feature)} commits classified as feature work, scaled by a ` +
        `${pct(survival)} survival factor: ${pct(lineage.survivalRate)} of the lines they added are still live, ` +
        `and a further ${Math.round(lineage.linesReworkedByOthers)} were built on by other developers.`,
      evidence: {
        featureCommits: metrics.commitsByCategory.feature,
        survivalRate: lineage.survivalRate,
        creditedSurvival: Math.round(creditedSurvival * 1000) / 1000,
      },
      confidence: 0.7,
    });

    components.push({
      dimension: 'bugfix',
      label: 'Bug fixes',
      points: w.bugfix * diminish(cat.bugfix),
      explanation:
        `${fmt(cat.bugfix)} commits identified as defect fixes. Fixes are scored per change, ` +
        'not per line, because a one-line fix can be worth more than a thousand-line feature.',
      evidence: { bugfixCommits: metrics.commitsByCategory.bugfix },
      confidence: 0.65,
    });

    components.push({
      dimension: 'quality',
      label: 'Refactoring and simplification',
      points: w.refactor * diminish(cat.refactor) * survival,
      explanation: `${fmt(cat.refactor)} commits restructured existing code without changing what it does.`,
      evidence: { refactorCommits: metrics.commitsByCategory.refactor },
      confidence: 0.6,
    });

    // Not all deletion is equal. Removing code the project had settled on is a
    // real improvement; deleting your own work is mostly undoing it, and
    // deleting your own work days after writing it is churn. Deletion is never
    // negative — it is simply credited according to what it actually cleaned up.
    const ownSettledDeletions = Math.max(
      0,
      lineage.linesDeleted - lineage.linesReworkedForOthers - lineage.selfChurnLines,
    );
    const cleanupQuality =
      lineage.linesDeleted > 0
        ? (lineage.linesReworkedForOthers + 0.3 * ownSettledDeletions) / lineage.linesDeleted
        : 0;
    const netRemoved = Math.max(0, lineage.linesDeleted - lineage.linesAdded);
    components.push({
      dimension: 'quality',
      label: 'Code removal',
      points: w.removal * diminish(cat.removal + netRemoved / 200) * cleanupQuality,
      explanation:
        `${fmt(cat.removal)} removal-focused commits and a net reduction of ${Math.round(netRemoved)} lines, ` +
        `credited at ${pct(cleanupQuality)} because ${Math.round(lineage.linesReworkedForOthers)} of the ` +
        `${Math.round(lineage.linesDeleted)} deleted lines were code other people had written. ` +
        'Deleting code is never penalised — a smaller codebase that does the same job is an improvement — but ' +
        'deleting your own recent output earns little.',
      evidence: {
        removalCommits: metrics.commitsByCategory.removal,
        netLinesRemoved: Math.round(netRemoved),
        cleanupQuality: Math.round(cleanupQuality * 1000) / 1000,
      },
      confidence: 0.55,
    });

    components.push({
      dimension: 'testing',
      label: 'Testing',
      points: w.testing * diminish(cat.test + metrics.testLinesAdded / 150),
      explanation: `${fmt(cat.test)} test-focused commits and ${metrics.testLinesAdded} lines added in test files.`,
      evidence: { testCommits: metrics.commitsByCategory.test, testLinesAdded: metrics.testLinesAdded },
      confidence: 0.75,
    });

    components.push({
      dimension: 'documentation',
      label: 'Documentation',
      points: w.documentation * diminish(cat.docs + metrics.docLinesAdded / 200),
      explanation: `${fmt(cat.docs)} documentation commits and ${metrics.docLinesAdded} documentation lines added.`,
      evidence: { docCommits: metrics.commitsByCategory.docs, docLinesAdded: metrics.docLinesAdded },
      confidence: 0.7,
    });

    components.push({
      dimension: 'maintenance',
      label: 'Improving others’ code',
      points: w.maintenance * diminish(lineage.linesReworkedForOthers / 50 + metrics.filesTouchedFromOthers / 5),
      explanation:
        `Reworked ${Math.round(lineage.linesReworkedForOthers)} lines originally written by other developers ` +
        `across ${metrics.filesTouchedFromOthers} files they did not start. Picking up someone else's code is ` +
        'contribution, even though it adds little net volume.',
      evidence: {
        linesReworkedForOthers: Math.round(lineage.linesReworkedForOthers),
        filesFromOthers: metrics.filesTouchedFromOthers,
      },
      confidence: 0.5,
    });

    components.push({
      dimension: 'review',
      label: 'Code review',
      points: w.review * diminish(collab.substantiveReviewsGiven + 0.25 * (collab.reviewsGiven - collab.substantiveReviewsGiven)),
      explanation:
        `${collab.substantiveReviewsGiven} substantive reviews (inline comments or written feedback) ` +
        `out of ${collab.reviewsGiven} reviews given. Bare approvals count for a quarter.`,
      evidence: { reviewsGiven: collab.reviewsGiven, substantiveReviews: collab.substantiveReviewsGiven },
      confidence: 0.8,
    });

    components.push({
      dimension: 'collaboration',
      label: 'Collaboration',
      points: w.collaboration * diminish(collab.collaborators + collab.pullRequestsMerged / 4 + collab.issuesOpened / 4),
      explanation:
        `Worked with ${collab.collaborators} other developers, merged ${collab.pullRequestsMerged} pull requests ` +
        `and opened ${collab.issuesOpened} issues.`,
      evidence: {
        collaborators: collab.collaborators,
        pullRequestsMerged: collab.pullRequestsMerged,
        issuesOpened: collab.issuesOpened,
      },
      confidence: 0.7,
    });

    const share =
      context.repository.totalSurvivingLines > 0
        ? lineage.survivingLines / context.repository.totalSurvivingLines
        : 0;
    components.push({
      dimension: 'longevity',
      label: 'Long-term maintained code',
      points: w.longevity * diminish(lineage.longevityWeightedLines / 100),
      explanation:
        `${Math.round(lineage.survivingLines)} of their lines are still live (${pct(share)} of the codebase), ` +
        `with a mean age of ${Math.round(lineage.meanSurvivingAgeDays)} days. Older surviving code counts for more, ` +
        'on a logarithmic curve so age cannot dominate without bound.',
      evidence: {
        survivingLines: Math.round(lineage.survivingLines),
        meanAgeDays: Math.round(lineage.meanSurvivingAgeDays),
        codebaseShare: Math.round(share * 1000) / 1000,
      },
      confidence: context.repository.totalSurvivingLines > 0 ? 0.85 : 0.3,
    });

    const earned = components.reduce((n, c) => n + Math.max(0, c.points), 0);
    if (gaming.suspicionScore > 0.05) {
      const factor = Math.min(1, gaming.suspicionScore) * w.maxGamingPenalty;
      components.push({
        dimension: 'penalty',
        label: 'Volume-inflation dampening',
        points: -earned * factor,
        explanation:
          `Activity shows signs of inflated volume rather than added value (suspicion ${pct(gaming.suspicionScore)}): ` +
          (gaming.notes.length > 0 ? gaming.notes.join('; ') : 'aggregate churn and commit-shape signals') +
          '. Points earned are reduced proportionally rather than zeroed.',
        evidence: {
          suspicionScore: gaming.suspicionScore,
          selfChurnRatio: gaming.selfChurnRatio,
          trivialCommitRatio: gaming.trivialCommitRatio,
          fragmentedCommitRatio: gaming.fragmentedCommitRatio,
        },
        confidence: 0.5,
      });
    }

    return buildScore(metrics.developer, components, this.info, this.#caveats(metrics));
  }

  #caveats(metrics: DeveloperMetrics): string[] {
    const caveats: string[] = [];
    if (metrics.commitCount < 5) {
      caveats.push('Fewer than 5 commits analyzed — the score is a weak signal.');
    }
    if (metrics.gaming.suspicionScore > 0.4) {
      caveats.push('Strong volume-inflation signals; review the underlying commits before acting on this score.');
    }
    if (metrics.lineage.linesAdded > 500 && metrics.lineage.survivalRate < 0.1) {
      caveats.push('Almost none of their added code survives — it may have been superseded, or moved wholesale.');
    }
    if (metrics.collaboration.reviewsGiven === 0 && metrics.collaboration.pullRequestsOpened === 0) {
      caveats.push('No pull request or review data available for this developer (git-only analysis).');
    }
    return caveats;
  }
}

/**
 * Diminishing returns curve. Doubling the input adds a constant, so a
 * developer cannot outscore a colleague simply by producing more.
 */
function diminish(value: number): number {
  return value > 0 ? Math.log2(1 + value) : 0;
}

function fmt(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
