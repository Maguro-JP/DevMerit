import type { ActivitySnapshot, DeveloperId } from '../domain/types.js';
import { isBot } from '../domain/identity.js';
import type { ChangeCategory } from './classifier.js';
import { classifyCommit, isDocPath, isTestPath } from './classifier.js';
import type { DeveloperLineage, LineageOptions } from './lineage.js';
import { LineageAnalyzer, reconcileWithBlame } from './lineage.js';
import type { GamingOptions, GamingSignals } from './gaming.js';
import { detectGaming } from './gaming.js';

/**
 * Everything measurable about one developer in one repository.
 *
 * This is the sole input to scoring: algorithms may not reach back into raw
 * git data, which keeps them swappable and comparable.
 */
export interface DeveloperMetrics {
  readonly developer: DeveloperId;
  readonly commitCount: number;
  /** Commits by intent category, e.g. `{ feature: 12, bugfix: 5 }`. */
  readonly commitsByCategory: Readonly<Record<ChangeCategory, number>>;
  /** Sum of classification confidence per category; discounts guesswork. */
  readonly weightedCategory: Readonly<Record<ChangeCategory, number>>;
  readonly lineage: DeveloperLineage;
  readonly gaming: GamingSignals;
  /** Lines added in test files — testing effort, independent of commit intent. */
  readonly testLinesAdded: number;
  readonly docLinesAdded: number;
  /** Distinct files this developer changed that others had authored. */
  readonly filesTouchedFromOthers: number;
  readonly firstContributionAt?: Date;
  readonly lastContributionAt?: Date;
  /** Distinct days on which they contributed; a steadiness proxy. */
  readonly activeDays: number;
  readonly collaboration: CollaborationMetrics;
}

export interface CollaborationMetrics {
  readonly pullRequestsOpened: number;
  readonly pullRequestsMerged: number;
  /** Reviews they gave to other people's pull requests. */
  readonly reviewsGiven: number;
  /** Reviews with inline comments or substantive prose, not bare approvals. */
  readonly substantiveReviewsGiven: number;
  readonly reviewsReceived: number;
  /** Distinct developers whose PRs they reviewed or whose code they changed. */
  readonly collaborators: number;
  readonly issuesOpened: number;
}

export interface RepositoryMetrics {
  readonly repository: ActivitySnapshot['repository'];
  readonly capturedAt: Date;
  readonly developers: readonly DeveloperMetrics[];
  readonly totalSurvivingLines: number;
  readonly analyzedCommits: number;
}

export interface MetricsOptions extends LineageOptions, GamingOptions {
  /** Exclude bot identities (dependabot, github-actions, ...). Default true. */
  readonly excludeBots?: boolean;
}

const EMPTY_CATEGORIES: Record<ChangeCategory, number> = {
  feature: 0,
  bugfix: 0,
  refactor: 0,
  test: 0,
  docs: 0,
  removal: 0,
  chore: 0,
  revert: 0,
  merge: 0,
  unknown: 0,
};

/** Turns a raw activity snapshot into per-developer metrics. */
export function computeMetrics(
  snapshot: ActivitySnapshot,
  options: MetricsOptions = {},
): RepositoryMetrics {
  const excludeBots = options.excludeBots ?? true;
  const commits = snapshot.commits.filter((c) => !(excludeBots && isBot(c.author)));

  const filtered: ActivitySnapshot = { ...snapshot, commits };
  const lineage = reconcileWithBlame(
    new LineageAnalyzer(options).analyze(filtered),
    filtered,
    options.asOf ?? snapshot.capturedAt,
  );
  const gaming = detectGaming(commits, lineage.byDeveloper, options);

  interface Acc {
    developer: DeveloperId;
    commitCount: number;
    categories: Record<ChangeCategory, number>;
    weighted: Record<ChangeCategory, number>;
    testLines: number;
    docLines: number;
    days: Set<string>;
    first?: Date;
    last?: Date;
    collaborators: Set<string>;
    filesFromOthers: Set<string>;
  }

  const acc = new Map<string, Acc>();
  const ensure = (developer: DeveloperId): Acc => {
    const found = acc.get(developer.key);
    if (found) return found;
    const created: Acc = {
      developer,
      commitCount: 0,
      categories: { ...EMPTY_CATEGORIES },
      weighted: { ...EMPTY_CATEGORIES },
      testLines: 0,
      docLines: 0,
      days: new Set(),
      collaborators: new Set(),
      filesFromOthers: new Set(),
    };
    acc.set(developer.key, created);
    return created;
  };

  // First author of each file, used to tell "wrote it" from "worked on someone
  // else's code" without a second blame pass.
  const fileOriginator = new Map<string, string>();
  const ordered = [...commits].sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime());

  for (const commit of ordered) {
    const a = ensure(commit.author);
    if (commit.parents.length > 1) {
      a.categories.merge += 1;
      continue;
    }
    a.commitCount += 1;

    const { category, confidence } = classifyCommit(commit);
    a.categories[category] += 1;
    a.weighted[category] += Math.max(confidence, 0.25);

    for (const file of commit.files) {
      if (file.binary) continue;
      if (isTestPath(file.path)) a.testLines += file.insertions;
      if (isDocPath(file.path)) a.docLines += file.insertions;
      const origin = fileOriginator.get(file.path);
      if (origin === undefined) fileOriginator.set(file.path, commit.author.key);
      else if (origin !== commit.author.key) {
        a.filesFromOthers.add(file.path);
        a.collaborators.add(origin);
      }
    }

    for (const co of commit.coAuthors) {
      if (co.key === commit.author.key) continue;
      a.collaborators.add(co.key);
      ensure(co).collaborators.add(commit.author.key);
    }

    a.days.add(commit.authoredAt.toISOString().slice(0, 10));
    if (!a.first || commit.authoredAt < a.first) a.first = commit.authoredAt;
    if (!a.last || commit.authoredAt > a.last) a.last = commit.authoredAt;
  }

  const collaboration = computeCollaboration(snapshot, excludeBots, (id) => ensure(id));

  const developers: DeveloperMetrics[] = [];
  for (const [key, a] of acc) {
    const metrics: {
      -readonly [K in keyof DeveloperMetrics]: DeveloperMetrics[K];
    } = {
      developer: a.developer,
      commitCount: a.commitCount,
      commitsByCategory: a.categories,
      weightedCategory: a.weighted,
      lineage: lineage.byDeveloper.get(key) ?? emptyLineage(key),
      gaming: gaming.get(key) ?? emptyGaming(key),
      testLinesAdded: a.testLines,
      docLinesAdded: a.docLines,
      filesTouchedFromOthers: a.filesFromOthers.size,
      activeDays: a.days.size,
      collaboration: {
        ...(collaboration.get(key) ?? emptyCollaboration()),
        collaborators: a.collaborators.size,
      },
    };
    if (a.first) metrics.firstContributionAt = a.first;
    if (a.last) metrics.lastContributionAt = a.last;
    developers.push(metrics);
  }

  return {
    repository: snapshot.repository,
    capturedAt: snapshot.capturedAt,
    developers,
    totalSurvivingLines: lineage.totalSurvivingLines,
    analyzedCommits: commits.length,
  };
}

