import type { ActivitySnapshot } from '../domain/types.js';

const DAY_MS = 86_400_000;

export interface LineageOptions {
  /**
   * Own lines removed by the same developer within this window are treated as
   * churn (rewriting yesterday's work), not as maintenance of legacy code.
   */
  readonly selfChurnWindowDays?: number;
  /** Instant that "now" refers to when computing code age. */
  readonly asOf?: Date;
}

/** Per-developer output of the lineage replay. */
export interface DeveloperLineage {
  readonly developerKey: string;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  /** Lines they authored that are still present in the final tree. */
  readonly survivingLines: number;
  /** survivingLines / linesAdded, or 0 when they added nothing. */
  readonly survivalRate: number;
  /**
   * Age-weighted survival: each surviving line counts for
   * `log2(1 + ageInDays)`, so code that has held up for years outweighs code
   * merged last week without letting old code dominate without bound.
   */
  readonly longevityWeightedLines: number;
  /** Mean age in days of their surviving lines. */
  readonly meanSurvivingAgeDays: number;
  /** Their lines that other developers later rewrote or removed. */
  readonly linesReworkedByOthers: number;
  /** Other developers' lines that they rewrote or removed — maintenance work. */
  readonly linesReworkedForOthers: number;
  /** Own lines they removed again inside the churn window. */
  readonly selfChurnLines: number;
  /** Distinct files they changed. */
  readonly filesTouched: number;
  /** Files where they hold the largest share of surviving lines. */
  readonly filesOwned: number;
}

export interface LineageResult {
  readonly byDeveloper: ReadonlyMap<string, DeveloperLineage>;
  /** Total surviving lines across the tree, for share calculations. */
  readonly totalSurvivingLines: number;
}

interface Stock {
  lines: number;
  /** Sum of (lines * addedAtMillis), so mean add time is derivable. */
  weightedTime: number;
}

interface Mutable {
  linesAdded: number;
  linesDeleted: number;
  linesReworkedByOthers: number;
  linesReworkedForOthers: number;
  selfChurnLines: number;
  files: Set<string>;
}

/**
 * Replays history file by file to follow the *lineage* of code rather than
 * counting diffs.
 *
 * For each file we keep a per-developer stock of live lines. A commit's
 * deletions are drawn proportionally from the developers who currently hold
 * lines in that file, and its insertions are added to the committer's stock.
 * At the end of the replay the remaining stock approximates `git blame` of the
 * final tree, but — unlike blame — the replay also records *who displaced
 * whom*, which is what lets DevMerit credit maintenance and detect churn.
 *
 * Proportional attribution is an approximation: it does not know which exact
 * lines were removed. It is deterministic, needs no extra git calls, and its
 * error is unbiased across developers, which matters more here than exactness.
 * When a provider supplies blame, `reconcileWithBlame` corrects the surviving
 * totals with ground truth.
 */
export class LineageAnalyzer {
  readonly #churnWindowMs: number;
  readonly #asOf: Date | undefined;

  constructor(options: LineageOptions = {}) {
    this.#churnWindowMs = (options.selfChurnWindowDays ?? 14) * DAY_MS;
    this.#asOf = options.asOf;
  }

  analyze(snapshot: ActivitySnapshot): LineageResult {
    const asOf = (this.#asOf ?? snapshot.capturedAt).getTime();
    // Oldest first: lineage only makes sense replayed forward.
    const commits = [...snapshot.commits].sort(
      (a, b) => a.authoredAt.getTime() - b.authoredAt.getTime(),
    );

    const stocks = new Map<string, Map<string, Stock>>(); // path -> dev -> stock
    const devs = new Map<string, Mutable>();

    for (const commit of commits) {
      if (commit.parents.length > 1) continue; // merge commits duplicate their sides
      const author = commit.author.key;
      const dev = ensure(devs, author);
      const at = commit.authoredAt.getTime();

      for (const file of commit.files) {
        if (file.binary) continue;
        dev.files.add(file.path);

        const key = file.previousPath ?? file.path;
        const fileStock = stocks.get(key) ?? new Map<string, Stock>();
        if (file.previousPath !== undefined && stocks.has(key)) {
          // A rename carries the lineage with it.
          stocks.delete(key);
        }
        stocks.set(file.path, fileStock);

        if (file.deletions > 0) {
          this.#applyDeletions(fileStock, devs, author, file.deletions, at);
          dev.linesDeleted += file.deletions;
        }

        if (file.insertions > 0) {
          const own = fileStock.get(author) ?? { lines: 0, weightedTime: 0 };
          own.lines += file.insertions;
          own.weightedTime += file.insertions * at;
          fileStock.set(author, own);
          dev.linesAdded += file.insertions;
        }
      }
    }

    return this.#summarize(stocks, devs, asOf);
  }

  /** Draws `count` deleted lines proportionally from the file's current holders. */
  #applyDeletions(
    fileStock: Map<string, Stock>,
    devs: Map<string, Mutable>,
    author: string,
    count: number,
    at: number,
  ): void {
    const live = [...fileStock.entries()].filter(([, s]) => s.lines > 0);
    const total = live.reduce((n, [, s]) => n + s.lines, 0);
    if (total === 0) return;

    const removable = Math.min(count, total);
    for (const [holder, stock] of live) {
      const removed = (stock.lines / total) * removable;
      if (removed <= 0) continue;
      const meanAddedAt = stock.weightedTime / stock.lines;
      stock.weightedTime -= removed * meanAddedAt;
      stock.lines -= removed;

      if (holder === author) {
        if (at - meanAddedAt <= this.#churnWindowMs) {
          ensure(devs, author).selfChurnLines += removed;
        }
      } else {
        ensure(devs, holder).linesReworkedByOthers += removed;
        ensure(devs, author).linesReworkedForOthers += removed;
      }
    }
  }

