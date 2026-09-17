/*
 * The download list, read from the project's own releases.
 *
 * WHY THE PAGE ASKS GITHUB INSTEAD OF SHIPPING A FILE OF LINKS
 *
 * A committed list of versions, sizes and checksums is a second source of truth for the one thing
 * on this page that must not be wrong. It would be edited by hand after each release, by someone
 * who has just spent an hour on a release, and a stale checksum beside a fresh installer is worse
 * than no checksum at all. The release list is the record; this page reads it.
 *
 * Draft releases are excluded by `/releases/latest`, so publishing a release stays the deliberate,
 * human step that makes a build public.
 *
 * WHAT IT DOES WHEN IT CANNOT
 *
 * No repository configured, rate-limited (60 anonymous requests an hour per IP, which a shared
 * office network can exhaust), offline, or no release yet: the page says which of those happened
 * and, where there is one, links to the releases page. It never draws a download button that
 * leads nowhere — on a page whose entire job is handing someone an installer, a dead primary
 * action is the worst possible failure.
 *
 * NO FRAMEWORK, AND NO innerHTML. Everything below builds nodes and sets textContent, so a field
 * that arrives from the API can never be interpreted as markup on this page.
 */
(() => {
  "use strict";

  const CACHE_KEY = "voidcode:release";
  const CACHE_MS = 10 * 60 * 1000;

  /**
   * The files a release is expected to carry, in the order they are listed.
   *
   * Matched on the asset name from `electron-builder.yml`'s
   * `${productName}-${version}-${os}-${arch}.${ext}` — so `VoidCode-0.1.0-mac-arm64.dmg`. Keyed by
   * the platform the browser reports, and `arch` is what a person has to choose between.
   */
  const KINDS = [
    { os: "mac", arch: "arm64", label: "Apple silicon (M1 and later)", pattern: /-mac-arm64\.dmg$/ },
    { os: "mac", arch: "x64", label: "Intel", pattern: /-mac-x64\.dmg$/ },
    { os: "win", arch: "x64", label: "64-bit (most PCs)", pattern: /-win-x64\.exe$/ },
    { os: "win", arch: "arm64", label: "ARM (Snapdragon, Surface Pro X)", pattern: /-win-arm64\.exe$/ },
  ];

  const OS_TITLES = { mac: "macOS", win: "Windows" };

  const $ = (id) => document.getElementById(id);

  function repo() {
    const meta = document.querySelector('meta[name="voidcode:repo"]');
    const value = (meta && meta.getAttribute("content") || "").trim();
    // A placeholder is not a repository. Refusing anything that is not `owner/name` also keeps a
    // pasted URL from being interpolated into the API path.
    return /^[\w.-]+\/[\w.-]+$/.test(value) && value !== "OWNER/REPO" ? value : null;
  }

  function cached(key) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (raw === null) return null;
      const entry = JSON.parse(raw);
      if (entry.key !== key || Date.now() - entry.at > CACHE_MS) return null;
      return entry.release;
    } catch {
      // Private windows and blocked site data both throw here. Not having a cache is fine.
      return null;
    }
  }

  function remember(key, release) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ key, at: Date.now(), release }));
    } catch {
      /* see cached() */
    }
  }

  /** Bytes as a person would say them. Two significant figures is all a download size deserves. */
  function size(bytes) {
    if (typeof bytes !== "number" || !isFinite(bytes) || bytes <= 0) return "";
    const mb = bytes / 1024 / 1024;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
  }

  /**
   * The SHA-256 of an asset, when the API gives one.
   *
   * `asset.digest` arrives as `sha256:<hex>` on releases published since GitHub added it, and is
   * absent on older ones — hence the empty string rather than a guess. The install instructions
   * tell people what to compare it against.
   */
  function digest(asset) {
    const value = typeof asset.digest === "string" ? asset.digest : "";
    const match = /^sha256:([0-9a-f]{64})$/.exec(value);
    return match === null ? "" : match[1];
  }

  /**
   * Which download to put on the primary button.
   *
   * Client hints where they exist, because they are the only way to tell an ARM Windows PC from an
   * x64 one. On macOS the answer is deliberately NOT derived from the user agent: Safari and
   * Firefox report "Intel Mac OS X 10_15_7" on every Mac including Apple silicon, so the UA can
   * only ever say "a Mac". Apple silicon has been the only Mac sold since 2023, so it is the
   * default, and both files stay listed with the "Which Mac?" note beside them.
   */
  async function detect() {
    const ua = navigator.userAgent;
    const data = navigator.userAgentData;
    const platform = /Windows|Win32|Win64/.test(ua) ? "win" : /Mac/.test(ua) ? "mac" : null;

    if (platform === null) return null; // Linux, Android, iOS: no primary button, the table serves.

    let arch = platform === "mac" ? "arm64" : "x64";
    if (data && typeof data.getHighEntropyValues === "function") {
      try {
        const hints = await data.getHighEntropyValues(["architecture", "bitness"]);
        if (hints.architecture === "arm") arch = "arm64";
        else if (hints.architecture === "x86") arch = hints.bitness === "32" ? null : "x64";
      } catch {
        /* Hints are a courtesy; the default stands. */
      }
    }
    if (arch === null) return null; // 32-bit x86: nothing here runs on it.
    return { os: platform, arch };
  }

  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null && text !== "") node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function renderFiles(found, release, repoName) {
    const host = $("files");
    host.textContent = "";

    for (const os of ["mac", "win"]) {
      const rows = KINDS.filter((kind) => kind.os === os && found.has(kind.pattern));
      if (rows.length === 0) continue;

      host.appendChild(el("h3", OS_TITLES[os]));
      const scroller = el("div", null, "files");
      const table = document.createElement("table");
      const head = document.createElement("tr");
      for (const column of ["File", "Size", "SHA-256"]) head.appendChild(el("th", column));
      table.appendChild(head);

      for (const kind of rows) {
        const asset = found.get(kind.pattern);
        const row = document.createElement("tr");

        const first = document.createElement("td");
        const link = el("a", kind.label);
        link.href = asset.browser_download_url;
        first.appendChild(link);
        first.appendChild(document.createElement("br"));
        first.appendChild(el("span", asset.name, "small muted mono"));
        row.appendChild(first);

        row.appendChild(el("td", size(asset.size), "small"));

        const hash = digest(asset);
        row.appendChild(el("td", hash === "" ? "not published for this file" : hash, "hash"));
        table.appendChild(row);
      }

      scroller.appendChild(table);
      host.appendChild(scroller);
    }

    const note = $("release-note");
    note.textContent = `Version ${String(release.tag_name || "").replace(/^v/, "")}, published ${new Date(
      release.published_at,
    ).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}.`;

    const others = $("other-downloads");
    others.textContent = "Linux builds (AppImage and .deb), older versions and the source are on ";
    const link = el("a", "the releases page");
    link.href = `https://github.com/${repoName}/releases`;
    others.appendChild(link);
    others.appendChild(document.createTextNode("."));
  }

  function renderPrimary(choice, found) {
    const button = $("primary");
    const kind = choice === null ? null : KINDS.find((k) => k.os === choice.os && k.arch === choice.arch);
    const asset = kind === undefined || kind === null ? undefined : found.get(kind.pattern);

    if (asset === undefined) {
      // A platform we do not build for, or a release missing that file. The table is the answer.
      button.textContent = "See all downloads";
      button.href = "#download";
      button.removeAttribute("aria-disabled");
      button.dataset.state = "list";
      return;
    }

    button.textContent = `Download for ${OS_TITLES[kind.os]}`;
    button.href = asset.browser_download_url;
    button.removeAttribute("aria-disabled");
    button.dataset.state = "ready";

    const detail = [kind.label, size(asset.size)].filter(Boolean).join(" · ");
    $("primary-note").textContent = `${detail}. Free and open source, under the Apache License 2.0.`;
  }

  function fail(message, repoName) {
    const button = $("primary");
    button.textContent = "See all downloads";
    button.href = repoName === null ? "#download" : `https://github.com/${repoName}/releases`;
    button.removeAttribute("aria-disabled");
    button.dataset.state = "fallback";

    const note = $("release-note");
    note.textContent = message + " ";
    if (repoName !== null) {
      const link = el("a", "Open the releases page");
      link.href = `https://github.com/${repoName}/releases`;
      note.appendChild(link);
      note.appendChild(document.createTextNode("."));
    }
  }

  async function main() {
    const repoName = repo();
    if (repoName === null) {
      fail("The first release has not been published yet, so there is nothing to download from this page.", null);
      return;
    }

    let release = cached(repoName);
    if (release === null) {
      try {
        const response = await fetch(`https://api.github.com/repos/${repoName}/releases/latest`, {
          headers: { accept: "application/vnd.github+json" },
        });
        if (response.status === 404) {
          fail("No release has been published yet.", repoName);
          return;
        }
        if (response.status === 403 || response.status === 429) {
          fail("GitHub is rate-limiting this network, so the file list could not be read.", repoName);
          return;
        }
        if (!response.ok) {
          fail("The release list could not be read just now.", repoName);
          return;
        }
        release = await response.json();
        remember(repoName, release);
      } catch {
        fail("Could not reach GitHub to read the release list.", repoName);
        return;
      }
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const found = new Map();
    for (const kind of KINDS) {
      const asset = assets.find((candidate) => kind.pattern.test(String(candidate.name || "")));
      if (asset !== undefined) found.set(kind.pattern, asset);
    }

    if (found.size === 0) {
      fail("The latest release does not carry installers for macOS or Windows.", repoName);
      return;
    }

    renderFiles(found, release, repoName);
    renderPrimary(await detect(), found);
  }

  void main();
})();
