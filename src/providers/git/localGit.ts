import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ActivityProvider, FetchOptions } from '../provider.js';
import type {
  ActivitySnapshot,
  BlameSegment,
  Commit,
  FileChange,
  FileChangeKind,
  RepositoryRef,
} from '../../domain/types.js';
import { IdentityRegistry } from '../../domain/identity.js';
import { PathFilter } from '../pathFilter.js';

const exec = promisify(execFile);

/** git log field/record separators, chosen to be implausible in commit prose. */
const FIELD = '\x1f';
const RECORD = '\x1e';

const CO_AUTHOR_RE = /^co-authored-by:\s*(.*?)\s*<([^>]+)>\s*$/gim;

/** 64 MiB: large enough for sizeable histories, bounded enough to stay safe. */
const MAX_BUFFER = 64 * 1024 * 1024;

export interface LocalGitOptions {
  /** Working tree to analyze. */
  readonly cwd: string;
  /** Revision range or ref to walk. Defaults to HEAD. */
  readonly rev?: string;
}

/**
 * Reads history straight from a local clone via the `git` CLI.
 *
 * This provider is the backbone of DevMerit's lineage analysis: blame and full
 * per-file diffstats are cheap here but rate-limited (or unavailable) over the
 * GitHub API. A typical run clones once, then analyzes offline.
 */
export class LocalGitProvider implements ActivityProvider {
  readonly name = 'git';
  readonly #cwd: string;
  readonly #rev: string;

  constructor(options: LocalGitOptions) {
    this.#cwd = options.cwd;
    this.#rev = options.rev ?? 'HEAD';
  }

  async fetch(repo: RepositoryRef, options: FetchOptions = {}): Promise<ActivitySnapshot> {
    const filter = new PathFilter(options.excludePaths);
    const identities = new IdentityRegistry();
    const commits = await this.#readCommits(identities, filter, options);
    const blame = options.skipBlame ? [] : await this.#readBlame(identities, filter, options);
    return {
      repository: repo,
      capturedAt: new Date(),
      commits,
      pullRequests: [],
      issues: [],
      blame,
    };
  }

  async #git(args: readonly string[], signal?: AbortSignal): Promise<string> {
    const opts: Record<string, unknown> = { cwd: this.#cwd, maxBuffer: MAX_BUFFER };
    if (signal) opts['signal'] = signal;
    const { stdout } = await exec('git', [...args], opts);
    return typeof stdout === 'string' ? stdout : String(stdout);
  }

  async #readCommits(
    identities: IdentityRegistry,
    filter: PathFilter,
    options: FetchOptions,
  ): Promise<Commit[]> {
    const format = ['%H', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%B'].join(FIELD);
    const args = [
      'log',
      this.#rev,
      `--pretty=format:${RECORD}${format}${FIELD}`,
      '--numstat',
      '--raw',
      '--no-abbrev',
      '-M',
    ];
    if (options.since) args.push(`--since=${options.since.toISOString()}`);
    if (options.maxCommits) args.push(`--max-count=${options.maxCommits}`);
    const stdout = await this.#git(args, options.signal);

    const commits: Commit[] = [];
    for (const record of stdout.split(RECORD)) {
      if (!record.trim()) continue;
      const parsed = parseCommitRecord(record, identities, filter);
      if (parsed) commits.push(parsed);
    }
    return commits;
  }

  async #readBlame(
    identities: IdentityRegistry,
    filter: PathFilter,
    options: FetchOptions,
  ): Promise<BlameSegment[]> {
    const listing = await this.#git(['ls-tree', '-r', '--name-only', this.#rev], options.signal);
    const paths = listing.split('\n').filter((p) => p.length > 0 && !filter.excludes(p));
    const segments: BlameSegment[] = [];
    for (const path of paths) {
      options.signal?.throwIfAborted();
      let porcelain: string;
      try {
        // -w ignores whitespace-only reflows so reformatting does not steal credit.
        porcelain = await this.#git(
          ['blame', '--line-porcelain', '-w', this.#rev, '--', path],
          options.signal,
        );
      } catch {
        continue; // binary file, or a path git refuses to blame
      }
      segments.push(...parseBlamePorcelain(path, porcelain, identities));
    }
    return segments;
  }
}

export function parseCommitRecord(
  record: string,
  identities: IdentityRegistry,
  filter: PathFilter,
): Commit | undefined {
  const [header, body = ''] = splitOnce(record, `${FIELD}\n`);
  const parts = header.split(FIELD);
  if (parts.length < 8) return undefined;
  const [sha, parents, authorName, authorEmail, authoredAt, committerName, committerEmail, message] =
    parts as [string, string, string, string, string, string, string, string];

  const files = parseDiffBlock(body).filter((f) => !filter.excludes(f.path));

  const coAuthors = [...message.matchAll(CO_AUTHOR_RE)].map(([, name, email]) =>
    identities.resolve({ name: name?.trim() ?? '', email: email ?? '' }),
  );

  return {
    sha,
    author: identities.resolve({ name: authorName, email: authorEmail }),
    committer: identities.resolve({ name: committerName, email: committerEmail }),
    authoredAt: new Date(authoredAt),
    message: message.trim(),
    parents: parents.split(' ').filter((p) => p.length > 0),
    files,
    coAuthors,
  };
}

/**
 * Parses the combined `--raw --numstat` block git emits per commit.
 *
 * `--raw` carries the authoritative add/modify/delete status, `--numstat`
 * carries the line counts; they are matched up by path.
 */
