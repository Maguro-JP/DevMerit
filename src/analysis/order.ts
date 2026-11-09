import type { Commit } from '../domain/types.js';

/**
 * Orders commits oldest-first for replay.
 *
 * Sorting by author timestamp alone is not enough: timestamps tie routinely
 * (scripted commits, imports, rebases) and can even run backwards, and a
 * mis-ordered replay silently loses lineage — a commit that rewrites a file
 * before the file's creation is replayed finds nothing to attribute.
 *
 * Parent links are the authoritative order, so this performs a topological
 * sort over them, breaking ties by author time. Commits whose parents are
 * outside the analyzed set (a truncated history, a shallow clone) are treated
 * as roots. Anything left over by a cycle is appended in time order rather
 * than dropped.
 */
export function orderCommitsForReplay(commits: readonly Commit[]): Commit[] {
  const bySha = new Map<string, Commit>();
  for (const commit of commits) bySha.set(commit.sha, commit);

  const children = new Map<string, string[]>();
  const pending = new Map<string, number>();

  for (const commit of commits) {
    const presentParents = commit.parents.filter((p) => bySha.has(p));
    pending.set(commit.sha, presentParents.length);
    for (const parent of presentParents) {
      const list = children.get(parent);
      if (list) list.push(commit.sha);
      else children.set(parent, [commit.sha]);
    }
  }

  const ready = new MinHeap<Commit>((a, b) => {
    const byTime = a.authoredAt.getTime() - b.authoredAt.getTime();
    return byTime !== 0 ? byTime : a.sha.localeCompare(b.sha);
  });
  for (const commit of commits) {
    if (pending.get(commit.sha) === 0) ready.push(commit);
  }

  const ordered: Commit[] = [];
  const emitted = new Set<string>();
  while (ready.size > 0) {
    const commit = ready.pop()!;
    ordered.push(commit);
    emitted.add(commit.sha);
    for (const childSha of children.get(commit.sha) ?? []) {
      const remaining = (pending.get(childSha) ?? 0) - 1;
      pending.set(childSha, remaining);
      if (remaining === 0) {
        const child = bySha.get(childSha);
        if (child) ready.push(child);
      }
    }
  }

  if (ordered.length < commits.length) {
    const leftovers = commits
      .filter((c) => !emitted.has(c.sha))
      .sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime());
    ordered.push(...leftovers);
  }
  return ordered;
}

/** Small binary heap; keeps topological ordering linear-ish on large histories. */
class MinHeap<T> {
  readonly #items: T[] = [];
  readonly #compare: (a: T, b: T) => number;

  constructor(compare: (a: T, b: T) => number) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#items.length;
  }

  push(item: T): void {
    const items = this.#items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.#compare(items[i]!, items[parent]!) >= 0) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): T | undefined {
    const items = this.#items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0 && last !== undefined) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && this.#compare(items[left]!, items[smallest]!) < 0) smallest = left;
        if (right < items.length && this.#compare(items[right]!, items[smallest]!) < 0) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest]!, items[i]!];
        i = smallest;
      }
    }
    return top;
  }
}
