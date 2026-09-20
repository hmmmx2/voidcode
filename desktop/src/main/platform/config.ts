/**
 * Where the VoidCode platform is, and which build this is.
 *
 * WHY A BUILD-TIME CONSTANT AND NOT AN ENVIRONMENT VARIABLE
 *
 * The API address used to be `process.env.VOIDCODE_API_URL ?? "http://127.0.0.1:8020/v1"`, read in
 * three places. A packaged app has no environment a user sets, so every installed copy pointed at
 * loopback: sign-in and the hosted model could only ever work on a developer's machine. The address a
 * build talks to is decided when the build is made, so it is baked in then — `electron.vite.config.ts`
 * replaces `__VOIDCODE_BUILD__` with values from `VOIDCODE_BUILD_*` at build time.
 *
 * WHY THE OVERRIDE IS DEVELOPMENT-ONLY
 *
 * `VOIDCODE_API_URL` still works when running from source, so a developer can point at a local API.
 * In a packaged build it is ignored unless the build itself opted in (`allowOverride`): an
 * environment variable that redirects where a learner's password is sent is not something an
 * installed application should honour from whatever launched it.
 *
 * WHY A NON-LOOPBACK ADDRESS MUST BE HTTPS
 *
 * The password and the session token travel to this address. Plain http is accepted only for
 * 127.0.0.1, where it never leaves the machine; anything else that is not https is treated as not
 * configured rather than used.
 */
import { app } from "electron";

export interface BuildConfig {
  apiUrl: string | null;
  siteUrl: string | null;
  allowOverride: boolean;
}

declare const __VOIDCODE_BUILD__: BuildConfig | undefined;

const DEVELOPMENT_API = "http://127.0.0.1:8020/v1";

/** What was baked in. Empty under vitest, which defines nothing. */
export function buildConfig(): BuildConfig {
  const baked = typeof __VOIDCODE_BUILD__ === "undefined" ? undefined : __VOIDCODE_BUILD__;
  return {
    apiUrl: baked?.apiUrl ?? null,
    siteUrl: baked?.siteUrl ?? null,
    allowOverride: baked?.allowOverride === true,
  };
}

/**
 * Whether this process may be told where to connect by its environment.
 *
 * `app` is undefined under the unit-test Electron stub. Unknown is treated as packaged, because the
 * override is the thing that must never apply by accident — tests that need it set it explicitly
 * through `__setOverridesAllowed`.
 */
let overridesForced: boolean | undefined;

export function overridesAllowed(): boolean {
  if (overridesForced !== undefined) return overridesForced;
  const unpackaged = app !== undefined && app.isPackaged === false;
  return unpackaged || buildConfig().allowOverride;
}

/** Tests only. */
export function __setOverridesAllowed(value: boolean | undefined): void {
  overridesForced = value;
}

/** `https:`, or `http:` to 127.0.0.1 — the only addresses a credential may be sent to. */
export function isAcceptableApiBase(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && url.hostname === "127.0.0.1";
}

/**
 * The API base, without a trailing slash, or `null` when no acceptable address is configured.
 *
 * Precedence: the environment (only where overrides are allowed), then the baked-in address, then
 * loopback — but loopback only where overrides are allowed, so a packaged build with nothing baked in
 * reports "not configured" instead of quietly calling a port on the learner's machine.
 */
export function apiBase(): string | null {
  const fromEnv = overridesAllowed() ? process.env.VOIDCODE_API_URL : undefined;
  const candidate =
    (fromEnv !== undefined && fromEnv !== "" ? fromEnv : null) ??
    buildConfig().apiUrl ??
    (overridesAllowed() ? DEVELOPMENT_API : null);
  if (candidate === null || !isAcceptableApiBase(candidate)) return null;
  return candidate.replace(/\/+$/, "");
}

/** The public website — download page, legal pages, payment return pages — or `null`. */
export function siteUrl(): string | null {
  const fromEnv = overridesAllowed() ? process.env.VOIDCODE_SITE_URL : undefined;
  const candidate = (fromEnv !== undefined && fromEnv !== "" ? fromEnv : null) ?? buildConfig().siteUrl;
  if (candidate === null) return null;
  try {
    return new URL(candidate).protocol === "https:" || overridesAllowed()
      ? candidate.replace(/\/+$/, "")
      : null;
  } catch {
    return null;
  }
}

/*
 * `oauthClientId()` STOOD HERE, with a long note on why a client id is public and why `null` was a
 * supported state rather than a misconfiguration. Provider sign-in is removed and the function had
 * NO CALLERS -- `grep oauthClientId` found only its own definition. The build no longer bakes the
 * ids either; see `electron.vite.config.ts` for why the pair outlived the feature.
 */