export function parseDiffBlock(block: string): FileChange[] {
  const statuses = new Map<string, FileChangeKind>();
  const counts = new Map<string, { insertions: number; deletions: number; binary: boolean; previousPath?: string }>();

  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    if (line.startsWith(':')) {
      const raw = parseRawLine(line);
      if (raw) statuses.set(raw.path, raw.kind);
      continue;
    }
    const stat = parseNumstatLine(line);
    if (stat) {
      const entry: { insertions: number; deletions: number; binary: boolean; previousPath?: string } = {
        insertions: stat.insertions,
        deletions: stat.deletions,
        binary: stat.binary,
      };
      if (stat.previousPath !== undefined) entry.previousPath = stat.previousPath;
      counts.set(stat.path, entry);
    }
  }

  const files: FileChange[] = [];
  for (const [path, c] of counts) {
    const kind =
      statuses.get(path) ??
      (c.previousPath !== undefined
        ? 'renamed'
        : c.deletions === 0 && c.insertions > 0
          ? 'added'
          : c.insertions === 0 && c.deletions > 0
            ? 'deleted'
            : 'modified');
    const change: { -readonly [K in keyof FileChange]: FileChange[K] } = {
      path,
      kind,
      insertions: c.insertions,
      deletions: c.deletions,
      binary: c.binary,
    };
    if (c.previousPath !== undefined) change.previousPath = c.previousPath;
    files.push(change);
  }
  return files;
}

/** `:100644 000000 <sha> <sha> D\tpath` (renames add a second tab-separated path). */
export function parseRawLine(line: string): { path: string; kind: FileChangeKind } | undefined {
  const fields = line.split('\t');
  const meta = fields[0];
  if (!meta) return undefined;
  const status = meta.trim().split(/\s+/).at(-1);
  if (!status) return undefined;
  const path = (status.startsWith('R') || status.startsWith('C') ? fields[2] : fields[1])?.trim();
  if (!path) return undefined;
  const letter = status[0];
  const kind: FileChangeKind =
    letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : letter === 'R' ? 'renamed' : 'modified';
  return { path, kind };
}

/** One `--numstat` row: `insertions\tdeletions\tpath` (`-` counts mean binary). */
export function parseNumstatLine(
  line: string,
): (FileChange & { previousPath?: string }) | undefined {
  if (!line.trim()) return undefined;
  const [ins, del, rawPath] = line.split('\t');
  if (ins === undefined || del === undefined || rawPath === undefined) return undefined;
  const binary = ins === '-' || del === '-';
  const insertions = binary ? 0 : Number.parseInt(ins, 10);
  const deletions = binary ? 0 : Number.parseInt(del, 10);
  if (Number.isNaN(insertions) || Number.isNaN(deletions)) return undefined;

  // Renames arrive as `old => new` or `dir/{old => new}/file`.
  const rename = parseRenamePath(rawPath);
  const path = rename?.to ?? rawPath;
  const change: { -readonly [K in keyof FileChange]: FileChange[K] } & { previousPath?: string } = {
    path,
    kind: rename ? 'renamed' : deletions === 0 && insertions > 0 ? 'added' : insertions === 0 && deletions > 0 ? 'deleted' : 'modified',
    insertions,
    deletions,
    binary,
  };
  if (rename) change.previousPath = rename.from;
  return change;
}

export function parseRenamePath(raw: string): { from: string; to: string } | undefined {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (braced) {
    const [, prefix = '', from = '', to = '', suffix = ''] = braced;
    const join = (mid: string) => `${prefix}${mid}${suffix}`.replace(/\/{2,}/g, '/');
    return { from: join(from), to: join(to) };
  }
  const plain = /^(.*) => (.*)$/.exec(raw);
  if (plain) return { from: plain[1]!, to: plain[2]! };
  return undefined;
}

/**
 * `git blame --line-porcelain` emits a header block per line; consecutive lines
 * from the same commit are collapsed into one segment.
 */
export function parseBlamePorcelain(
  path: string,
  porcelain: string,
  identities: IdentityRegistry,
): BlameSegment[] {
  const counts = new Map<
    string,
    { author: { name: string; email: string }; time: number; lines: number }
  >();
  let sha: string | undefined;
  let name: string | undefined;
  let email: string | undefined;
  let time: number | undefined;

  for (const line of porcelain.split('\n')) {
    const shaMatch = /^([0-9a-f]{40})\s\d+\s\d+(?:\s\d+)?$/.exec(line);
    if (shaMatch) {
      sha = shaMatch[1];
      continue;
    }
    if (line.startsWith('author ')) name = line.slice(7);
    else if (line.startsWith('author-mail ')) email = line.slice(12).replace(/^<|>$/g, '');
    else if (line.startsWith('author-time ')) time = Number.parseInt(line.slice(12), 10) * 1000;
    else if (line.startsWith('\t') && sha) {
      const entry = counts.get(sha) ?? {
        author: { name: name ?? '', email: email ?? '' },
        time: time ?? 0,
        lines: 0,
      };
      entry.lines += 1;
      counts.set(sha, entry);
    }
  }

  return [...counts].map(([commitSha, e]) => ({
    path,
    commitSha,
    author: identities.resolve(e.author),
    authoredAt: new Date(e.time),
    lineCount: e.lines,
  }));
}

function splitOnce(value: string, sep: string): [string, string | undefined] {
  const i = value.indexOf(sep);
  return i === -1 ? [value, undefined] : [value.slice(0, i), value.slice(i + sep.length)];
}
