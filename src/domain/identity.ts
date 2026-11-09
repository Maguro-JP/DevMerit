import type { DeveloperId } from './types.js';
import { mergeDeveloperId } from './types.js';

/** Emails GitHub generates for web-UI commits: `12345+login@users.noreply.github.com`. */
const NOREPLY_RE = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i;

/** Well-known bot identities, excluded from developer scoring by default. */
const BOT_RE = /(\[bot\]$|^dependabot|^renovate|^github-actions|^greenkeeper)/i;

export function isBot(id: DeveloperId): boolean {
  return [id.login, id.name, id.email].some((v) => v !== undefined && BOT_RE.test(v));
}

/**
 * Build a canonical key for a developer.
 *
 * Preference order: platform login (stable across email changes) > email > name.
 * GitHub noreply addresses are decoded back into the login they encode, so the
 * same person committing from the web UI and from a laptop collapses into one.
 */
export function canonicalKey(raw: { name?: string; email?: string; login?: string }): string {
  const email = raw.email?.trim().toLowerCase();
  const noreply = email ? NOREPLY_RE.exec(email) : null;
  const login = raw.login?.trim().toLowerCase() ?? noreply?.[1];
  if (login) return `login:${login}`;
  if (email) return `email:${email}`;
  const name = raw.name?.trim().toLowerCase();
  if (name) return `name:${name}`;
  return 'unknown';
}

export function makeDeveloperId(raw: { name?: string; email?: string; login?: string }): DeveloperId {
  const noreply = raw.email ? NOREPLY_RE.exec(raw.email.trim().toLowerCase()) : null;
  const login = raw.login ?? noreply?.[1];
  const id: { -readonly [K in keyof DeveloperId]: DeveloperId[K] } = { key: canonicalKey(raw) };
  if (raw.name !== undefined) id.name = raw.name;
  if (raw.email !== undefined) id.email = raw.email;
  if (login !== undefined) id.login = login;
  return id;
}

/**
 * Collects the several identities one person commits under and exposes the
 * richest merged view of each. Aliases let a project map known duplicates
 * (e.g. a personal and a work email) onto a single canonical key.
 */
export class IdentityRegistry {
  readonly #byKey = new Map<string, DeveloperId>();
  readonly #aliases: ReadonlyMap<string, string>;

  /** @param aliases map of alias key -> canonical key, as produced by `canonicalKey`. */
  constructor(aliases: ReadonlyMap<string, string> = new Map()) {
    this.#aliases = aliases;
  }

  resolve(raw: { name?: string; email?: string; login?: string }): DeveloperId {
    const seen = makeDeveloperId(raw);
    const key = this.#aliases.get(seen.key) ?? seen.key;
    const id: DeveloperId = key === seen.key ? seen : { ...seen, key };
    const existing = this.#byKey.get(key);
    const merged = existing ? mergeDeveloperId(existing, id) : id;
    this.#byKey.set(key, merged);
    return merged;
  }

  get(key: string): DeveloperId | undefined {
    return this.#byKey.get(key);
  }

  all(): readonly DeveloperId[] {
    return [...this.#byKey.values()];
  }

  /** Best display label for a developer key, falling back to the key itself. */
  displayName(key: string): string {
    const id = this.#byKey.get(key);
    return id?.login ?? id?.name ?? id?.email ?? key;
  }
}
