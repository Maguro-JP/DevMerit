/** Minimal glob support: `*` (within a segment), `**` (across segments), `?`. */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Paths that almost never represent authored engineering value. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '**/package-lock.json',
  '**/pnpm-lock.yaml',
  '**/yarn.lock',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/vendor/**',
  '**/*.snap',
];

/** Matches paths against exclusion globs; used to keep generated code out of scoring. */
export class PathFilter {
  readonly #patterns: readonly RegExp[];

  constructor(globs: readonly string[] = DEFAULT_EXCLUDES) {
    this.#patterns = globs.map(globToRegExp);
  }

  excludes(path: string): boolean {
    return this.#patterns.some((re) => re.test(path));
  }
}
