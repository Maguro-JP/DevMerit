import { describe, expect, it, vi } from 'vitest';
import { GitHubApiError, GitHubClient, parseNextLink } from '../src/providers/github/client.js';
import {
  GitHubProvider,
  extractClosedIssues,
  mergeSnapshots,
} from '../src/providers/github/githubProvider.js';
import { computeMetrics } from '../src/analysis/metrics.js';
import type { ActivitySnapshot } from '../src/domain/types.js';
import { makeDeveloperId } from '../src/domain/identity.js';
import { REPO, at, commit, file, snapshot } from './helpers.js';

function json(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('parseNextLink', () => {
  it('picks the next page out of a Link header', () => {
    const header = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe('https://api.github.com/x?page=2');
    expect(parseNextLink('<https://api.github.com/x?page=9>; rel="last"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

describe('GitHubClient', () => {
  it('follows pagination until there is no next link', async () => {
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json([1, 2], { link: '<https://api.github.com/next>; rel="next"' }))
      .mockResolvedValueOnce(json([3]));

    const client = new GitHubClient({ fetch: fetchStub });
    const pages: number[][] = [];
    for await (const page of client.paginate<number>('/things')) pages.push(page);

    expect(pages).toEqual([[1, 2], [3]]);
    expect(fetchStub.mock.calls[0]![0]).toContain('per_page=100');
  });

  it('waits out a secondary rate limit and then succeeds', async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ message: 'rate limited' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, 403),
      )
      .mockResolvedValueOnce(json({ ok: true }, { 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(reset) }));
    const sleep = vi.fn(async (_ms: number) => {});

    const client = new GitHubClient({ fetch: fetchStub, sleep });
    await expect(client.get('/thing')).resolves.toEqual({ ok: true });
    // Waits until the reset the response advertised, rather than hammering.
    expect(sleep).toHaveBeenCalled();
    expect(sleep.mock.calls[0]![0]).toBeGreaterThan(1000);
    expect(client.rateLimit?.remaining).toBe(4999);
  });

  it('pauses before the primary budget is exhausted rather than after', async () => {
    const reset = Math.floor(Date.now() / 1000) + 60;
    const fetchStub = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json({}, { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(reset), 'x-ratelimit-limit': '5000' }),
      );
    const sleep = vi.fn(async (_ms: number) => {});

    const client = new GitHubClient({ fetch: fetchStub, sleep });
    await client.get('/a'); // learns remaining = 1
    await client.get('/b'); // must wait before spending the last requests
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('gives up with a descriptive error on a non-retryable failure', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation(async () => json({ message: 'Not Found' }, {}, 404));
    const client = new GitHubClient({ fetch: fetchStub });
    await expect(client.get('/missing')).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

describe('GitHubProvider', () => {
  it('maps REST payloads into the domain model', async () => {
    const fetchStub = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/commits')) {
        return json([
          {
            sha: 'abc',
            commit: {
              message: 'feat: add thing\n\nCo-authored-by: Carol <carol@acme.test>',
              author: { name: 'Alice', email: 'alice@acme.test', date: '2024-01-01T00:00:00Z' },
            },
            author: { login: 'alice' },
            parents: [{ sha: 'p' }],
          },
        ]);
      }
      if (/\/pulls\/\d+\/reviews/.test(url)) {
        return json([
          { id: 5, user: { login: 'bob' }, state: 'APPROVED', submitted_at: '2024-01-02T00:00:00Z', body: 'looks good to me overall' },
        ]);
      }
      if (url.includes('/pulls')) {
        return json([
          { id: 1, number: 7, title: 'Add thing', body: 'Closes #12', state: 'closed', merged_at: '2024-01-02T00:00:00Z', created_at: '2024-01-01T00:00:00Z', user: { login: 'alice' } },
        ]);
      }
      if (url.includes('/issues')) {
        return json([
          { id: 2, number: 12, title: 'Thing missing', created_at: '2023-12-01T00:00:00Z', user: { login: 'dan' }, labels: ['bug'] },
          { id: 3, number: 7, title: 'Add thing', created_at: '2024-01-01T00:00:00Z', user: { login: 'alice' }, pull_request: {} },
        ]);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const provider = new GitHubProvider({ fetch: fetchStub, token: 'x' });
    const result = await provider.fetch(REPO);

    expect(result.commits).toHaveLength(1);
    expect(result.commits[0]!.author.login).toBe('alice');
    expect(result.commits[0]!.coAuthors[0]!.email).toBe('carol@acme.test');
    expect(result.pullRequests[0]).toMatchObject({ number: 7, state: 'merged', closesIssues: ['12'] });
    expect(result.pullRequests[0]!.reviews[0]!.verdict).toBe('approved');
    // Pull requests must not be double-counted as issues.
    expect(result.issues.map((i) => i.number)).toEqual([12]);

    const auth = fetchStub.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(auth['authorization']).toBe('Bearer x');
  });

  it('does not spend a request per commit unless asked to', async () => {
    const fetchStub = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/commits')) {
        return json([{ sha: 'abc', commit: { message: 'x', author: { name: 'A', email: 'a@b.c', date: '2024-01-01T00:00:00Z' } }, parents: [] }]);
      }
      return json([]);
    });

    await new GitHubProvider({ fetch: fetchStub }).fetch(REPO);
    const commitCalls = fetchStub.mock.calls.filter(([u]) => /\/commits\/[a-z0-9]+/.test(String(u)));
    expect(commitCalls).toHaveLength(0);
  });
});

describe('extractClosedIssues', () => {
  it('finds the issues a pull request claims to close', () => {
    expect(extractClosedIssues('Fixes #12 and closes #40, refs #99')).toEqual(['12', '40']);
    expect(extractClosedIssues('')).toEqual([]);
  });
});

describe('mergeSnapshots', () => {
  it('unifies a developer’s git email identity with their GitHub login', () => {
    const git = snapshot([
      commit('alice', 0, 'feat: add core', [file('src/core.ts', 100, 0)]),
    ]);
    const github: ActivitySnapshot = {
      ...snapshot([]),
      commits: [
        {
          ...commit('alice', 0, 'feat: add core', []),
          author: makeDeveloperId({ name: 'alice', email: 'alice@acme.test', login: 'alice-gh' }),
        },
      ],
      pullRequests: [
        {
          id: '1',
          number: 1,
          title: 'Add core',
          author: makeDeveloperId({ login: 'alice-gh' }),
          state: 'merged',
          createdAt: at(0),
          mergedAt: at(1),
          commitShas: [],
          closesIssues: [],
          reviews: [],
        },
      ],
    };

    const merged = mergeSnapshots(git, github);
    expect(merged.commits[0]!.author.key).toBe('login:alice-gh');

    // One identity, holding both the code work and the pull request.
    const metrics = computeMetrics(merged);
    expect(metrics.developers).toHaveLength(1);
    expect(metrics.developers[0]!.lineage.linesAdded).toBe(100);
    expect(metrics.developers[0]!.collaboration.pullRequestsMerged).toBe(1);
  });

  it('keeps git diffs and blame while taking GitHub collaboration data', () => {
    const git = snapshot([commit('alice', 0, 'feat: x', [file('src/x.ts', 10, 0)])]);
    const merged = mergeSnapshots(git, { ...snapshot([]), pullRequests: [] });
    expect(merged.commits).toHaveLength(1);
    expect(merged.commits[0]!.files).toHaveLength(1);
  });
});
