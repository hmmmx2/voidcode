/**
 * The `app://` scheme that serves the renderer.
 *
 * Spec §2.1 requires this instead of a localhost HTTP server. A dev server on
 * 127.0.0.1 is reachable by every other process on the machine — including any
 * other Electron app, any browser tab that guesses the port, and anything the
 * user is running from a terminal. `app://` has no port and no socket, so the
 * renderer bundle is not addressable from outside this process.
 *
 * It also makes the CSP and the `will-navigate` guard meaningful: there is a
 * single origin the renderer is ever allowed to be at.
 */
import { protocol, net } from "electron";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { resolveWithin } from "./paths.js";

export const APP_SCHEME = "app";
export const APP_ORIGIN = `${APP_SCHEME}://bundle`;

/**
 * Where the renderer bundle sits inside a packaged app, relative to `process.resourcesPath`.
 *
 * A constant rather than a literal at the use site because the same name is written down twice
 * — here, and as the `to:` of an `extraResources` entry in electron-builder.yml — and the two
 * are only correct together. When they disagreed (the copy was missing entirely), the app
 * started, opened a window, and served 404 for every route: no crash, no log line, nothing to
 * grep for. `tests/packaging.test.ts` reads the YAML and asserts it still matches this.
 */
export const PACKAGED_RENDERER_DIR = "renderer";

/**
 * Where the gathered licence text sits in a packaged app, relative to `process.resourcesPath`.
 *
 * Same reason as above — the name is written down twice, here and as an `extraResources` `to:` — and
 * the same consequence if they disagree, except quieter: Help ▸ Open Licences would open nothing, and
 * the distribution would be missing an Apache-2.0 §4(d) obligation with nothing to indicate it.
 */
export const PACKAGED_LICENSES_DIR = "licenses";

/**
 * The app icon, likewise.
 *
 * Worth being clear about what this is *not* for. The taskbar icon on Windows comes from the icon
 * embedded in the executable by electron-builder, and macOS reads the bundle's `.icns` — neither
 * consults `BrowserWindow`'s `icon`. This copy is what `windows.ts` passes to `BrowserWindow`, which
 * matters for the packaged Linux window icon and in development, where there is no bundle at all.
 */
export const PACKAGED_ICON = "icon.png";

/**
 * Must run before `app.whenReady()`.
 *
 * `standard: true` gives the scheme normal URL semantics (so relative paths and
 * `history.pushState` behave). `secure: true` makes it a trustworthy origin, so
 * the renderer is not treated as insecure context — without it, things like
 * `crypto.subtle` and service workers are unavailable and SameSite handling
 * differs.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // No `allowServiceWorkers`: nothing here needs one, and a service worker
        // would add a cache layer that outlives an app update.
      },
    },
  ]);
}

/**
 * Resolve a request path to a file inside `root`, or `undefined` if it escapes.
 *
 * Containment is delegated to `resolveWithin` so the `app://` handler and
 * workspace file access share one implementation of the check — see `paths.ts`
 * for why string comparison is not sufficient. Here an escape is folded into
 * `undefined` (becoming a 404) rather than surfaced, because a URL handler should
 * not tell a caller whether the path it probed exists but was forbidden.
 */
async function resolveWithinRoot(root: string, requestPath: string): Promise<string | undefined> {
  const decoded = decodeURIComponent(requestPath);
  // Strip the leading slash so this is treated as relative to the bundle; an
  // absolute path here would replace the root entirely.
  const relative = decoded.replace(/^\/+/, "") || "index.html";

  let real: string;
  try {
    real = await resolveWithin(root, relative);
  } catch {
    return undefined; // missing, or resolves outside the bundle
  }

  const stat = await fs.stat(real);
  if (stat.isDirectory()) {
    return resolveWithinRoot(root, path.posix.join(relative, "index.html"));
  }
  return real;
}

/**
 * Serve the renderer bundle from `rendererRoot`.
 *
 * Unknown paths fall back to a route shell so client-side routing works on a cold
 * load — but only after the traversal guard has run, so the fallback cannot be
 * used to smuggle a path through. See `resolveRoute` for the order it tries.
 */
export function handleAppScheme(rendererRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);

    // One origin only. `app://something-else/...` is not ours.
    if (url.host !== "bundle") {
      return new Response("Not found", { status: 404 });
    }

    const file = await resolveRoute(rendererRoot, url.pathname);

    if (file === undefined) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(file).toString());
  });
}

/**
 * The name every dynamic route must give its exported shell.
 *
 * Shared with every `[param]/page.tsx` under `renderer/src/app`, because `resolveRoute` looks the
 * directory up by this exact word and a route that picks a different one silently loses its
 * fallback. `tests/app-scheme.test.ts` asserts both halves still agree.
 */
export const SHELL_NAME = "placeholder";

/**
 * A request path to a file inside the bundle, or `undefined` for an honest 404.
 *
 * ## The fallback is restricted to navigations
 *
 * It used to apply to every unresolved path, which meant a missing script was answered with
 * `index.html`. The browser parsed HTML as JavaScript, threw `Unexpected token '<'`, and
 * hydration died — with no 404 anywhere to say what was actually missing. A fallback that hides
 * the failure it compensates for is worse than no fallback. So a path with a file extension is an
 * asset request and gets a 404; everything else is a route, and routes legitimately have no file
 * behind them because the slugs come from content rather than from the build.
 *
 * ## The sibling shell comes first, and that is the whole point
 *
 * A dynamic segment exports one shell, which is the correct answer for every sibling slug because
 * it reads the slug from `usePathname()`. Falling straight back to the root `index.html` instead
 * serves the *root* route, which redirects — so a cold load of a real slug lands somewhere else
 * entirely. Not a 404, not an error: the wrong page, rendered successfully.
 *
 * That has now happened twice. First for `/interviews/{slug}`, which is what this ordering was
 * introduced to fix. Then for `/problems/{id}`, which was not fixed by it, because that route
 * named its shell `1` instead of `placeholder` — so the lookup missed, the root answered, and
 * **every curriculum problem except the first opened the IDE.** Clicking a problem in the
 * catalogue looked like navigation, so nothing looked broken enough to investigate.
 *
 * Split out of the handler because it had no test. Both failures were in the arrangement between
 * this function and the routes it serves, which is exactly what a unit test over a fake tree can
 * hold still.
 */

export async function resolveRoute(
  rendererRoot: string,
  pathname: string
): Promise<string | undefined> {
  const direct = await resolveWithinRoot(rendererRoot, pathname);
  if (direct !== undefined) return direct;

  if (/\.[a-z0-9]+$/i.test(pathname)) return undefined;

  // No guard on `parent` being the root. `resolveWithinRoot` strips leading slashes, so `/x` asks
  // for the bundle-level shell and simply finds nothing today — and if a root-level dynamic route
  // is ever added, serving its shell is the right answer rather than a case to exclude. The guard
  // that used to be here was unobservable, which is how it read as protecting something.
  const shell = await resolveWithinRoot(rendererRoot, `${path.posix.dirname(pathname)}/${SHELL_NAME}`);
  if (shell !== undefined) return shell;

  return resolveWithinRoot(rendererRoot, "/index.html");
}
