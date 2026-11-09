import type { ActivityProvider, FetchOptions } from '../provider.js';
import type {
  ActivitySnapshot,
  Commit,
  DeveloperId,
  FileChange,
  FileChangeKind,
  Issue,
  PullRequest,
  RepositoryRef,
  Review,
  ReviewVerdict,
} from '../../domain/types.js';
import { IdentityRegistry, canonicalKey } from '../../domain/identity.js';
import { PathFilter } from '../pathFilter.js';
import type { GitHubClientOptions } from './client.js';
import { GitHubClient } from './client.js';

/** The slices of the GitHub REST payloads DevMerit actually reads. */
interface RestUser {
  login?: string;
  type?: string;
}
interface RestCommit {
  sha: string;
  commit: {
    message: string;
    author?: { name?: string; email?: string; date?: string };
    committer?: { name?: string; email?: string; date?: string };
  };
  author?: RestUser | null;
  committer?: RestUser | null;
  parents?: { sha: string }[];
  files?: {
    filename: string;
    previous_filename?: string;
    status?: string;
    additions?: number;
    deletions?: number;
    patch?: string;
  }[];
}
interface RestPull {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  merged_at?: string | null;
  created_at: string;
  user?: RestUser | null;
}
interface RestReview {
  id: number;
  user?: RestUser | null;
  state?: string;
  submitted_at?: string | null;
  body?: string | null;
}
interface RestIssue {
  id: number;
  number: number;
  title: string;
  created_at: string;
  closed_at?: string | null;
  user?: RestUser | null;
  labels?: ({ name?: string } | string)[];
  pull_request?: unknown;
}

export interface GitHubProviderOptions extends GitHubClientOptions {
  /**
   * Fetch per-file diffs for each commit. This costs one API request per
   * commit, so it is off by default: pair the GitHub provider with
   * `LocalGitProvider` for diff detail and use this only when no clone exists.
   */
  readonly includeCommitFiles?: boolean;
  /** Cap on pull requests inspected for reviews. Default 300. */
  readonly maxPullRequests?: number;
}

/**
 * Reads development history from GitHub's REST API.
 *
 * The API is the only source for pull requests, reviews and issues, but it is
 * a poor source for diffs and cannot produce blame at all. The intended
 * arrangement is therefore to merge this provider's collaboration data with a
 * `LocalGitProvider` snapshot (see `mergeSnapshots`), which keeps request
 * counts proportional to pull requests rather than to commits.
 */
export class GitHubProvider implements ActivityProvider {
  readonly name = 'github';
  readonly #client: GitHubClient;
  readonly #options: GitHubProviderOptions;

  constructor(options: GitHubProviderOptions = {}) {
    this.#client = new GitHubClient(options);
    this.#options = options;
  }

  get rateLimit(): GitHubClient['rateLimit'] {
    return this.#client.rateLimit;
  }

  async fetch(repo: RepositoryRef, options: FetchOptions = {}): Promise<ActivitySnapshot> {
    const identities = new IdentityRegistry();
    const filter = new PathFilter(options.excludePaths);
    const base = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

    const commits = await this.#fetchCommits(base, identities, filter, options);
    const pullRequests = await this.#fetchPullRequests(base, identities, options);
    const issues = await this.#fetchIssues(base, identities, options);

    return {
      repository: repo,
      capturedAt: new Date(),
      commits,
      pullRequests,
      issues,
      blame: [], // GitHub's REST API cannot produce blame; use LocalGitProvider.
    };
  }

