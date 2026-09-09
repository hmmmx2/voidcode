/**
 * Reading `.gitignore`, so the index does not embed what the project already ignores.
 *
 * Implemented rather than shelled out to `git check-ignore`, for two reasons: the folder the
 * user opened may not be a repository at all, and spawning a process per file — or feeding
 * thousands of paths through one — is slower than matching them here.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it is not a complete implementation of gitignore. No
 * character classes (`[abc]`), no `\` escaping, and only the repository-root file is read —
 * nested `.gitignore` files and `.git/info/exclude` are not consulted. Those are stated here
 * rather than discovered later, and none of them change what gets skipped in a normal project.
 *
 * The cost of being wrong is asymmetric and the design leans on that: a pattern this misses
 * means a few extra files are embedded, which is waste. There is no correctness or privacy
 * claim resting on it — `.git` itself is skipped structurally by the walker, not by this.
 */

export interface IgnoreRule {
  /** Compiled from the pattern. Tested against a project-relative, forward-slash path. */
  regex: RegExp;
  /** `!` prefix — a later negation re-includes a path an earlier rule excluded. */
  negated: boolean;
  /** Trailing `/` — matches directories only. */
  directoryOnly: boolean;
}

/**
 * Turn one pattern into a regex.
 *
 * The ordering inside the loop matters: `**` has to be consumed before `*`, or the first
 * star of a `**` is treated as a single-segment wildcard and the pattern silently stops
 * matching across directories.
 */
function compile(pattern: string): RegExp {
  let source = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i] as string;

    if (char === "*" && pattern[i + 1] === "*") {
      // `**/` matches zero or more directories, so `**/x` also matches a bare `x`. Without
      // the `(?:...)?` a leading `**/` would require at least one directory and miss the
      // top-level case entirely.
      if (pattern[i + 2] === "/") {
        source += "(?:[^/]+/)*";
        i += 3;
      } else {
        source += ".*";
        i += 2;
      }
      continue;
    }

    if (char === "*") {
      // A single star stops at a separator — `src/*.py` must not match `src/a/b.py`.
      source += "[^/]*";
      i += 1;
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }

    // Everything else is literal. Escaped rather than passed through, so a `.` in a filename
    // cannot act as a wildcard and `+` in `c++/` cannot break the regex outright.
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }

  return new RegExp(`^${source}$`);
}

/** Parse a `.gitignore` file's contents into rules, in order. */
export function parseGitignore(contents: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const raw of contents.split(/\r?\n/)) {
    // Trailing whitespace is not part of a pattern; leading whitespace is left alone because
    // a filename may legitimately begin with a space.
    const line = raw.replace(/\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;

    const negated = line.startsWith("!");
    let pattern = negated ? line.slice(1) : line;

    const directoryOnly = pattern.endsWith("/");
    if (directoryOnly) pattern = pattern.slice(0, -1);

    // A pattern containing a slash is anchored to the root; one without matches at any depth.
    // This is the rule people are most often surprised by, and getting it backwards means
    // either ignoring far too much or nothing at all.
    const anchored = pattern.includes("/");
    if (pattern.startsWith("/")) pattern = pattern.slice(1);

    const body = anchored ? pattern : `**/${pattern}`;
    rules.push({ regex: compile(body), negated, directoryOnly });
  }

  return rules;
}

/**
 * Whether a path is ignored.
 *
 * Last matching rule wins, which is what makes `!` work: `node_modules/` followed by
 * `!node_modules/mine/` re-includes the second. Evaluated in order rather than short-circuiting
 * on the first match, for exactly that reason.
 *
 * A path inside an ignored *directory* is ignored too, so `dist/` covers `dist/a/b.js` without
 * needing `dist/**`.
 */
export function isIgnored(
  rules: readonly IgnoreRule[],
  relativePath: string,
  isDirectory = false
): boolean {
  let ignored = false;

  // Every ancestor, then the path itself: `dist/` has to catch `dist/a/b.js`.
  const segments = relativePath.split("/");
  const candidates = segments.map((_, index) => ({
    path: segments.slice(0, index + 1).join("/"),
    // Everything but the last segment is necessarily a directory.
    directory: index < segments.length - 1 ? true : isDirectory,
  }));

  for (const rule of rules) {
    for (const candidate of candidates) {
      if (rule.directoryOnly && !candidate.directory) continue;
      if (rule.regex.test(candidate.path)) ignored = !rule.negated;
    }
  }

  return ignored;
}
