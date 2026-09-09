/**
 * Matching a typed fragment against a project's file paths.
 *
 * `CommandPalette` filters with `includes`, which is right for a list of forty labelled commands
 * and wrong for four thousand paths: nobody types a contiguous substring of
 * `src/components/Build/BuildWorkspace.tsx`. They type `bwork`, or `buildws`, and expect it
 * first.
 *
 * So this is a subsequence match with a score, and the score is where all the behaviour lives.
 * Three rules, in the order they matter:
 *
 *   1. **The basename outranks the directory.** Typing `index` should not bury `src/index.ts`
 *      under `index/legacy/thing.ts`. This is the one that makes a picker feel like it is
 *      reading your mind rather than grepping.
 *   2. **Runs outrank scattered letters.** `build` matching `build` beats `build` matching
 *      `b...u...i...l...d` spread across a path, even though both are subsequences.
 *   3. **Boundaries outrank the middle of a word.** A letter after `/`, `-`, `_` or `.` is one
 *      the user was probably aiming at.
 *
 * Pure and dependency-free, so the ranking can be tested against real path lists rather than by
 * typing into a picker and squinting.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in the target that matched, for highlighting. Ascending. */
  positions: number[];
}

export interface RankedPath extends FuzzyMatch {
  path: string;
}

const BOUNDARY = /[/\-_. ]/;

/**
 * One greedy left-to-right pass, starting the search at `from`.
 *
 * Positions and context are global, so a character's "is it after a boundary?" question is
 * answered against the real path however late the scan began.
 */
function scanFrom(
  needle: string,
  target: string,
  hay: string,
  from: number,
  basenameStart: number
): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let cursor = from;
  let previousMatch = -2;

  for (const char of needle) {
    // A space in the query means "and then, somewhere later" — it separates terms rather than
    // having to match a literal space, which paths rarely contain.
    if (char === " ") continue;

    const found = hay.indexOf(char, cursor);
    if (found === -1) return null;

    positions.push(found);
    cursor = found + 1;

    // Consecutive with the previous match: the strongest signal that this is the word meant.
    if (found === previousMatch + 1) score += 8;

    const before = found === 0 ? "/" : target[found - 1]!;
    if (BOUNDARY.test(before)) score += 6;
    // A capital inside a word is a boundary too — `BuildWorkspace` should answer to `bw`.
    else if (target[found] !== target[found]!.toLowerCase()) score += 4;

    if (found >= basenameStart) score += 5;
    // Earlier is better, gently: enough to break ties, not enough to beat a basename hit.
    score -= Math.min(found, 40) * 0.05;

    previousMatch = found;
  }

  // Shorter targets win among equals — `src/app.ts` over `src/vendor/deep/app.ts` for `app`.
  score -= target.length * 0.01;
  return { score, positions };
}

/**
 * Match `query` as a subsequence of `target`, or null.
 *
 * **Two passes, because one greedy pass is measurably wrong here.** A single left-to-right scan
 * takes the earliest letter it can, which is usually a directory: `dock` matches the `d` in
 * `buil{d}/` and then limps through `dock.ts` non-contiguously, scoring *below*
 * `Layout/DockGrid.tsx`. `bw` is worse — it takes the `B` of the directory `Build/` and finds
 * `BuildWorkspace` only for the `w`, losing to `build-workspace-notes.md`.
 *
 * So the basename is tried as a second starting point and the better score wins. That is not a
 * general fix for greedy alignment — an optimal matcher would try every one — but it is a fix
 * for the case that actually occurs, because the collision is nearly always a folder sharing a
 * word with the file inside it. Two passes over a few thousand paths per keystroke is cheap;
 * exhaustive alignment is not.
 */
export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };

  const needle = query.toLowerCase();
  const hay = target.toLowerCase();
  const basenameStart = target.lastIndexOf("/") + 1;

  const whole = scanFrom(needle, target, hay, 0, basenameStart);
  if (basenameStart === 0) return whole;

  const fromBasename = scanFrom(needle, target, hay, basenameStart, basenameStart);
  if (fromBasename === null) return whole;
  if (whole === null) return fromBasename;
  return fromBasename.score > whole.score ? fromBasename : whole;
}

/**
 * Rank paths against a query, best first.
 *
 * An empty query keeps the input order and takes the first `limit`, because "the tree, from the
 * top" is a more useful starting view than an arbitrary alphabetical slice of four thousand
 * files.
 */
export function rankPaths(
  query: string,
  paths: readonly string[],
  limit = 50
): RankedPath[] {
  const trimmed = query.trim();
  if (trimmed === "") {
    return paths.slice(0, limit).map((path) => ({ path, score: 0, positions: [] }));
  }

  const ranked: RankedPath[] = [];
  for (const path of paths) {
    const match = fuzzyMatch(trimmed, path);
    if (match !== null) ranked.push({ path, ...match });
  }

  // Stable within equal scores: `Array.prototype.sort` is stable, so ties keep tree order rather
  // than reshuffling as the user types another character.
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

/**
 * Split a path into matched and unmatched runs, for rendering.
 *
 * Returned as segments rather than as indices so the component does no arithmetic — the thing
 * that has the positions is the thing that knows what they mean.
 */
export function highlight(path: string, positions: readonly number[]): Array<{ text: string; hit: boolean }> {
  if (positions.length === 0) return [{ text: path, hit: false }];

  const marks = new Set(positions);
  const segments: Array<{ text: string; hit: boolean }> = [];
  let current = "";
  let currentHit = marks.has(0);

  for (let i = 0; i < path.length; i += 1) {
    const hit = marks.has(i);
    if (hit !== currentHit) {
      if (current !== "") segments.push({ text: current, hit: currentHit });
      current = "";
      currentHit = hit;
    }
    current += path[i];
  }
  if (current !== "") segments.push({ text: current, hit: currentHit });
  return segments;
}
