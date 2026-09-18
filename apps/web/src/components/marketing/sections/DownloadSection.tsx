"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Container,
  Eyebrow,
  Lead,
  MonoLabel,
  Section,
  SectionHeading,
} from "@/components/marketing/primitives/SectionShell";
import { Pill } from "@/components/ui/Pill";
import { Reveal } from "@/components/motion/Reveal";

/**
 * Where a visitor actually gets the application.
 *
 * THE LAST SECTION ON PURPOSE. Everything above it argues that the product is worth having; this is
 * the one place that hands it over. It is built from the page's own primitives — `Section`,
 * `Container`, `SectionHeading`, `Lead`, `Eyebrow`, `MonoLabel`, `Pill`, `Reveal` — so it reads as
 * the end of this page rather than a download page bolted onto one.
 *
 * TWO PLATFORM PANELS, NOT A TABLE. A table is the right shape for "every file this release
 * carries" and the wrong shape for the decision a visitor is actually making, which is one choice
 * between two operating systems and, on a Mac, between two processors. So each platform gets a
 * panel with its own primary button, its files listed underneath with size and checksum, and the
 * install step that platform's own security prompt will require. Nobody has to read a row they are
 * not on.
 *
 * A CLIENT COMPONENT, AND THE ONLY ONE IN THE PAGE'S TAIL. It has to be: the file list comes from
 * the release feed at view time, and the primary button depends on the visitor's own platform.
 * Nothing above it is affected — the hero's `<h1>` is still server-rendered text with nothing in
 * front of it, which is what keeps the largest paint fast.
 *
 * WHY THE LINKS ARE NOT COMMITTED TO THIS REPOSITORY
 *
 * A hand-maintained table of versions, sizes and checksums is a second source of truth for the one
 * thing here that must not be wrong, edited by hand right after a release by someone who has just
 * spent an hour on a release. A stale checksum beside a fresh installer is worse than no checksum.
 * The release list is the record; this asks it.
 *
 * WHAT IT DOES WHEN IT CANNOT ASK
 *
 * No repository configured, rate-limited (60 anonymous requests an hour per IP, which a shared
 * office network can exhaust), offline, or no release published yet: it says which of those
 * happened and, where there is one, links to the releases page. It never draws a download button
 * that leads nowhere — on the section whose whole job is handing someone an installer, a dead
 * primary action is the worst failure available.
 */

/** `owner/name` of the repository that publishes the installers. Empty until the owner sets it. */
const REPO = (process.env.NEXT_PUBLIC_RELEASES_REPO ?? "").trim();

const CACHE_KEY = "voidcode:release";
const CACHE_MS = 10 * 60 * 1000;

interface Kind {
  os: "mac" | "win";
  arch: "arm64" | "x64";
  /** What a person chooses between, in their words rather than the build's. */
  label: string;
  hint: string;
  /** The installer's extension, shown before a release exists so the row still says something. */
  file: string;
  pattern: RegExp;
}

/**
 * The files a release carries.
 *
 * Matched on the asset name from `desktop/electron-builder.yml`'s
 * `${productName}-${version}-${os}-${arch}.${ext}` — so `VoidCode-0.1.0-mac-arm64.dmg`.
 */
const KINDS: Kind[] = [
  {
    os: "mac",
    arch: "arm64",
    label: "Apple silicon",
    hint: "M1, M2, M3, M4",
    file: ".dmg",
    pattern: /-mac-arm64\.dmg$/,
  },
  {
    os: "mac",
    arch: "x64",
    label: "Intel",
    hint: "pre-2020 Macs",
    file: ".dmg",
    pattern: /-mac-x64\.dmg$/,
  },
  {
    os: "win",
    arch: "x64",
    label: "64-bit",
    hint: "most PCs",
    file: ".exe installer",
    pattern: /-win-x64\.exe$/,
  },
  {
    os: "win",
    arch: "arm64",
    label: "ARM",
    hint: "Snapdragon, Surface Pro X",
    file: ".exe installer",
    pattern: /-win-arm64\.exe$/,
  },
];

