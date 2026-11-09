import type { Commit, FileChange } from '../domain/types.js';

/**
 * The kind of engineering work a commit represents.
 *
 * Categories are deliberately about *intent*, not size: a one-line bug fix and
 * a thousand-line one are both `bugfix`.
 */
export type ChangeCategory =
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'test'
  | 'docs'
  | 'removal'
  | 'chore'
  | 'revert'
  | 'merge'
  | 'unknown';

export interface Classification {
  readonly category: ChangeCategory;
  /** 0..1 — how much the evidence agrees. Consumers may discount weak signals. */
  readonly confidence: number;
  /** Human-readable reasons, surfaced in score explanations. */
  readonly evidence: readonly string[];
}

interface Signal {
  readonly category: ChangeCategory;
  readonly weight: number;
  readonly reason: string;
}

const MESSAGE_RULES: readonly { re: RegExp; category: ChangeCategory; weight: number; reason: string }[] = [
  { re: /^revert[\s:"]/i, category: 'revert', weight: 3, reason: 'message marks a revert' },
  { re: /^(feat|feature)(\([^)]*\))?!?:/i, category: 'feature', weight: 3, reason: 'conventional commit type `feat`' },
  { re: /^(fix|bugfix|hotfix)(\([^)]*\))?!?:/i, category: 'bugfix', weight: 3, reason: 'conventional commit type `fix`' },
  { re: /^refactor(\([^)]*\))?!?:/i, category: 'refactor', weight: 3, reason: 'conventional commit type `refactor`' },
  { re: /^test(\([^)]*\))?!?:/i, category: 'test', weight: 3, reason: 'conventional commit type `test`' },
  { re: /^docs?(\([^)]*\))?!?:/i, category: 'docs', weight: 3, reason: 'conventional commit type `docs`' },
  { re: /^(chore|build|ci|style)(\([^)]*\))?!?:/i, category: 'chore', weight: 3, reason: 'conventional commit type `chore`' },
  { re: /\b(fix(e[sd])?|bug|regression|crash|broken|patch(ed)?)\b/i, category: 'bugfix', weight: 1.5, reason: 'message mentions a defect' },
  { re: /\b(add(s|ed)?|implement(s|ed)?|introduce(s|d)?|support)\b/i, category: 'feature', weight: 1, reason: 'message describes new capability' },
  { re: /\b(refactor|simplif(y|ied)|clean\s?up|rename|extract|deduplicat|dry up)\b/i, category: 'refactor', weight: 1.5, reason: 'message describes restructuring' },
  { re: /\b(remove[sd]?|delete[sd]?|drop(s|ped)?|prune|obsolete|dead code|unused)\b/i, category: 'removal', weight: 1.5, reason: 'message describes removal' },
  { re: /\b(test|spec|coverage)\b/i, category: 'test', weight: 1, reason: 'message mentions tests' },
  { re: /\b(docs?|documentation|readme|comment)\b/i, category: 'docs', weight: 1, reason: 'message mentions documentation' },
];

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|Test[A-Z_.]/;
const DOC_PATH_RE = /(^|\/)(docs?|documentation)(\/|$)|\.(md|mdx|rst|adoc|txt)$/i;
const CONFIG_PATH_RE = /(^|\/)(\.github|\.circleci|\.gitlab-ci\.yml|Dockerfile|Makefile)|\.(ya?ml|toml|ini|cfg|lock|json)$/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

export function isDocPath(path: string): boolean {
  return DOC_PATH_RE.test(path);
}

export function isConfigPath(path: string): boolean {
  return CONFIG_PATH_RE.test(path);
}

function share(files: readonly FileChange[], predicate: (f: FileChange) => boolean): number {
  const total = files.reduce((n, f) => n + f.insertions + f.deletions, 0);
  if (total === 0) return 0;
  const matched = files
    .filter(predicate)
    .reduce((n, f) => n + f.insertions + f.deletions, 0);
  return matched / total;
}

/**
 * Classifies a commit from its message *and* its diff shape.
 *
 * File evidence is weighted alongside message evidence on purpose: commit
 * messages are cheap to game, whereas "90% of the touched lines are in test
 * files" is a fact about the change itself.
 */
export function classifyCommit(commit: Commit): Classification {
  if (commit.parents.length > 1) {
    return { category: 'merge', confidence: 1, evidence: ['commit has multiple parents'] };
  }

  const subject = commit.message.split('\n', 1)[0] ?? '';
  const signals: Signal[] = [];

  for (const rule of MESSAGE_RULES) {
    if (rule.re.test(subject)) {
      signals.push({ category: rule.category, weight: rule.weight, reason: rule.reason });
    }
  }

  const files = commit.files.filter((f) => !f.binary);
  const insertions = files.reduce((n, f) => n + f.insertions, 0);
  const deletions = files.reduce((n, f) => n + f.deletions, 0);

  const testShare = share(files, (f) => isTestPath(f.path));
  if (testShare >= 0.6) {
    signals.push({ category: 'test', weight: 2.5, reason: `${pct(testShare)} of changed lines are in test files` });
  }
  const docShare = share(files, (f) => isDocPath(f.path));
  if (docShare >= 0.7) {
    signals.push({ category: 'docs', weight: 2.5, reason: `${pct(docShare)} of changed lines are documentation` });
  }
  const configShare = share(files, (f) => isConfigPath(f.path) && !isDocPath(f.path));
  if (configShare >= 0.8) {
    signals.push({ category: 'chore', weight: 1.5, reason: `${pct(configShare)} of changed lines are configuration` });
  }

  if (files.length > 0 && files.every((f) => f.kind === 'deleted')) {
    signals.push({ category: 'removal', weight: 3, reason: 'every changed file was deleted' });
  } else if (deletions > 0 && insertions <= deletions * 0.25 && deletions >= 20) {
    signals.push({
      category: 'removal',
      weight: 2,
      reason: `net removal of ${deletions - insertions} lines`,
    });
  }

  // Similar insert/delete volume across existing files, with no new files, is
  // the classic shape of a restructuring rather than a new capability.
  const addsFiles = files.some((f) => f.kind === 'added');
  if (
    !addsFiles &&
    insertions >= 10 &&
    deletions >= 10 &&
    Math.abs(insertions - deletions) / Math.max(insertions, deletions) <= 0.3
  ) {
    signals.push({ category: 'refactor', weight: 1.5, reason: 'balanced insertions and deletions in existing files' });
  }

  if (addsFiles && insertions > deletions * 3 && insertions >= 20) {
    signals.push({ category: 'feature', weight: 1, reason: 'new files with predominantly new lines' });
  }

  if (signals.length === 0) {
    return { category: 'unknown', confidence: 0, evidence: ['no message or diff signal matched'] };
  }

  const totals = new Map<ChangeCategory, number>();
  for (const s of signals) totals.set(s.category, (totals.get(s.category) ?? 0) + s.weight);
  const ranked = [...totals].sort((a, b) => b[1] - a[1]);
  const [category, top] = ranked[0]!;
  const sum = ranked.reduce((n, [, w]) => n + w, 0);

  return {
    category,
    confidence: round(top / sum),
    evidence: signals.filter((s) => s.category === category).map((s) => s.reason),
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
