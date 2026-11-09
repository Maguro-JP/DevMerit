import type { ActivitySnapshot, RepositoryRef } from '../domain/types.js';

export interface FetchOptions {
  /** Only consider activity at or after this instant. */
  readonly since?: Date;
  /** Upper bound on commits walked; guards against enormous repositories. */
  readonly maxCommits?: number;
  /** Skip blame collection, which is by far the most expensive step. */
  readonly skipBlame?: boolean;
  /** Paths matching these globs are ignored (lockfiles, vendored code, ...). */
  readonly excludePaths?: readonly string[];
  readonly signal?: AbortSignal;
}

/**
 * A source of development history.
 *
 * Implementations are responsible for their own pagination, retries and rate
 * limiting; everything above this interface is provider-agnostic.
 */
export interface ActivityProvider {
  readonly name: string;
  fetch(repo: RepositoryRef, options?: FetchOptions): Promise<ActivitySnapshot>;
}
