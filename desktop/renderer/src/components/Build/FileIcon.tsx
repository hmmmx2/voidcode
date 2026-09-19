"use client";

/**
 * A glyph per file kind, so the tree can be scanned rather than read.
 *
 * **Scope, stated up front:** this is a coherent set of six shapes tinted by family — not a
 * reproduction of Seti or vscode-icons. Those are forty-plus hand-drawn brand marks and a
 * licence question each; that is a different project, and a half-finished version of it looks
 * worse than a deliberate small set. What a file tree actually needs is enough differentiation
 * to find the config file among the sources at a glance, and colour does most of that work.
 *
 * **Inline SVG rather than assets**, following three separate decisions already recorded in
 * this repo (`TopNavigation.tsx:50`, `app/Verdict.tsx:34`, `ProfileClient.tsx:553`): shipped
 * SVGs bake hard-coded hex fills, so they cannot follow a theme and had to be replaced with
 * inline JSX. Starting there saves doing it twice.
 *
 * The extension table is deliberately a superset of `LANGUAGE_BY_EXTENSION` in
 * `@shared/languages` — that one exists to pick a Monaco language and only lists what Monaco can
 * highlight. A tree has to say something about `.png` and `.lock` too.
 *
 * (This sentence pointed at `BuildWorkspace.tsx` for a long time, and no such symbol was there:
 * it went with the Build editor and the comment was the only trace left of it. The reasoning was
 * right and only the address was wrong, which is the worse of the two — a dangling reference
 * sends the next reader looking for code that does not exist. The table now lives in
 * `src/shared/` so the main process can read it too.)
 */

type IconKind = "code" | "markup" | "style" | "data" | "doc" | "config" | "image" | "shell" | "lock" | "file";

/**
 * Extension → kind.
 *
 * Grouped by what a reader is looking for, not by language family: `.json`, `.yml` and `.toml`
 * are three different syntaxes and one job.
 */
const KIND_BY_EXTENSION: Record<string, IconKind> = {
  ts: "code", tsx: "code", js: "code", jsx: "code", mjs: "code", cjs: "code",
  py: "code", rs: "code", go: "code", java: "code", c: "code", h: "code",
  cpp: "code", hpp: "code", cs: "code", rb: "code", php: "code", swift: "code",
  kt: "code", scala: "code", lua: "code", r: "code", sql: "code", ipynb: "code",

  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",

  css: "style", scss: "style", sass: "style", less: "style",

  json: "data", jsonc: "data", csv: "data", tsv: "data", parquet: "data",

  md: "doc", mdx: "doc", txt: "doc", rst: "doc", pdf: "doc",

  yml: "config", yaml: "config", toml: "config", ini: "config", cfg: "config",
  conf: "config", env: "config", editorconfig: "config", gitignore: "config",

  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  ico: "image", bmp: "image", avif: "image",

  sh: "shell", bash: "shell", zsh: "shell", fish: "shell", ps1: "shell", bat: "shell", cmd: "shell",

  lock: "lock",
};

/**
 * Whole filenames that mean more than their extension.
 *
 * `package.json` is config, not data, whatever its suffix says — and `Dockerfile` and
 * `Makefile` have no suffix at all, which is exactly why an extension-only table looks broken
 * on a real repository's root.
 */
const KIND_BY_NAME: Record<string, IconKind> = {
  "package.json": "config",
  "package-lock.json": "lock",
  "pnpm-lock.yaml": "lock",
  "yarn.lock": "lock",
  "cargo.lock": "lock",
  "poetry.lock": "lock",
  "tsconfig.json": "config",
  dockerfile: "config",
  makefile: "config",
  ".gitignore": "config",
  ".env": "config",
  license: "doc",
  readme: "doc",
  "readme.md": "doc",
};

/**
 * One colour per kind, from the theme's ink scale plus two accents.
 *
 * Muted on purpose. A file tree with ten saturated colours is a stained-glass window; the
 * point is to let the eye group things, not to decorate. `currentColor` is avoided so the
 * icon keeps its meaning when the row is selected and the label goes bright.
 */
const TINT: Record<IconKind, string> = {
  code: "#7aa2f7",
  markup: "#e0af68",
  style: "#bb9af7",
  data: "#9ece6a",
  doc: "#a3a3a3",
  config: "#7dcfff",
  image: "#f7768e",
  shell: "#73daca",
  lock: "#565f89",
  file: "#565f89",
};

export function kindFor(name: string): IconKind {
  const lower = name.toLowerCase();
  const byName = KIND_BY_NAME[lower];
  if (byName !== undefined) return byName;

  // `.` before the extension: a dotfile like `.gitignore` has no extension by `split`, and
  // `pop()` would return the whole name.
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "file";
  return KIND_BY_EXTENSION[lower.slice(dot + 1)] ?? "file";
}

/** A page outline, shared by every file kind. The mark inside it is what differs. */
function Page({ tint, children }: { tint: string; children?: React.ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden style={{ color: tint }}>
      <path
        d="M3.5 1.5h6l3 3v10h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
        opacity="0.55"
      />
      {children}
    </svg>
  );
}

const MARKS: Record<IconKind, React.ReactNode> = {
  // Angle brackets — the universal "this is source".
  code: <path d="M6 7.5L4.5 9l1.5 1.5M10 7.5L11.5 9L10 10.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />,
  markup: <path d="M5.5 7.5l-1 1.5 1 1.5M10.5 7.5l1 1.5-1 1.5M9 6.5l-2 5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />,
  style: <path d="M5.5 8.5h5M5.5 11h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />,
  // Braces.
  data: <path d="M7 7.5q-1 0 -1 1.5t-1 1.5q1 0 1 1.5M9 7.5q1 0 1 1.5t1 1.5q-1 0 -1 1.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />,
  doc: <path d="M5.5 8h5M5.5 10h5M5.5 12h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />,
  // A cog, small enough to read as one at 14px.
  config: <><circle cx="8" cy="10" r="1.6" fill="none" stroke="currentColor" strokeWidth="1" /><path d="M8 6.9v-.9M8 14v-.9M5.8 10h-.9M11.1 10h.9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" /></>,
  // Horizon and sun.
  image: <><circle cx="6.5" cy="8.5" r="1" fill="currentColor" /><path d="M4.5 12.5l2.5-2.5 2 2 1.5-1.5 1.5 2z" fill="currentColor" opacity="0.75" /></>,
  shell: <path d="M5 8.5l2 1.5-2 1.5M8.5 12h3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />,
  lock: <><rect x="6" y="9.5" width="4" height="3.5" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" /><path d="M6.9 9.5v-1a1.1 1.1 0 0 1 2.2 0v1" fill="none" stroke="currentColor" strokeWidth="1" /></>,
  file: null,
};

export function FileIcon({ name }: { name: string }) {
  const kind = kindFor(name);
  return <Page tint={TINT[kind]}>{MARKS[kind]}</Page>;
}

/**
 * Folders, open and closed.
 *
 * A separate shape rather than a tinted page, because the one thing a tree must never make
 * ambiguous is which rows can be expanded.
 */
export function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden style={{ color: "#7aa2f7" }}>
      {open ? (
        <path
          d="M1.5 12.5V4.5h4l1.5 2h6v1.5M1.5 12.5l2-5h11l-2 5z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
          opacity="0.8"
        />
      ) : (
        <path
          d="M1.5 12.5v-8h4l1.5 2h7v6z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinejoin="round"
          opacity="0.8"
        />
      )}
    </svg>
  );
}
