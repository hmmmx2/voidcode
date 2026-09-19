/**
 * Which Monaco language a file is, from its name.
 *
 * Import-free and shared by both tsconfigs, the same arrangement as `diagnostics.ts` and
 * `hardware-types.ts`.
 *
 * WHY THIS FILE EXISTS AT ALL, which is a small story worth keeping. `Build/FileIcon.tsx` has
 * said for some time that its extension table is "deliberately a superset of
 * `LANGUAGE_BY_EXTENSION` in `BuildWorkspace.tsx` — that one exists to pick a Monaco language".
 * There was no such symbol anywhere in the tree. It went with the Build editor, and the comment
 * was the only trace left of it. So this is a restoration rather than an invention, and the
 * reasoning that comment recorded is the reasoning kept here: an icon table has to say something
 * about `.png` and `.lock`, and a language table must say nothing at all about them.
 *
 * WHY IT IS NOT MERGED WITH `CodeBlock.tsx`'s `LANGUAGE_ALIASES`. That table is keyed by *fence
 * tokens* — `bash`, `shell`, `markdown`, `yml`, `typescript` — which are what a model writes
 * after three backticks, not what a file is called. The keyspaces overlap heavily and are not the
 * same question, and one table answering both would have to accept `markdown` as a file
 * extension. `tests/languages.test.ts` asserts they agree wherever they do overlap, which is the
 * property that actually matters.
 *
 * WHY NOT AN OBJECT LOOKUP AT THE CALL SITE. `monacoLanguageFor` goes through a `Map`, because a
 * file literally named `__proto__.ts` is a legal filename and `RECORD["__proto__"]` is not a
 * miss — it returns `Object.prototype`. `lib/build/dock.ts` and `problems.test.ts` both record
 * this hazard already.
 */

/**
 * Extension → Monaco language id.
 *
 * Every value is an id Monaco actually registers; `tests/languages.test.ts` checks each one
 * against the installed `monaco-editor`, because a wrong id does not throw — it degrades
 * silently to plain text, which looks exactly like the theme having failed to apply.
 *
 * Extensions only. Whole filenames that carry a language (`Dockerfile`, `Makefile`) are handled
 * in `FILENAME_LANGUAGES` below, for the same reason `FileIcon` keeps a separate table: an
 * extension-only lookup looks broken on a real repository's root.
 */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  // TypeScript and JavaScript. `.mts`/`.cts` are typescript; `.mjs`/`.cjs` are javascript.
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",

  py: "python",
  pyi: "python",
  pyw: "python",

  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  rb: "ruby",
  php: "php",
  lua: "lua",
  r: "r",
  dart: "dart",
  pl: "perl",
  pm: "perl",
  ex: "elixir",
  exs: "elixir",
  clj: "clojure",
  jl: "julia",
  cs: "csharp",

  // C and C++. `c` is registered by the cpp contribution rather than a directory of its own —
  // see `ID_IS_REGISTERED_BY`.
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  m: "objective-c",
  mm: "objective-c",

  // Markup and style.
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  xsd: "xml",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",

  // Data and configuration. `.toml` is Monaco's `ini` — close enough to be useful and named
  // honestly here rather than pretended to be a TOML mode Monaco does not ship.
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  proto: "proto",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  tfvars: "hcl",

  // Prose and queries.
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  rst: "restructuredtext",
  sql: "sql",

  // Shells.
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
};

/**
 * Filenames whose language does not come from an extension.
 *
 * Matched case-insensitively on the whole basename. `Dockerfile.dev` and friends are not handled:
 * a prefix rule would claim `Makefile.bak` too, and being wrong is worse than being plain.
 */
export const FILENAME_LANGUAGES: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  containerfile: "dockerfile",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".npmignore": "ini",
  ".editorconfig": "ini",
  ".env": "ini",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
};

/**
 * Ids Monaco registers from a directory with a different name.
 *
 * Only here so `tests/languages.test.ts` can check every id against the installed package
 * without a hand-maintained allowlist of "ids the test should skip" — which is the shape that
 * goes stale and then hides a real typo.
 */
export const ID_IS_REGISTERED_BY: Readonly<Record<string, string>> = {
  c: "cpp",
  proto: "protobuf",
};

/**
 * Which of Monaco's bundled language *services* covers an id, if any.
 *
 * THE POINT OF THIS TABLE IS WHAT IT LEAVES OUT. Only these languages get real diagnostics,
 * hovers and go-to-definition, because only these have a worker under `vs/language/`. Everything
 * else in `LANGUAGE_BY_EXTENSION` gets tokenisation — colour and nothing more.
 *
 * Python is the case that matters and the one people assume. It is absent, and its problems come
 * from `lint:run` (ruff, over the file on disk) instead. Naming the served set explicitly is what
 * lets the Problems pane say which of the two answered, rather than showing an empty list that
 * reads as "no problems" when it means "nothing looked".
 *
 * Values are the directory under `vs/language/`, so several ids share one service.
 */
export const MONACO_WORKER_SERVICE: Readonly<Record<string, string>> = {
  typescript: "typescript",
  javascript: "typescript",
  json: "json",
  css: "css",
  scss: "css",
  less: "css",
  html: "html",
};

/** The ids with a language service, for a caller that only needs membership. */
export const MONACO_WORKER_LANGUAGES: readonly string[] = Object.keys(MONACO_WORKER_SERVICE);

const BY_EXTENSION = new Map(Object.entries(LANGUAGE_BY_EXTENSION));
const BY_FILENAME = new Map(Object.entries(FILENAME_LANGUAGES));
const HAS_WORKER = new Set(MONACO_WORKER_LANGUAGES);

/** The basename of a `/`-separated path. Also tolerates `\`, since Windows paths reach this. */
function basename(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return cut === -1 ? filePath : filePath.slice(cut + 1);
}

/**
 * The Monaco language id for a path, or `null` when Monaco has nothing for it.
 *
 * `null` rather than a fallback of `"plaintext"`: the caller has to be able to tell "this is
 * text" from "we do not know", because the second is what decides whether to offer a linter and
 * whether to say anything in the Problems pane.
 *
 * A dotfile like `.gitignore` is a filename, not an extension — `lastIndexOf(".") === 0` is
 * checked before the extension lookup, or `.gitignore` would be read as the extension
 * `gitignore`.
 */
export function monacoLanguageFor(filePath: string): string | null {
  const name = basename(filePath).toLowerCase();
  if (name === "") return null;

  const byName = BY_FILENAME.get(name);
  if (byName !== undefined) return byName;

  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;

  return BY_EXTENSION.get(name.slice(dot + 1)) ?? null;
}

/** Whether Monaco's own language service reports problems for this path. */
export function hasLanguageService(filePath: string): boolean {
  const language = monacoLanguageFor(filePath);
  return language !== null && HAS_WORKER.has(language);
}