  #summarize(
    stocks: Map<string, Map<string, Stock>>,
    devs: Map<string, Mutable>,
    asOf: number,
  ): LineageResult {
    const surviving = new Map<string, { lines: number; weighted: number; ageSum: number }>();
    const owned = new Map<string, number>();
    let totalSurvivingLines = 0;

    for (const fileStock of stocks.values()) {
      let bestDev: string | undefined;
      let bestLines = 0;
      for (const [devKey, stock] of fileStock) {
        if (stock.lines <= 0) continue;
        const meanAddedAt = stock.weightedTime / stock.lines;
        const ageDays = Math.max(0, (asOf - meanAddedAt) / DAY_MS);
        const entry = surviving.get(devKey) ?? { lines: 0, weighted: 0, ageSum: 0 };
        entry.lines += stock.lines;
        entry.weighted += stock.lines * Math.log2(1 + ageDays);
        entry.ageSum += stock.lines * ageDays;
        surviving.set(devKey, entry);
        totalSurvivingLines += stock.lines;
        if (stock.lines > bestLines) {
          bestLines = stock.lines;
          bestDev = devKey;
        }
      }
      if (bestDev) owned.set(bestDev, (owned.get(bestDev) ?? 0) + 1);
    }

    const byDeveloper = new Map<string, DeveloperLineage>();
    for (const [developerKey, m] of devs) {
      const s = surviving.get(developerKey);
      const survivingLines = s?.lines ?? 0;
      byDeveloper.set(developerKey, {
        developerKey,
        linesAdded: r(m.linesAdded),
        linesDeleted: r(m.linesDeleted),
        survivingLines: r(survivingLines),
        survivalRate: m.linesAdded > 0 ? r2(survivingLines / m.linesAdded) : 0,
        longevityWeightedLines: r(s?.weighted ?? 0),
        meanSurvivingAgeDays: survivingLines > 0 ? r2((s?.ageSum ?? 0) / survivingLines) : 0,
        linesReworkedByOthers: r(m.linesReworkedByOthers),
        linesReworkedForOthers: r(m.linesReworkedForOthers),
        selfChurnLines: r(m.selfChurnLines),
        filesTouched: m.files.size,
        filesOwned: owned.get(developerKey) ?? 0,
      });
    }

    return { byDeveloper, totalSurvivingLines: r(totalSurvivingLines) };
  }
}

/**
 * Replaces replayed survival figures with `git blame` ground truth where the
 * snapshot provides it, keeping the replay-only fields (rework, churn) intact.
 */
export function reconcileWithBlame(
  result: LineageResult,
  snapshot: ActivitySnapshot,
  asOf: Date = snapshot.capturedAt,
): LineageResult {
  if (snapshot.blame.length === 0) return result;

  const measured = new Map<string, { lines: number; weighted: number; ageSum: number }>();
  const ownedLines = new Map<string, Map<string, number>>();
  let total = 0;

  for (const seg of snapshot.blame) {
    const ageDays = Math.max(0, (asOf.getTime() - seg.authoredAt.getTime()) / DAY_MS);
    const entry = measured.get(seg.author.key) ?? { lines: 0, weighted: 0, ageSum: 0 };
    entry.lines += seg.lineCount;
    entry.weighted += seg.lineCount * Math.log2(1 + ageDays);
    entry.ageSum += seg.lineCount * ageDays;
    measured.set(seg.author.key, entry);
    total += seg.lineCount;

    const perFile = ownedLines.get(seg.path) ?? new Map<string, number>();
    perFile.set(seg.author.key, (perFile.get(seg.author.key) ?? 0) + seg.lineCount);
    ownedLines.set(seg.path, perFile);
  }

  const owned = new Map<string, number>();
  for (const perFile of ownedLines.values()) {
    const top = [...perFile].sort((a, b) => b[1] - a[1])[0];
    if (top) owned.set(top[0], (owned.get(top[0]) ?? 0) + 1);
  }

  const byDeveloper = new Map<string, DeveloperLineage>();
  const keys = new Set([...result.byDeveloper.keys(), ...measured.keys()]);
  for (const key of keys) {
    const base = result.byDeveloper.get(key) ?? emptyLineage(key);
    const m = measured.get(key);
    const survivingLines = m?.lines ?? 0;
    byDeveloper.set(key, {
      ...base,
      survivingLines,
      survivalRate: base.linesAdded > 0 ? r2(survivingLines / base.linesAdded) : 0,
      longevityWeightedLines: r(m?.weighted ?? 0),
      meanSurvivingAgeDays: survivingLines > 0 ? r2((m?.ageSum ?? 0) / survivingLines) : 0,
      filesOwned: owned.get(key) ?? 0,
    });
  }

  return { byDeveloper, totalSurvivingLines: total };
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

function ensure(devs: Map<string, Mutable>, key: string): Mutable {
  const found = devs.get(key);
  if (found) return found;
  const created: Mutable = {
    linesAdded: 0,
    linesDeleted: 0,
    linesReworkedByOthers: 0,
    linesReworkedForOthers: 0,
    selfChurnLines: 0,
    files: new Set<string>(),
  };
  devs.set(key, created);
  return created;
}

/** Commits are integers but proportional attribution is not; keep one decimal. */
function r(value: number): number {
  return Math.round(value * 10) / 10;
}

function r2(value: number): number {
  return Math.round(value * 1000) / 1000;
}