  async #fetchCommits(
    base: string,
    identities: IdentityRegistry,
    filter: PathFilter,
    options: FetchOptions,
  ): Promise<Commit[]> {
    const query = options.since ? `?since=${options.since.toISOString()}` : '';
    const max = options.maxCommits ?? Number.POSITIVE_INFINITY;
    const commits: Commit[] = [];

    for await (const page of this.#client.paginate<RestCommit>(`${base}/commits${query}`, options.signal)) {
      for (const raw of page) {
        const detail =
          this.#options.includeCommitFiles === true
            ? await this.#client.get<RestCommit>(`${base}/commits/${raw.sha}`, options.signal)
            : raw;
        commits.push(toCommit(detail, identities, filter));
        if (commits.length >= max) return commits;
      }
    }
    return commits;
  }

  async #fetchPullRequests(
    base: string,
    identities: IdentityRegistry,
    options: FetchOptions,
  ): Promise<PullRequest[]> {
    const max = this.#options.maxPullRequests ?? 300;
    const pulls: PullRequest[] = [];

    for await (const page of this.#client.paginate<RestPull>(
      `${base}/pulls?state=all&sort=updated&direction=desc`,
      options.signal,
    )) {
      for (const raw of page) {
        const createdAt = new Date(raw.created_at);
        // The list is newest-first, so an old page means we are done.
        if (options.since && createdAt < options.since) return pulls;

        const reviews = await this.#fetchReviews(base, raw.number, identities, options);
        const state = raw.merged_at ? 'merged' : raw.state === 'open' ? 'open' : 'closed';
        const pull: { -readonly [K in keyof PullRequest]: PullRequest[K] } = {
          id: String(raw.id),
          number: raw.number,
          title: raw.title,
          author: resolveUser(identities, raw.user, raw.title),
          state,
          createdAt,
          commitShas: [],
          reviews,
          closesIssues: extractClosedIssues(raw.body ?? ''),
        };
        if (raw.body != null) pull.body = raw.body;
        if (raw.merged_at) pull.mergedAt = new Date(raw.merged_at);
        pulls.push(pull);

        if (pulls.length >= max) return pulls;
      }
    }
    return pulls;
  }

  async #fetchReviews(
    base: string,
    number: number,
    identities: IdentityRegistry,
    options: FetchOptions,
  ): Promise<Review[]> {
    const reviews: Review[] = [];
    for await (const page of this.#client.paginate<RestReview>(
      `${base}/pulls/${number}/reviews`,
      options.signal,
    )) {
      for (const raw of page) {
        if (!raw.submitted_at) continue;
        const body = raw.body ?? '';
        reviews.push({
          id: String(raw.id),
          reviewer: resolveUser(identities, raw.user),
          verdict: toVerdict(raw.state),
          submittedAt: new Date(raw.submitted_at),
          // The reviews endpoint does not carry inline comment counts; review
          // depth is approximated from prose length until they are fetched.
          commentCount: 0,
          bodyLength: body.length,
        });
      }
    }
    return reviews;
  }

  async #fetchIssues(
    base: string,
    identities: IdentityRegistry,
    options: FetchOptions,
  ): Promise<Issue[]> {
    const query = options.since ? `&since=${options.since.toISOString()}` : '';
    const issues: Issue[] = [];
    for await (const page of this.#client.paginate<RestIssue>(
      `${base}/issues?state=all&filter=all${query}`,
      options.signal,
    )) {
      for (const raw of page) {
        if (raw.pull_request) continue; // GitHub lists pull requests as issues
        const issue: { -readonly [K in keyof Issue]: Issue[K] } = {
          id: String(raw.id),
          number: raw.number,
          title: raw.title,
          author: resolveUser(identities, raw.user),
          createdAt: new Date(raw.created_at),
          labels: (raw.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
        };
        if (raw.closed_at) issue.closedAt = new Date(raw.closed_at);
        issues.push(issue);
      }
    }
    return issues;
  }
}

export function toCommit(
  raw: RestCommit,
  identities: IdentityRegistry,
  filter: PathFilter,
): Commit {
  const author = raw.commit.author;
  const committer = raw.commit.committer;
  const files: FileChange[] = (raw.files ?? [])
    .filter((f) => !filter.excludes(f.filename))
    .map((f) => {
      const change: { -readonly [K in keyof FileChange]: FileChange[K] } = {
        path: f.filename,
        kind: toFileKind(f.status),
        insertions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        // GitHub omits `patch` for binary files (and for very large diffs).
        binary: f.patch === undefined && (f.additions ?? 0) === 0 && (f.deletions ?? 0) === 0,
      };
      if (f.previous_filename !== undefined) change.previousPath = f.previous_filename;
      return change;
    });

  const commit: { -readonly [K in keyof Commit]: Commit[K] } = {
    sha: raw.sha,
    author: identities.resolve({
      ...(author?.name !== undefined ? { name: author.name } : {}),
      ...(author?.email !== undefined ? { email: author.email } : {}),
      ...(raw.author?.login !== undefined ? { login: raw.author.login } : {}),
    }),
    authoredAt: new Date(author?.date ?? Date.now()),
    message: raw.commit.message,
    parents: (raw.parents ?? []).map((p) => p.sha),
    files,
    coAuthors: extractCoAuthors(raw.commit.message, identities),
  };
  if (committer || raw.committer) {
    commit.committer = identities.resolve({
      ...(committer?.name !== undefined ? { name: committer.name } : {}),
      ...(committer?.email !== undefined ? { email: committer.email } : {}),
      ...(raw.committer?.login !== undefined ? { login: raw.committer.login } : {}),
    });
  }
  return commit;
}