const PLATFORMS = [
  {
    os: "mac" as const,
    title: "macOS",
    what: "A disk image you drag into Applications. Apple silicon and Intel are separate files.",
    /** The prompt this platform will show, and the exact way past it. */
    gate: [
      "Open the .dmg and drag VoidCode to Applications.",
      "The app is not signed with an Apple developer certificate, so the first launch is refused.",
      "Open System Settings › Privacy & Security, find the message about VoidCode, and choose Open Anyway.",
    ],
    verify: "shasum -a 256 VoidCode-*.dmg",
    /** How to tell which file you need, when the browser cannot. */
    which: "Apple menu › About This Mac. “Chip: Apple M…” is Apple silicon; “Processor: Intel” is the Intel build.",
  },
  {
    os: "win" as const,
    title: "Windows",
    what: "An installer that sets the app up for your user account. No administrator rights needed.",
    gate: [
      "Run the .exe.",
      "The installer is not signed, so SmartScreen shows “Windows protected your PC”.",
      "Choose More info, then Run anyway. Nothing else is needed — the app carries its own Python runtime.",
    ],
    verify: "Get-FileHash VoidCode-*.exe -Algorithm SHA256",
    which: "Settings › System › About, under “System type”. ARM only applies to Snapdragon and Surface Pro X machines.",
  },
];

interface Asset {
  name: string;
  size: number;
  browser_download_url: string;
  digest?: string | null;
}

interface Release {
  tag_name?: string;
  published_at?: string;
  assets?: Asset[];
}

type State =
  | { status: "loading" }
  | { status: "unavailable"; reason: string }
  | { status: "ready"; release: Release; found: Map<string, Asset> };

const key = (kind: Kind): string => `${kind.os}-${kind.arch}`;

/** A placeholder is not a repository, and refusing anything else keeps a pasted URL out of the path. */
function repoName(): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(REPO) && REPO !== "OWNER/REPO" ? REPO : null;
}

/** Bytes as a person would say them. Two significant figures is all a download size deserves. */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/**
 * The SHA-256 of an asset, when the feed gives one.
 *
 * `digest` arrives as `sha256:<hex>` on releases published since GitHub added the field, and is
 * absent on older ones — hence the empty string rather than a guess.
 */
function digestOf(asset: Asset): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? "");
  return match === null ? "" : match[1];
}

/**
 * Which platform to put first.
 *
 * Client hints where they exist, because they are the only way to tell an ARM Windows PC from an
 * x64 one. On macOS the answer is deliberately NOT taken from the user agent: Safari and Firefox
 * report "Intel Mac OS X 10_15_7" on every Mac, Apple silicon included, so the UA can only say "a
 * Mac". Apple silicon is the default there — and both files stay listed, with the note on how to
 * check, because guessing wrong costs someone a download that will not open.
 */
async function detect(): Promise<string | null> {
  const ua = navigator.userAgent;
  const os = /Windows|Win32|Win64/.test(ua) ? "win" : /Mac/.test(ua) ? "mac" : null;
  if (os === null) return null; // Linux, Android, iOS: no guess, both panels stay equal.

  let arch = os === "mac" ? "arm64" : "x64";
  const data = (
    navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<Record<string, string>> };
    }
  ).userAgentData;

  if (data !== undefined) {
    try {
      const hints = await data.getHighEntropyValues(["architecture", "bitness"]);
      if (hints.architecture === "arm") arch = "arm64";
      else if (hints.architecture === "x86" && hints.bitness === "32") return null;
    } catch {
      /* Hints are a courtesy; the default stands. */
    }
  }
  return `${os}-${arch}`;
}

function cached(repo: string): Release | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const entry = JSON.parse(raw) as { key: string; at: number; release: Release };
    if (entry.key !== repo || Date.now() - entry.at > CACHE_MS) return null;
    return entry.release;
  } catch {
    // Private windows and blocked site data both throw here. No cache is fine.
    return null;
  }
}

function remember(repo: string, release: Release): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ key: repo, at: Date.now(), release }));
  } catch {
    /* see cached() */
  }
}

