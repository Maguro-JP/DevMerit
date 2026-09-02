import type { ActivitySnapshot, Commit, FileChange, RepositoryRef } from '../src/domain/types.js';
import { makeDeveloperId } from '../src/domain/identity.js';

export const REPO: RepositoryRef = { provider: 'git', owner: 'acme', name: 'widget' };

export const DAY = 86_400_000;
export const T0 = new Date('2024-01-01T00:00:00Z').getTime();

export function at(days: number): Date {
  return new Date(T0 + days * DAY);
}

export function file(path: string, insertions: number, deletions: number, kind?: FileChange['kind']): FileChange {
  return {
    path,
    kind: kind ?? (deletions === 0 ? 'added' : insertions === 0 ? 'deleted' : 'modified'),
    insertions,
    deletions,
    binary: false,
  };
}

let counter = 0;

export function commit(
  author: string,
  days: number,
  message: string,
  files: readonly FileChange[],
): Commit {
  counter += 1;
  return {
    sha: String(counter).padStart(40, '0'),
    author: makeDeveloperId({ name: author, email: `${author}@acme.test` }),
    authoredAt: at(days),
    message,
    parents: ['parent'],
    files,
    coAuthors: [],
  };
}

export function snapshot(commits: readonly Commit[], capturedDays = 400): ActivitySnapshot {
  return {
    repository: REPO,
    capturedAt: at(capturedDays),
    commits,
    pullRequests: [],
    issues: [],
    blame: [],
  };
}

export function devKey(name: string): string {
  return makeDeveloperId({ name, email: `${name}@acme.test` }).key;
}