const CO_AUTHOR_RE = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim;

function extractCoAuthors(message: string, identities: IdentityRegistry): DeveloperId[] {
  return [...message.matchAll(CO_AUTHOR_RE)].map(([, name, email]) =>
    identities.resolve({ name: name?.trim() ?? '', email: email ?? '' }),
  );
}

/** `Closes #12`, `fixes #7` — the issues a pull request claims to resolve. */
export function extractClosedIssues(body: string): string[] {
  const re = /\b(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  return [...new Set([...body.matchAll(re)].map(([, n]) => n!))];
}

function toFileKind(status: string | undefined): FileChangeKind {
  switch (status) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

function toVerdict(state: string | undefined): ReviewVerdict {
  switch (state?.toUpperCase()) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    default:
      return 'commented';
  }
}

function resolveUser(
  identities: IdentityRegistry,
  user: RestUser | null | undefined,
  fallbackName?: string,
): DeveloperId {
  return identities.resolve({
    ...(user?.login !== undefined ? { login: user.login } : {}),
    ...(fallbackName !== undefined && user?.login === undefined ? { name: fallbackName } : {}),
  });
}

/**
 * Combines a git snapshot (commits, diffs, blame) with a GitHub snapshot
 * (pull requests, reviews, issues).
 *
 * This is the recommended way to run DevMerit against a GitHub project: clone
 * once for the expensive code analysis, and spend API requests only on the
 * collaboration data that git cannot see.
 *
 * The two sources identify people differently — git by commit email, GitHub by
 * login — so the same person would otherwise appear twice, splitting their
 * score. GitHub's commit payloads carry both, which gives an email-to-login
 * mapping; the git side is rewritten onto the login keys so that a developer's
 * code work and their review work land on one identity.
 */
export function mergeSnapshots(git: ActivitySnapshot, github: ActivitySnapshot): ActivitySnapshot {
  const aliases = buildAliasMap(github);
  const remap = (id: DeveloperId): DeveloperId => {
    const target = aliases.get(id.key);
    return target === undefined ? id : { ...id, key: target.key, login: target.login };
  };

  return {
    repository: github.repository,
    capturedAt: git.capturedAt > github.capturedAt ? git.capturedAt : github.capturedAt,
    commits:
      git.commits.length > 0
        ? git.commits.map((c) => ({
            ...c,
            author: remap(c.author),
            ...(c.committer ? { committer: remap(c.committer) } : {}),
            coAuthors: c.coAuthors.map(remap),
          }))
        : github.commits,
    pullRequests: github.pullRequests,
    issues: github.issues,
    blame: git.blame.map((b) => ({ ...b, author: remap(b.author) })),
  };
}

/**
 * Maps email-derived identity keys onto login-derived ones, using GitHub
 * commits, which report both the git author and the linked GitHub account.
 */
export function buildAliasMap(
  github: ActivitySnapshot,
): ReadonlyMap<string, { key: string; login: string }> {
  const aliases = new Map<string, { key: string; login: string }>();
  for (const commit of github.commits) {
    const { login, email } = commit.author;
    if (login === undefined || email === undefined) continue;
    const emailKey = canonicalKey({ email });
    const loginKey = canonicalKey({ login });
    if (emailKey !== loginKey) aliases.set(emailKey, { key: loginKey, login });
  }
  return aliases;
}
