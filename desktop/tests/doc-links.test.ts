/**
 * Markdown links across the repository resolve.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────────────────────
 *
 * `docs/OPEN_QUESTIONS.md` was linked from the README as "what is undecided" for long enough that the
 * most visible statement of this project's uncertainty was seven answers about a GPU it does not use —
 * ZeRO-2, DeepSpeed's `no_sync`, a PCIe link negotiated at 8x. The link worked perfectly. That is the
 * failure this cannot catch, and it is worth saying so at the top: a resolving link is the floor, not
 * the ceiling.
 *
 * What it does catch is the cheaper and more common one. Between the dead-code batch deleting four
 * renderer modules, `SUPERSEDED-SPECS.md` carrying forty-odd citations into a moving tree, and
 * `OPEN_QUESTIONS.md` being replaced wholesale, this repository now has enough cross-document
 * reference to rot quietly.
 *
 * **Scope, stated so it is not overestimated.** This checks `[text](target)` links only. Most
 * documents here cite paths in backticks instead, and those are checked for exactly one document —
 * `superseded-specs.test.ts` does it for `SUPERSEDED-SPECS.md` with a curated prefix list, because
 * telling a real path from a prose fragment in backticks needs per-document judgement. Generalising
 * that is a separate job; the measurement below says what this actually covers.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "..");

/** Directories that are not ours to check, or are build output. */
const SKIP = new Set(["node_modules", ".git", ".next", "out", "release", "dist", "vendor", "coverage"]);

function markdownFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      markdownFiles(path.join(dir, entry.name), found);
    } else if (entry.name.endsWith(".md")) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

interface Link {
  from: string;
  target: string;
}

/**
 * Every `[text](target)` whose target is a repository path.
 *
 * External URLs, `mailto:`, and bare anchors are all somebody else's problem: this checks that a file
 * we point at is a file we have. An anchor is stripped rather than followed — verifying `#section`
 * would mean modelling how each renderer slugifies headings, which is a different test with a much
 * worse false-positive rate.
 */
