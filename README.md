# DevMerit

開発者の貢献度を可視化する

DevMerit analyzes development history and estimates **what value each developer left in a
project** — not how many lines they typed.

> The question is not "who wrote the most code?" but "who left the most value behind?"

## Design principles

1. **Code volume is decoupled from contribution.** Every line-based term passes through a
   logarithm and is gated on survival. Writing more code cannot by itself raise a score.
   1000 lines added and 900 later deleted score below 100 lines that have run for years.
2. **Deletion is never a penalty.** Removing code is credited — weighted by *what* it cleaned
   up. Removing code the project had settled on counts fully; deleting your own recent output
   earns little, because that is undoing work rather than improving a codebase.
3. **Code has a genealogy.** When B rewrites A's code and C improves it further, all three keep
   a traceable share. Being succeeded is not a demerit — code that others built on counts as
   having survived.
4. **Every point is explainable.** A score is never a bare number: each component carries a
   sentence, the raw metrics behind it, and a confidence value.
5. **Gaming is dampened, not rewarded.** Commit splitting, trivial commits, self-churn and
   low-substance padding reduce the credit volume earns, and are always reported alongside the
   score so a human can judge the call.

## Usage

```bash
npm install && npm run build

# Leaderboard for a local clone
node dist/cli/index.js analyze /path/to/repo

# Why does this developer have that score?
node dist/cli/index.js analyze /path/to/repo --explain alice

# Machine-readable report
node dist/cli/index.js analyze /path/to/repo --json
```

Useful flags: `--since <date>`, `--max-commits <n>`, `--rev <ref>`, `--no-blame` (faster, less
accurate survival figures), `--top <n>`.

Analysis runs against a **local clone**, so a full report costs no API quota.

### GitHub

Pull requests, reviews and issues only exist in the API. The intended arrangement is to clone
once for the expensive code analysis and spend requests only on what git cannot see:

```ts
const git = await new LocalGitProvider({ cwd }).fetch(repo);
const github = await new GitHubProvider({ token }).fetch(repo);
const report = new ContributionCalculator().calculate(mergeSnapshots(git, github));
```

`GitHubClient` paginates via `Link`, honours `Retry-After` and secondary rate limits, and pauses
*before* the primary budget is exhausted rather than after. Per-commit diffs are off by default
because they cost one request each. `mergeSnapshots` also unifies each developer's git email
identity with their GitHub login, so code work and review work land on one person.

### Example output

```
Developer: alice
Contribution Score: 405.0

Breakdown:
     +90.0  Long-term maintained code  [longevity, confidence 0.85]
            1,240 of their lines are still live (31% of the codebase), with a mean age of
            612 days. Older surviving code counts for more, on a logarithmic curve.
     +60.0  Testing  [testing, confidence 0.75]
     +45.0  Refactoring and simplification  [quality, confidence 0.60]
     -20.0  Volume-inflation dampening  [penalty, confidence 0.50]
            ...
```

## Architecture

```
Activity (provider)  →  Analysis  →  Metrics  →  Scoring algorithm  →  Contribution score
```

| Layer | Location | Responsibility |
| --- | --- | --- |
| Domain | `src/domain/` | Forge-agnostic model (`Commit`, `PullRequest`, `Review`, `BlameSegment`) and identity resolution |
| Providers | `src/providers/` | `ActivityProvider` implementations: `LocalGitProvider` (clone, via the `git` CLI) and `GitHubProvider` (pull requests, reviews, issues) |
| Analysis | `src/analysis/` | Intent classification, lineage replay, anti-gaming signals, metric aggregation |
| Scoring | `src/scoring/` | `ScoringAlgorithm` strategy + `BalancedV1` baseline model |
| Pipeline | `src/pipeline/` | `ContributionCalculator` ties the stages together |

Every layer depends only on the domain model, so GitLab or Bitbucket support means adding a
provider, and improving the model means adding an algorithm — never touching data collection.

### Lineage replay

`LineageAnalyzer` replays history file by file, keeping a per-developer stock of live lines.
A commit's deletions are drawn proportionally from the developers currently holding lines in
that file; its insertions go to the author. The result approximates `git blame` of the final
tree — and, unlike blame, records *who displaced whom*, which is what makes it possible to
credit maintenance and to distinguish churn from cleanup. Where blame is available it replaces
the replay's survival figures with ground truth (`reconcileWithBlame`).

### Swapping the scoring model

`ScoringAlgorithm` is a plain strategy over `DeveloperMetrics`; algorithms may not reach back
into raw git data. Several can be run over one snapshot and compared:

```ts
ContributionCalculator.compare(snapshot, [new BalancedV1(), new BalancedV1({ longevity: 30 })]);
```

## Development

```bash
npm run check   # typecheck + lint + tests
```

## Status

Working: domain model, local-git and GitHub providers, lineage analysis, anti-gaming signals,
the `BalancedV1` baseline algorithm, and an explainable CLI report.

Next: a second scoring algorithm to compare against the baseline, inline review-comment counts
for a sharper review-depth signal, and a web view of the per-developer breakdown.
