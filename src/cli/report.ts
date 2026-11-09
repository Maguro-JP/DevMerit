import type { ContributionReport } from '../pipeline/calculator.js';
import type { DeveloperScore } from '../scoring/algorithm.js';

/** Best human label for a developer identity. */
export function displayName(score: DeveloperScore): string {
  const d = score.developer;
  return d.login ?? d.name ?? d.email ?? d.key;
}

/** Compact leaderboard: developer, score, and the dimensions driving it. */
export function renderSummary(report: ContributionReport, limit = 20): string {
  const lines: string[] = [];
  const repo = report.repository;
  lines.push(`DevMerit — ${repo.owner}/${repo.name}`);
  lines.push(
    `${plural(report.metrics.analyzedCommits, 'commit')} · ` +
      `${plural(Math.round(report.metrics.totalSurvivingLines), 'surviving line')} · ` +
      `algorithm ${report.algorithm.id}@${report.algorithm.version}`,
  );
  lines.push('');

  const shown = report.scores.slice(0, limit);
  const width = Math.max(9, ...shown.map((s) => displayName(s).length));
  lines.push(`${'DEVELOPER'.padEnd(width)}  ${'SCORE'.padStart(7)}  TOP CONTRIBUTIONS`);
  lines.push('-'.repeat(width + 11 + 30));

  for (const score of shown) {
    const top = score.components
      .filter((c) => c.points > 0)
      .slice(0, 3)
      .map((c) => `${c.label} +${Math.round(c.points)}`)
      .join(', ');
    lines.push(`${displayName(score).padEnd(width)}  ${score.total.toFixed(1).padStart(7)}  ${top}`);
  }

  if (report.scores.length > shown.length) {
    lines.push(`… and ${report.scores.length - shown.length} more developers`);
  }
  return lines.join('\n');
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/** Full explanation of one developer's score — the "why 1,842?" view. */
export function renderExplanation(score: DeveloperScore): string {
  const lines: string[] = [];
  lines.push(`Developer: ${displayName(score)}`);
  lines.push(`Contribution Score: ${score.total.toFixed(1)}`);
  lines.push('');
  lines.push('Breakdown:');
  for (const c of score.components) {
    const sign = c.points >= 0 ? '+' : '-';
    const points = `${sign}${Math.abs(c.points).toFixed(1)}`.padStart(8);
    lines.push(`  ${points}  ${c.label}  [${c.dimension}, confidence ${c.confidence.toFixed(2)}]`);
    lines.push(`            ${c.explanation}`);
  }
  lines.push('');
  lines.push(`  ${score.total.toFixed(1).padStart(8)}  Total`);

  if (score.caveats.length > 0) {
    lines.push('');
    lines.push('Caveats:');
    for (const caveat of score.caveats) lines.push(`  - ${caveat}`);
  }
  return lines.join('\n');
}

/** Machine-readable report; the shape a future web UI would consume. */
export function toJson(report: ContributionReport): string {
  return JSON.stringify(
    {
      repository: report.repository,
      generatedAt: report.generatedAt.toISOString(),
      algorithm: report.algorithm,
      totals: {
        commits: report.metrics.analyzedCommits,
        survivingLines: report.metrics.totalSurvivingLines,
        developers: report.scores.length,
      },
      developers: report.scores.map((score) => ({
        name: displayName(score),
        identity: score.developer,
        total: score.total,
        byDimension: score.byDimension,
        caveats: score.caveats,
        components: score.components.map((c) => ({
          dimension: c.dimension,
          label: c.label,
          points: Math.round(c.points * 10) / 10,
          explanation: c.explanation,
          evidence: c.evidence,
          confidence: c.confidence,
        })),
      })),
    },
    null,
    2,
  );
}
