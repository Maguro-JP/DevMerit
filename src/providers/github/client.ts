/**
 * A very small GitHub REST client.
 *
 * It exists rather than a dependency because DevMerit needs exactly three
 * things from a GitHub client and needs them to behave predictably under rate
 * limiting: paginate via `Link`, back off when GitHub says to, and never spin.
 */

export interface GitHubClientOptions {
  /** Personal access token or app token. Requests are unauthenticated without it. */
  readonly token?: string;
  readonly baseUrl?: string;
  readonly userAgent?: string;
  /** Retries for transient failures and secondary rate limits. Default 3. */
  readonly maxRetries?: number;
  /** Injection point for tests; defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injection point for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RateLimitState {
  readonly remaining: number;
  readonly limit: number;
  /** When the primary limit resets. */
  readonly resetAt: Date;
}

export class GitHubApiError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

const DEFAULT_BASE_URL = 'https://api.github.com';
/** Stop before hitting zero so a run never exhausts a shared token. */
const RESERVE_REQUESTS = 10;

export class GitHubClient {
  readonly #token: string | undefined;
  readonly #baseUrl: string;
  readonly #userAgent: string;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  #rateLimit: RateLimitState | undefined;

  constructor(options: GitHubClientOptions = {}) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.#userAgent = options.userAgent ?? 'devmerit';
    this.#maxRetries = options.maxRetries ?? 3;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Most recent rate-limit state reported by GitHub, if any request has run. */
  get rateLimit(): RateLimitState | undefined {
    return this.#rateLimit;
  }

  async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.#baseUrl}${path}`;
    const { body } = await this.#request<T>(url, signal);
    return body;
  }

  /**
   * Yields every page of a paginated collection, following `Link: rel="next"`.
   *
   * Pages are yielded as they arrive so a caller can stop early — important on
   * repositories with tens of thousands of commits.
   */
  async *paginate<T>(path: string, signal?: AbortSignal): AsyncGenerator<T[], void, void> {
    let url: string | undefined = path.startsWith('http')
      ? path
      : `${this.#baseUrl}${path}${path.includes('?') ? '&' : '?'}per_page=100`;

    while (url !== undefined) {
      const page: { body: T[]; next?: string } = await this.#request<T[]>(url, signal);
      const body = page.body;
      if (!Array.isArray(body)) {
        throw new GitHubApiError('Expected a paginated array response', 200, url);
      }
      yield body;
      url = page.next;
    }
  }

  async #request<T>(url: string, signal?: AbortSignal): Promise<{ body: T; next?: string }> {
    const headers: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': this.#userAgent,
    };
    if (this.#token) headers['authorization'] = `Bearer ${this.#token}`;

    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      await this.#respectRateLimit(signal);

      const init: RequestInit = { headers };
      if (signal) init.signal = signal;
      const response = await this.#fetch(url, init);
      this.#readRateLimit(response);

      if (response.ok) {
        const body = (await response.json()) as T;
        const next = parseNextLink(response.headers.get('link'));
        return next === undefined ? { body } : { body, next };
      }

      const retryAfter = this.#retryDelayMs(response);
      if (retryAfter !== undefined && attempt < this.#maxRetries) {
        await this.#sleep(retryAfter);
        continue;
      }

      const detail = await response.text().catch(() => '');
      throw new GitHubApiError(
        `GitHub responded ${response.status} for ${url}${detail ? `: ${truncate(detail)}` : ''}`,
        response.status,
        url,
      );
    }
  }

  /**
   * Decides whether a failed response is worth retrying and after how long.
   *
   * Honours `Retry-After` and the secondary-rate-limit convention of a 403 with
   * `x-ratelimit-remaining: 0`; 5xx get exponential backoff.
   */
  #retryDelayMs(response: Response): number | undefined {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
    }
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get('x-ratelimit-remaining') === '0'
    ) {
      const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10);
      if (Number.isFinite(reset)) {
        return Math.max(1000, reset * 1000 - Date.now());
      }
      return 60_000;
    }
    if (response.status >= 500) return 1000;
    return undefined;
  }

  /** Waits out the primary rate limit before it is actually exhausted. */
  async #respectRateLimit(signal?: AbortSignal): Promise<void> {
    const state = this.#rateLimit;
    if (!state || state.remaining > RESERVE_REQUESTS) return;
    const waitMs = state.resetAt.getTime() - Date.now();
    if (waitMs <= 0) return;
    signal?.throwIfAborted();
    await this.#sleep(waitMs + 1000);
  }

  #readRateLimit(response: Response): void {
    const remaining = Number.parseInt(response.headers.get('x-ratelimit-remaining') ?? '', 10);
    const limit = Number.parseInt(response.headers.get('x-ratelimit-limit') ?? '', 10);
    const reset = Number.parseInt(response.headers.get('x-ratelimit-reset') ?? '', 10);
    if (!Number.isFinite(remaining) || !Number.isFinite(reset)) return;
    this.#rateLimit = {
      remaining,
      limit: Number.isFinite(limit) ? limit : remaining,
      resetAt: new Date(reset * 1000),
    };
  }
}

/** Extracts the `rel="next"` URL from a `Link` header. */
export function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match && match[2] === 'next') return match[1];
  }
  return undefined;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
