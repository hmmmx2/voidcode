/**
 * Which product a route belongs to, and which one it does not.
 *
 * Two claims are being protected here, both of which the app got wrong at some point:
 *
 * 1. **The IDE is the default.** It is the product; Interview Prep is a section of it. That
 *    shows up as rail order and as where an unrecognised route lands.
 * 2. **Account belongs to neither product.** It used to sit in Interview Prep's `match`, so
 *    editing your name lit the Interview Prep icon — the profile read as part of the
 *    curriculum. Moving it out exposed the opposite bug: `destinationForPath` must return
 *    something, its fallback is now the IDE, and so the account page reported itself as
 *    "Code" in the rail *and* in the status bar. `isAccountRoute` is what the shell checks
 *    before trusting the fallback.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DESTINATIONS,
  destinationForPath,
  isAccountRoute,
  isModelsRoute,
  isPlatformRoute,
} from "../renderer/src/lib/shell/destinations.js";

describe("the IDE is the main product", () => {
  it("puts Code first, which is what orders the rail", () => {
    expect(DESTINATIONS[0]?.id).toBe("code");
  });

  it("sends an unrecognised route to the IDE rather than the study app", () => {
    expect(destinationForPath("/some/route/that/does/not/exist").id).toBe("code");
  });

  it("still resolves each product's own routes", () => {
    expect(destinationForPath("/build").id).toBe("code");
    expect(destinationForPath("/problems").id).toBe("prep");
    // Longest match: a detail route belongs to the section it came from.
    expect(destinationForPath("/problems/stable-softmax").id).toBe("prep");
    expect(destinationForPath("/interviews").id).toBe("prep");
  });

  it("opens the app in the IDE", () => {
    // The redirect is one line in a client component, so it is read rather than rendered —
    // mounting it would mean mocking the router to observe the one thing being asserted.
    const root = readFileSync(new URL("../renderer/src/app/page.tsx", import.meta.url), "utf8");
    const code = root.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).toMatch(/router\.replace\(\s*["'`]\/build["'`]\s*\)/);
  });
});

describe("account is platform-level, not part of a product", () => {
  it("recognises the profile route", () => {
    expect(isAccountRoute("/profile")).toBe(true);
  });

  it("does not claim routes that merely start similarly", () => {
    expect(isAccountRoute("/problems")).toBe(false);
    expect(isAccountRoute("/build")).toBe(false);
    expect(isAccountRoute("/")).toBe(false);
  });

  it("is absent from every product's section list", () => {
    // The actual regression: Profile appeared as a row under Interview Prep.
    for (const destination of DESTINATIONS) {
      expect(destination.sections.map((s) => s.href)).not.toContain("/profile");
    }
  });

  it("is claimed by no product's match list", () => {
    for (const destination of DESTINATIONS) {
      expect(destination.match).not.toContain("/profile");
    }
  });

  it("gives the model manager the same treatment", () => {
    // Same reasoning, same failure if it regresses: /models under a destination would light
    // that product's icon and imply the models belong to it.
    for (const destination of DESTINATIONS) {
      expect(destination.match).not.toContain("/models");
      expect(destination.sections.map((s) => s.href)).not.toContain("/models");
    }
    expect(destinationForPath("/models").id).toBe("code");
    expect(isModelsRoute("/models")).toBe(true);
  });

  it("is the reason the shell cannot trust the fallback on /profile", () => {
    // Both halves matter. The fallback resolving to `code` is correct behaviour for an
    // unknown route — so the guard, not the fallback, is what keeps the rail honest. If this
    // ever returned something other than `code`, the guard in `Workbench` would still be
    // right but this test would stop describing why it exists.
    expect(destinationForPath("/profile").id).toBe("code");
    expect(isAccountRoute("/profile")).toBe(true);
  });
});

describe("the shell acts on that distinction", () => {
  const workbench = readFileSync(
    new URL("../renderer/src/components/Shell/Workbench.tsx", import.meta.url),
    "utf8"
  )
    // Comments first: the prose above these lines names both symbols, and matching that
    // would let a commented-out guard pass.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("lights no rail icon on a platform route", () => {
    /**
     * This used to read `active={onAccountRoute ? null : …}` and be asserted as source text.
     * A second platform route made that wrong: the rail's question is "does any product own
     * this", not "is this the account page", and answering it per-route means finding every
     * `||` when the third one lands.
     *
     * The regex is now scoped to the generalised guard, and the claim it was really making —
     * that platform routes light nothing — is asserted directly below, against behaviour
     * rather than against how the source happens to be written.
     */
    expect(workbench).toMatch(/active=\{\s*onPlatformRoute\s*\?\s*null\s*:/);
  });

  it("names the account in the status bar instead of a product", () => {
    expect(workbench).toMatch(/context=\{\s*onAccountRoute\s*\?\s*"Account"\s*:/);
  });

  it("derives the flag from the route, not from a piece of state that can drift", () => {
    expect(workbench).toMatch(/const onAccountRoute = isAccountRoute\(pathname\)/);
    expect(workbench).toMatch(/const onPlatformRoute = isPlatformRoute\(pathname\)/);
  });
});