export function DownloadSection() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [copied, setCopied] = useState<string | null>(null);
  /** The visitor's platform, resolved independently of the release feed — it is known offline. */
  const [detected, setDetected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void detect().then((platform) => {
      if (!cancelled) setDetected(platform);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const repo = repoName();
    if (repo === null) {
      setState({
        status: "unavailable",
        reason: "The first release has not been published yet, so there is nothing to download here.",
      });
      return;
    }

    let cancelled = false;
    const unavailable = (reason: string): void => {
      if (!cancelled) setState({ status: "unavailable", reason });
    };

    const load = async (): Promise<void> => {
      let release = cached(repo);
      if (release === null) {
        try {
          const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { accept: "application/vnd.github+json" },
          });
          if (response.status === 404) return unavailable("No release has been published yet.");
          if (response.status === 403 || response.status === 429) {
            return unavailable(
              "GitHub is rate-limiting this network, so the file list could not be read."
            );
          }
          if (!response.ok) return unavailable("The release list could not be read just now.");
          release = (await response.json()) as Release;
          remember(repo, release);
        } catch {
          return unavailable("Could not reach GitHub to read the release list.");
        }
      }

      const assets = release.assets ?? [];
      const found = new Map<string, Asset>();
      for (const kind of KINDS) {
        const asset = assets.find((candidate) => kind.pattern.test(candidate.name ?? ""));
        if (asset !== undefined) found.set(key(kind), asset);
      }
      if (found.size === 0) {
        return unavailable("The latest release does not carry installers for macOS or Windows.");
      }

      if (!cancelled) setState({ status: "ready", release, found });
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = useCallback((value: string, id: string) => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(id);
        window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
      },
      () => {
        /* Clipboard denied. The checksum is selectable text; nothing else to do. */
      }
    );
  }, []);

  const repo = repoName();
  const releasesUrl = repo === null ? null : `https://github.com/${repo}/releases`;
  const version =
    state.status === "ready" ? (state.release.tag_name ?? "").replace(/^v/, "") : null;
  const published =
    state.status === "ready" && state.release.published_at !== undefined
      ? new Date(state.release.published_at).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;

  return (
    <Section id="download">
      <Container>
        <Reveal>
          {/* Heading left, metadata right — the arrangement every section head on this page uses,
              with the release's identity where a data sheet would put it. */}
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <Eyebrow>Download</Eyebrow>
              <SectionHeading className="max-w-none">
                Install it on your own machine.
              </SectionHeading>
            </div>
            <dl className="flex items-center gap-8">
              <div>
                <dt>
                  <MonoLabel>Version</MonoLabel>
                </dt>
                <dd className="mt-1 text-sm font-light tracking-tight text-ink">
                  {version ?? "—"}
                </dd>
              </div>
              <div>
                <dt>
                  <MonoLabel>Published</MonoLabel>
                </dt>
                <dd className="mt-1 text-sm font-light tracking-tight text-ink">
                  {published ?? "—"}
                </dd>
              </div>
              <div>
                <dt>
                  <MonoLabel>Licence</MonoLabel>
                </dt>
                <dd className="mt-1 text-sm font-light tracking-tight text-ink">Apache-2.0</dd>
              </div>
            </dl>
          </div>

          {/* FULL WIDTH, to the container's own margins. `Lead` and `SectionHeading` cap their
              measure for a paragraph that shares a row with something else; these two have the row
              to themselves, so the cap only left empty space to the right of every line. The
              container (`Container`) is what holds the gutter now — nothing here sets its own. */}
          <Lead className="max-w-none">
            The editor, the problems and the grader all run locally. An account is optional — it is
            needed only for the hosted VoidCode model and the credits that pay for it.
          </Lead>

          {/*
            THE PANELS ALWAYS RENDER. Which file a visitor needs, and what their operating system
            will do when they run an unsigned installer, are facts about the platform — not about
            whether a release happens to be published, or whether GitHub answered. Only the links,
            sizes and checksums come from the release feed, so only those parts change state. The
            first version hid all of it behind the feed, which meant the section said nothing at
            all until a release existed.
          */}
          <div className="mt-14 grid gap-6 lg:grid-cols-2">
            {PLATFORMS.map((platform) => {
              const kinds = KINDS.filter((kind) => kind.os === platform.os);
              const mine = detected !== null && detected.startsWith(`${platform.os}-`);
              const found = state.status === "ready" ? state.found : new Map<string, Asset>();
              const available = kinds.filter((kind) => found.has(key(kind)));
              const primaryKind =
                available.find((kind) => key(kind) === detected) ?? available[0] ?? null;
              const primary = primaryKind === null ? undefined : found.get(key(primaryKind));

              return (
                <div
                  key={platform.os}
                  className={[
                    "flex flex-col rounded-cta border bg-void-1 p-8 lg:p-10",
                    // The detected platform is emphasised by its border, not by colour or size:
                    // the other panel must stay a first-class choice for anyone the guess missed.
                    mine ? "border-line-strong" : "border-line",
                  ].join(" ")}
                >
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="text-xl font-light tracking-tight text-ink">{platform.title}</h3>
                    {mine ? <MonoLabel>Your system</MonoLabel> : null}
                  </div>

                  <p className="mt-4 text-sm leading-relaxed text-ink-2">{platform.what}</p>

                  {/* The download itself: a button when there is a file, and an honest sentence
                      when there is not. Never a button that leads nowhere. */}
                  <div className="mt-7">
                    {primary !== undefined && primaryKind !== null ? (
                      <>
                        <Pill href={primary.browser_download_url} variant="solid" size="lg">
                          Download for {platform.title}
                        </Pill>
                        <p className="mt-3 text-sm text-ink-3">
                          {primaryKind.label} · {formatSize(primary.size)} · {primaryKind.hint}
                        </p>
                      </>
                    ) : (
                      <>
                        <Pill href="#download" variant="outline" size="lg" aria-disabled="true">
                          {state.status === "loading" ? "Checking for a release…" : "No download yet"}
                        </Pill>
                        <p className="mt-3 max-w-[40ch] text-sm text-ink-3">
                          {state.status === "loading"
                            ? "Reading the latest release…"
                            : state.status === "unavailable"
                              ? state.reason
                              : `The latest release carries no ${platform.title} installer.`}
                        </p>
                      </>
                    )}
                  </div>

                  {/* Every file this platform gets, so the choice is visible whether or not the
                      feed answered: a size where one is known, and the architecture either way. */}
                  <ul className="mt-6 space-y-2 border-t border-line pt-6">
                    {kinds.map((kind) => {
                      const asset = found.get(key(kind));
                      return (
                        <li key={kind.arch} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          {asset === undefined ? (
                            <span className="text-sm text-ink-3">{kind.label}</span>
                          ) : (
                            <a
                              href={asset.browser_download_url}
                              className="text-sm text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
                            >
                              {kind.label}
                            </a>
                          )}
                          <MonoLabel>
                            {asset === undefined ? kind.file : formatSize(asset.size)}
                          </MonoLabel>
                          <span className="text-xs text-ink-3">{kind.hint}</span>
                        </li>
                      );
                    })}
                  </ul>

                  <p className="mt-6 text-xs leading-relaxed text-ink-3">{platform.which}</p>

                  {/* The install steps, numbered. Every visitor on an unsigned build meets their
                      platform's security prompt, and a step list is read where a paragraph is
                      skipped. */}
                  <ol className="mt-8 space-y-3 border-t border-line pt-7">
                    {platform.gate.map((step, index) => (
                      <li key={step} className="flex gap-3 text-sm leading-relaxed text-ink-2">
                        <MonoLabel className="mt-0.5 shrink-0 text-ink-3">
                          {String(index + 1).padStart(2, "0")}
                        </MonoLabel>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>

                  {/* Verifying is instructional whether or not a checksum is on the page yet, so
                      the command stays; the digests appear when the release carries them. */}
                  <div className="mt-8 border-t border-line pt-7">
                    <MonoLabel>Verify what you downloaded</MonoLabel>
                    <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-void-2 px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
                      {platform.verify}
                    </pre>
                    {available.length > 0 ? (
                      <ul className="mt-4 space-y-3">
                        {available.map((kind) => {
                          const asset = found.get(key(kind))!;
                          const hash = digestOf(asset);
                          const id = key(kind);
                          return (
                            <li key={id}>
                              <div className="flex items-baseline justify-between gap-3">
                                <MonoLabel>SHA-256 · {kind.label}</MonoLabel>
                                {hash === "" ? null : (
                                  <button
                                    type="button"
                                    onClick={() => copy(hash, id)}
                                    className="rounded text-[11px] text-ink-3 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
                                  >
                                    {copied === id ? "Copied" : "Copy"}
                                  </button>
                                )}
                              </div>
                              <p className="mt-1 break-all font-mono text-[11px] leading-relaxed text-ink-3">
                                {hash === "" ? "not published for this file" : hash}
                              </p>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="mt-3 text-xs leading-relaxed text-ink-3">
                        Each file&apos;s SHA-256 is listed here once a release is published. Compare
                        it with the command above before installing.
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {releasesUrl !== null ? (
            <p className="mt-10 text-sm text-ink-3">
              Linux builds (AppImage and .deb), older versions and the source are on{" "}
              <a
                href={releasesUrl}
                className="text-ink-2 underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink hover:decoration-ink"
              >
                the releases page
              </a>
              .
            </p>
          ) : null}
        </Reveal>
      </Container>
    </Section>
  );
}