function computeCollaboration(
  snapshot: ActivitySnapshot,
  excludeBots: boolean,
  register: (id: DeveloperId) => { collaborators: Set<string> },
): Map<string, CollaborationMetrics> {
  interface Acc {
    opened: number;
    merged: number;
    given: number;
    substantive: number;
    received: number;
    issues: number;
  }
  const acc = new Map<string, Acc>();
  const get = (id: DeveloperId): Acc => {
    register(id);
    const found = acc.get(id.key);
    if (found) return found;
    const created: Acc = { opened: 0, merged: 0, given: 0, substantive: 0, received: 0, issues: 0 };
    acc.set(id.key, created);
    return created;
  };
  const collaboratorsOf = (id: DeveloperId): Set<string> => register(id).collaborators;

  for (const pr of snapshot.pullRequests) {
    if (excludeBots && isBot(pr.author)) continue;
    const author = get(pr.author);
    author.opened += 1;
    if (pr.state === 'merged') author.merged += 1;

    for (const review of pr.reviews) {
      if (excludeBots && isBot(review.reviewer)) continue;
      if (review.reviewer.key === pr.author.key) continue;
      const reviewer = get(review.reviewer);
      reviewer.given += 1;
      // A bare "LGTM" is not review work; require inline comments or prose.
      if (review.commentCount > 0 || review.bodyLength >= 80) reviewer.substantive += 1;
      author.received += 1;
      collaboratorsOf(review.reviewer).add(pr.author.key);
      collaboratorsOf(pr.author).add(review.reviewer.key);
    }
  }

  for (const issue of snapshot.issues) {
    if (excludeBots && isBot(issue.author)) continue;
    get(issue.author).issues += 1;
  }

  const out = new Map<string, CollaborationMetrics>();
  for (const [key, a] of acc) {
    out.set(key, {
      pullRequestsOpened: a.opened,
      pullRequestsMerged: a.merged,
      reviewsGiven: a.given,
      substantiveReviewsGiven: a.substantive,
      reviewsReceived: a.received,
      collaborators: 0, // replaced by the caller, which owns the collaborator sets
      issuesOpened: a.issues,
    });
  }
  return out;
}

function emptyCollaboration(): CollaborationMetrics {
  return {
    pullRequestsOpened: 0,
    pullRequestsMerged: 0,
    reviewsGiven: 0,
    substantiveReviewsGiven: 0,
    reviewsReceived: 0,
    collaborators: 0,
    issuesOpened: 0,
  };
}

function emptyLineage(developerKey: string): DeveloperLineage {
  return {
    developerKey,
    linesAdded: 0,
    linesDeleted: 0,
    survivingLines: 0,
    survivalRate: 0,
    longevityWeightedLines: 0,
    meanSurvivingAgeDays: 0,
    linesReworkedByOthers: 0,
    linesReworkedForOthers: 0,
    selfChurnLines: 0,
    filesTouched: 0,
    filesOwned: 0,
  };
}

function emptyGaming(developerKey: string): GamingSignals {
  return {
    developerKey,
    trivialCommitRatio: 0,
    fragmentedCommitRatio: 0,
    selfChurnRatio: 0,
    lowSubstanceRatio: 0,
    revertRatio: 0,
    suspicionScore: 0,
    notes: [],
  };
}
