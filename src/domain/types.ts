/**
 * Provider-agnostic domain model.
 *
 * Nothing in this file may reference GitHub (or any other forge) specifics.
 * Providers translate their own payloads into these shapes so that analysis
 * and scoring stay portable across GitHub / GitLab / Bitbucket / plain git.
 */

/** Stable, provider-scoped identity of a person. */
export interface DeveloperId {
  /** Canonical key used for grouping. Lowercased email when available. */
  readonly key: string;
  readonly name?: string;
  readonly email?: string;
  /** Login/handle on the source platform, when the provider knows one. */
  readonly login?: string;
}

export interface RepositoryRef {
  readonly provider: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch?: string;
}

/** How a file participated in a change. */
export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export interface FileChange {
  readonly path: string;
  /** Previous path, for renames. */
  readonly previousPath?: string;
  readonly kind: FileChangeKind;
  readonly insertions: number;
  readonly deletions: number;
  /** True when the file is binary or otherwise not line-diffable. */
  readonly binary: boolean;
}

export interface Commit {
  readonly sha: string;
  readonly author: DeveloperId;
  /** Committer may differ from author (rebases, co-authored pushes). */
  readonly committer?: DeveloperId;
  readonly authoredAt: Date;
  readonly message: string;
  readonly parents: readonly string[];
  readonly files: readonly FileChange[];
  /** Developers credited via trailers such as `Co-authored-by:`. */
  readonly coAuthors: readonly DeveloperId[];
}

export type PullRequestState = 'open' | 'merged' | 'closed';

export interface PullRequest {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly body?: string;
  readonly author: DeveloperId;
  readonly state: PullRequestState;
  readonly createdAt: Date;
  readonly mergedAt?: Date;
  readonly commitShas: readonly string[];
  readonly reviews: readonly Review[];
  /** Issue identifiers this PR claims to close. */
  readonly closesIssues: readonly string[];
}

export type ReviewVerdict = 'approved' | 'changes_requested' | 'commented';

export interface Review {
  readonly id: string;
  readonly reviewer: DeveloperId;
  readonly verdict: ReviewVerdict;
  readonly submittedAt: Date;
  /** Number of inline comments; a proxy for review depth. */
  readonly commentCount: number;
  /** Total characters of review prose; separates "LGTM" from real review. */
  readonly bodyLength: number;
}

export interface Issue {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly author: DeveloperId;
  readonly createdAt: Date;
  readonly closedAt?: Date;
  readonly labels: readonly string[];
}

/** One `git blame` region: a run of lines currently attributed to a commit. */
export interface BlameSegment {
  readonly path: string;
  readonly commitSha: string;
  readonly author: DeveloperId;
  readonly authoredAt: Date;
  readonly lineCount: number;
}

/**
 * Everything a provider could gather about one repository, in domain terms.
 * Analyzers consume this and nothing else.
 */
export interface ActivitySnapshot {
  readonly repository: RepositoryRef;
  /** Point in time the snapshot describes; all ages are measured from here. */
  readonly capturedAt: Date;
  readonly commits: readonly Commit[];
  readonly pullRequests: readonly PullRequest[];
  readonly issues: readonly Issue[];
  /** Blame of the current tree. Empty when the provider cannot supply it. */
  readonly blame: readonly BlameSegment[];
}

export function developerKey(id: DeveloperId): string {
  return id.key;
}

/** Merge partial identities, preferring the most informative fields. */
export function mergeDeveloperId(a: DeveloperId, b: DeveloperId): DeveloperId {
  const merged: { -readonly [K in keyof DeveloperId]: DeveloperId[K] } = { key: a.key };
  const name = a.name ?? b.name;
  const email = a.email ?? b.email;
  const login = a.login ?? b.login;
  if (name !== undefined) merged.name = name;
  if (email !== undefined) merged.email = email;
  if (login !== undefined) merged.login = login;
  return merged;
}