function repoLinks(): Link[] {
  const links: Link[] = [];
  for (const file of markdownFiles(repo)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const raw = match[1] as string;
      if (/^(https?:|mailto:|#|data:)/.test(raw)) continue;
      const target = (raw.split("#")[0] as string).trim();
      if (target === "") continue;
      links.push({ from: path.relative(repo, file).replace(/\\/g, "/"), target });
    }
  }
  return links;
}

describe("markdown links", () => {
  const links = repoLinks();

  it("finds enough links to be worth checking", () => {
    /**
     * Vacuity guard, with thresholds taken from a measurement rather than a guess — the first attempt
     * asserted "more than 15" and found 12, because most documents here cite with backticks rather
     * than links. Measured: **12 links across 2 files**, 10 of them in the README's document table.
     *
     * Both halves matter. A total floor catches a regex that stops matching; requiring the README's
     * share catches one that only matches some other file's style, which would leave the document
     * table — the thing that actually points readers anywhere — unchecked.
     */
    expect(links.length, "no markdown links found; the pattern has stopped matching").toBeGreaterThan(
      9
    );
    expect(links.filter((l) => l.from === "README.md").length).toBeGreaterThan(7);
  });

  it("point at files that exist", () => {
    const broken = links
      .filter(({ from, target }) => {
        const base = path.dirname(path.join(repo, from));
        return !fs.existsSync(path.resolve(base, target));
      })
      .map(({ from, target }) => `${from} -> ${target}`);

    expect([...new Set(broken)].sort(), "markdown links pointing at nothing").toEqual([]);
  });
});

/**
 * The two documents that exist to be found.
 *
 * Both were written because a question had been answered by a full repository audit more than once.
 * A document nobody is pointed at gets re-derived by audit, which is precisely the cost it was written
 * to remove — so being linked is part of what each one *is*, not decoration.
 */
describe("the documents that answer repeated questions are reachable", () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");

  it("points at the open questions and the superseded specs", () => {
    expect(readme).toContain("docs/OPEN_QUESTIONS.md");
    expect(readme).toContain("docs/SUPERSEDED-SPECS.md");
  });

  it("has open questions about this project rather than the retired one", () => {
    /**
     * The defect the replacement fixed, pinned in both directions. The file used to ask about
     * DeepSpeed, ZeRO-2 and NCCL bus bandwidth — real questions, about a branch that shares only the
     * initial commit with this one.
     */
    const questions = fs.readFileSync(path.join(repo, "docs/OPEN_QUESTIONS.md"), "utf8");

    // It must still name what it replaced, so the history is not simply erased…
    expect(questions).toMatch(/Q-001 . Q-007|Q-001 … Q-007/);
    // …but the questions themselves have to be this project's.
    for (const heading of [...questions.matchAll(/^## (Q-\d+ .+)$/gm)].map((m) => m[1] as string)) {
      expect(heading, `an open question about the retired project: ${heading}`).not.toMatch(
        /ZeRO|DeepSpeed|NCCL|PCIe|GPU|monorepo|RAM/i
      );
    }

    /**
     * And the signing questions are the ones the release path actually leaves open — asserted
     * **per section**, not against the file.
     *
     * `expect(questions).toMatch(/SignPath/)` was the first version and it survived gutting Q-001,
     * because the name still appeared in that question's own "settled by" line. This repository has
     * produced that mistake three times now: a term surviving in the prose that explains why the term
     * matters. Sections are the unit.
     */
    const section = (heading: RegExp): string => {
      const all = questions.split(/^## /m);
      const found = all.find((chunk) => heading.test(chunk));
      expect(found, `no section matching ${String(heading)}`).toBeDefined();
      return found as string;
    };

    expect(section(/Code signing on Windows/)).toMatch(/SignPath/);
    expect(section(/Notarisation on macOS/)).toMatch(/Apple Developer/);
    // The unsigned state is the premise of both, so it has to be stated rather than implied.
    expect(section(/Code signing on Windows/)).toMatch(/NotSigned|unsigned/i);
  });
});

/**
 * The governance files spec §4.3 asks for, and the one property that binds them.
 *
 * A list of filenames is a weak test on its own — `existsSync` four times proves nothing anyone
 * cares about. What makes it worth writing is the **single contact address**: `honest-copy.test.ts`
 * already asserts that the Privacy Policy and the Terms give exactly one between them, and a Code of
 * Conduct is the third document a person in trouble reads. Three documents naming three mailboxes for
 * one product is the defect that guard was built for, one file further out.
 */
describe("governance files", () => {
  const repoFile = (rel: string): string => fs.readFileSync(path.join(repo, rel), "utf8");

  /** Spec §4.3: "`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, DCO sign-off" and "`.nvmrc`". */
  const REQUIRED = ["CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", ".nvmrc"];

  it("exist", () => {
    const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(repo, rel)));
    expect(missing, "governance files spec §4.3 asks for").toEqual([]);
  });

  it("give one contact address between them, and it is the legal one", () => {
    /**
     * Derived from the legal components rather than pinned, so the address itself stays a decision
     * for a human while "there is exactly one" stays a property. Changing it means changing it in one
     * place and watching this fail until the others follow.
     */
    const legal = repoFile("desktop/renderer/src/components/Legal/PrivacyClient.tsx");
    const addresses = [...legal.matchAll(/mailto:([^"'\s>]+)/g)].map((m) => m[1] as string);
    expect(new Set(addresses).size, "the Privacy Policy names more than one address").toBe(1);
    const address = addresses[0] as string;

    /**
     * The Code of Conduct is the load-bearing one. The Contributor Covenant ships a
     * `[INSERT CONTACT METHOD]` placeholder, and a code of conduct that still contains it is worse
     * than none — it invites a report and then drops it.
     */
    const conduct = repoFile("CODE_OF_CONDUCT.md");
    expect(conduct, "the Covenant's contact placeholder was never filled in").not.toContain(
      "INSERT CONTACT METHOD"
    );
    expect(conduct).toContain(address);

    // And the security route, which said to use a GitHub button on a repository with no remote.
    expect(repoFile("SECURITY.md")).toContain(address);
  });

  it("keeps the Covenant's own attribution intact", () => {
    /**
     * It is CC BY 4.0 and reproduced verbatim, which is the licensed use — but only with the
     * attribution block it ships with. Filling in the contact placeholder is the one edit intended;
     * quietly dropping the credit is not.
     */
    const conduct = repoFile("CODE_OF_CONDUCT.md");
    expect(conduct).toContain("Contributor Covenant");
    expect(conduct).toContain("version 2.1");
    expect(conduct).toContain("https://www.contributor-covenant.org");
  });

  it("documents the release trade-offs rather than leaving them as omissions", () => {
    /**
     * The distinction this file exists for. Each row has to name a follow-up, or it is an omission
     * wearing a table's clothes — so the count of "Q-" references is what is asserted, not the prose.
     */
    const release = repoFile("docs/RELEASE.md");
    for (const subject of [/SignPath/, /notaris/i, /auto-update/i, /Flatpak/, /provenance/i]) {
      expect(subject.test(release), `RELEASE.md does not cover ${String(subject)}`).toBe(true);
    }
    // Every trade-off points at an open question that can actually be closed.
    const followUps = [...release.matchAll(/Q-\d{3}/g)].map((m) => m[0]);
    expect(new Set(followUps).size).toBeGreaterThan(4);

    // And it must not claim the workflows have run, because they have not.
    expect(release).toMatch(/never (run|executed)|unexecuted|no (git )?remote/i);
  });
});