/**
 * What the source regex above was really claiming, stated as behaviour.
 *
 * Pure calls, so these survive any rewrite of `Workbench.tsx` that keeps the meaning — which
 * is the whole difference between a test and a transcription of the code.
 */
describe("platform routes belong to no product", () => {
  it("recognises both of them", () => {
    expect(isPlatformRoute("/profile")).toBe(true);
    expect(isPlatformRoute("/models")).toBe(true);
  });

  it("claims no product route", () => {
    for (const path of ["/build", "/problems", "/homepage", "/interviews", "/projects", "/"]) {
      expect(isPlatformRoute(path), `${path} is a product route`).toBe(false);
    }
  });

  it("keeps the two apart, because the status bar names them differently", () => {
    expect(isAccountRoute("/models")).toBe(false);
    expect(isModelsRoute("/profile")).toBe(false);
  });

  it("covers nested paths under each", () => {
    expect(isPlatformRoute("/models/anything")).toBe(true);
    expect(isPlatformRoute("/profile/anything")).toBe(true);
  });
});

/**
 * Account stays reachable from the palette, which is the surface it nearly fell out of.
 *
 * The Go group is built from `DESTINATIONS`, and the registry sweep after it drops every
 * `go.*` id on the grounds that the destinations label them better. Account belongs to no
 * destination *and* is a `go.*` id, so it satisfies neither producer — it was silently absent
 * once, searching "account" returned No matches, and the only reason it had been there before
 * is that Profile used to be an Interview Prep section.
 */
describe("account survives the palette's two producers", () => {
  const workbench = readFileSync(
    new URL("../renderer/src/components/Shell/Workbench.tsx", import.meta.url),
    "utf8"
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("names it explicitly, since neither producer yields it", () => {
    // Scoped to the palette item rather than to the string "Account", which also appears in
    // the menu label and the status-bar guard — either would pass against a missing entry.
    expect(workbench).toMatch(/id: "go:account",\s*label: "Account"/);
  });

  it("names the model manager explicitly too", () => {
    // `go.models` satisfies neither palette producer for the same reason `go.account` did not:
    // the Go group is built from DESTINATIONS, and the registry sweep drops every `go.*` id.
    expect(workbench).toMatch(/id: "go:models",\s*label: "Models"/);
  });

  it("still excludes go.\* from the registry sweep, which is why the above is needed", () => {
    // If this filter ever goes away the explicit entry becomes a duplicate React key, which
    // the palette's own dev-mode check reports. Tying the two together here means whoever
    // removes the filter is told where to look.
    expect(workbench).toMatch(/!command\.id\.startsWith\("go\."\)/);
  });
});
