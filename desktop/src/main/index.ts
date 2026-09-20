/**
 * Main process entry.
 *
 * Order is load-bearing: the scheme must be registered as privileged before
 * `whenReady`, and the broker must be installed before any window exists, so
 * that no renderer can ever be live against an un-gated `ipcMain`.
 */
import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  registerAppScheme,
  handleAppScheme,
  APP_ORIGIN,
  PACKAGED_RENDERER_DIR,
} from "./protocol.js";
import { installBroker } from "./ipc/broker.js";
import { installQuitHandlers } from "./quit.js";
import { restoreSession, handleSecondInstance } from "./session/restore.js";
import { registerHandlers } from "./ipc/handlers/index.js";
import { createWindow } from "./windows.js";
import { captureShot } from "./smoke-capture.js";
import { installApplicationMenu } from "./menu.js";
import { openDatabase } from "./store/db.js";
import { onNotificationCreated, seedWelcomeNotification } from "./store/notifications.js";
import { setAccountBroadcaster } from "./account/session.js";
import { logInfo, logFile } from "./log.js";
import { installCrashHandlers, crashDumpDir } from "./crash.js";
import { startTelemetry, stopTelemetry } from "./hardware/telemetry.js";

/**
 * Crash handlers first, before anything that can crash.
 *
 * This call is at module scope for the same reason `registerAppScheme()` below is: inside `onReady`
 * it would miss every failure during startup, and it would leave the child processes started before
 * it uninstrumented. `crash.ts` holds the reasoning and the four handlers, which used to be written
 * out here and were therefore the only error handling in main with no test — importing this file
 * takes the instance lock and calls `whenReady`, so there was nothing a test could hold.
 */
installCrashHandlers();

// Both of these must happen before the app is ready, so they sit at module top
// rather than inside `onReady`. Registering the scheme late silently does nothing,
// and enabling the sandbox late leaves already-created windows unsandboxed.
//
// `enableSandbox` makes the sandbox the default for every window rather than
// relying on each `BrowserWindow` call to opt in — so a window created later
// without the full `securePreferences` block still gets it.
app.enableSandbox();

/**
 * Under the smoke, on Linux, pick a credential-store backend that exists.
 *
 * SMOKE-ONLY AND LINUX-ONLY, and both halves are deliberate. A headless CI runner has no keyring,
 * so `safeStorage.isEncryptionAvailable()` is false, `vault.ts` raises
 * `EncryptionUnavailableError` — correctly; that refusal is the product behaviour — and the smoke's
 * `build/vault` check threw. Worse than the one failure: a throw inside `runBuildSmoke` skips every
 * check after it, which is why the Linux runner never reported the agent failure its siblings did.
 *
 * `--password-store=basic` was passed on the command line first and did not take effect. Rather
 * than keep guessing at where Electron parses a switch that arrives after the script path, it is
 * set here, before `app` is ready, which is the documented place for it. `basic_text` is a backend
 * `inference/vault.ts` handles on purpose: `backendIsDurable()` names it as one it can vouch
 * against, so the secret is kept for the launch only and `storedDurably` comes back false — exactly
 * what the smoke already tolerates off Windows and macOS.
 *
 * OPT-IN BY ENVIRONMENT, so no installed build is ever quietly downgraded to a plaintext store. A
 * real user with no keyring keeps the refusal and the sentence explaining it.
 *
 * TWO VARIABLES, and the second is not redundant. `VOIDCODE_SMOKE` covers `npm run smoke`.
 * `scripts/account-e2e.mjs` cannot use it: `VOIDCODE_SMOKE` also changes session restoration and
 * opens a scripted window, and that harness exists to exercise the REAL sign-in — so it needs the
 * credential store without any of the rest. It signs in through `safeStorage` by design, on a
 * headless Linux runner with no keyring, which is exactly the refusal this switch answers.
 *
 * Named for what it does rather than for who needs it, because the next caller will not be a smoke
 * either. A person who sets it gets session-only storage, which the app already handles and reports
 * honestly through `storedDurably`.
 */
if (
  process.platform === "linux" &&
  (process.env.VOIDCODE_SMOKE === "1" || process.env.VOIDCODE_PASSWORD_STORE_BASIC === "1")
) {
  app.commandLine.appendSwitch("password-store", "basic");
}

registerAppScheme();

/**
 * One instance, so two copies cannot race on the SQLite file.
 *
 * `better-sqlite3` in WAL mode tolerates concurrent readers but a second app
 * instance would also start a second Pyodide worker pool and a second model
 * pull, which is confusing rather than dangerous. Fail early instead.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A second launch focuses the running app, and opens a folder it named ONLY if the user has
  // already granted that folder through a dialog. `voidcode.exe C:\somewhere` from a
  // shortcut is not the same authorisation as picking it — see `projectFromArgv`.
  app.on("second-instance", (_event, argv) => handleSecondInstance(argv));

  void app.whenReady().then(onReady);
}

async function onReady(): Promise<void> {
  // The renderer is the real VoidCode app, built by Next as a static export
  // (`renderer/out`). It is not produced by electron-vite, so the path is relative to the
  // project rather than to the main bundle — and packaging has to copy it explicitly, which
  // is what `PACKAGED_RENDERER_DIR` and the `extraResources` entry beside it are for.
  const rendererRoot = app.isPackaged
    ? path.join(process.resourcesPath, PACKAGED_RENDERER_DIR)
    : path.join(__dirname, "..", "..", "renderer", "out");
  handleAppScheme(rendererRoot);

  applyContentSecurityPolicy();

  installBroker();
  registerHandlers();

  /**
   * One line per launch, naming the file it is writing to.
   *
   * It marks a session boundary — without it, a log covering three launches reads as one long
   * run, and "it broke after restarting" is unanswerable. It also means the path is in the
   * file itself, so anyone handed the log knows where it came from.
   *
   * `crashDumps` is here for the same reason: a process that dies leaves a minidump rather than a log
   * line, and a minidump nobody can find is not a diagnostic. This is the one place both paths appear
   * together. It is reported here rather than in `installCrashHandlers` because `app.getPath` is only
   * reliable once the app is ready, and that call runs before.
   */
  logInfo("main", `VoidCode ${app.getVersion()} started`, {
    logFile: logFile(),
    crashDumps: crashDumpDir(),
    electron: process.versions.electron,
    platform: process.platform,
  });

  /**
   * Notifications, pushed to every live window.
   *
   * The web fanned these out through Redis pub/sub so an event raised on one node reached a
   * client connected to another. Here the only distance is main to renderer, so this is the
   * whole of that mechanism.
   *
   * Broadcast rather than addressed to the window that caused it: a notification is about
   * the user, not about a request, and the badge has to be right in whichever window they
   * are looking at.
   */
  onNotificationCreated((notification) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("notifications:new", notification);
    }
  });

  /**
   * The account, pushed to every window the moment it changes.
   *
   * Broadcast for the reason notifications are: whether someone is signed in is a property of the
   * application, not of a window. A session that ended on the server is often discovered by a
   * request in one window while the account menu is open in another.
   */
  setAccountBroadcaster((event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("account:changed", event);
    }
  });

  /**
   * Live hardware load, pushed to every window.
   *
   * `hw:telemetry` has existed as a channel name since the spec and had no sender — the
   * preload subscribed to an event nothing emitted, which is why the subscription was deleted
   * rather than left standing. This is the other half arriving: `startTelemetry` measures CPU
   * by differencing `os.cpus()`, RAM from `os.freemem()`, and GPU utilisation from
   * `nvidia-smi`, emitting null for anything the machine does not report.
   *
   * Broadcast for the same reason notifications are: the load is a property of the machine,
   * not of a request, and the status bar has to be right in whichever window is in front.
   *
   * Started once, unconditionally. The poller is two array reads a second plus an nvidia-smi
   * every third tick, it never overlaps itself, and its interval is unref'd so it cannot hold
   * the process open at quit.
   */
  startTelemetry((sample) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send("hw:telemetry", sample);
    }
  });

  // The database is opened here rather than lazily on first use, because the welcome
  // notification has to be decided before any window can ask for the list — otherwise the
  // bell renders empty and gains a row a moment later for no visible reason.
  openDatabase();
  seedWelcomeNotification();

  // The normal window is the whole app: study surfaces and the IDE in one place.
  //
  // `--mode=study` opts into a restricted window that cannot reach `fs:*` at all — for a
  // classroom or kiosk deployment where the machine is not the user's own. It is still
  // enforced by the broker and still tested; it is just not what ships by default.
  const startMode = process.argv.includes("--mode=study") ? "study" : "build";

  /**
   * Last session first, a fresh window only if there was nothing to bring back.
   *
   * Skipped entirely under the smoke, which needs one window at a known route rather than
   * whatever the developer happened to have open — and whose database is in-memory anyway, so
   * there would be nothing to restore.
   *
   * `--mode=study` also skips it: that flag asks for a restricted window, and restoring a
   * remembered Build window would quietly hand back the privileges it was invoked to withhold.
   */
  const restored =
    process.env.VOIDCODE_SMOKE === "1" || startMode === "study" ? 0 : restoreSession();

  const first = BrowserWindow.getAllWindows()[0] ?? createWindow({ mode: startMode });
  if (restored > 0) console.log(`[session] restored ${restored} window(s)`);

  installApplicationMenu();

  // Headless verification of the preload barrier (spec §2.2). Unit tests cover the
  // broker gate, but only a real sandboxed window can show what the preload
  // actually exposed. Run via `npm run smoke`; CI uses it as the runtime half of
  // the Phase 1 exit criterion.
  if (process.env.VOIDCODE_SMOKE === "1") {
    await runSmokeChecks(first);
    return;
  }

  /**
   * Derive an answer key so a newly authored item can record one.
   *
   * Electron rather than a script, and not by choice: `runInSandbox` uses `utilityProcess`
   * (`exec/host.ts`), which is an Electron API, so no plain-Node tool can execute a reference. The
   * mode sits here beside the smoke for the same reason the smoke does.
   *
   * With an id, it prints the derived key for that problem to paste into `derivedKey`. With no
   * argument it checks every recorded snapshot against what the sandbox produces now — which is
   * what stops the snapshot rotting into a second stale mirror. D0's lesson was that a generated
   * artefact with no runner becomes a lie; this is the runner.
   */
  if (process.env.VOIDCODE_DERIVE !== undefined) {
    await runDeriveKey(process.env.VOIDCODE_DERIVE);
    return;
  }

  app.on("activate", () => {
    // macOS: dock click with no windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow({ mode: startMode });
    }
  });
}

/**
 * CSP, applied as a response header rather than a meta tag so the renderer
 * cannot weaken it by editing its own DOM.
 *
 * `script-src 'self'` with no `'unsafe-eval'` is the important line (spec §2.1).
 * It is also why Monaco needs care later: Monaco's default worker loading path
 * wants a blob: URL, so Build Mode will need workers served from `app://`
 * instead. Better to hit that in Phase 7 with the policy already tight than to
 * ship `'unsafe-eval'` and try to remove it afterwards.
 *
 * `connect-src` allows loopback because the daemons live there (spec §2.7).
 * `img-src data:` is for generated visualiser assets. No `remote` origins: paper
 * PDFs are fetched by main and served locally, never loaded cross-origin by the
 * renderer.
 */
function applyContentSecurityPolicy(): void {
  const csp = [
    "default-src 'none'",
    /**
     * `'unsafe-inline'` is required, and this is the one place it is worth arguing for.
     *
     * Next's static export hydrates through inline bootstrap scripts — the flight payload
     * and the chunk manifest. With a bare `script-src 'self'` Chromium blocks all of them,
     * React never mounts, `#root` is never created, and the page renders as the bare
     * server-rendered shell with no error attributable to any of our code. That is exactly
     * what happened, and it cost several wrong diagnoses because nothing in the app was
     * running to report anything.
     *
     * A nonce is the correct fix and is not available: `output: "export"` writes the HTML
     * at build time, so there is no per-response value to stamp into it. Hashes are
     * theoretically possible but would have to be recomputed on every build and would
     * break silently when they drift.
     *
     * What this does *not* weaken: `'unsafe-eval'` is still absent, so no string-to-code
     * evaluation. Scripts still cannot be loaded from any remote origin — `'self'` is
     * `app://bundle`, and there is no network origin in the policy at all. The renderer is
     * still sandboxed with contextIsolation and no nodeIntegration. The realistic attack
     * this would open — injecting an inline script through content — is instead handled by
     * the fact that paper text and model output are rendered as text, never as HTML.
     */
    "script-src 'self' 'unsafe-inline'",
    // Inline styles only. Vite injects a style element in dev; tightening this
    // to a nonce is a Phase 5 task once the design system is settled.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });

  /**
   * Deny every device permission outright.
   *
   * Nothing in either mode needs camera, microphone, geolocation or
   * notifications. An app that reads untrusted paper content and runs untrusted
   * model output should not have a permission prompt available to social-engineer
   * the user with.
   */
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  // A renderer pinned to app:// has no legitimate reason to ask.
  session.defaultSession.setPermissionCheckHandler((_wc, _permission, origin) => {
    return origin === APP_ORIGIN && false;
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Registered at module scope, beside `window-all-closed`, because `before-quit` can fire
// before `whenReady` resolves — a shutdown during startup is rare and losing work to it would
// be indistinguishable from a crash.
installQuitHandlers();

/**
 * Assert, inside a live Study window, that the preload exposed only what it should.
 *
 * This is the half the unit tests cannot reach: `tests/mode-gate.test.ts` proves the
 * broker denies `fs:*`, but the preload's promise is stronger — in a Study window
 * those namespaces are not merely denied, they are absent. Only a real sandboxed
 * renderer can confirm that, because it depends on `additionalArguments` reaching
 * the preload and on `contextBridge` behaving as expected.
 *
 * Exits non-zero on failure so CI treats it as a test.
 */
/**
 * `VOIDCODE_DERIVE=<problem id>` — print a derived answer key. Empty value — audit every snapshot.
 *
 * The authoring loop for interview content. Exits non-zero on a mismatch so it can be a check as
 * well as a tool.
 */
async function runDeriveKey(target: string): Promise<void> {
  const { derivedKeyOrReason } = await import("./exec/grader.js");
  const { INTERVIEW_PROBLEMS } = await import("./content/interview-problems.js");

  const wanted = target.trim();
  const entries =
    wanted === ""
      ? INTERVIEW_PROBLEMS.filter((e) => e.derivedKey !== undefined)
      : INTERVIEW_PROBLEMS.filter((e) => e.problem.id === wanted);

  if (entries.length === 0) {
    console.error(
      wanted === ""
        ? "[derive] no item records a derivedKey yet. Pass an id to produce one."
        : `[derive] no interview problem with id ${wanted}. Ids look like iq-<question-slug>.`
    );
    app.exit(1);
    return;
  }

  let mismatched = 0;
  for (const entry of entries) {
    const result = await derivedKeyOrReason(entry.problem);
    if ("broken" in result) {
      console.error(`[derive] ${entry.problem.id}: reference did not run — ${result.broken}`);
      mismatched += 1;
      continue;
    }

    if (wanted !== "") {
      // Printed as the literal to paste, because retyping a key by hand is the thing this exists
      // to avoid.
      console.log(`[derive] ${entry.problem.id} — paste this as \`derivedKey\`:`);
      console.log(`      derivedKey: ${JSON.stringify(result.key)},`);
      entry.problem.cases.forEach((problemCase, index) => {
        console.log(`        // ${problemCase.id}: ${result.key[index] ?? ""}`);
      });
      continue;
    }

    const snapshot = entry.derivedKey ?? [];
    const drifted = result.key.some((value, index) => value !== snapshot[index]);
    if (drifted || snapshot.length !== result.key.length) {
      mismatched += 1;
      console.error(`[derive] ${entry.problem.id}: snapshot is stale`);
      console.error(`         recorded: ${JSON.stringify(snapshot)}`);
      console.error(`         derived:  ${JSON.stringify(result.key)}`);
    }
  }

  if (wanted === "") {
    console.log(
      `[derive] audited ${entries.length} snapshot(s); ${mismatched} stale`
    );
  }
  app.exit(mismatched === 0 ? 0 : 1);
}

async function runSmokeChecks(window: Electron.BrowserWindow): Promise<void> {
  const failures: string[] = [];

  try {
    await window.webContents.executeJavaScript("1"); // wait for a live context

    const report = (await window.webContents.executeJavaScript(`
      (() => {
        const h = window.host;
        return {
          hasHost: typeof h === "object" && h !== null,
          windowMode: h?.windowMode ?? null,
          namespaces: Object.keys(h ?? {}).sort(),
          fsAbsent: h?.fs === undefined,
          ptyAbsent: h?.pty === undefined,
          lspAbsent: h?.lsp === undefined,
          vaultHasNoGetter: typeof h?.vault?.get === "undefined",
          modeGetIsFunction: typeof h?.mode?.get === "function",
          noIpcRenderer: typeof window.require === "undefined" &&
                         typeof window.ipcRenderer === "undefined",
        };
      })()
    `)) as Record<string, unknown>;

    const expect = (label: string, actual: unknown, wanted: unknown) => {
      if (actual !== wanted) failures.push(`${label}: expected ${String(wanted)}, got ${String(actual)}`);
    };

    // The default window is the whole app now — study surfaces and the IDE together — so
    // this one is expected to hold the privileged namespaces. The restricted window is
    // asserted separately in `runRestrictedWindowSmoke`, and that pairing is the actual
    // claim: asserting only one side would pass just as happily if the gate did nothing.
    expect("host exposed", report.hasHost, true);
    expect("windowMode", report.windowMode, "build");
    expect("fs present in the unified window", report.fsAbsent, false);
    expect("vault has no getter", report.vaultHasNoGetter, true);
    expect("mode.get present", report.modeGetIsFunction, true);
    expect("no ipcRenderer in page", report.noIpcRenderer, true);

    // The authoritative answer must agree with argv.
    const viaIpc = (await window.webContents.executeJavaScript(
      "window.host.mode.get().then(r => r.mode)"
    )) as string;
    expect("mode:get agrees with argv", viaIpc, "build");

    console.log(`[smoke] namespaces in the unified window: ${(report.namespaces as string[]).join(" ")}`);
  } catch (err) {
    failures.push(`threw: ${(err as Error).message}`);
  }

  if (failures.length > 0) {
    console.error("[smoke] FAILED");
    for (const f of failures) console.error(`  - ${f}`);
    app.exit(1);
    return;
  }

  failures.push(...(await runExecSmoke()));
  failures.push(...(await runHardwareSmoke()));
  failures.push(...(await runStoreSmoke()));
  failures.push(...(await runRestrictedWindowSmoke()));
  failures.push(...(await runTransportSmoke(window)));
  failures.push(...(await runSignedOutSmoke(window)));
  // AFTER the signed-out check, never before: that one asserts a count of zero requests, and
  // this one deliberately puts a session in place.
  failures.push(...(await runSignedInSmoke(window)));
  failures.push(...(await runBuildSmoke()));

  if (failures.length > 0) {
    console.error("[smoke] FAILED");
    for (const f of failures) console.error(`  - ${f}`);
    app.exit(1);
    return;
  }

  console.log("[smoke] PASS — privilege boundary, Tier A execution, Build Mode");
  app.exit(0);
}

/**
 * Signed out, the app does not contact our server — checked in the real app, against a real listener.
 *
 * The Privacy Policy's founding sentence is "An account is optional, and without one the application
 * runs entirely on your machine". Unit tests prove each module short-circuits; only the running app
 * can show that nothing ELSE does — a provider probe on startup, a Models page fetching a balance, a
 * refresh on focus. So a loopback server stands in for the API, the app is pointed at it, and every
 * request it receives is counted while the signed-out app starts up and renders `/models`.
 *
 * The positive control matters as much as the zero: one sign-in attempt must arrive. Without it, a
 * wrong port or an unread environment variable would count zero for the wrong reason.
 */
async function runSignedOutSmoke(window: Electron.BrowserWindow): Promise<string[]> {
  const failures: string[] = [];
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ detail: "Invalid email or password." }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const previous = process.env.VOIDCODE_API_URL;
  process.env.VOIDCODE_API_URL = `http://127.0.0.1:${port}/v1`;
  /**
   * Cleared for the duration, and not merely assumed absent.
   *
   * The two client-id variables were saved and deleted here, so a developer who had them set to
   * drive the provider flow by hand did not get a real browser window on every `npm run smoke`.
   * The provider check they protected is gone, nothing reads those variables any more, and
   * `oauthClientId()` -- their only consumer -- had no callers.
   */

  try {
    await window.loadURL(`${APP_ORIGIN}/models`);
    const state = (await window.webContents.executeJavaScript(`
      (async () => {
        const session = await window.host.account.session();
        const refreshed = await window.host.account.refresh();
        const providers = await window.host.providers.list();
        const credits = await window.host.voidcode.credits();
        // Long enough for the Models page's own effects — provider probes, the account card — to run.
        await new Promise((r) => setTimeout(r, 1500));
        return {
          signedIn: session.signedIn,
          refreshedSignedIn: refreshed.signedIn,
          providers: Array.isArray(providers) ? providers.length : Array.isArray(providers?.providers) ? providers.providers.length : -1,
          creditsOk: credits.ok,
          signInButton: [...document.querySelectorAll("button")].some((b) => /sign in to use the voidcode model/i.test(b.textContent ?? "")),
        };
      })()
    `)) as { signedIn: boolean; refreshedSignedIn: boolean; providers: number; creditsOk: boolean; signInButton: boolean };

    if (state.signedIn || state.refreshedSignedIn) failures.push("signed-out: a fresh profile reported a session");
    // Only reachable providers are listed, so an empty list is fine on a machine with no Ollama. What
    // matters is that the call ran: it asks every provider, the hosted one included, if it is available.
    if (state.providers < 0) failures.push("signed-out: providers:list did not answer with a list");
    if (state.creditsOk) failures.push("signed-out: credits answered ok with no session");
    if (!state.signInButton) failures.push("signed-out: /models did not render the VoidCode sign-in call to action");
    if (hits.length !== 0) {
      failures.push(`signed-out: the app contacted the API ${hits.length} time(s) with nobody signed in: ${hits.join(", ")}`);
    }

    /**
     * A PROVIDER SIGN-IN BLOCK STOOD HERE, and what it guarded is now guarded by there being no
     * channel at all.
     *
     * It called `account.providers()`, `account.signInOAuth({provider:"google"})` and
     * `account.cancelOAuth()` through the broker, asserting that a build with no client ids
     * answered `not_configured` and opened nothing. Its reason for living here rather than in a
     * unit test was that `account:signInOAuth` was the ONE path from a renderer to
     * `shell.openExternal` in this application, and unit tests call the module directly.
     *
     * All four `account:*OAuth` channels are removed from the contract, so the generated preload
     * exposes no such method and the broker would refuse the name. `research:openPdf` is now the
     * only renderer-reachable `shell.openExternal`, and it takes a slug rather than an address —
     * see its note in `contract.ts`. `ipc-callers.test.ts` holds the declared set to the contract,
     * which is what would notice a provider channel being declared again.
     */

    // Positive control: an explicit sign-in is the first request, and it arrives.
    const signIn = (await window.webContents.executeJavaScript(
      `window.host.account.signInPassword({ email: "smoke@example.com", password: "not-a-real-password" })`
    )) as { ok: boolean };
    if (signIn.ok) failures.push("signed-out: a rejected sign-in reported success");
    if (hits.length !== 1 || hits[0] !== "POST /v1/auth/desktop/session") {
      failures.push(`signed-out: expected exactly the sign-in request, got [${hits.join(", ")}]`);
    }

    console.log(`[smoke] signed out: ${hits.length - 1} request(s) before sign-in; control request arrived`);
  } catch (err) {
    failures.push(`signed-out smoke threw: ${(err as Error).message}`);
  } finally {
    if (previous === undefined) delete process.env.VOIDCODE_API_URL;
    else process.env.VOIDCODE_API_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return failures;
}

/**
 * Signed in, against a stand-in API: the account and credits pages, rendered and photographed.
 *
 * WHY THIS EXISTS AS A SMOKE AND NOT AS A UNIT TEST. The credits page is a balance, a pack list, a
 * voucher form and a table of movements, and every one of those is a round trip: renderer to IPC to
 * main to HTTP and back. The unit tests cover each leg; nothing else covers them composed, with a
 * real session token in the real credential store and a real Next bundle doing the rendering. Two
 * bugs of this shape a unit test cannot catch: a channel that answers correctly beside a component
 * that reads the wrong field off it, and a table that is in the DOM with no height.
 *
 * `/account` is captured here too, signed in, because its sign-in methods list exists only in that
 * state — the signed-out screenshots cannot reach it at all.
 *
 * THE API IS A LOOPBACK SERVER WITH FIXED ANSWERS. No Postgres, no Stripe, no payment: the point is
 * what the application does with a wallet, and fixing the figures is what lets the assertions below
 * name them.
 */
async function runSignedInSmoke(window: Electron.BrowserWindow): Promise<string[]> {
  const failures: string[] = [];

  // Chosen to be checkable on sight: one grant of 1,200 credits and three charges of 0.02, plus a
  // hold and a release that must NOT appear as rows.
  const LEDGER = [
    { id: 106, type: "release", amountMicro: 0, balanceAfterMicro: 1_204_940_000, reservationId: "r-3", createdAt: "2026-09-18T09:05:00+00:00" },
    { id: 105, type: "charge", amountMicro: -20_000, balanceAfterMicro: 1_204_940_000, reservationId: "r-3", createdAt: "2026-09-18T09:05:00+00:00" },
    { id: 104, type: "hold", amountMicro: 0, balanceAfterMicro: 1_204_960_000, reservationId: "r-3", createdAt: "2026-09-18T09:04:00+00:00" },
    { id: 103, type: "charge", amountMicro: -20_000, balanceAfterMicro: 1_204_960_000, reservationId: "r-2", createdAt: "2026-09-18T08:30:00+00:00" },
    { id: 102, type: "charge", amountMicro: -20_000, balanceAfterMicro: 1_204_980_000, reservationId: "r-1", createdAt: "2026-09-17T21:12:00+00:00" },
    { id: 101, type: "grant", amountMicro: 1_200_000_000, balanceAfterMicro: 1_205_000_000, reservationId: null, createdAt: "2026-09-17T20:58:00+00:00" },
  ];
  /** Movements only: a hold and a release change no balance, so the page must not list them. */
  const MOVEMENTS = LEDGER.filter((row) => row.amountMicro !== 0).length;

  /**
   * Two papers, one of them part-read, and four breakdowns each.
   *
   * `pdfUrl` is a real arXiv address and the smoke never clicks "Open PDF": doing so would open a
   * browser on whoever ran this. What the guard does with an address it should refuse is covered
   * exhaustively in `research.test.ts`, against five shapes this fixture cannot produce.
   */
  const SECTIONS = ["architecture", "implementation", "systems", "mathematics"];
  const PAPERS = [
    {
      slug: "attention-is-all-you-need",
      title: "Attention Is All You Need",
      authors: "Vaswani et al.",
      year: 2017,
      venue: "NeurIPS",
      arxivId: "1706.03762",
      abstract: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.",
      difficulty: "hard",
      categories: ["transformers"],
      orderIndex: 0,
      relatedProblemSlugs: ["scaled-dot-product-attention"],
      sectionsRead: ["architecture"],
      sectionCount: 4,
      completedAt: null,
    },
    {
      slug: "layer-normalization",
      title: "Layer Normalization",
      authors: "Ba, Kiros and Hinton",
      year: 2016,
      venue: null,
      arxivId: "1607.06450",
      abstract: "Training state-of-the-art, deep neural networks is computationally expensive.",
      difficulty: "medium",
      categories: ["normalisation"],
      orderIndex: 1,
      relatedProblemSlugs: ["layer-norm"],
      sectionsRead: [],
      sectionCount: 4,
      completedAt: null,
    },
  ];
  /** Every section the reader POSTs, so the smoke can assert the marking actually reaches main. */
  const marked: string[] = [];

  const server = createServer((request, response) => {
    const route = (request.url ?? "").split("?")[0] ?? "";
    const send = (body: unknown, status = 200): void => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (route === "/v1/auth/me") {
      send({
        id: "u-smoke",
        email: "learner@example.test",
        name: "Smoke Learner",
        has_password: true,
        email_verified: true,
        providers: [],
        created_at: "2026-09-01T00:00:00Z",
      });
    } else if (route === "/v1/credits") {
      send({
        balanceMicro: 1_204_940_000,
        reservedMicro: 0,
        availableMicro: 1_204_940_000,
        availableCredits: 1204,
        estimatedMinutes: 120,
        rateMicroPerSlotSecond: 1000,
      });
    } else if (route === "/v1/credits/packs") {
      send({
        packs: [
          { code: "my-starter-20", label: "Starter", priceDisplay: "RM20.00", credits: 1200 },
          { code: "my-regular-50", label: "Regular", priceDisplay: "RM50.00", credits: 3300 },
          { code: "my-heavy-100", label: "Heavy", priceDisplay: "RM100.00", credits: 7000 },
        ],
      });
    } else if (route === "/v1/credits/ledger") {
      send({ entries: LEDGER });
    } else if (route === "/v1/papers") {
      send({
        papers: PAPERS,
        sections: SECTIONS.map((key) => ({ key, label: key })),
        progress: { papers: 2, finished: 0, sectionsRead: 1, sectionsTotal: 8 },
      });
    } else if (/^\/v1\/papers\/[a-z0-9-]+$/.test(route)) {
      const slug = route.split("/").pop();
      const paper = PAPERS.find((candidate) => candidate.slug === slug);
      if (paper === undefined) {
        send({ detail: "Paper not found" }, 404);
      } else {
        send({
          ...paper,
          pdfUrl: `https://arxiv.org/pdf/${paper.arxivId ?? ""}`,
          keyEquations: [
            {
              label: "Scaled dot-product attention",
              latex: "\\mathrm{softmax}\\left(\\frac{QK^T}{\\sqrt{d_k}}\\right)V",
              note: "The scaling keeps the softmax out of its saturated region as d_k grows.",
            },
          ],
          sections: SECTIONS.map((key) => ({
            key,
            label: key === "systems" ? "System design" : `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`,
            body: `## What ${key} covers\n\nOne paragraph of ${key} for the smoke to render.`,
          })),
        });
      }
    } else if (/^\/v1\/papers\/[a-z0-9-]+\/read$/.test(route)) {
      let raw = "";
      request.on("data", (chunk) => (raw += String(chunk)));
      request.on("end", () => {
        const section = (JSON.parse(raw || "{}") as { section?: string }).section ?? "";
        if (!marked.includes(section)) marked.push(section);
        const slug = route.split("/")[3] ?? "";
        const paper = PAPERS.find((candidate) => candidate.slug === slug);
        const read = [...new Set([...(paper?.sectionsRead ?? []), ...marked])];
        send({ slug, sectionsRead: read, completedAt: read.length >= 4 ? "2026-09-19T00:00:00Z" : null });
      });
      return;
    } else {
      send({ detail: "not part of this smoke" }, 404);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const previousApi = process.env.VOIDCODE_API_URL;
  const previousToken = process.env.VOIDCODE_DEV_SESSION_TOKEN;
  process.env.VOIDCODE_API_URL = `http://127.0.0.1:${port}/v1`;
  // The development session path, which exists for exactly this: a token main will present without
  // one having been minted by a real sign-in. Honoured only in an unpackaged build.
  process.env.VOIDCODE_DEV_SESSION_TOKEN = "smoke-session-token";

  const shots = process.env.VOIDCODE_SMOKE_SHOTS;

  try {
    /**
     * A per-route readiness test, because the two pages show different things.
     *
     * The first version waited for the signed-in email on both, which `/account/credits` does not
     * display at all -- it names a balance, not a person. The wait timed out and the smoke reported
     * "never showed the signed-in account" for a page that had rendered perfectly.
     */
    for (const [name, route, ready] of [
      ["account-signed-in", "/account", '(document.querySelector("main")?.innerText ?? "").includes("learner@example.test")'],
      ["credits", "/account/credits", 'document.querySelectorAll("tbody tr").length > 0'],
      ["research", "/research", '(document.querySelector("main")?.innerText ?? "").includes("Attention Is All You Need")'],
      ["paper", "/research/attention-is-all-you-need", 'document.querySelectorAll("[role=tab]").length === 4'],
    ] as const) {
      const consoleErrors: string[] = [];
      const onConsole = (event: { level: string; message: string }) => {
        if (event.level === "error") consoleErrors.push(event.message);
      };
      window.webContents.on("console-message", onConsole);

      await window.loadURL(`${APP_ORIGIN}${route}`);
      const painted = await waitFor(window, ready);
      // The wallet arrives after first paint, so give the fetches and the re-render a moment.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      window.webContents.off("console-message", onConsole);

      if (!painted) failures.push(`signed-in/${name} never rendered what it fetched: ${ready}`);
      for (const message of consoleErrors.slice(0, 3)) {
        failures.push(`signed-in/${name} console error: ${message}`);
      }

      if (shots !== undefined) await captureShot(window, shots, name);
    }

    /**
     * EACH ASSERTION BLOCK OPENS ITS OWN PAGE.
     *
     * The reads below used to run straight after the capture loop, on whatever the loop had left
     * on screen. Adding the research pages to that loop moved the last page from `/account/credits`
     * to a paper, and every credits assertion failed against a page that was never wrong. A block
     * that depends on the order of a loop above it is a block that breaks when the loop grows.
     */
    const openAndWait = async (route: string, ready: string): Promise<void> => {
      await window.loadURL(`${APP_ORIGIN}${route}`);
      if (!(await waitFor(window, ready))) failures.push(`signed-in: ${route} did not render`);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    };

    await openAndWait("/account/credits", 'document.querySelectorAll("tbody tr").length > 0');

    /**
     * What the credits page made of that wallet.
     *
     * EVERY BACKSLASH IN THE SCRIPT BELOW IS DOUBLED. It is built as a template literal, and a
     * template literal drops an unrecognised escape -- so a regex written with one backslash
     * reaches the page with none. The whitespace collapse became /s+/g, which replaced every
     * letter s on the page with a space and reported "All 4 movement ." as a missing footer.
     *
     * Read out of the rendered DOM rather than checked against the component's props, because the
     * failure being looked for is a component reading the wrong field off a correct answer, and
     * only the rendered figure can show that.
     */
    const rendered = (await window.webContents.executeJavaScript(`
      (() => {
        const text = document.querySelector("main")?.innerText ?? "";
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        const table = document.querySelector("table");
        const cell = (row, n) => row.children[n]?.textContent?.trim() ?? "";
        return {
          balanceShown: text.includes("1,204"),
          rows: rows.length,
          words: Array.from(new Set(rows.map((r) => cell(r, 1)))).sort(),
          amounts: rows.map((r) => cell(r, 2)),
          packs: Array.from(document.querySelectorAll("button"))
            .filter((b) => /RM\\d/.test(b.textContent ?? "")).length,
          voucher: document.querySelector("#voucher") !== null,
          footer: text.replace(/\\s+/g, " "),
          tableHeight: table === null ? 0 : Math.round(table.getBoundingClientRect().height),
        };
      })()
    `)) as {
      balanceShown: boolean;
      rows: number;
      words: string[];
      amounts: string[];
      packs: number;
      voucher: boolean;
      footer: string;
      tableHeight: number;
    };

    if (!rendered.balanceShown) failures.push("credits: the available balance is not on the page");
    if (rendered.rows !== MOVEMENTS) {
      failures.push(
        `credits: ${rendered.rows} history rows for ${MOVEMENTS} movements — a hold or a release is being listed`
      );
    }
    // The ledger's own vocabulary must not reach a column headed "What".
    for (const word of rendered.words) {
      if (word === "charge" || word === "grant" || word === "") {
        failures.push(`credits: a history row says ${JSON.stringify(word)} under "What"`);
      }
    }
    if (!rendered.amounts.includes("+1,200")) {
      failures.push(`credits: no +1,200 purchase row; amounts were ${JSON.stringify(rendered.amounts)}`);
    }
    if (!rendered.amounts.includes("-0.02")) {
      failures.push(`credits: no -0.02 charge row; amounts were ${JSON.stringify(rendered.amounts)}`);
    }
    if (rendered.packs !== 3) failures.push(`credits: ${rendered.packs} packs offered, expected 3`);
    if (!rendered.voucher) failures.push("credits: no voucher field");
    /**
     * The footer counts MOVEMENTS and says whether that is all of them.
     *
     * Six ledger rows came back against a limit of fifty, so this history is complete and the page
     * must say "All 4 movements" rather than "the 4 movements in your last 50 ledger entries" --
     * which would invite the reader to wonder what the other forty-six were. There were none.
     */
    if (!rendered.footer.includes("All 4 movements.")) {
      failures.push(
        "credits: the history footer does not say the four movements are all of them; page text was "
          + JSON.stringify(rendered.footer.slice(-400))
      );
    }
    if (!rendered.footer.includes("Holds and releases aren")) {
      failures.push("credits: the page does not explain the entries it leaves out");
    }
    // Content in the DOM is not content on screen.
    if (rendered.tableHeight < 80) {
      failures.push(`credits: the history table is ${rendered.tableHeight}px tall`);
    }

    await openAndWait(
      "/research/attention-is-all-you-need",
      'document.querySelectorAll("[role=tab]").length === 4'
    );

    /**
     * The reader, and the one piece of wiring here that can only be checked end to end: arriving on
     * a paper marks its first breakdown read, and switching tabs marks the next.
     *
     * `marked` is filled by the stand-in server, so this is the whole path -- a click in the
     * renderer, through the channel, through main, to an HTTP POST with the right section in it.
     * The unit tests prove each leg; nothing else proves they are joined up.
     */
    const reader = (await window.webContents.executeJavaScript(`
      (async () => {
        const tabs = () => Array.from(document.querySelectorAll("[role=tab]"));
        const labels = tabs().map((t) => t.textContent.trim());
        const before = tabs().filter((t) => t.querySelector("[aria-label=read]")).length;
        // The last tab, so the click is unambiguous and is not the one already marked on arrival.
        tabs().at(-1).click();
        await new Promise((r) => setTimeout(r, 900));
        const body = document.querySelector("main").innerText;
        return {
          labels,
          ticksBefore: before,
          ticksAfter: tabs().filter((t) => t.querySelector("[aria-label=read]")).length,
          showsMathematics: body.includes("What mathematics covers"),
          equation: document.querySelector(".katex") !== null,
          relatedProblem: Array.from(document.querySelectorAll("a"))
            .map((a) => a.getAttribute("href") ?? "")
            .map((href) => (href.endsWith("/") ? href.slice(0, -1) : href))
            .includes("/problems/scaled-dot-product-attention"),
          hasPdfButton: Array.from(document.querySelectorAll("button"))
            .some((b) => /open pdf/i.test(b.textContent ?? "")),
        };
      })()
    `)) as {
      labels: string[];
      ticksBefore: number;
      ticksAfter: number;
      showsMathematics: boolean;
      equation: boolean;
      relatedProblem: boolean;
      hasPdfButton: boolean;
    };

    if (reader.labels.join(",") !== "Architecture,Implementation,System design,Mathematics") {
      failures.push(`paper: the breakdowns read ${JSON.stringify(reader.labels)}`);
    }
    // One tick on arrival: the paper came back with `architecture` already read.
    if (reader.ticksBefore !== 1) failures.push(`paper: ${reader.ticksBefore} ticks on arrival, expected 1`);
    if (reader.ticksAfter !== 2) failures.push(`paper: ${reader.ticksAfter} ticks after opening a tab, expected 2`);
    if (!reader.showsMathematics) failures.push("paper: opening the Mathematics tab did not show its body");
    if (!reader.equation) failures.push("paper: the key equation was not typeset");
    if (!reader.relatedProblem) failures.push("paper: the related problem is not linked by slug");
    if (!reader.hasPdfButton) failures.push("paper: no Open PDF button");
    /**
     * WHICH SECTIONS REACHED THE SERVER. `mathematics` is the click; `systems` must NOT be there,
     * because nothing opened it -- a component that marked every tab on mount rather than the one
     * on screen would pass every assertion above and fail this one.
     */
    if (!marked.includes("mathematics")) {
      failures.push(`paper: the server was never told mathematics was read; it got ${JSON.stringify(marked)}`);
    }
    if (marked.includes("systems")) {
      failures.push(`paper: sections nobody opened were marked read: ${JSON.stringify(marked)}`);
    }

    if (failures.length === 0) {
      console.log(
        `[smoke] signed in: /account, /account/credits, /research and a paper rendered; `
          + `${rendered.rows} movements shown, holds and releases filtered, ${rendered.packs} packs offered; `
          + `reader marked ${JSON.stringify(marked)}`
      );
    }
  } catch (err) {
    failures.push(`signed-in smoke threw: ${(err as Error).message}`);
  } finally {
    if (previousApi === undefined) delete process.env.VOIDCODE_API_URL;
    else process.env.VOIDCODE_API_URL = previousApi;
    if (previousToken === undefined) delete process.env.VOIDCODE_DEV_SESSION_TOKEN;
    else process.env.VOIDCODE_DEV_SESSION_TOKEN = previousToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return failures;
}

/**
 * The transport seam: the route table against the verbs its callers actually send.
 *
 * This exists because of a real bug it would have caught. `lib/api/drafts.ts` sends
 * `PUT /v1/drafts`; the route table registered `POST /v1/drafts`. Nothing matched, the
 * request fell through to the 501 "not migrated" fallback, and `useAutosave` rendered that
 * as "Save failed" — on every keystroke, for every problem, with no draft ever persisted.
 *
 * Nothing caught it: unit tests exercise `drafts:save` in main, which was always fine, and
 * the smoke exercised the store directly rather than through the seam. The mismatch lived
 * exactly in the gap between the two.
 *
 * So this drives `window.fetch` with the same method, path and body shape the client library
 * sends, and asserts a real round trip. A route table that silently disagrees with its
 * callers is the failure mode of this whole design, and it deserves a test at the seam.
 */
async function runTransportSmoke(window: Electron.BrowserWindow): Promise<string[]> {
  const failures: string[] = [];

  try {
    const marker = `# transport ${new Date().toISOString()}`;
    const result = (await window.webContents.executeJavaScript(`
      (async () => {
        // Exactly what lib/api/drafts.ts sends. Copying the shape is the point — a
        // hand-rolled request that happened to use the right verb would test nothing.
        const put = await fetch("app://api/v1/drafts", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            problem_id: "sigmoid",
            language: "python",
            source_code: ${JSON.stringify(marker)},
          }),
        });
        if (!put.ok) return { stage: "save", status: put.status };

        const get = await fetch(
          "app://api/v1/drafts?problem_id=sigmoid&language=python"
        );
        if (!get.ok) return { stage: "load", status: get.status };

        const data = await get.json();
        return { stage: "ok", source: data?.draft?.source_code ?? data?.sourceCode ?? null };
      })()
    `)) as { stage: string; status?: number; source?: string | null };

    // Probe the submit route's actual response shape. Diagnostic only — reported, not
    // asserted, until the shape is known.
    const submitShape = (await window.webContents.executeJavaScript(`
      (async () => {
        const r = await fetch("app://api/v1/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // snake_case, exactly as judge0.ts sends it. The first version of this probe used
          // camelCase and passed against a route that the real client could not reach — the
          // precise mistake this file's own comment warns about.
          body: JSON.stringify({
            problem_id: "sigmoid",
            // One line, so nothing here needs an escaped newline — this whole block is a
            // template literal and a stray line break silently unterminates the string.
            source_code: "def sigmoid(x): return [1/(1+2.718281828459045**-v) for v in x] if isinstance(x, list) else 1/(1+2.718281828459045**-x)",
            language: "python",
          }),
        });
        if (!r.ok) return { status: r.status };
        const d = await r.json();
        return {
          status: 200,
          total: d.total_tests ?? null,
          passed: d.passed_tests ?? null,
          cases: Array.isArray(d.test_case_results) ? d.test_case_results.length : null,
          elapsedPresent: Array.isArray(d.test_case_results)
            ? d.test_case_results.every((c) => typeof c.elapsed_ms === "number")
            : false,
          limit: d.time_limit_ms ?? null,
        };
      })()
    `)) as {
      status: number;
      total?: number | null;
      passed?: number | null;
      cases?: number | null;
      elapsedPresent?: boolean;
      limit?: number | null;
    };

    if (submitShape.status !== 200) {
      failures.push(`transport/submit returned ${submitShape.status}`);
    } else if (submitShape.cases === null || submitShape.cases === 0) {
      // The shape `submitSolution` parses. Returning main's `Grade` verbatim left
      // `test_case_results` undefined, and the client threw on `.map` before any of it
      // reached the UI — which is why Submit had never worked.
      failures.push("transport/submit returned no test_case_results — the client would throw");
    } else if (submitShape.elapsedPresent !== true) {
      failures.push("transport/submit omitted per-case elapsed_ms");
    } else if (!submitShape.limit) {
      failures.push("transport/submit omitted time_limit_ms — a timing has no denominator");
    } else {
      console.log(
        `[smoke] transport: submit graded ${String(submitShape.passed)}/${String(
          submitShape.total
        )} cases with timings against a ${String(submitShape.limit)}ms budget`
      );
    }

    /**
     * Every remaining migrated route, checked against the fields its client actually reads.
     *
     * Four routes were found broken by hand before this existed — drafts (three ways),
     * submit (two ways), submissions and profile — all the same mechanism: the table
     * disagreeing with its caller about a verb, a body's casing, or a response shape. None
     * of it was reachable from a unit test, because both halves were individually correct.
     *
     * So the assertion is deliberately "the exact keys the parser dereferences", not "a 200".
     * A 200 is what every one of those bugs already returned.
     */
    const sweep = (await window.webContents.executeJavaScript(`
      (async () => {
        const need = async (path, keys) => {
          const r = await fetch("app://api" + path);
          if (!r.ok) return path + " -> " + r.status;
          const d = await r.json();
          const missing = keys.filter((k) => {
            const target = k.includes("[]") ? (d[k.split("[]")[0]] ?? [])[0] : d;
            const field = k.includes("[]") ? k.split("[]")[1].slice(1) : k;
            return target === undefined || target[field] === undefined;
          });
          return missing.length ? path + " missing " + missing.join(",") : null;
        };

        return (await Promise.all([
          need("/v1/dashboard", ["problems", "categories", "total_problems", "activity"]),
          need("/v1/problems", ["problems"]),
          need("/v1/problems/stable-softmax", ["id", "order_index", "title", "description"]),
          need("/v1/profile", ["id", "name", "created_at", "updated_at"]),
          // Rows exist because the submit probe above just graded one.
          need("/v1/submissions?problem_id=sigmoid", [
            "submissions[].status",
            "submissions[].total_tests",
            "submissions[].passed_tests",
            "submissions[].created_at",
            "submissions[].source_code",
          ]),
        ])).filter(Boolean);
      })()
    `)) as string[];

    for (const problem of sweep) failures.push(`transport/${problem}`);
    if (sweep.length === 0) {
      console.log("[smoke] transport: every migrated route matches its client's parser");
    }

    /**
     * The whole session lifecycle, through the seam the panel uses.
     *
     * Four routes on two entries — the matcher is longest-prefix, so
     * `GET /v1/chat/sessions/{id}` also matches `GET /v1/chat/sessions`, and the same
     * collision exists between creating a session and appending a message. Both splits
     * happen inside their handler, and this is what proves each half is reachable.
     */
    const sessions = (await window.webContents.executeJavaScript(`
      (async () => {
        const post = (path, payload) =>
          fetch("app://api" + path, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }).then(async (r) => (r.ok ? r.json() : { __status: r.status }));

        const created = await post("/v1/chat/sessions", {
          problem_id: "sigmoid",
          title: "smoke",
        });
        if (created.__status) return { stage: "create", status: created.__status };
        // parseSessionDetail maps \`messages\` unconditionally; a missing key throws.
        if (!Array.isArray(created.messages)) return { stage: "create", missing: "messages" };

        const saved = await post("/v1/chat/sessions/" + created.id + "/messages", {
          role: "user",
          content: "does this survive a reload?",
        });
        if (saved.__status) return { stage: "saveMessage", status: saved.__status };
        await post("/v1/chat/sessions/" + created.id + "/messages", {
          role: "assistant",
          content: "yes",
        });

        const listed = await (await fetch("app://api/v1/chat/sessions?limit=20&offset=0")).json();
        const summary = (listed.sessions ?? []).find((s) => s.id === created.id);

        const detail = await (
          await fetch("app://api/v1/chat/sessions/" + created.id)
        ).json();

        return {
          stage: "ok",
          // Exactly the keys parseSessionSummary / parseSessionMessage dereference.
          summaryKeysMissing: summary === undefined
            ? ["summary absent from list"]
            : ["id", "title", "problem_id", "is_active", "message_count", "created_at", "updated_at"]
                .filter((k) => summary[k] === undefined),
          messageCount: summary?.message_count ?? null,
          total: listed.total ?? null,
          detailMessages: Array.isArray(detail.messages) ? detail.messages.length : null,
          firstMessageKeysMissing: (detail.messages ?? [])[0] === undefined
            ? ["no messages in detail"]
            : ["id", "role", "content", "detected_mode", "thinking_content", "created_at"]
                .filter((k) => detail.messages[0][k] === undefined),
          // Order is the thing the panel replays; a shuffled thread reads as a broken model.
          order: (detail.messages ?? []).map((m) => m.role).join(","),
        };
      })()
    `)) as Record<string, unknown>;

    if (sessions.stage !== "ok") {
      failures.push(
        `transport/chat session ${String(sessions.stage)} failed: ${JSON.stringify(sessions)}`
      );
    } else {
      const summaryMissing = sessions.summaryKeysMissing as string[];
      const messageMissing = sessions.firstMessageKeysMissing as string[];

      if (summaryMissing.length > 0) {
        failures.push(`transport/chat summary missing ${summaryMissing.join(",")}`);
      }
      if (messageMissing.length > 0) {
        failures.push(`transport/chat message missing ${messageMissing.join(",")}`);
      }
      if (sessions.messageCount !== 2) {
        failures.push(`transport/chat message_count was ${String(sessions.messageCount)}, want 2`);
      }
      if (sessions.detailMessages !== 2) {
        failures.push(`transport/chat detail had ${String(sessions.detailMessages)} messages`);
      }
      if (sessions.order !== "user,assistant") {
        failures.push(`transport/chat replayed out of order: ${String(sessions.order)}`);
      }
      if (failures.length === 0) {
        console.log("[smoke] transport: chat sessions create, save, list and replay in order");
      }
    }

    /**
     * Interviews, end to end through the seam.
     *
     * Three entries carry seven paths here, so most of what can go wrong is a request
     * reaching the wrong branch and still returning 200 — which is what every earlier
     * transport bug looked like. So this asserts on content, not status: that the answer
     * is absent until asked for, that a notes-only save does not blank a rating, and that
     * the two unbuilt sub-paths still say 501 rather than being swallowed by the slug
     * regex and blamed on the user.
     */
    const interviews = (await window.webContents.executeJavaScript(`
      (async () => {
        const get = (path) =>
          fetch("app://api" + path).then(async (r) =>
            r.ok ? r.json() : { __status: r.status });
        const send = (method, path, payload) =>
          fetch("app://api" + path, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }).then(async (r) => (r.ok ? r.json() : { __status: r.status }));

        // What does an IpcError's message actually look like by the time it reaches here?
        // Assumed once already and it was wrong, so it is measured rather than guessed.
        const notFound = await fetch("app://api/v1/interviews/definitely-not-a-question");
        const notFoundBody = await notFound.json().catch(() => ({}));

        const list = await get("/v1/interviews");
        if (list.__status) return { stage: "list", status: list.__status };

        const first = (list.questions ?? [])[0];
        if (first === undefined) return { stage: "list", missing: "questions" };

        const slug = first.slug;
        const detail = await get("/v1/interviews/" + slug);
        if (detail.__status) return { stage: "detail", status: detail.__status };

        // The property the whole staged reveal rests on. Asserted on the serialised
        // payload, because a key present but undefined would pass a key check.
        const listWire = JSON.stringify(list);
        const detailWire = JSON.stringify(detail);
        const leaked = ["approach", "modelAnswer", "redFlags", "followUps"]
          .filter((k) => listWire.includes('"' + k + '"') || detailWire.includes('"' + k + '"'));

        const approach = await send("POST", "/v1/interviews/" + slug + "/reveal", {
          stage: "approach",
        });
        const answer = await send("POST", "/v1/interviews/" + slug + "/reveal", {
          stage: "answer",
        });

        // Rating first, then a notes-only save. If the seam spreads an absent key as
        // undefined, the second call clears the rating and this is where it shows.
        await send("PUT", "/v1/interviews/" + slug + "/attempt", { self_rating: 3 });
        const afterNotes = await send("PUT", "/v1/interviews/" + slug + "/attempt", {
          notes: "reread this one",
        });

        const relisted = await get("/v1/interviews");
        const row = (relisted.questions ?? []).find((q) => q.slug === slug);

        // The IDE payload, and the property that matters about it.
        const ws = await get("/v1/interviews/" + slug + "/workspace");
        const wsWire = JSON.stringify(ws);

        // "Submitted" is DERIVED FROM submissions, not taken on trust. The client calls
        // this after a submit, but on the desktop the client is even less of an authority
        // than it was on the web — the user can edit the renderer. So: refused before any
        // submission exists, accepted after one does.
        //
        // A different question for the negative half. This used to be load-bearing: the
        // store was the real user database and survived between runs, so asking this of the
        // question we are about to submit passed once and then failed forever. The smoke now
        // runs on its own in-memory database, so either question would do — this one is kept
        // because "a question nobody has touched" is what the assertion is actually about.
        const untouched = (list.questions ?? [])[1];
        const submittedTooEarly = await fetch(
          "app://api/v1/interviews/" + (untouched?.slug ?? slug) + "/submitted",
          { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }
        );

        // The template itself: a stub that returns None. It is meant to fail cases — what
        // is being proven is that an iq- problem id reaches the grader at all.
        const graded = await send("POST", "/v1/submit", {
          problem_id: ws.problem?.id,
          source_code: ws.codeTemplates?.[0]?.template_code ?? "",
        });
        const submittedAfter = await send("POST", "/v1/interviews/" + slug + "/submitted", {});

        // Marking. The short-answer guard runs entirely in main with no model involved, so
        // this half is assertable on any machine — including CI, where nothing is installed.
        const tooShort = await send("POST", "/v1/interviews/" + slug + "/assess", {
          answer: "ewfwfe",
        });

        // A real answer needs a model. Where there is none the route must fail *honestly*
        // rather than return an empty assessment that reads like a verdict.
        const marked = await send("POST", "/v1/interviews/" + slug + "/assess", {
          answer:
            "Cross-entropy, because the log cancels the softmax Jacobian and the gradient " +
            "collapses to p minus y, which stays full strength when the model is wrong.",
        });

        return {
          stage: "ok",
          leaked,
          // Exactly the keys api/interviews.ts dereferences off a summary.
          summaryKeysMissing: [
            "slug", "title", "promptPreview", "domain", "domainLabel", "kind", "kindLabel",
            "difficulty", "companies", "categories", "orderIndex", "selfRating",
            "revealedAnswer", "attempted", "hasWorkspace", "solved",
          ].filter((k) => first[k] === undefined),
          detailKeysMissing: ["prompt", "notes"].filter((k) => detail[k] === undefined),
          facetGroups: Object.keys(list.facets ?? {}).sort().join(","),
          progressKeys: Object.keys(list.progress ?? {}).sort().join(","),
          total: list.progress?.total ?? null,
          hasApproach: typeof approach.approach === "string" && approach.approach.length > 0,
          hasAnswer: typeof answer.modelAnswer === "string" && answer.modelAnswer.length > 0,
          answerExtras: Array.isArray(answer.followUps) && Array.isArray(answer.redFlags),
          ratingAfterNotesOnlySave: afterNotes.selfRating,
          notesAfterNotesOnlySave: afterNotes.notes,
          revealedInList: row?.revealedAnswer ?? null,
          attemptedInList: row?.attempted ?? null,
          ratingInList: row?.selfRating ?? null,
          hasWorkspaceInList: row?.hasWorkspace ?? null,

          notFoundStatus: notFound.status,
          notFoundDetail: String(notFoundBody.detail ?? ""),

          tooShortVerdict: tooShort.verdict ?? null,
          tooShortStatus: tooShort.__status ?? 200,
          // Either it marked the answer, or it said it could not. What must never happen is
          // a 200 carrying neither — that renders as a badge over empty feedback.
          markedStatus: marked.__status ?? 200,
          markedVerdict: marked.verdict ?? null,
          markedHasFeedback: typeof marked.feedback === "string" && marked.feedback.length > 0,
          // The reference must not be in the response on any path, including the error one.
          // The reference must not come back on any path, including the error one. Compared
          // against the answer this probe revealed a moment ago, which is the real text --
          // a placeholder here would assert nothing.
          markedLeaksReference: (() => {
            const reference = String(answer.modelAnswer || "");
            if (reference.length < 60) return "no reference to compare";
            const run = reference.split(/\s+/).filter(Boolean).slice(0, 12).join(" ");
            return JSON.stringify(marked).includes(run) ? "leaked" : false;
          })(),

          // Exactly the keys fetchInterviewWorkspace dereferences. It reads
          // data.problem.order_index and maps data.testCases[].inputs unconditionally, so a
          // missing one is a TypeError in the client, not a soft failure.
          // (No backticks in here: this whole block is a template literal.)
          workspaceStatus: ws.__status ?? 200,
          workspaceKeysMissing: ws.__status
            ? ["workspace did not load"]
            : ["problem", "testCases", "codeTemplates", "elapsedSeconds", "submittedAt",
               "notes", "companies", "domainLabel", "difficulty", "title"]
                .filter((k) => ws[k] === undefined),
          problemKeysMissing: ws.problem === undefined
            ? ["no problem"]
            : ["id", "order_index", "title", "difficulty", "description", "examples",
               "constraints", "hints"].filter((k) => ws.problem[k] === undefined),
          templateKeysMissing: (ws.codeTemplates ?? [])[0] === undefined
            ? ["no template"]
            : ["id", "language", "template_code", "driver_code"]
                .filter((k) => ws.codeTemplates[0][k] === undefined),
          // The feature: every expected output is null, and none is hiding under another
          // spelling anywhere in the payload.
          expectationsLeaked:
            (ws.testCases ?? []).some((t) => t.expected_output !== null) ||
            wsWire.includes("expectedOutput"),
          workspaceProblemId: ws.problem?.id ?? null,
          visibleCases: (ws.testCases ?? []).length,
          hiddenCount: ws.hidden_count ?? null,
          inputNames: ((ws.testCases ?? [])[0]?.inputs ?? []).map((i) => i.name).join(","),

          submittedTooEarlyOk: submittedTooEarly.ok,
          gradedCases: Array.isArray(graded.test_case_results)
            ? graded.test_case_results.length
            : null,
          submittedAfterOk: typeof submittedAfter.submittedAt === "string",
        };
      })()
    `)) as Record<string, unknown>;

    if (interviews.stage !== "ok") {
      failures.push(
        `transport/interviews ${String(interviews.stage)} failed: ${JSON.stringify(interviews)}`
      );
    } else {
      const leaked = interviews.leaked as string[];
      const summaryMissing = interviews.summaryKeysMissing as string[];
      const detailMissing = interviews.detailKeysMissing as string[];

      if (leaked.length > 0) {
        failures.push(`transport/interviews leaked ${leaked.join(",")} before it was asked for`);
      }
      if (summaryMissing.length > 0) {
        failures.push(`transport/interviews summary missing ${summaryMissing.join(",")}`);
      }
      if (detailMissing.length > 0) {
        failures.push(`transport/interviews detail missing ${detailMissing.join(",")}`);
      }
      if (interviews.facetGroups !== "companies,difficulties,domains,kinds") {
        failures.push(`transport/interviews facets were ${String(interviews.facetGroups)}`);
      }
      if (interviews.progressKeys !== "attempted,solid,total") {
        failures.push(`transport/interviews progress was ${String(interviews.progressKeys)}`);
      }
      if (interviews.hasApproach !== true) failures.push("transport/interviews reveal gave no approach");
      if (interviews.hasAnswer !== true) failures.push("transport/interviews reveal gave no answer");
      if (interviews.answerExtras !== true) {
        failures.push("transport/interviews answer reveal dropped followUps or redFlags");
      }
      if (interviews.ratingAfterNotesOnlySave !== 3) {
        failures.push(
          `transport/interviews notes-only save blanked the rating (got ${String(interviews.ratingAfterNotesOnlySave)})`
        );
      }
      if (interviews.notesAfterNotesOnlySave !== "reread this one") {
        failures.push("transport/interviews notes did not round-trip");
      }
      if (interviews.revealedInList !== true) {
        failures.push("transport/interviews revealing the answer was not recorded in the list");
      }
      if (interviews.attemptedInList !== true || interviews.ratingInList !== 3) {
        failures.push("transport/interviews the list did not reflect the saved attempt");
      }
      // A slug nobody authored is a 404, not a 500 — 500 blames us for a URL that is simply
      // wrong. This is asserted rather than assumed because the first version of that
      // mapping matched on the text of an ordinary Error, which the broker replaces with
      // "${channel} failed" before it ever reaches the renderer. It was dead on arrival and
      // nothing said so.
      if (interviews.notFoundStatus !== 404) {
        failures.push(
          `transport/interviews an unknown slug answered ${String(interviews.notFoundStatus)}, want 404`
        );
      }
      if (!String(interviews.notFoundDetail).includes("not found")) {
        failures.push(
          `transport/interviews the 404 said "${String(interviews.notFoundDetail)}", which names nothing`
        );
      }

      // The short-answer guard runs entirely in main with no model involved, so this is
      // assertable everywhere — including CI, where nothing is installed.
      if (interviews.tooShortStatus !== 200 || interviews.tooShortVerdict !== "too_short") {
        failures.push(
          `transport/interviews graded a non-answer: ${String(interviews.tooShortStatus)} ` +
            `${String(interviews.tooShortVerdict)}`
        );
      }

      // Marking a real answer needs a model. Both outcomes are acceptable; what is not is a
      // 200 carrying neither a verdict nor feedback, which renders as a badge over nothing.
      const marked = interviews.markedStatus === 200;
      if (marked && (interviews.markedVerdict === null || interviews.markedHasFeedback !== true)) {
        failures.push("transport/interviews assess returned 200 with no assessment in it");
      }
      if (!marked && interviews.markedStatus !== 503) {
        failures.push(
          `transport/interviews assess failed as ${String(interviews.markedStatus)}, want 200 or 503`
        );
      }
      if (interviews.markedLeaksReference !== false) {
        failures.push(
          `transport/interviews assess response ${String(interviews.markedLeaksReference)} the reference`
        );
      }

      const workspaceMissing = interviews.workspaceKeysMissing as string[];
      const problemMissing = interviews.problemKeysMissing as string[];
      const templateMissing = interviews.templateKeysMissing as string[];

      if (interviews.workspaceStatus !== 200) {
        failures.push(`transport/interviews workspace answered ${String(interviews.workspaceStatus)}`);
      }
      for (const [what, missing] of [
        ["workspace", workspaceMissing],
        ["workspace problem", problemMissing],
        ["workspace template", templateMissing],
      ] as const) {
        if (missing.length > 0) failures.push(`transport/interviews ${what} missing ${missing.join(",")}`);
      }
      if (interviews.expectationsLeaked !== false) {
        failures.push("transport/interviews workspace shipped an expected output");
      }
      if (interviews.hasWorkspaceInList !== true) {
        failures.push("transport/interviews the catalogue still says the question is not runnable");
      }
      if (typeof interviews.hiddenCount !== "number" || interviews.hiddenCount <= 0) {
        failures.push(`transport/interviews hidden_count was ${String(interviews.hiddenCount)}`);
      }
      // Named from the entry point's parameters, not `arg1, arg2`. The prompt talks about
      // `logits` and `label`; positional names make the reader do the mapping.
      if (/^arg\d/.test(String(interviews.inputNames)) || interviews.inputNames === "") {
        failures.push(`transport/interviews case inputs were labelled ${String(interviews.inputNames)}`);
      }
      if (interviews.submittedTooEarlyOk !== false) {
        failures.push(
          "transport/interviews marked a question submitted with no submission behind it"
        );
      }
      if (typeof interviews.gradedCases !== "number" || interviews.gradedCases <= 0) {
        failures.push(
          `transport/interviews submitting an iq- problem graded ${String(interviews.gradedCases)} cases`
        );
      }
      if (interviews.submittedAfterOk !== true) {
        failures.push("transport/interviews refused to mark submitted after a real submission");
      }
      if (failures.length === 0) {
        console.log(
          `[smoke] transport: ${String(interviews.total)} interview questions; answer withheld until revealed; ` +
            `workspace ${String(interviews.workspaceProblemId)} sends ${String(interviews.visibleCases)} cases ` +
            `(+${String(interviews.hiddenCount)} hidden) with no expectations, inputs named ${String(interviews.inputNames)}`
        );
        console.log(
          `[smoke] transport: interview submit graded ${String(interviews.gradedCases)} cases; ` +
            `"submitted" refused before a submission existed and accepted after`
        );
        console.log(
          `[smoke] transport: assess rejected a non-answer without a model; a real answer ` +
            (marked
              ? `came back "${String(interviews.markedVerdict)}"`
              : `reported the tutor unavailable`) +
            ` with the reference withheld`
        );
      }
    }

    /**
     * Notifications: the policy, and the stream.
     *
     * TWO ASSERTIONS THAT NEED DIFFERENT TRIGGERS, AND THAT IS THE WHOLE SHAPE OF THIS.
     *
     * The policy is "only a first solve raises one", asserted in the negative: a failing
     * submission must raise nothing. That direction is the honest one to test here anyway,
     * and it stays true whether or not the database is fresh.
     *
     * (It was also the only repeatable direction back when the smoke shared the user's
     * database — a first solve happens once per problem, so a positive assertion passed once
     * and failed forever after. The smoke now has its own in-memory database, so that
     * constraint is gone; the negative test is kept because it is the sharper one.)
     *
     * The stream is the part with no unit coverage and the most ways to fail quietly: a
     * `ReadableStream` the seam builds itself, fed by a main→renderer push instead of the
     * Redis pub/sub the web used. Every failure mode looks the same from outside — the bell
     * simply never updates — so it is driven by raising a notification *from main*, which is
     * the only thing that can: there is deliberately no channel for it.
     */
    const streamOpen = (await window.webContents.executeJavaScript(`
      (async () => {
        const before = await fetch("app://api/v1/notifications/count").then((r) => r.json());

        const res = await fetch("app://api/v1/notifications/stream");
        if (!res.ok || !res.body) return { stage: "stream", status: res.status };

        // Held on window so a second executeJavaScript can read what arrived in between.
        // The loop is deliberately not awaited — it runs for the rest of the probe.
        window.__smokeFrames = [];
        const reader = res.body.getReader();
        window.__smokeReader = reader;
        (async () => {
          const decoder = new TextDecoder();
          let buffer = "";
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const parts = buffer.split(String.fromCharCode(10, 10));
              buffer = parts.pop() ?? "";
              for (const part of parts) {
                const line = part.replace(/^data: /, "").trim();
                if (line) { try { window.__smokeFrames.push(JSON.parse(line)); } catch {} }
              }
            }
          } catch {}
        })();

        // "connected" is sent immediately, exactly as the server did — a stream that opens
        // without it is one the client treats as not connected.
        const deadline = Date.now() + 3000;
        while (window.__smokeFrames.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }

        // A failing submission. Under the old per-submission rule this raised one; now it
        // must raise nothing, and that is the policy assertion.
        const graded = await fetch("app://api/v1/submit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ problem_id: "sigmoid", source_code: "def sigmoid(x): return x" }),
        }).then((r) => (r.ok ? r.json() : { __status: r.status }));

        await new Promise((r) => setTimeout(r, 1200));

        return {
          stage: "ok",
          firstFrameType: window.__smokeFrames[0]?.type ?? null,
          gradedOk: graded.__status === undefined,
          gradedSolved: Array.isArray(graded.test_case_results)
            ? graded.test_case_results.every((t) => t.status && t.status.status_id === 3)
            : null,
          framesAfterFailedSubmit: window.__smokeFrames.filter((f) => f.type === "notification").length,
          unreadBefore: before.unread_count ?? null,
        };
      })()
    `)) as Record<string, unknown>;

    if (streamOpen.stage !== "ok") {
      failures.push(`transport/notifications stream failed: ${JSON.stringify(streamOpen)}`);
    } else {
      if (streamOpen.firstFrameType !== "connected") {
        failures.push(
          `transport/notifications stream opened with ${String(streamOpen.firstFrameType)}, want connected`
        );
      }
      if (streamOpen.gradedOk !== true) {
        failures.push("transport/notifications could not submit at all");
      }
      if (streamOpen.gradedSolved !== false) {
        failures.push(
          "transport/notifications the smoke's deliberately wrong solution passed, so the policy check proves nothing"
        );
      }
      if (streamOpen.framesAfterFailedSubmit !== 0) {
        failures.push(
          `transport/notifications a failed submission raised ${String(streamOpen.framesAfterFailedSubmit)} notifications, want 0`
        );
      }

      // Raised from main, because nothing else can. This is what a first solve does; the
      // rest of the chain does not care which event produced it.
      const { createNotification } = await import("./store/notifications.js");
      const raised = createNotification({
        type: "submission_accepted",
        title: "Solved: smoke check",
        message: "Raised by the transport smoke to drive the stream.",
        referenceId: "sigmoid",
      });

      const delivered = (await window.webContents.executeJavaScript(`
        (async () => {
          const deadline = Date.now() + 4000;
          const has = () => window.__smokeFrames.some((f) => f.type === "notification");
          while (!has() && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 50));
          }
          try { window.__smokeReader.cancel(); } catch {}

          const pushed = window.__smokeFrames.find((f) => f.type === "notification");
          const listed = await fetch("app://api/v1/notifications?limit=50").then((r) => r.json());
          const first = (listed.notifications ?? [])[0];

          const markOne = first === undefined ? null : await fetch("app://api/v1/notifications/read", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notification_ids: [first.id] }),
          }).then((r) => r.json());

          const markAll = await fetch("app://api/v1/notifications/read", {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ notification_ids: [] }),
          }).then((r) => r.json());

          const cleared = await fetch("app://api/v1/notifications/count").then((r) => r.json());

          return {
            sawPush: pushed !== undefined,
            // Exactly the keys parseNotification dereferences off a pushed frame.
            pushKeysMissing: pushed === undefined
              ? ["nothing was pushed"]
              : ["id", "type", "title", "message", "is_read", "reference_id", "created_at"]
                  .filter((k) => pushed.data?.[k] === undefined),
            listKeysMissing: first === undefined
              ? ["list was empty"]
              : ["id", "type", "title", "message", "is_read", "reference_id", "created_at"]
                  .filter((k) => first[k] === undefined),
            pushedId: pushed?.data?.id ?? null,
            newestId: first?.id ?? null,
            listTotal: listed.total ?? null,
            markedOne: markOne?.updated ?? null,
            markedAll: markAll.updated ?? null,
            clearedTo: cleared.unread_count ?? null,
          };
        })()
      `)) as Record<string, unknown>;

      const pushMissing = delivered.pushKeysMissing as string[];
      const listMissing = delivered.listKeysMissing as string[];

      if (delivered.sawPush !== true) {
        failures.push("transport/notifications raising one pushed nothing to the stream");
      }
      if (pushMissing.length > 0) {
        failures.push(`transport/notifications pushed frame missing ${pushMissing.join(",")}`);
      }
      if (listMissing.length > 0) {
        failures.push(`transport/notifications list row missing ${listMissing.join(",")}`);
      }
      // The pushed row and the stored row must be the same notification, or the bell shows
      // one thing and the list another.
      if (delivered.pushedId !== raised.id || delivered.newestId !== raised.id) {
        failures.push(
          `transport/notifications pushed ${String(delivered.pushedId)} and listed ${String(delivered.newestId)}, but raised ${raised.id}`
        );
      }
      if (delivered.markedOne !== 1) {
        failures.push(
          `transport/notifications marking one read changed ${String(delivered.markedOne)} rows`
        );
      }
      if (delivered.clearedTo !== 0) {
        failures.push(
          `transport/notifications mark-all left ${String(delivered.clearedTo)} unread`
        );
      }
      if (failures.length === 0) {
        console.log(
          `[smoke] transport: a failed submission raised nothing (first solve only); ` +
            `a raised notification reached the stream and the list of ${String(delivered.listTotal)}; ` +
            `mark-one then mark-all cleared the badge`
        );
      }
    }

    /**
     * The tutor stream, asserted on frame shape rather than status.
     *
     * A 200 is what all six of the transport bugs already returned, and this route is riskier
     * than those: it has to satisfy a 150-line SSE parser nobody is rewriting. So this reads
     * an actual frame and checks it destructures the way `VoidCodeAIPanel` destructures it.
     *
     * Skipped when no model is installed — that is a real deployment, not a failure, and the
     * route reports it as an error the panel renders.
     */
    const stream = (await window.webContents.executeJavaScript(`
      (async () => {
        const r = await fetch("app://api/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // What the panel sends: no system turn, and streaming.
          body: JSON.stringify({
            messages: [{ role: "user", content: "Reply with the single word: ok" }],
            stream: true,
            // 16 was too small for a reasoning model to ever reach its answer: the whole budget
            // went on thinking, no content frame arrived, and the probe blamed the transport.
            max_tokens: 512,
          }),
        });

        if (!r.ok) {
          const detail = await r.json().catch(() => ({}));
          return { skipped: String(detail.detail ?? r.status) };
        }
        if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) {
          return { error: "not an event stream: " + r.headers.get("content-type") };
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        // Built rather than written literally: an escaped newline inside this template has
        // twice been reflowed into a real line break, which unterminates the string.
        const NL = String.fromCharCode(10);

        let buffer = "";
        let delta = null;
        let sawReasoning = false;
        let finished = false;

        // One frame carrying model output is enough to prove the contract, and reasoning counts.
        // A thinking model emits reasoning deltas before any content; the claim under test is
        // that provider output reaches the renderer's parser, not which field it lands in.
        //
        // Wrapped because the stream errors mid-flight when the only reachable provider is
        // remote and has no key — a real deployment state, not a transport bug. Unwrapped,
        // reader.read() rejects, the whole probe throws, and the smoke reports a useless
        // "threw" instead of naming the cause.
        try {
        while (delta === null && !finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          for (const line of buffer.split(NL)) {
            if (!line.startsWith("data: ")) continue;
            const raw = line.slice(6).trim();
            if (raw === "[DONE]") { finished = true; break; }
            try {
              const parsed = JSON.parse(raw);
              const d = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
              const content = d && d.content;
              const reasoning = d && d.reasoning;
              if (typeof reasoning === "string" && reasoning.length > 0) sawReasoning = true;
              if (typeof content === "string" && content.length > 0) { delta = content; break; }
            } catch (e) { /* partial frame — wait for the rest */ }
          }
        }

        } catch (streamError) {
          return { skipped: String(streamError && streamError.message ? streamError.message : streamError) };
        }

        // Cancelling here also exercises the cancel path, which is what actually aborts
        // generation rather than merely detaching the reader.
        await reader.cancel().catch(() => {});
        return { delta, sawReasoning };
      })()
    `)) as { skipped?: string; error?: string; delta?: string | null; sawReasoning?: boolean };

    if (stream.skipped !== undefined) {
      console.log(`[smoke] transport: tutor stream not exercised — ${stream.skipped}`);
    } else if (stream.error !== undefined) {
      failures.push(`transport/chat ${stream.error}`);
    } else if (typeof stream.delta === "string" && stream.delta.length > 0) {
      console.log("[smoke] transport: tutor stream emits frames the panel parses");
    } else if (stream.sawReasoning === true) {
      /**
       * Reasoning but no answer. The transport is proven — output crossed the port, was framed as
       * SSE and parsed — so this is not a failure of the thing under test. It is a model that
       * thought for its whole budget, which the assessor now reports honestly rather than storing
       * as an empty `unknown`.
       */
      console.log("[smoke] transport: tutor stream carried reasoning frames but no answer");
    } else {
      failures.push("transport/chat produced no delta frame of any kind");
    }

    if (result.stage !== "ok") {
      failures.push(
        `transport/draft ${result.stage} returned ${String(result.status)} — the route table ` +
          `and its caller disagree about the verb or path`
      );
    } else if (result.source !== marker) {
      failures.push(`transport/draft did not round-trip: got ${String(result.source)}`);
    } else {
      console.log("[smoke] transport: draft PUT/GET round-tripped through the seam");
    }

    /**
     * The profile, which until now could be edited but not saved.
     *
     * The assertion that matters is not that PUT returns 200 — it is that a *second* GET
     * agrees with it. A route that echoed its own request back would satisfy the first and
     * fail the user, which is exactly what "editing your details cannot persist" looked
     * like from the outside.
     */
    const profile = (await window.webContents.executeJavaScript(`
      (async () => {
        const put = (payload) =>
          fetch("app://api/v1/profile", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          }).then(async (r) => (r.ok ? r.json() : { __status: r.status }));

        const get = () => fetch("app://api/v1/profile").then((r) => r.json());

        const marker = "smoke-" + String(Date.now());
        const saved = await put({
          name: marker,
          bio: "written by the transport smoke",
          birth_date: "1998-03-14",
          country: "Australia",
        });
        if (saved.__status) return { stage: "put", status: saved.__status };

        // The reload. Anything that only echoes the request passes above and fails here.
        const reloaded = await get();

        // Name only. Under a spread that treats absent as undefined-and-therefore-present,
        // this wipes the bio — the failure the seam's conditional spread exists to prevent.
        const nameOnly = await put({ name: marker + "-2" });

        // A date that does not exist. Must be 400, not 500: it is the user's input that is
        // wrong, and a 500 sends them looking for a bug in the app instead of at the field.
        const badDate = await fetch("app://api/v1/profile", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ birth_date: "2026-02-30" }),
        });

        const afterBadDate = await get();

        return {
          stage: "ok",
          savedName: saved.name ?? null,
          reloadedName: reloaded.name ?? null,
          reloadedBio: reloaded.bio ?? null,
          reloadedBirthDate: reloaded.birth_date ?? null,
          // Derived on read, never stored, so it cannot go stale on a birthday.
          age: reloaded.age ?? null,
          bioAfterNameOnlySave: nameOnly.bio ?? null,
          badDateStatus: badDate.status,
          // A rejected write must leave the stored profile untouched.
          birthDateAfterBadDate: afterBadDate.birth_date ?? null,
          // Fields a local install cannot know, and must not invent.
          email: reloaded.email === null ? "null" : String(reloaded.email),
          // Presence, not value. role used to be synthesised as "learner", and this probe read
          // reloaded.role ?? null — which cannot tell absent from present-and-null, so the field
          // could have come back as an explicit null and still looked removed.
          // (No backticks in this comment: it lives inside a template literal.)
          hasRole: "role" in reloaded,
        };
      })()
    `)) as Record<string, unknown>;

    if (profile.stage !== "ok") {
      failures.push(`transport/profile ${String(profile.stage)} failed: ${JSON.stringify(profile)}`);
    } else {
      if (profile.reloadedName !== profile.savedName) {
        failures.push(
          `transport/profile saved ${String(profile.savedName)} but a reload gave ${String(profile.reloadedName)}`
        );
      }
      if (profile.reloadedBio !== "written by the transport smoke") {
        failures.push(`transport/profile bio did not persist: ${String(profile.reloadedBio)}`);
      }
      if (profile.reloadedBirthDate !== "1998-03-14") {
        failures.push(`transport/profile birth date did not persist`);
      }
      if (typeof profile.age !== "number" || profile.age < 25) {
        failures.push(`transport/profile age was ${String(profile.age)}, expected it derived`);
      }
      if (profile.bioAfterNameOnlySave !== "written by the transport smoke") {
        failures.push("transport/profile a name-only save wiped the bio");
      }
      if (profile.badDateStatus !== 400) {
        failures.push(
          `transport/profile an impossible date answered ${String(profile.badDateStatus)}, want 400`
        );
      }
      if (profile.birthDateAfterBadDate !== "1998-03-14") {
        failures.push("transport/profile a rejected write changed the stored profile");
      }
      if (profile.email !== "null" || profile.hasRole !== false) {
        failures.push(
          `transport/profile invented an email or a role: email=${String(profile.email)} hasRole=${String(profile.hasRole)}`
        );
      }
      if (failures.length === 0) {
        console.log(
          `[smoke] transport: profile saved and survived a reload (age ${String(profile.age)} derived); ` +
            `a name-only save kept the bio; an impossible date was refused with 400 and changed nothing`
        );
      }
    }
  } catch (err) {
    failures.push(`transport/threw: ${(err as Error).message}`);
  }

  return failures;
}

/**
 * Poll a boolean expression in the renderer until it holds, or give up.
 *
 * Needed because there is no event for "React finished hydrating" — `did-finish-load` is
 * about the document, and anything client-only renders after it.
 */
async function waitFor(
  window: Electron.BrowserWindow,
  expression: string,
  timeoutMs = 10_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = (await window.webContents.executeJavaScript(`(() => ${expression})()`)) as boolean;
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * `--mode=study`: the restricted deployment.
 *
 * The unified window holds every privileged namespace, so this is the half that proves the
 * gate still does something. A restricted window must not merely be *denied* `fs:*` — the
 * namespaces must be absent from `host` entirely, which depends on `additionalArguments`
 * reaching the preload and on `contextBridge` behaving. Only a real sandboxed renderer shows
 * that; unit tests can only reach the broker.
 *
 * Kept because the mode machinery is what the unified window's safety argument leans on: the
 * claim is "capability follows consent and conversation, and the old window gate still works
 * where it is wanted", and an unexercised gate is not a gate.
 */
async function runRestrictedWindowSmoke(): Promise<string[]> {
  const failures: string[] = [];
  let window: Electron.BrowserWindow | undefined;

  try {
    window = createWindow({ mode: "study" });
    await new Promise<void>((resolve) =>
      window!.webContents.once("did-finish-load", () => resolve())
    );

    const report = (await window.webContents.executeJavaScript(`
      (() => {
        const h = window.host;
        return {
          windowMode: h?.windowMode ?? null,
          fsAbsent: h?.fs === undefined,
          ptyAbsent: h?.pty === undefined,
          lspAbsent: h?.lsp === undefined,
          visionAbsent: h?.vision === undefined,
          memoryAbsent: h?.memory === undefined,
          agentAbsent: h?.agent === undefined,
          namespaces: Object.keys(h ?? {}).sort().join(","),
        };
      })()
    `)) as Record<string, unknown>;

    const expect = (label: string, actual: unknown, wanted: unknown) => {
      if (actual !== wanted) {
        failures.push(`restricted/${label}: expected ${String(wanted)}, got ${String(actual)}`);
      }
    };

    expect("windowMode", report.windowMode, "study");
    expect("fs absent", report.fsAbsent, true);
    // Inline completion would finish the exercise on the first keystroke. In a restricted
    // deployment that is not a preference — the namespace is not there.
    expect("pty absent", report.ptyAbsent, true);
    expect("lsp absent", report.lspAbsent, true);
    /**
     * A Study window cannot ask what is in a screenshot of the user's screen.
     *
     * `vision:locate` runs a vision model over a renderer-supplied image and then searches the
     * project with what it read back. Neither half belongs in the restricted mode, and the
     * namespace being absent is the check — a channel that were merely unused here would
     * still be one `invoke` away.
     */
    expect("vision absent", report.visionAbsent, true);
    expect("memory absent", report.memoryAbsent, true);
    /**
     * No agent in a restricted window.
     *
     * The tutor surface already gets an empty tool list, so a run here could reach nothing —
     * but "it would have no tools" and "it cannot be started" are different guarantees, and
     * only the second survives someone later changing what the tutor is allowed.
     */
    expect("agent absent", report.agentAbsent, true);

    console.log(`[smoke] restricted window exposes: ${String(report.namespaces)}`);
  } catch (err) {
    failures.push(`restricted/threw: ${(err as Error).message}`);
  } finally {
    window?.destroy();
  }

  return failures;
}

/**
 * The modifier this platform's bindings actually want, as a `KeyboardEvent` property.
 *
 * SIX SMOKE CHECKS SENT `ctrlKey: true` ON EVERY PLATFORM, and six of the seven macOS failures in
 * the first readable CI run were that and nothing else: the command palette, the side bar, both
 * Ctrl+Enter runs, Ctrl+F reaching Monaco, and "the run never started" as a knock-on.
 *
 * `renderer/src/lib/shell/keybindings.ts` computes `wantMeta = binding.cmdOrCtrl && isMac` and then
 * requires `event.metaKey === wantMeta`. So a synthetic `ctrlKey: true` matches nothing on a Mac —
 * correctly, because a Mac user presses Cmd. The app was right and the smoke was asking it the
 * wrong question, which is the more dangerous way round: it reads as six broken features.
 *
 * Interpolated into the `executeJavaScript` payloads rather than branched inside them, so there is
 * one place to read and no chance of two payloads disagreeing.
 */
const CMD_OR_CTRL = process.platform === "darwin" ? "metaKey: true" : "ctrlKey: true";

/**
 * A temp project root whose path is already its own realpath, on every platform.
 *
 * WHY THIS IS NOT JUST `mkdtemp`. `workspace.ts`'s `bindRoot` canonicalises whatever root it is
 * given, through `fs.realpathSync.native` — added because every path the user sees was otherwise
 * computed against the wrong spelling. Several things are then KEYED BY THAT ROOT, and the agent's
 * transcript is one: `recentRuns(projectRoot)` called with the raw `mkdtemp` result finds nothing a
 * run wrote under the canonical one.
 *
 * So the smoke reported `agent/expected one proposed diff, got 0` on Windows, whose runner home
 * `runneradmin` has the 8.3 alias `RUNNER~1`, and on macOS, where `/var/folders` resolves to
 * `/private/var/folders` — and passed on Linux and on any developer machine whose `os.tmpdir()` is
 * already canonical. A regression from the fix, wearing the costume of a broken agent. Three
 * guesses went to the provider before instrumentation showed it resolving a model perfectly.
 *
 * `realpathSync.native`, not `realpathSync`: the plain one resolves symlinks and returns an 8.3
 * short name UNCHANGED, which would have fixed macOS and left Windows exactly as it was. And the
 * promises API has no `.native` at all — checked, rather than assumed, after assuming it once.
 *
 * Resolved HERE rather than beside each caller, for the reason `bindRoot` gives: one call site
 * forgetting is the same bug again, and no assertion would notice.
 */
async function smokeProjectRoot(tag: string): Promise<string> {
  const fsp = await import("node:fs/promises");
  const fsSync = await import("node:fs");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const made = await fsp.mkdtemp(nodePath.join(os.tmpdir(), `voidcode-smoke-${tag}-`));
  return fsSync.realpathSync.native(made);
}


/**
 * The IDE renders at `/build`, inside the ordinary app window.
 *
 * This catches a failure that would otherwise be silent: `/build` missing from the static
 * export. The SPA fallback answers an unknown extensionless path with `index.html`, so a
 * missing route does not 404 — it quietly renders the dashboard instead.
 */
async function runBuildSmoke(): Promise<string[]> {
  const failures: string[] = [];
  let window: Electron.BrowserWindow | undefined;

  try {
    window = createWindow({ mode: "build", route: "/build" });
    await new Promise<void>((resolve) => window!.webContents.once("did-finish-load", () => resolve()));

    // `did-finish-load` fires when the document is loaded, not when React has hydrated. The
    // nav is prerendered static HTML and appears immediately; the workspace body is
    // client-only, so asserting straight after the load event sees an empty column and
    // reports the IDE as broken. Wait for the app to actually mount.
    const hydrated = await waitFor(window, `/assistant/i.test(document.body.innerText)`);
    if (!hydrated) failures.push("build/workspace did not hydrate within 10s");

    const report = (await window.webContents.executeJavaScript(`
      (() => {
        const h = window.host;
        return {
          windowMode: h?.windowMode ?? null,
          hasFs: typeof h?.fs === "object" && h.fs !== null,
          fsMethods: Object.keys(h?.fs ?? {}).sort().join(","),
          visionMethods: Object.keys(h?.vision ?? {}).sort().join(","),
          vaultHasNoGetter: typeof h?.vault?.get === "undefined",
          // React mounted and this is the Build route, not the SPA fallback's homepage.
          onBuildRoute: location.pathname === "/build",
          // The workbench frame is present — this is the IDE inside the shell, not a
          // standalone surface. Checked via the menu bar, which is text; the activity bar
          // is icons and carries no words to match on.
          renderedAppNav: document.body.innerText.includes("Terminal") &&
                          document.body.innerText.includes("Selection"),
          // The rail lights the destination the route belongs to. Asserted through the DOM
          // rather than by eye, because "which icon looks brighter" is not a check.
          activeDestination:
            document.querySelector('nav[aria-label="Destinations"] [aria-current="page"]')
              ?.getAttribute("title") ?? null,
          // Case-insensitive: innerText applies text-transform, so the panel's
          // uppercase label comes back as "ASSISTANT".
          // (No backticks in here — this whole block is inside a template literal.)
          renderedEditorChrome: /assistant/i.test(document.body.innerText),
          mountedSomething: document.body.innerText.trim().length > 0,
        };
      })()
    `)) as Record<string, unknown>;

    const expect = (label: string, actual: unknown, wanted: unknown) => {
      if (actual !== wanted) failures.push(`build/${label}: expected ${String(wanted)}, got ${String(actual)}`);
    };

    expect("windowMode", report.windowMode, "build");
    expect("fs namespace present", report.hasFs, true);
    // Sorted, exact, and deliberately brittle: this is the privileged surface, so a method
    // appearing here should require someone to have decided it belongs. `save` and
    // `confirmDiscard` arrived with Build-mode saving.
    expect(
      "fs methods",
      report.fsMethods,
      "commitDiff,confirmDiscard,create,currentProject,delete,openProject,openRecent,read,rename,save,saveAs,search,tree,writeWithDiff"
    );
    expect("vault still has no getter", report.vaultHasNoGetter, true);
    // One method, and the exact name matters: the preload generates `host.vision.locate` from
    // the contract, so this failing means the channel was renamed or a second one appeared.
    expect("vision methods", report.visionMethods, "locate");
    /**
     * The command palette, driven the way a user reaches it.
     *
     * It has no unit test — it is shell state plus a keyboard listener — so this opens it
     * with the real accelerator and reads back what it offered. The assertion is that
     * *problems* are in there: the palette listed only destinations until now, and the
     * problem list arrives asynchronously, so "it rendered" and "it found the catalogue"
     * are different claims.
     */
    const palette = (await window.webContents.executeJavaScript(`
      (async () => {
        // \`code\` as well as \`key\`, because that is what a real keystroke carries and what
        // the dispatcher matches on. Matching the physical key is what keeps Alt+Arrow
        // bindings alive on layouts where Alt changes the produced character — so an event
        // with only \`key\` is not a keystroke this app would ever see.
        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "k", code: "KeyK", ${CMD_OR_CTRL}, bubbles: true,
        }));

        // Opening is a state update; give React a frame to commit it.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const dialog = document.querySelector('[role="dialog"][aria-label="Command palette"]');
        if (dialog === null) return { open: false };

        const groups = Array.from(dialog.querySelectorAll("p[aria-hidden]"))
          .map((p) => p.textContent.trim());
        const rows = dialog.querySelectorAll("li button").length;

        // Two rows with the same visible text is the symptom a duplicate id produces —
        // DESTINATIONS yielded an entry for the section-less "code" destination and a
        // hardcoded one sat right after it, so the palette listed Code twice.
        //
        // TYPED, NOT READ STRAIGHT OFF THE OPEN PALETTE, and that is not fussiness: with an
        // empty query each group is capped at five rows, the Go group already has exactly
        // five, and the duplicate sixth was silently truncated out of the DOM. The check
        // passed against a palette that really did contain the bug. Filtering lifts the cap.
        //
        // Asserted on the DOM rather than on React's duplicate-key warning, because console
        // errors are only collected inside the screenshot block (VOIDCODE_SMOKE_SHOTS), so
        // leaning on that warning would be a check that never runs in CI.
        const input = dialog.querySelector("input");
        const setValue = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, "value"
        ).set;
        setValue.call(input, "o");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        const labels = Array.from(dialog.querySelectorAll("li button")).map((b) =>
          b.textContent.replace(/\s+/g, " ").trim()
        );
        const seen = new Set();
        const repeated = labels.filter((l) => (seen.has(l) ? true : (seen.add(l), false)));

        setValue.call(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));

        // Leave it closed so the screenshot below is of the workspace, not the palette.
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        if (input !== null) {
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        }

        return { open: true, groups, rows, repeated };
      })()
    `)) as { open: boolean; groups?: string[]; rows?: number; repeated?: string[] };

    if (!palette.open) {
      failures.push("build/command palette did not open on Ctrl+K");
    } else if (!(palette.groups ?? []).includes("Problems")) {
      failures.push(
        `build/palette offered no Problems group — groups were ${JSON.stringify(palette.groups)}`
      );
    } else if ((palette.repeated ?? []).length > 0) {
      failures.push(
        `build/palette listed the same row twice: ${JSON.stringify(palette.repeated)}`
      );
    } else {
      console.log(
        `[smoke] palette: ${String(palette.rows)} entries across ${(palette.groups ?? []).join(", ")}`
      );
    }

    /**
     * A panel accelerator, which is the thing this whole keyboard phase is for.
     *
     * ⌘K above proves the dispatcher runs, but ⌘K already worked — it had a hand-rolled
     * listener precisely because someone noticed the menu's accelerators were dead. Ctrl+B is
     * the honest test: on Windows and Linux `Menu.setApplicationMenu(null)` means no menu
     * accelerator has ever fired, so before this phase nothing happened when you pressed it.
     */
    const accelerator = (await window.webContents.executeJavaScript(`
      (async () => {
        // The section rail only exists on a destination that has sections, and only while
        // the left panel is open — so go somewhere it is rendered rather than assuming the
        // window is still wherever the previous probe left it.
        if (!location.pathname.startsWith("/homepage")) {
          history.pushState({}, "", "/homepage");
          window.dispatchEvent(new PopStateEvent("popstate"));
          await new Promise((r) => setTimeout(r, 600));
        }

        const rail = () => document.querySelector("aside");
        const before = rail() !== null;

        const press = (code, key) =>
          window.dispatchEvent(new KeyboardEvent("keydown", {
            key, code, ${CMD_OR_CTRL}, bubbles: true,
          }));
        const settle = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        press("KeyB", "b");
        await settle();
        const afterToggle = rail() !== null;

        // Put it back, so the screenshots below are of the normal layout.
        press("KeyB", "b");
        await settle();
        const afterRestore = rail() !== null;

        // THE STEP THAT IS EASY TO GET WRONG, and it needs a chord that is IN the table but
        // not currently bound — not one the table has never heard of, which exits at the
        // no-match branch and proves nothing.
        //
        // Ctrl+Enter is exactly that here: \`run.execute\` is a real binding, and the
        // dashboard does not mount the workspace that provides it. A matched-but-disabled
        // chord must fall through WITHOUT preventDefault, so the key still reaches Monaco or
        // the browser. Swallowing it would make honest-disable a lie at the keyboard.
        const disabled = new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", ${CMD_OR_CTRL}, bubbles: true, cancelable: true,
        });
        window.dispatchEvent(disabled);

        return {
          before,
          afterToggle,
          afterRestore,
          disabledWasConsumed: disabled.defaultPrevented,
        };
      })()
    `)) as Record<string, unknown>;

    if (accelerator.before !== true) {
      failures.push("build/accelerator probe started with no side bar to toggle");
    } else if (accelerator.afterToggle !== false) {
      failures.push("build/Ctrl+B did not hide the primary side bar");
    } else if (accelerator.afterRestore !== true) {
      failures.push("build/Ctrl+B did not bring the primary side bar back");
    } else if (accelerator.disabledWasConsumed !== false) {
      failures.push("build/the dispatcher swallowed Ctrl+Enter where run.execute is unbound");
    } else {
      console.log(
        "[smoke] keyboard: Ctrl+B toggled the side bar; Ctrl+Enter fell through where Run is unbound"
      );
    }

    /**
     * An editor command, end to end.
     *
     * The longest chain in the app: keystroke -> capture-phase dispatcher -> registry ->
     * the Monaco instance the workspace published -> the editor action. Nothing in this app
     * held that instance until now — a repo-wide search for onMount or getAction returned
     * nothing — so Find, Replace and the selection commands had no way to reach the thing
     * they operate on.
     *
     * Asserted on the find widget appearing, because that is the only proof the whole chain
     * connected. A registry that ran the command and an editor that ignored it look identical
     * from every other angle.
     */
    await window.loadURL(`${APP_ORIGIN}/problems/1`);
    await waitFor(window, `document.querySelector(".monaco-editor") !== null`);

    const editorCommand = (await window.webContents.executeJavaScript(`
      (async () => {
        const settle = () =>
          new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        /**
         * Wait for the editor to be WIRED, not merely present.
         *
         * A .monaco-editor node in the DOM is not the same as a working editor:
         * monaco-editor/react mounts the element and attaches its model in an effect afterwards, so
         * there is a window where the node exists and a dispatched keystroke reaches nothing. The
         * outer waitFor only proves the node arrived.
         *
         * A registered model is the first observable evidence that the editor is live. This probe
         * flaked twice — once on a flat 400ms wait, then again on a 6s poll for the widget — and both
         * times the real cause was here rather than at the other end. The split probe that used to
         * live in this file recorded exactly this hazard, and deleting it took the note with it.
         */
        const until = async (fn, ms = 10000) => {
          const deadline = Date.now() + ms;
          while (Date.now() < deadline) {
            if (fn()) return true;
            await new Promise((r) => setTimeout(r, 100));
          }
          return false;
        };

        const surface = document.querySelector(".monaco-editor");
        if (surface === null) return { stage: "no editor" };
        if (!(await until(() => (window.monaco?.editor?.getModels?.() ?? []).length > 0))) {
          return { stage: "editor never wired a model" };
        }

        // Monaco needs focus for its actions to have a selection to act on, and the command
        // binding focuses first for exactly that reason. Clicking is how a user gets there.
        surface.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        await settle();

        const before = document.querySelector(".find-widget") !== null;

        const pressCtrlF = () => {
          window.dispatchEvent(new KeyboardEvent("keydown", {
            key: "f", code: "KeyF", ${CMD_OR_CTRL}, bubbles: true, cancelable: true,
          }));
        };

        /**
         * Polled, not slept. This was a flat 400ms followed by one look, and it flaked — the find
         * widget animates in, and on a busy run 400ms is sometimes not enough. It failed once
         * against a build where the whole chain was working, which is the same cost as a stale
         * assertion: CI gates the installer on this smoke, so a probe that is right 95% of the
         * time blocks one release in twenty for no reason.
         *
         * The deadline is generous because being slow is not the failure under test. What is
         * under test is whether the command reached the editor at all.
         */
        const isVisible = () => {
          const w = document.querySelector(".find-widget");
          return w !== null && w.classList.contains("visible");
        };

        /**
         * THE KEYSTROKE IS RE-SENT EACH ROUND, and that is the fix rather than a longer wait.
         *
         * A registered Monaco model is not the same as a registered *command*. Publishing the
         * instance sets React state, useEditorCommands recomputes its supported set in an effect,
         * and only then does useRegisterCommands bind edit.find. The wait above clears as soon as
         * Monaco creates the model, which can be several effect ticks earlier — so on a contended
         * run the one dispatch landed before anything was listening.
         *
         * Polling after a lost keystroke can never recover: the widget opens in response to a
         * keypress, so there is nothing for the poll to observe. That is why the previous fix —
         * "poll for the widget instead of sleeping 400ms" — did not stop the flake, and this is
         * its third occurrence. Re-pressing makes the probe insensitive to the ordering entirely,
         * while still testing exactly what it claims: that a Ctrl+F reaches the editor.
         */
        await until(() => {
          if (isVisible()) return true;
          pressCtrlF();
          return false;
        });
        await settle();
        if (isVisible()) return { stage: "ok", before, visible: true };

        /**
         * The chain has four links and "did not open" named none of them, which cost a round of
         * guessing. So when the keystroke route fails, ask Monaco directly: if the action runs
         * and the widget appears, Monaco and the selector are fine and the break is upstream in
         * publish -> registry -> keybinding. If it does not, the break is at the editor end.
         */
        const monacoEditor = window.monaco?.editor?.getEditors?.()[0];
        const action = monacoEditor?.getAction?.("actions.find");
        const diagnosis = {
          editors: window.monaco?.editor?.getEditors?.().length ?? 0,
          actionExists: action != null,
          isSupported: action?.isSupported?.() ?? null,
          direct: null,
        };
        if (action != null) {
          monacoEditor.focus();
          await action.run();
          await until(isVisible, 3000);
          diagnosis.direct = isVisible();
        }
        return { stage: "ok", before, visible: false, diagnosis };
      })()
    `)) as Record<string, unknown>;

    if (editorCommand.stage !== "ok") {
      failures.push(`transport/editor command ${String(editorCommand.stage)}`);
    } else if (editorCommand.before === true) {
      failures.push("transport/the find widget was already open, so the test proves nothing");
    } else if (editorCommand.visible !== true) {
      failures.push(
        "transport/Ctrl+F did not open Monaco's find widget " +
          `(${JSON.stringify(editorCommand.diagnosis)}; ` +
          "direct:true means Monaco is fine and the break is publish -> registry -> keybinding)"
      );
    } else {
      console.log("[smoke] editor: Ctrl+F reached Monaco through the registry");
    }

    /**
     * Run, from the keyboard.
     *
     * Ctrl+Enter is the shortcut CodeColumn's tooltip has advertised since long before
     * anything listened for it. This asserts the whole chain — keystroke, dispatcher,
     * registry, the actions WorkspaceClient publishes — by watching the test console leave
     * idle, which only a real execution does.
     *
     * Still on /problems/1 from the editor probe above.
     */
    const runCommand = (await window.webContents.executeJavaScript(`
      (async () => {
        // The Execution tab becoming selected, which TestConsole does the moment
        // executionState goes to "running" — and, crucially, does not undo when the run
        // settles. A durable signal.
        //
        // Two earlier attempts at this were wrong in instructive ways. Matching page text for
        // "Output"/"Passed" was green before any run, because those words are on the page
        // anyway. Watching the Run button's disabled flag was correct but transient: the run
        // finishes in single-digit milliseconds here, so it flipped back between polls and
        // the assertion missed it.
        const tab = () =>
          Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent.trim() === "Execution"
          );
        const selected = () => tab()?.className.includes("font-medium") === true;

        if (tab() === undefined) return { stage: "no execution tab" };
        if (selected()) return { stage: "execution tab was already selected" };

        // Escape first: the editor probe above left Monaco's find widget open, and it takes
        // Enter for "find next".
        document.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Escape", code: "Escape", bubbles: true,
        }));
        await new Promise((r) => setTimeout(r, 200));

        window.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Enter", code: "Enter", ${CMD_OR_CTRL}, bubbles: true, cancelable: true,
        }));

        const deadline = Date.now() + 20000;
        let switched = false;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          if (selected()) { switched = true; break; }
        }

        return { stage: "ok", switched };
      })()
    `)) as Record<string, unknown>;

    if (runCommand.stage !== "ok") {
      failures.push(`transport/run probe could not start: ${String(runCommand.stage)}`);
    } else if (runCommand.switched !== true) {
      failures.push("transport/Ctrl+Enter did not start a run in the workspace");
    } else {
      console.log("[smoke] workspace: Ctrl+Enter started a run through the registry");
    }

    /**
     * Stop is enabled exactly while something is running — the inverse of every other Run
     * item, and the only reason Stop is worth having.
     *
     * RECORDED, NOT POLLED, and that distinction is the whole assertion.
     *
     * The obvious version — dispatch Ctrl+Enter, then read `menuStateFor` in a loop — was
     * written first and reported "run.stop never became enabled" while the binding was
     * correct all along. Menu state is a stream of pushes; reading it back only ever shows
     * the latest one. A run here settles in single-digit milliseconds (the probe above says
     * so in its own comment), so the busy state is pushed and superseded between two reads,
     * and no poll interval fixes that — the window is not a duration, it is two messages.
     *
     * So `__observeMenuState` records every push instead, and the assertion is that one of
     * them had Stop live. Both edges are checked: a state where Run is dead proves the
     * workspace actually went busy, which tells a wrong binding apart from a run that never
     * started.
     *
     * Waiting for idle first matters as much. The probe above returns as soon as the console
     * switches tabs, which happens when a run STARTS — dispatching into a workspace that is
     * still busy would hit a disabled `run.execute`, the dispatcher would decline it, and
     * nothing would run at all.
     */
    {
      const { menuStateFor, __observeMenuState } = await import("./menu.js");

      const idleBy = Date.now() + 30_000;
      while (
        Date.now() < idleBy &&
        !menuStateFor(window.webContents).enabled.has("run.execute" as never)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      let sawStopWhileBusy = false;
      let sawBusy = false;
      let sawStopWhileIdle = false;
      __observeMenuState((sender, state) => {
        if (sender !== window!.webContents) return;
        const stop = state.enabled.has("run.stop" as never);
        // Busy is defined as Run being dead, which is the state the user is in when they
        // want Stop. Reading it off the same push as Stop is what makes this an assertion
        // about a single moment rather than two unrelated ones.
        const busy = !state.enabled.has("run.execute" as never);
        if (busy) sawBusy = true;
        if (stop && busy) sawStopWhileBusy = true;
        // The inverse, and the reason the two are not counted separately: `enabled:
        // !workspace.busy` — the plausible way to get this backwards — leaves Stop live at
        // idle. Tallying "Stop was enabled at some point" would have passed that.
        if (stop && !busy) sawStopWhileIdle = true;
      });

      try {
        await window.webContents.executeJavaScript(`
          new Promise((done) => {
            window.dispatchEvent(new KeyboardEvent("keydown", {
              key: "Enter", code: "Enter", ${CMD_OR_CTRL}, bubbles: true, cancelable: true,
            }));
            // Long enough for the run to settle and push its idle state, so the recorder
            // has both edges before it is torn down.
            setTimeout(done, 5000);
          })
        `);
      } finally {
        __observeMenuState(undefined);
      }

      if (!sawBusy) {
        failures.push("transport/the run never started, so Stop's enablement went untested");
      } else if (!sawStopWhileBusy) {
        failures.push("transport/the workspace went busy but run.stop stayed greyed");
      } else if (sawStopWhileIdle) {
        failures.push("transport/run.stop was live while nothing was running");
      } else {
        console.log("[smoke] workspace: Stop is live exactly while a run is in flight");
      }
    }

    /**
     * And the other half of the same claim: on a page with no workspace, Run is not merely
     * inert — it is absent from the registry, so the menu greys it and the palette omits it.
     *
     * This is the assertion that would catch a route check creeping in. Enablement is meant
     * to fall out of what is mounted; if someone later special-cases a path, Run would stay
     * enabled here and this fails.
     */
    await window.loadURL(`${APP_ORIGIN}/homepage`);
    await waitFor(window, `(document.querySelector("main")?.innerText.trim().length ?? 0) > 0`);
    await new Promise((resolve) => setTimeout(resolve, 800));

    {
      const { menuStateFor } = await import("./menu.js");
      const enabled = menuStateFor(window.webContents).enabled;
      const live = ["run.execute", "run.submit", "run.reset", "run.stop"].filter((id) =>
        enabled.has(id as never)
      );

      if (live.length > 0) {
        failures.push(`transport/Run stayed enabled on the dashboard: ${live.join(",")}`);
      } else {
        console.log("[smoke] workspace: Run is absent from the registry where no editor is mounted");
      }

      /**
       * Account reaches main, which is the one link the unit tests cannot see.
       *
       * `menu.test.ts` proves the table is coherent and that a bound command is enabled in
       * the submenu; `destinations.test.ts` proves the shell binds this one. Neither observes
       * the push itself — and the push is what the native menu is built from, so a command
       * that never arrives is greyed no matter how correct both ends are. Reading it off the
       * state main actually holds is the only assertion that covers the whole path.
       *
       * On the dashboard deliberately: account is platform-level, so unlike Run it must be
       * live on a route that belongs to the other product entirely.
       */
      if (!enabled.has("go.account" as never)) {
        failures.push("shell/Account never reached main, so the Go menu would grey it");
      } else {
        console.log("[smoke] shell: Account is live in the native menu from any surface");
      }
    }

    /**
     * The toast surface, checked for existence rather than by triggering one.
     *
     * Every real trigger needs an open project and an applied diff, which the smoke cannot
     * reach — so this asserts the provider is mounted and renders nothing while idle. That
     * second half is the part worth pinning: an always-present empty container would sit
     * over the bottom-right corner of the editor swallowing clicks.
     */
    const toasts = (await window.webContents.executeJavaScript(`
      (() => {
        const live = document.querySelectorAll('[role="status"][aria-live="polite"]');
        return { idleCount: live.length };
      })()
    `)) as { idleCount: number };

    if (toasts.idleCount !== 0) {
      failures.push(`build/${toasts.idleCount} toast container(s) rendered while idle`);
    }

    expect("on /build", report.onBuildRoute, true);
    expect("react mounted", report.mountedSomething, true);
    /**
     * OFF macOS ONLY, because on macOS this is not in the page to find.
     *
     * `renderedAppNav` matches the menu bar's own words — "Terminal" and "Selection" — in
     * `document.body.innerText`. Electron puts the application menu in the SYSTEM menu bar on
     * darwin, so the page contains none of its labels and this reported
     * `expected true, got false` there while passing on the other two. Nothing was broken: the
     * check was asking a Windows and Linux question on a Mac.
     *
     * It only became visible once the Cmd/Ctrl fix cleared the six keybinding failures ahead of it,
     * which is the second time in this file that fixing one platform assumption exposed another.
     *
     * THE FRAME IS STILL ASSERTED ON ALL THREE, which is what makes this a narrowing rather than a
     * hole: `activeDestination` below reads `nav[aria-label="Destinations"]` out of the DOM, and
     * `renderedEditorChrome` matches the assistant panel's label. Both exist on macOS. What is
     * skipped there is the in-window menu bar specifically — and the native menu has its own check,
     * printed as `[smoke] shell: Account is live in the native menu from any surface`.
     */
    if (process.platform !== "darwin") {
      expect("in-window menu bar rendered", report.renderedAppNav, true);
    }
    expect("editor chrome rendered", report.renderedEditorChrome, true);
    expect("Code lit in the activity bar", report.activeDestination, "Code");

    // The write path's central claim, exercised against a real diff rather than a unit stub:
    // proposing must not create the file.
    const proposal = (await window.webContents.executeJavaScript(`
      window.host.fs.writeWithDiff({ path: "../escape.txt", next: "x" })
        .then(() => "ACCEPTED")
        .catch(e => e.message.includes("No project is open") ? "NO_PROJECT" : "REFUSED")
    `)) as string;
    // No project is open in the smoke run, so confinement cannot be reached — but it must
    // fail closed rather than accept the path.
    if (proposal === "ACCEPTED") {
      failures.push("build/writeWithDiff accepted a path with no project open");
    }

    console.log(`[smoke] Build exposes fs: ${String(report.fsMethods)}`);

    /**
     * A real shell, through the real port transport.
     *
     * `pty:spawn` sat in the contract with no handler from Phase 1 onward, and the Terminal
     * menu said so with two hardcoded disabled items. This asserts the whole thing: the
     * N-API prebuild loads under Electron without a rebuild, main refuses without a project,
     * and bytes make the round trip renderer -> pty -> renderer.
     *
     * Reports "not exercised" rather than failing if the optional prebuild is missing for
     * this platform, matching how the tutor stream handles an absent model. A missing
     * binary should grey the Terminal menu, not fail the build.
     */
    {
      const { isTerminalAvailable } = await import("./terminal/pty.js");
      const { __setProjectRoot } = await import("./workspace.js");

      if (!isTerminalAvailable()) {
        console.log("[smoke] terminal: not exercised — no pty binary for this platform");
      } else {
        const os = await import("node:os");
        const fsp = await import("node:fs/promises");
        const nodePath = await import("node:path");

        // Refuses before a project is open: the folder-picker consent is what makes running
        // a shell in that directory legitimate.
        __setProjectRoot(window!.webContents, undefined);
        const refused = (await window!.webContents.executeJavaScript(`
          window.host.pty.spawn({ cols: 80, rows: 24 })
            .then(() => ({ spawned: true }))
            .catch((e) => ({ spawned: false, message: String(e && e.message) }))
        `)) as Record<string, unknown>;

      /**
       * CANONICALISED, because `bindRoot` canonicalises and several things are KEYED BY THE ROOT.
       *
       * `workspace.ts` resolves a bound root through `fs.realpathSync.native` — added to fix every
       * displayed path being computed against the wrong spelling. That made the root main stores
       * differ from the raw `mkdtemp` result wherever the two spellings differ, and the agent's
       * transcript is keyed by project root: `recentRuns(projectRoot)` from the RAW path found
       * nothing the run had written under the CANONICAL one, so the smoke reported
       * "agent/expected one proposed diff, got 0".
       *
       * A REGRESSION FROM THAT FIX, and the platforms tell the story: it failed on Windows, whose
       * runner home `runneradmin` has the 8.3 alias `RUNNER~1`, and on macOS, where `/var/folders`
       * resolves to `/private/var/folders` — and passed on Linux and on this machine, where
       * `os.tmpdir()` is already its own realpath. Three guesses were spent on the provider before
       * instrumentation showed it resolving a model perfectly and the diff simply not being found.
       */
        const projectRoot = await smokeProjectRoot("pty");
        __setProjectRoot(window!.webContents, projectRoot);

        const marker = "voidcode-terminal-smoke";
        const session = (await window!.webContents.executeJavaScript(`
          (async () => {
            const term = await window.host.pty.spawn({ cols: 80, rows: 24 });
            let out = "";
            term.onChunk((m) => { if (m && m.t === "data") out += m.d; });

            // A command whose echo proves the bytes went both ways: the shell had to receive
            // the write and produce output for the marker to come back.
            term.send({ t: "data", d: "echo ${marker}" + String.fromCharCode(13) });

            const deadline = Date.now() + 12000;
            while (Date.now() < deadline && !out.includes("${marker}")) {
              await new Promise((r) => setTimeout(r, 100));
            }

            const saw = out.includes("${marker}");
            term.send({ t: "resize", cols: 100, rows: 30 });
            term.close();
            return { saw, bytes: out.length };
          })()
        `)) as Record<string, unknown>;

        await fsp.rm(projectRoot, { recursive: true, force: true }).catch(() => {});
        __setProjectRoot(window!.webContents, undefined);

        if (refused.spawned !== false) {
          failures.push("build/pty:spawn started a shell with no project open");
        } else if (!String(refused.message).includes("project")) {
          failures.push(`build/pty:spawn refused without saying why: ${String(refused.message)}`);
        } else if (session.saw !== true) {
          failures.push(
            `build/terminal did not echo the marker back (${String(session.bytes)} bytes seen)`
          );
        } else {
          console.log(
            `[smoke] terminal: refused without a project, then echoed through the port (${String(session.bytes)} bytes)`
          );
        }
      }
    }

    /**
     * Saving, through the real transport.
     *
     * Build mode could open a project, read a file into Monaco and let you type, with nowhere
     * to put it — `host.fs` had no write the editor could reach, and closing a tab dropped
     * the buffer without asking. This asserts the write lands, the baseline guard refuses a
     * stale save, and confinement still holds for the new path.
     *
     * `__setProjectRoot` is the seam the diff tests already use, pointed at a temp directory,
     * so the smoke never writes into anyone's real project.
     */
    {
      const { __setProjectRoot } = await import("./workspace.js");
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const nodePath = await import("node:path");

      const projectRoot = await smokeProjectRoot("save");
      __setProjectRoot(window!.webContents, projectRoot);

      const save = (payload: unknown): Promise<Record<string, unknown>> =>
        // `window!`, matching this function's existing style: it is assigned at the top of
        // the try and TypeScript cannot narrow it inside a closure.
        window!.webContents.executeJavaScript(`
          window.host.fs.save(${JSON.stringify(payload)})
            .then((r) => ({ ok: true, ...r }))
            .catch((e) => ({ ok: false, message: String(e && e.message) }))
        `) as Promise<Record<string, unknown>>;

      const created = await save({ path: "smoke.py", contents: "x = 1", baseline: null });
      const onDisk = await fsp
        .readFile(nodePath.join(projectRoot, "smoke.py"), "utf8")
        .catch(() => undefined);

      // A save against a baseline that no longer matches must refuse, or the assistant's
      // writes and the user's could silently overwrite each other.
      const stale = await save({ path: "smoke.py", contents: "x = 2", baseline: "something else" });
      const afterStale = await fsp
        .readFile(nodePath.join(projectRoot, "smoke.py"), "utf8")
        .catch(() => undefined);

      // The same confinement the diff path has. Without it, "save" is arbitrary file write.
      const escape = await save({ path: "../escaped.py", contents: "x", baseline: null });

      // Find in Files, over the file the save just created, through the same transport. The
      // unit tests cover the walk and its bounds; what only the real seam can show is that
      // the channel is reachable from the renderer and comes back shaped as the panel reads it.
      const found = (await window!.webContents.executeJavaScript(`
        window.host.fs.search({ query: "x = 1" })
          .then((r) => ({ ok: true, ...r }))
          .catch((e) => ({ ok: false, message: String(e && e.message) }))
      `)) as Record<string, unknown>;
      const matches = (found.matches ?? []) as { path?: string; line?: number }[];

      /**
       * File operations, through the real transport, in the order a user performs them.
       *
       * The unit tests cover confinement and the refusals; what only the seam can show is that
       * the four new channels are reachable from a renderer and agree with each other — that
       * `fs:tree` sees what `fs:create` made, and stops seeing what `fs:delete` removed. A
       * create whose result never appears in the tree is the shape of bug that leaves a
       * sidebar quietly disagreeing with the disk.
       */
      const lifecycle = (await window!.webContents.executeJavaScript(`
        (async () => {
          const names = async () => {
            const { tree } = await window.host.fs.tree();
            return tree.entries.map((e) => e.name).sort().join(",");
          };
          await window.host.fs.create({ path: "made-by-smoke.py", kind: "file" });
          const afterCreate = await names();
          await window.host.fs.rename({ from: "made-by-smoke.py", to: "renamed-by-smoke.py" });
          const afterRename = await names();
          await window.host.fs.delete({ path: "renamed-by-smoke.py" });
          const afterDelete = await names();

          // Refusals reach the renderer as messages, not as silence.
          const overwrite = await window.host.fs
            .create({ path: "smoke.py", kind: "file" })
            .then(() => null)
            .catch((e) => String(e && e.message));
          const escape = await window.host.fs
            .create({ path: "../escaped-by-smoke.py", kind: "file" })
            .then(() => null)
            .catch((e) => String(e && e.message));

          return JSON.stringify({ afterCreate, afterRename, afterDelete, overwrite, escape });
        })()
      `)) as string;


      await fsp.rm(projectRoot, { recursive: true, force: true });
      __setProjectRoot(window!.webContents, undefined);

      if (created.ok !== true) {
        failures.push(`build/fs:save refused a legitimate write: ${String(created.message)}`);
      } else if (onDisk !== "x = 1") {
        failures.push(`build/fs:save reported success but wrote ${String(onDisk)}`);
      } else if (stale.ok !== false) {
        failures.push("build/fs:save overwrote a file that had changed underneath it");
      } else if (!String(stale.message).includes("changed on disk")) {
        failures.push(`build/fs:save refused a stale write without saying why: ${String(stale.message)}`);
      } else if (afterStale !== "x = 1") {
        failures.push("build/fs:save modified the file while refusing the write");
      } else if (escape.ok !== false) {
        failures.push("build/fs:save wrote outside the project root");
      } else if (found.ok !== true) {
        failures.push(`build/fs:search failed through the seam: ${String(found.message)}`);
      } else if (matches.length !== 1 || matches[0]?.path !== "smoke.py") {
        failures.push(
          `build/fs:search did not find the file it just wrote: ${JSON.stringify(matches)}`
        );
      } else {
        console.log(
          "[smoke] save: wrote through the seam, refused a stale baseline by name, refused to escape the root"
        );
        console.log(`[smoke] search: found ${String(matches[0]?.path)}:${String(matches[0]?.line)}`);
      }

      const steps = JSON.parse(lifecycle) as {
        afterCreate: string;
        afterRename: string;
        afterDelete: string;
        overwrite: string | null;
        escape: string | null;
      };
      const has = (list: string, name: string) => list.split(",").includes(name);

      if (!has(steps.afterCreate, "made-by-smoke.py")) {
        failures.push(`build/fs:create did not appear in the tree: ${String(steps.afterCreate)}`);
      } else if (has(steps.afterRename, "made-by-smoke.py") || !has(steps.afterRename, "renamed-by-smoke.py")) {
        failures.push(`build/fs:rename left the tree wrong: ${String(steps.afterRename)}`);
      } else if (has(steps.afterDelete, "renamed-by-smoke.py")) {
        failures.push(`build/fs:delete left the entry in the tree: ${String(steps.afterDelete)}`);
      } else if (steps.overwrite === null || !steps.overwrite.includes("already exists")) {
        // Silently truncating an existing file is data loss with a friendly name on it.
        failures.push(`build/fs:create overwrote an existing file (${String(steps.overwrite)})`);
      } else if (steps.escape === null) {
        failures.push("build/fs:create wrote outside the project root");
      } else {
        console.log(
          "[smoke] fs ops: created, renamed and deleted through the tree; refused an overwrite and an escape"
        );
      }

    }

    /**
     * The API key, against the real credential store.
     *
     * `tests/vault.test.ts` covers the policy exhaustively, but every branch of it runs against a
     * stubbed `safeStorage` whose "encryption" is a string prefix. What no unit test can show is that
     * **this machine's actual keychain round-trips** — DPAPI here, Keychain on macOS, libsecret or
     * kwallet on Linux — and that the ciphertext survives a real SQLite write and read.
     *
     * That matters because a keychain failure is silent in exactly the wrong direction: `set`
     * succeeds, and the key is unusable on the next launch, which is the bug the persistence work
     * exists to fix.
     *
     * Self-cleaning. It ends with `clear`, and it deliberately runs after any real key would have
     * been read — but note it *does* overwrite a developer's stored key, which is why the final
     * `clear` is an assertion rather than a courtesy: leaving a smoke value behind would be worse.
     */
    /**
     * SCOPED TRY, so a vault that cannot run does not take the rest of Build Mode with it.
     *
     * The Linux runner has no keyring, `setSecret` refused — correctly — and the refusal became
     * `build/threw` from the catch-all at the bottom of this function. That skipped every check
     * after this one, which is why Linux reported ONE failure where Windows and macOS reported the
     * agent failure too. A guard that hides its siblings makes the suite report the wrong size of
     * problem.
     *
     * A genuine vault fault is still a failure. What is downgraded is exactly one case: this
     * platform has no credential store at all, which is a fact about the machine rather than about
     * the code, and is now said out loud instead of throwing.
     */
    try {
      const vault = (await window!.webContents.executeJavaScript(`
        (async () => {
          const set = await window.host.vault.set({ key: "openrouter", value: "sk-smoke-not-a-real-key" });
          const afterSet = await window.host.vault.has({ key: "openrouter" });
          const cleared = await window.host.vault.clear({ key: "openrouter" });
          const afterClear = await window.host.vault.has({ key: "openrouter" });
          // Clearing twice reports honestly rather than inventing a second success.
          const again = await window.host.vault.clear({ key: "openrouter" });
          return JSON.stringify({
            stored: set.stored,
            storedDurably: set.storedDurably,
            afterSet,
            cleared: cleared.cleared,
            afterClear,
            again: again.cleared,
          });
        })()
      `)) as string;

      const v = JSON.parse(vault) as Record<string, boolean>;

      if (v.stored !== true || v.afterSet !== true) {
        failures.push("build/vault: a key was set and vault:has did not see it");
      } else if (v.cleared !== true || v.afterClear !== false) {
        failures.push("build/vault: vault:clear did not remove the key");
      } else if (v.again !== false) {
        failures.push("build/vault: clearing nothing reported that something was cleared");
      } else if (process.platform !== "linux" && v.storedDurably !== true) {
        // Windows and macOS always have a real credential store, so a false here means
        // `getSelectedStorageBackend` is being consulted on a platform that does not define it.
        failures.push("build/vault: a durable backend reported storedDurably: false");
      } else {
        console.log(
          `[smoke] vault: set, read back and cleared through the real credential store (durable: ${String(v.storedDurably)}), and clearing nothing said so`
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      // The ONE downgrade, matched on the vault's own sentence rather than on any error: this
      // machine has no credential store, which `EncryptionUnavailableError` says in those words.
      // Anything else is a real fault and still fails.
      if (/no credential store/i.test(message)) {
        console.log(
          "[smoke] vault: SKIPPED — this machine has no credential store, which is what " +
            "`EncryptionUnavailableError` reports and is a fact about the machine, not the code. " +
            "Every check after this one still ran."
        );
      } else {
        failures.push(`build/vault threw: ${message}`);
      }
    }

    /**
     * Opening a file puts it in the assistant's context.
     *
     * This probe used to assert split view: click a file, get a Monaco editor, press Ctrl+\,
     * get a second editor showing the same buffer, then wait for autosave to reach disk. Every
     * one of those assertions is now about a design the app deliberately does not have.
     * `Build/WorkspaceSurface.tsx:25-27` states it: code arrives in the conversation as diffs to
     * review, and the only Monaco left is the one Study mounts. The split command is gone from
     * `COMMAND_IDS`, and `fs:save` — the channel the autosave half asserted — has no renderer
     * caller at all.
     *
     * So it failed with `no editor` and had been failing since the editor was removed, which is
     * worse than it sounds: CI gates the installer on this smoke, so a stale probe does not merely
     * test nothing, it blocks the release on a design decision.
     *
     * **Retargeted rather than deleted**, because three of its steps still cover live behaviour
     * that nothing else smokes: `file.openRecent` is the one path that opens a folder without a
     * native dialog (and only for a remembered path, so the smoke has to grant it first exactly
     * as a user would), the file tree renders from a real directory, and clicking a row makes
     * that file the assistant's context. The last is the assertion that replaces the editor one —
     * it is what opening a file *means* on this surface now.
     */
    {
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const nodePath = await import("node:path");
      const { rememberProject, forgetProject } = await import("./store/recents.js");

      const projectRoot = await smokeProjectRoot("open");
      await fsp.writeFile(nodePath.join(projectRoot, "context-me.py"), "x = 1\n", "utf8");
      rememberProject(projectRoot);

      await window.loadURL(`${APP_ORIGIN}/build`);
      await waitFor(window, `(document.querySelector("main")?.innerText.trim().length ?? 0) > 0`);

      /**
       * Nothing on this page fetches a script from the network.
       *
       * THE DEFECT THIS CATCHES. `@monaco-editor/loader` defaults `paths.vs` to a jsDelivr URL
       * and `init()` injects `<script src="{paths.vs}/loader.js">`. `markdown/CodeBlock.tsx`
       * calls `useMonaco()` — which runs `init()` — for every fenced code block, and the only
       * thing that overrode that path used to be `MonacoWrapper`, which never mounts here. So
       * on this route the first fence asked for Monaco from a CDN, the CSP blocked it with no
       * error anyone saw, and every code block in the assistant's transcript rendered as plain
       * text. Configured at the app root now (`components/Providers.tsx`).
       *
       * TWO ASSERTIONS, AND THE SECOND IS THE ONE THAT CANNOT PASS VACUOUSLY.
       *
       * Whether a *script* has been injected depends on whether a fence has rendered, and an
       * empty transcript has none — so "no remote script" is real but weak on its own. What is
       * unconditional is that `configureMonacoLoader()` sets `window.MonacoEnvironment` while
       * the root component's module is evaluated. Before the fix, nothing on this route called
       * it and that object did not exist here at all. So an `app://` worker URL on `/build`, with
       * no editor mounted and nothing having asked for Monaco, is direct evidence that the
       * configuration ran on this route — which is the whole of the defect.
       *
       * The injected-src assertion below is what closes that gap: once the row click mounts an
       * editor, Monaco really is asked for on this route, and the src it is asked from is the
       * thing the defect was about.
       */
      const monacoOrigin = (await window.webContents.executeJavaScript(`
        JSON.stringify({
          scripts: Array.from(document.querySelectorAll("script[src]")).map((s) => s.src),
          worker: window.MonacoEnvironment?.getWorkerUrl?.() ?? null,
        })
      `)) as string;
      const origin = JSON.parse(monacoOrigin) as { scripts: string[]; worker: string | null };
      const remote = origin.scripts.filter((src) => !src.startsWith("app://"));
      if (remote.length > 0) {
        failures.push(`build/ fetched a script from off-app: ${remote.join(", ")}`);
      } else if (origin.worker === null) {
        failures.push(
          "build/ has no MonacoEnvironment, so the loader was never configured on this route " +
            "and the first code fence will ask a CDN the CSP blocks"
        );
      } else if (!origin.worker.startsWith("app://")) {
        failures.push(`build/ would load Monaco's worker from ${origin.worker}`);
      } else {
        console.log(
          `[smoke] monaco: configured on /build with no editor mounted — worker ${origin.worker}` +
            `, all ${origin.scripts.length} scripts from app://`
        );
      }

      window.webContents.send("shell:command", {
        command: "file.openRecent",
        path: projectRoot,
      });

      const opened = (await window.webContents.executeJavaScript(`
        (async () => {
          const until = async (fn, ms = 8000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (fn()) return true;
              await new Promise((r) => setTimeout(r, 100));
            }
            return false;
          };
          const rows = () => Array.from(document.querySelectorAll('[role="treeitem"] button'));

          if (!(await until(() => rows().some((b) => b.textContent.includes("context-me.py"))))) {
            return JSON.stringify({ stage: "no tree" });
          }
          rows().find((b) => b.textContent.includes("context-me.py")).click();

          // The pane names the file it is holding for the assistant. Asserted on the rendered
          // sentence rather than on React state, because the sentence is what the user reads and
          // a prop that never reaches the DOM would satisfy a state check.
          const inContext = () =>
            document.body.innerText.includes("context-me.py is in the assistant's context");
          if (!(await until(inContext))) {
            return JSON.stringify({ stage: "not in context" });
          }

          // A tab appeared for it, in the strip beside Chat.
          const strip = () => document.querySelector('[role="tablist"][aria-label="Editors"]');
          if (!(await until(() => (strip()?.textContent ?? "").includes("context-me.py")))) {
            return JSON.stringify({ stage: "no tab" });
          }
          const tabs = (strip()?.textContent ?? "");

          // And the file is PAINTED. Monaco mounting is not the claim — a mounted editor
          // showing nothing is exactly what a blocked loader or a zero-height container looks
          // like — so this waits for the file's own text inside the editor's DOM.
          const mounted = () => document.querySelector(".monaco-editor") !== null;
          if (!(await until(mounted, 15000))) {
            return JSON.stringify({ stage: "no editor", tabs });
          }
          /**
           * Monaco writes non-breaking spaces between tokens, so a plain includes("x = 1")
           * fails against text that reads "x = 1" on screen and in a debug print. Normalised
           * with fromCharCode rather than an escape, because this block is inside a template
           * literal and a backslash here is eaten before the page sees it.
           */
          const painted = () => {
            const editor = document.querySelector(".monaco-editor");
            const text = (editor?.textContent ?? "").split(String.fromCharCode(160)).join(" ");
            return text.includes("x = 1");
          };
          if (!(await until(painted, 15000))) {
            const editor = document.querySelector(".monaco-editor");
            return JSON.stringify({
              stage: "editor painted nothing",
              tabs,
              // Printed, because "the text is not there" is the assertion that most often means
              // "it is there and I looked in the wrong place".
              saw: (editor?.textContent ?? "").slice(0, 120),
              rect: JSON.stringify(editor?.getBoundingClientRect() ?? null),
            });
          }

          // The injected loader script, now that something has actually asked for Monaco.
          const monacoScript = Array.from(document.querySelectorAll("script[src]"))
            .map((s) => s.src)
            .find((src) => src.includes("/vs/loader.js")) ?? null;

          return JSON.stringify({ stage: "ok", tabs, monacoScript });
        })()
      `)) as string;

      /**
       * TYPE, SAVE, AND READ THE BYTES BACK OFF DISK.
       *
       * The assertions above prove a file is displayed. This one proves the other half of what
       * an editor is for, and it is checked from MAIN rather than from the page: the renderer
       * reporting "saved" is the claim under test, so believing it would be circular. `readFile`
       * on the real path is the only thing that settles it.
       *
       * `insertText` rather than a synthetic key sequence, because Monaco listens on a hidden
       * textarea and reconstructs the buffer from composition events — dispatching `keydown` at
       * the container does nothing at all, which looks exactly like a broken editor.
       */
      const typed = "# smoke edit";
      const editResult = (await window.webContents.executeJavaScript(`
        (async () => {
          const until = async (fn, ms = 8000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (fn()) return true;
              await new Promise((r) => setTimeout(r, 100));
            }
            return false;
          };

          const area = document.querySelector(".monaco-editor textarea");
          if (!area) return JSON.stringify({ stage: "no editor textarea" });
          area.focus();
          if (document.activeElement !== area) {
            return JSON.stringify({ stage: "editor would not take focus" });
          }

          /*
            execCommand, not webContents.insertText, and not a synthetic keydown.

            A keydown at the container does nothing: Monaco reads from a hidden textarea and
            reconstructs the buffer from input events. insertText from main does work, but it is
            a second IPC round trip after the focus call, and two runs of this probe failed at
            two different points because of that race. execCommand emits the real
            beforeinput/input pair, page-side, in one step, with nothing to race.
          */
          document.execCommand("insertText", false, "# smoke edit");

          const dot = () => document.querySelector('[aria-label="Unsaved changes"]') !== null;
          if (!(await until(dot))) {
            const editor = document.querySelector(".monaco-editor");
            return JSON.stringify({
              stage: "no dirty dot after typing",
              saw: (editor && editor.textContent ? editor.textContent : "").slice(0, 120),
            });
          }
          return JSON.stringify({ stage: "dirty" });
        })()
      `)) as string;
      const edit = JSON.parse(editResult) as { stage: string; saw?: string };

      if (edit.stage !== "dirty") {
        failures.push(
          `build/typing did not mark the buffer unsaved: ${edit.stage}` +
            (edit.saw === undefined ? "" : ` | editor text: ${JSON.stringify(edit.saw)}`)
        );
      } else {
        // Through the shell command, which is the path Ctrl+S and the File menu both take.
        window.webContents.send("shell:command", { command: "file.save" });

        const cleared = (await window.webContents.executeJavaScript(`
          (async () => {
            const until = async (fn, ms = 8000) => {
              const deadline = Date.now() + ms;
              while (Date.now() < deadline) {
                if (fn()) return true;
                await new Promise((r) => setTimeout(r, 100));
              }
              return false;
            };
            const clean = () =>
              document.querySelector('[aria-label="Unsaved changes"]') === null;
            const ok = await until(clean);
            // The screen, printed on failure. "It did not save" is the kind of assertion that
            // most often means "it said why and nobody read it".
            const main = document.querySelector("main");
            return JSON.stringify({
              cleared: ok,
              reported: ok ? "" : (main && main.innerText ? main.innerText : "").slice(0, 400),
            });
          })()
        `)) as string;
        const clearedResult = JSON.parse(cleared) as { cleared: boolean; reported: string };

        /**
         * READ FROM MAIN, NOT FROM THE PAGE. The renderer reporting "saved" is the claim under
         * test, so believing it would be circular. The bytes on disk are what settle it.
         */
        const onDisk = await fsp
          .readFile(nodePath.join(projectRoot, "context-me.py"), "utf8")
          .catch(() => "");

        if (!clearedResult.cleared) {
          failures.push(
            `build/the dirty dot never cleared after Save | screen: ${JSON.stringify(
              clearedResult.reported
            )}`
          );
        } else if (!onDisk.includes("smoke edit")) {
          failures.push(
            `build/Save reported success and wrote nothing: ${JSON.stringify(onDisk)}`
          );
        } else {
          console.log(
            "[smoke] edit: typed into the editor, the tab went dirty, file.save cleared it, " +
              "and main read the new bytes off disk"
          );
        }
      }


      /**
       * THE PROBLEMS PANE NAMES ITS STATUS, WHICH IS THE ASSERTION THAT TRAVELS.
       *
       * Not "it has rows". This machine and a CI runner may each have ruff, or not, and a
       * `context-me.py` containing `x = 1` has nothing wrong with it either way — so asserting on
       * diagnostics would be flaky in one direction and vacuous in the other. What must hold
       * everywhere is the honesty property the pane exists for: an empty list has to say whether
       * the file is clean or whether nothing looked at it. Both sentences name the tool, so the
       * tool's name in the pane is the check.
       *
       * Read out of the DOM rather than photographed: the dock may be collapsed, and whether this
       * *sentence* exists is a different question from whether the pane is on screen. The
       * screenshot below covers the second.
       */
      const problems = (await window.webContents.executeJavaScript(`
        (async () => {
          const until = async (fn, ms = 10000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (fn()) return true;
              await new Promise((r) => setTimeout(r, 100));
            }
            return false;
          };
          const tab = [...document.querySelectorAll('[role="tab"]')]
            .find((t) => /^problems/i.test((t.textContent || "").trim()));
          if (!tab) return JSON.stringify({ stage: "no problems tab" });
          tab.click();

          /*
            The paragraph, not any element that happens to contain the text.

            The first version searched querySelectorAll("*"), whose first match in document order
            is <html> — and closest("div") on <html> is null, so the pane looked absent while it
            was on screen. Scoped to <p>, which is what renders it.
          */
          const pane = () => {
            const note = [...document.querySelectorAll("p")]
              .find((el) => (el.textContent || "").includes("Nothing scans the project"));
            return note ? note.parentElement : null;
          };
          if (!(await until(() => pane() !== null))) {
            return JSON.stringify({ stage: "problems pane said nothing" });
          }
          const text = (pane().textContent || "");
          return JSON.stringify({ stage: "ok", text: text.slice(0, 300) });
        })()
      `)) as string;
      const problemsPane = JSON.parse(problems) as { stage: string; text?: string };
      if (problemsPane.stage !== "ok") {
        failures.push(`build/problems pane: ${problemsPane.stage}`);
      } else if (!(problemsPane.text ?? "").includes("context-me.py")) {
        failures.push(
          `build/the problems pane does not name the open file: ${JSON.stringify(
            problemsPane.text
          )}`
        );
      } else if (!/ruff|no linter/i.test(problemsPane.text ?? "")) {
        failures.push(
          `build/the problems pane is empty without saying why: ${JSON.stringify(
            problemsPane.text
          )}`
        );
      } else {
        console.log(
          `[smoke] problems: the pane names the file and what checked it — ${JSON.stringify(
            (problemsPane.text ?? "").slice(0, 160)
          )}`
        );
      }

      /*
        A picture of the one thing this probe is really about.

        Captured before the project is forgotten, so the tree, the strip and the painted file are
        all still on screen. Opt-in under the same variable as the shell captures, and for the
        same reason: a text assertion cannot tell a painted editor from a zero-height one, and
        this repository has twice photographed an empty workbench and called it a pass.
      */
      if (process.env.VOIDCODE_SMOKE_SHOTS !== undefined) {
        await captureShot(window, process.env.VOIDCODE_SMOKE_SHOTS, "build-file-open");
      }

      forgetProject(projectRoot);
      await fsp.rm(projectRoot, { recursive: true, force: true }).catch(() => {});

      const result = JSON.parse(opened) as {
        stage: string;
        tabs?: string;
        saw?: string;
        lines?: number;
        present?: boolean;
        rect?: string;
        monacoScript?: string | null;
      };
      if (result.stage !== "ok") {
        failures.push(
          `build/opening a file: ${result.stage}` +
            (result.tabs === undefined ? "" : ` | strip: ${result.tabs.trim()}`) +
            (result.saw === undefined ? "" : ` | editor text: ${JSON.stringify(result.saw)}`) +
            (result.present === undefined ? "" : ` | element present: ${String(result.present)}`) +
            (result.lines === undefined ? "" : ` | .view-line nodes: ${String(result.lines)}`) +
            (result.rect === undefined ? "" : ` | rect: ${result.rect}`)
        );
      } else if (
        result.monacoScript !== null &&
        result.monacoScript !== undefined &&
        !result.monacoScript.startsWith("app://")
      ) {
        // Monaco has now genuinely been asked for on this route, so where it was asked FROM is
        // an assertion rather than a vacuous one. This is the defect `tests/monaco-loader.test.ts`
        // pins in a unit test, observed end to end.
        failures.push(`build/ loaded Monaco from ${result.monacoScript}`);
      } else {
        console.log(
          `[smoke] open file: the row painted the file in the editor (${String(
            result.monacoScript
          )}), put it in the assistant's context, and added a tab — strip reads "${String(
            result.tabs
          ).trim()}"`
        );
      }

      /**
       * A pane can be moved, and the move can be undone.
       *
       * Driven from main because both halves cross the boundary and neither can be seen from
       * one side alone. The drag is renderer-only, but `view.resetLayout` arrives as a
       * `shell:command` from a *native* menu — there is no DOM to click, and `window.host` is
       * behind `contextBridge`, so a script in the page cannot stand in for either end.
       *
       * The reset matters more than the move. Panes rearrange and the tree is persisted, so
       * without a way back a single clumsy drop survives every restart — and the menu item that
       * provides it is the one part of the feature no renderer test can reach.
       *
       * HTML5 drag cannot be driven with mouse events; a constructed `DataTransfer` on
       * dispatched `DragEvent`s is the only way in, which is also why `drop` reads its payload
       * from the event rather than from React state.
       */
      const paneMove = (await window.webContents.executeJavaScript(`
        (async () => {
          const until = async (fn, ms = 6000) => {
            const deadline = Date.now() + ms;
            while (Date.now() < deadline) {
              if (fn()) return true;
              await new Promise((r) => setTimeout(r, 100));
            }
            return false;
          };
          // Read off the grips, which carry the pane id — the panes themselves are anonymous
          // absolutely-positioned boxes and nothing else on the page identifies them.
          const grips = () => Array.from(document.querySelectorAll('[aria-label$="pane"]'));
          const shape = () =>
            grips()
              .map((g) => {
                const b = g.parentElement.getBoundingClientRect();
                return g.getAttribute("aria-label").replace(/^Move | pane$/g, "") +
                  ":" + Math.round(b.left) + "," + Math.round(b.top);
              })
              .sort()
              .join(" ");

          if (grips().length === 0) return JSON.stringify({ stage: "no grips — panes are not movable" });

          const before = shape();

          const from = grips().find((g) => /left/.test(g.getAttribute("aria-label")));
          const target = grips().find((g) => /right/.test(g.getAttribute("aria-label")))?.parentElement;
          if (!from || !target) return JSON.stringify({ stage: "no left/right pane to move" });

          const dt = new DataTransfer();
          from.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
          const r = target.getBoundingClientRect();
          const at = {
            dataTransfer: dt, bubbles: true, cancelable: true,
            clientX: Math.round(r.right - 8), clientY: Math.round(r.top + r.height / 2),
          };
          target.dispatchEvent(new DragEvent("dragover", at));
          target.dispatchEvent(new DragEvent("drop", at));

          const moved = await until(() => shape() !== before);
          return JSON.stringify({ stage: "ok", before, moved, after: shape() });
        })()
      `)) as string;

      const move = JSON.parse(paneMove) as {
        stage: string;
        before?: string;
        after?: string;
        moved?: boolean;
      };

      if (move.stage !== "ok") {
        failures.push(`build/pane move probe could not start: ${move.stage}`);
      } else if (move.moved !== true) {
        failures.push(`build/dragging a pane to another pane's edge moved nothing: ${paneMove}`);
      } else {
        // Now the half that only main can ask for.
        window.webContents.send("shell:command", { command: "view.resetLayout" });

        const restored = (await window.webContents.executeJavaScript(`
          (async () => {
            const shape = () =>
              Array.from(document.querySelectorAll('[aria-label$="pane"]'))
                .map((g) => {
                  const b = g.parentElement.getBoundingClientRect();
                  return g.getAttribute("aria-label").replace(/^Move | pane$/g, "") +
                    ":" + Math.round(b.left) + "," + Math.round(b.top);
                })
                .sort()
                .join(" ");
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
              if (shape() === ${JSON.stringify(move.before)}) return JSON.stringify({ back: true });
              await new Promise((r) => setTimeout(r, 100));
            }
            return JSON.stringify({ back: false, shape: shape() });
          })()
        `)) as string;

        const reset = JSON.parse(restored) as { back: boolean; shape?: string };
        if (!reset.back) {
          failures.push(
            `build/Reset Panel Layout did not put the panes back (still ${String(reset.shape)})`
          );
        } else {
          console.log("[smoke] dock: a pane moved on drop, and the View menu put it back");
        }
      }
    }

    /**
     * Images do not leave the machine without a prompt.
     *
     * THE ONLY SECURITY PROPERTY IN THIS PHASE, and the reason the check lives in main rather
     * than in the composer: a prompt the renderer shows is a prompt a compromised renderer
     * skips. So this drives `chat:open` through the real transport with a real image block and
     * asserts three things — that a remote provider is gated, that refusing actually stops the
     * send, and that a local provider is not gated at all.
     *
     * The dialog is scripted rather than shown. A real modal would block the run with nobody
     * to click it, and scripting is also what makes the *refusal* path testable, which is the
     * path that matters and the one a human tester would forget to try.
     */
    {
      const { __scriptUploadConsent, __consentRequests } = await import(
        "./inference/consent.js"
      );

      // A one-pixel PNG, real enough to pass the magic-byte check the previous phase added.
      const PNG =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

      const openWith = (provider: string, refuse: boolean): Promise<Record<string, unknown>> => {
        __scriptUploadConsent(() => !refuse);
        return window!.webContents.executeJavaScript(`
          window.host.chat.open({
            surface: "assistant",
            provider: ${JSON.stringify(provider)},
            model: "whatever",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "what is wrong here?" },
                { type: "image", data: ${JSON.stringify(PNG)}, mediaType: "image/png" }
              ]
            }]
          }).then(() => ({ ok: true })).catch((e) => ({ ok: false, message: String(e && e.message) }))
        `) as Promise<Record<string, unknown>>;
      };

      const refused = await openWith("openrouter", true);
      const refusedAsk = __consentRequests()[0];

      const accepted = await openWith("openrouter", false);
      const acceptedAsks = __consentRequests().length;

      const local = await openWith("ollama", true);
      const localAsks = __consentRequests().length;

      __scriptUploadConsent(undefined);

      if (refusedAsk === undefined) {
        failures.push("consent/a remote provider was not gated at all");
      } else if (refusedAsk.destination !== "openrouter.ai" || refusedAsk.imageCount !== 1) {
        // The two facts the decision rests on. A prompt that names the wrong place, or the
        // wrong number of images, is worse than none.
        failures.push(
          `consent/the prompt described the wrong thing: ${JSON.stringify(refusedAsk.destination)} x${String(refusedAsk.imageCount)}`
        );
      } else if (refused.ok !== false || !String(refused.message).includes("cancelled")) {
        failures.push(`consent/refusing did not stop the send: ${JSON.stringify(refused)}`);
      } else if (acceptedAsks !== 1) {
        failures.push("consent/accepting did not go through the prompt");
      } else if (accepted.ok !== true) {
        // Past the gate it may still fail for want of an API key; what must not happen is
        // being blocked by consent after agreeing.
        if (String(accepted.message).includes("cancelled")) {
          failures.push("consent/agreeing still blocked the send");
        }
      }

      if (localAsks !== 0) {
        // Nothing leaves the machine, so there is nothing to consent to — and prompting
        // anyway is how a prompt becomes something people click through without reading.
        failures.push("consent/a local provider prompted for an upload");
      } else if (local.ok === false && String(local.message).includes("cancelled")) {
        failures.push("consent/a local provider was blocked by the upload gate");
      } else if (failures.length === 0) {
        console.log(
          "[smoke] consent: a remote provider is gated by name and count, refusing stops it, local is not asked"
        );
      }
    }

    /**
     * The agent, and the gate that makes it safe to have one.
     *
     * Driven through the real broker with a scripted model, because the claim being tested is
     * about the *route* a write takes, and that route only exists once the IPC layer is in it.
     * The unit tests assert the same refusal against `commitDiff` directly; this asserts that
     * a renderer holding a real diff id, calling the real channel, is still refused.
     */
    {
      const { __scriptProvider } = await import("./inference/registry.js");
      const { __scriptAgentApproval, __approvalRequests } = await import("./agent/approve.js");
      const { __setProjectRoot } = await import("./workspace.js");
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const nodePath = await import("node:path");

      const projectRoot = await smokeProjectRoot("agent");
      const target = nodePath.join(projectRoot, "target.ts");
      await fsp.writeFile(target, "export const original = true;\n", "utf8");
      __setProjectRoot(window!.webContents, projectRoot);

      // A model that proposes one edit and then stops.
      __scriptProvider("ollama", {
        id: "ollama",
        label: "Scripted",
        capabilities: { tools: true, grammar: true, remote: false },
        available: async () => true,
        /**
         * A tool-capable name, because main now resolves the model rather than taking it.
         *
         * The stub returned no models and the smoke started failing with "expected one
         * proposed diff, got 0" — correctly: `pickAgentModel` refuses to run when nothing is
         * installed. The scripted provider has to look like a provider with a usable model.
         */
        listModels: async () => [{ id: "llama3.1:8b" }],
        // eslint-disable-next-line @typescript-eslint/require-await
        chat: (() => {
          let turn = 0;
          return function chat() {
            const first = turn++ === 0;
            return (async function* () {
              if (first) {
                yield {
                  kind: "tool_call" as const,
                  call: {
                    id: "smoke-1",
                    name: "propose_edit",
                    argumentsJson: JSON.stringify({
                      path: "target.ts",
                      contents: "export const rewritten = true;\n",
                    }),
                  },
                };
                yield { kind: "done" as const, finishReason: "tool_calls" as const };
              } else {
                yield { kind: "token" as const, text: "Proposed." };
                yield { kind: "done" as const, finishReason: "stop" as const };
              }
            })();
          };
        })(),
      });

      /**
       * RELOADED, so the panel sees the provider that was just scripted.
       *
       * This is why `agent/expected one proposed diff, got 0` failed on the CI runners and passed
       * on every developer machine, and the mechanism is worth stating because nothing about the
       * message hints at it.
       *
       * The panel fetches its provider list when it MOUNTS, which happened before
       * `__scriptProvider` ran above. It then sends the chosen provider's id with the turn, and
       * `handlers/index.ts` resolves it with `providerById(input.provider)` — an unknown id gives
       * no models, `pickAgentModel` returns undefined, and the handler throws `E_UNAVAILABLE`. The
       * turn ends cleanly having proposed nothing, which is exactly what was observed: `settled`
       * was true and the diff count was zero.
       *
       * On this machine a real Ollama is running, so the panel's first fetch found the `ollama` id
       * and the scripted provider — registered under that same id — answered for it. The runners
       * have no Ollama, so the panel had nothing to send. The stub was correct and unreachable.
       *
       * A reload after scripting is the smallest fix that keeps the turn going through the real
       * composer: the panel remounts, fetches again, and now finds the stub.
       */
      await window!.webContents.reload();
      await new Promise<void>((done) => window!.webContents.once("did-finish-load", () => done()));
      // The provider list is fetched on mount; give that round trip a moment to land before the
      // composer is driven, or the panel is mounted with an empty selector again.
      await new Promise((r) => setTimeout(r, 1_500));

      /**
       * Driven through the composer, not by calling the channel.
       *
       * There is one surface now — no tab to switch to — so this types into the assistant's
       * textarea and clicks Send, which is exactly what a user does. Calling `agent.open`
       * directly would leave the panel with none of the turn, and would test a path nobody
       * takes.
       */
      const run = (await window!.webContents.executeJavaScript(`
        (async () => {
          try {
            const box = document.querySelector("textarea[placeholder]");
            if (!box) return { ok: false, message: "no composer" };

            const setter = Object.getOwnPropertyDescriptor(
              window.HTMLTextAreaElement.prototype, "value"
            ).set;
            setter.call(box, "rewrite target.ts");
            box.dispatchEvent(new Event("input", { bubbles: true }));
            await new Promise((r) => setTimeout(r, 200));

            /**
             * Found by label, not by walking the tree.
             *
             * No backticks in this comment — it lives inside a template literal.
             *
             * This used to scope to the textarea's parentElement and search it for a button whose
             * text started with Send. That stopped working when SlashAutocomplete wrapped the
             * textarea: the parent became a bare relative div holding only the autocomplete and
             * the textarea, and Send moved to a sibling. The probe then reported "no Send button"
             * on every run about a button that worked — and because CI gates the installer on this
             * smoke, a DOM tidy-up in the renderer blocked releases.
             *
             * Asserting there is exactly one keeps the label honest: two would mean the tutor
             * panel had also mounted here, and clicking whichever came first would test the wrong
             * surface.
             */
            const sends = [...document.querySelectorAll('[aria-label="Send message"]')];
            // Concatenation, not a template literal: this code lives inside one.
            if (sends.length !== 1) {
              return { ok: false, message: "expected one Send button, found " + sends.length };
            }
            const send = sends[0];
            if (!send) return { ok: false, message: "no Send button" };
            if (send.disabled) return { ok: false, message: "Send stayed disabled" };
            send.click();

            // Watch the button rather than sleeping blind — and REPORT WHETHER IT WAS SEEN.
            //
            // No backticks anywhere in this comment: it lives inside a template literal, which is
            // stated twenty lines above and which I broke anyway on the first attempt.
            //
            // This returned ok:true either way, so running out of budget was indistinguishable
            // from the run finishing. On the CI runners it ran out, the store had no steps yet,
            // and the failure surfaced twenty lines later as
            // "agent/expected one proposed diff, got 0" — which names the symptom and gives no
            // hint that the cause was a clock. The settled flag is the difference between those
            // two messages, and main polls the store below rather than trusting this at all.
            let settled = false;
            for (let i = 0; i < 80; i++) {
              await new Promise((r) => setTimeout(r, 250));
              if (/^Send$/.test((send.textContent || "").trim()) && i > 2) {
                settled = true;
                break;
              }
            }
            return { ok: true, settled };
          } catch (e) {
            return { ok: false, message: String(e && e.message) };
          }
        })()
      `)) as Record<string, unknown>;

      const afterRun = await fsp.readFile(target, "utf8");

      // Read straight from the store rather than through the channel, so this asserts the row
      // exists rather than that one handler agrees with another.
      const { recentRuns, stepsFor } = await import("./store/agent.js");

      /**
       * Read straight from the store, so this asserts the row exists rather than that one handler
       * agrees with another — and POLL FOR IT rather than reading once.
       *
       * The single read was a race the developer machine always won. The renderer waits on the
       * composer's button returning to "Send", which says the turn is over as React sees it, and
       * the step rows are written on a path this side does not synchronise with. On a loaded CI
       * runner the read landed first, `diffIds` was empty, and the failure read
       * "agent/expected one proposed diff, got 0" — a real assertion reporting a scheduling
       * accident, on two of three platforms, having passed every local run.
       *
       * Thirty seconds and then the same assertion as before: this only removes the race, it does
       * not weaken what is checked. A run that genuinely proposes nothing still fails, and now the
       * `settled` flag above distinguishes "the turn never finished" from "it finished and
       * proposed nothing".
       */
      let storedSteps: { kind: string; diff_id: string | null }[] = [];
      let historyRuns = recentRuns(projectRoot);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        historyRuns = recentRuns(projectRoot);
        storedSteps = (
          historyRuns[0] === undefined ? [] : stepsFor(projectRoot, historyRuns[0].id)
        ).map((s) => ({ kind: s.kind, diff_id: s.diffId }));
        if (storedSteps.some((step) => step.diff_id !== null)) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (run.settled !== true) {
        failures.push(
          "agent/the composer never returned to Send within 20s, so the turn did not finish — " +
            "any count of proposed diffs below is about an interrupted run"
        );
      }

      /**
       * The diff ids come from the stored transcript now.
       *
       * The panel ran the turn, so the channel's return value went to React rather than here —
       * and reading them back out of `agent_steps` doubles as proof that the id a run proposed
       * survives into the audit record, which is the point of storing it at all.
       */
      const diffIds = storedSteps
        .filter((step) => step.diff_id !== null)
        .map((step) => String(step.diff_id));

      /**
       * What the real React panel made of that run.
       *
       * The turn was driven through the composer above, so the panel received the whole
       * stream — prose, tool steps and the proposal — over the port it opened itself. Reading
       * back what rendered is the assertion.
       *
       * Previously unverified: no vision-capable or tool-capable model is installed on this
       * machine, so the happy path had never rendered in the real UI. The scripted provider
       * stands in for the model; everything downstream is genuine.
       */
      const panel = (await window!.webContents.executeJavaScript(`
        (() => {
          try {
            const box = document.querySelector("textarea[placeholder]");
            if (!box) return { ok: false, message: "the assistant is not mounted" };
            const column = box.closest("div").parentElement.parentElement;
            return {
              ok: true,
              // A DiffView renders its lines as a table. Nothing else in this column does.
              diffNodes: column.querySelectorAll("table").length,
              applyButton: [...column.querySelectorAll("button")]
                .some((b) => /Review and apply/i.test(b.textContent || "")),
              /**
               * Mode tabs specifically: the Chat/Agent split, which is gone and must stay gone.
               *
               * FOOLED TWICE BY role=tab, WHICH IS WHY THE FILTER IS TWO CLAUSES NOW. A bare
               * count reached the old editor file tabs, reported 2 and meant nothing, so it was
               * narrowed to tabs labelled Chat or Agent. Then the centre pane gained a tab strip
               * whose first tab is literally labelled Chat — a different thing entirely, and the
               * text filter matched it. So the strip is excluded by name as well. A returning
               * mode split would be its own control inside the assistant, not this one.
               *
               * (No backticks in here — this whole block is inside a template literal, and a
               * backtick closes it. That has now cost three separate debugging rounds in this
               * file.)
               */
              tabs: [...document.querySelectorAll('[role="tab"]')]
                .filter((t) => !t.closest('[role="tablist"][aria-label="Editors"]'))
                .filter((t) => /^(chat|agent)$/i.test((t.textContent || "").trim())).length,
              text: (column.innerText || "").slice(0, 600),
            };
          } catch (e) {
            return { ok: false, message: String(e && e.message) };
          }
        })()
      `)) as Record<string, unknown>;

      // The renderer now holds a real, live diff id. The human channel must still refuse it.
      const smuggled = (await window!.webContents.executeJavaScript(`
        window.host.fs.commitDiff({ diffId: ${JSON.stringify(diffIds[0] ?? "none")} })
          .then(() => ({ ok: true }))
          .catch((e) => ({ ok: false, message: String(e && e.message) }))
      `)) as Record<string, unknown>;
      const afterSmuggle = await fsp.readFile(target, "utf8");

      // Declining the dialog writes nothing.
      __scriptAgentApproval(() => false);
      const declined = (await window!.webContents.executeJavaScript(`
        window.host.agent.applyDiffs({ ids: ${JSON.stringify(diffIds)} })
          .then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, message: String(e && e.message) }))
      `)) as Record<string, unknown>;
      const afterDecline = await fsp.readFile(target, "utf8");
      const declinedAsk = __approvalRequests()[0];

      // Agreeing does.
      __scriptAgentApproval(() => true);
      const applied = (await window!.webContents.executeJavaScript(`
        window.host.agent.applyDiffs({ ids: ${JSON.stringify(diffIds)} })
          .then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, message: String(e && e.message) }))
      `)) as Record<string, unknown>;
      const afterApprove = await fsp.readFile(target, "utf8");

      __scriptAgentApproval(undefined);
      __scriptProvider("ollama", undefined);
      __setProjectRoot(window!.webContents, undefined);
      await fsp.rm(projectRoot, { recursive: true, force: true });

      if (run.ok !== true) {
        failures.push(`agent/run failed through the broker: ${String(run.message)}`);
      } else if (diffIds.length !== 1) {
        failures.push(`agent/expected one proposed diff, got ${String(diffIds.length)}`);
      } else if (afterRun !== "export const original = true;\n") {
        failures.push("agent/the run wrote to disk without any approval");
      } else if (storedSteps.length === 0) {
        failures.push("agent/the turn was not recorded — nothing to audit after the window closes");
      } else if (!storedSteps.some((step) => step.kind === "proposal" && step.diff_id !== null)) {
        failures.push("agent/the stored transcript lost the proposal's diff id");
      } else if (panel.ok !== true) {
        failures.push(`agent/the panel could not be read: ${String(panel.message)}`);
      } else if (panel.diffNodes === 0) {
        /**
         * The unified surface rendered the proposal.
         *
         * This is the whole point of streaming tool steps and prose down one port: the diff
         * appears in the conversation as the turn produces it. A run that proposed an edit and
         * showed the user nothing to review would be the same silent failure the tab split had.
         */
        failures.push("agent/the transcript rendered no diff for a proposed edit");
      } else if (!String(panel.text).includes("target.ts")) {
        failures.push(`agent/the transcript did not name the file: ${String(panel.text).slice(0, 200)}`);
      } else if (panel.applyButton !== true) {
        failures.push("agent/no way to apply the proposal was offered");
      } else if (panel.tabs !== 0) {
        // The tab toggle is gone. One surface, and a stray tab would mean the split came back.
        failures.push(`agent/the assistant still has ${String(panel.tabs)} mode tabs`);
      } else if (smuggled.ok !== false) {
        /**
         * THE ASSERTION THIS PHASE EXISTS FOR.
         *
         * Two steps in main were never two parties: a compromised renderer could propose and
         * commit by itself. That was tolerable while every proposer was a person. With an
         * agent reading web pages as a proposer, it means fetched text can reach the disk.
         */
        failures.push("agent/fs:commitDiff applied an agent-proposed diff");
      } else if (afterSmuggle !== "export const original = true;\n") {
        failures.push("agent/the smuggled commit modified the file while reporting failure");
      } else if (!String(smuggled.message).includes("approval dialog")) {
        failures.push(`agent/the refusal did not name the real rule: ${String(smuggled.message)}`);
      } else if (declinedAsk === undefined) {
        failures.push("agent/applyDiffs wrote without asking anyone");
      } else if (!declinedAsk.batch.displayPaths.includes("target.ts")) {
        // A prompt that names the wrong file manufactures consent for an act nobody agreed to.
        failures.push(
          `agent/the dialog named the wrong files: ${JSON.stringify(declinedAsk.batch.displayPaths)}`
        );
      } else if (declined.approved !== false || afterDecline !== "export const original = true;\n") {
        failures.push("agent/declining the dialog still wrote the file");
      } else if (applied.approved !== true || afterApprove !== "export const rewritten = true;\n") {
        failures.push(
          `agent/approving did not apply the change: ${String(applied.message ?? afterApprove)}`
        );
      } else if (historyRuns.length === 0) {
        failures.push("agent/the run was not recorded — nothing to audit after the window closes");
      } else if (!String(historyRuns[0]?.question).includes("rewrite target.ts")) {
        /**
         * Containment, not equality — and the difference is the point.
         *
         * The composer prepends the open file to the question, so the stored text is the real
         * prompt rather than what was typed. An equality check here failed, and the failure
         * message was itself the evidence that the turn had gone through the panel: it
         * contained the editor buffer.
         */
        failures.push(`agent/history recorded the wrong run: ${JSON.stringify(historyRuns[0])}`);
      } else if (historyRuns[0]?.stepCount !== storedSteps.length) {
        // The run row and its steps must agree, or an audit reads a different turn from the
        // one that happened.
        failures.push(
          `agent/the run row counts ${String(historyRuns[0]?.stepCount)} steps but ${String(storedSteps.length)} were stored`
        );
      } else {
        console.log(
          `[smoke] agent: one surface streamed ${String(storedSteps.length)} steps and rendered the diff for target.ts, proposed without writing, fs:commitDiff refused the agent diff, the dialog named the file, declining wrote nothing, approving applied it`
        );
      }
    }

    /**
     * Screenshot → source, against a real project on disk.
     *
     * The unit tests rank hand-built hit sets; this is the half they cannot reach — that the
     * strings chosen from an image actually find files when a real `searchInFiles` walks a real
     * directory, and that a screenshot of something else finds nothing.
     *
     * The vision model is stood in for. Everything downstream of it is what this exercises, and
     * requiring a multi-gigabyte VLM would mean this assertion never ran on any machine that
     * matters — which is the same as not having it.
     */
    {
      const { __scriptFacts } = await import("./vision/locate.js");
      const { __setProjectRoot } = await import("./workspace.js");
      const os = await import("node:os");
      const fsp = await import("node:fs/promises");
      const nodePath = await import("node:path");

      const projectRoot = await smokeProjectRoot("vision");
      await fsp.writeFile(
        nodePath.join(projectRoot, "settings.ts"),
        'export const LABEL = "Appearance";\nfunction onSave() { throw new Error("E_MODE_DENIED"); }\n',
        "utf8"
      );
      await fsp.writeFile(nodePath.join(projectRoot, "unrelated.ts"), "export const x = 1;\n", "utf8");
      __setProjectRoot(window!.webContents, projectRoot);

      // A one-pixel PNG — the magic-byte check runs on this path too, so it has to be real.
      const PNG =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

      const locate = (): Promise<Record<string, unknown>> =>
        window!.webContents.executeJavaScript(`
          window.host.vision.locate({
            provider: "ollama",
            model: "whatever",
            image: { data: ${JSON.stringify(PNG)}, mediaType: "image/png" }
          }).then((r) => ({ ok: true, ...r })).catch((e) => ({ ok: false, message: String(e && e.message) }))
        `) as Promise<Record<string, unknown>>;

      __scriptFacts({
        visibleText: ["Appearance"],
        identifiers: ["E_MODE_DENIED"],
        uiElements: ["dialog"],
        errorText: null,
        appearance: "a settings dialog",
      });
      const hit = await locate();

      // The same call with text that is nowhere in this project. The answer must be nothing.
      __scriptFacts({
        visibleText: ["Kubernetes cluster autoscaler"],
        identifiers: ["ZZ_NOT_IN_THIS_PROJECT_ZZ"],
        uiElements: ["chart"],
        errorText: null,
        appearance: "a monitoring dashboard",
      });
      const miss = await locate();

      __scriptFacts(undefined);
      __setProjectRoot(window!.webContents, undefined);
      await fsp.rm(projectRoot, { recursive: true, force: true });

      const candidates = (hit.candidates ?? []) as Array<Record<string, unknown>>;
      const missCandidates = (miss.candidates ?? []) as Array<Record<string, unknown>>;

      if (hit.ok !== true) {
        failures.push(`vision/locate failed through the seam: ${String(hit.message)}`);
      } else if (candidates.length === 0) {
        failures.push("vision/found nothing in a project that contains both strings");
      } else if (candidates[0]?.path !== "settings.ts") {
        failures.push(
          `vision/ranked the wrong file first: ${JSON.stringify(candidates.map((c) => c.path))}`
        );
      } else if (!String(candidates[0]?.why).includes("E_MODE_DENIED")) {
        // The reason has to name the evidence, or the list is a set of paths to be taken
        // on faith.
        failures.push(`vision/did not say what it matched: ${String(candidates[0]?.why)}`);
      } else if (candidates.some((c) => c.path === "unrelated.ts")) {
        failures.push("vision/offered a file containing none of the screenshot's text");
      } else if (miss.ok !== true) {
        failures.push(`vision/the no-match case errored: ${String(miss.message)}`);
      } else if (missCandidates.length !== 0) {
        /**
         * The failure this whole feature is designed against.
         *
         * A screenshot of an unrelated application must produce an empty list, not the
         * closest-looking file — because a plausible answer and a correct one are
         * indistinguishable right up until someone edits the wrong file.
         *
         * WORTH BEING PRECISE ABOUT WHAT THIS PROVES. The temp project has no memory index, so
         * the semantic pass returns nothing here regardless — this covers the exact pass not
         * inventing matches, not the harder case of an embedding index offering a confident
         * neighbour. That case is covered in `tests/vision-crossref.test.ts` at the ranking
         * level, and end-to-end it needs an indexed project and a local embedding model.
         */
        failures.push(
          `vision/guessed at a project that matched nothing: ${JSON.stringify(missCandidates.map((c) => c.path))}`
        );
      } else {
        console.log(
          `[smoke] vision: located "E_MODE_DENIED" at settings.ts, named its evidence, and found nothing for an unrelated screenshot`
        );
      }
    }

    /**
     * Session restoration, through the real store.
     *
     * The renderer half is exercised by the split probe above, which opens a project and files
     * in a live window; what this adds is the part that only main can answer — that a window's
     * arrangement survives being written and read back, and that the `restorable` rule
     * distinguishes "the user closed this" from "the app stopped".
     *
     * Deliberately not a relaunch test. Restarting Electron inside its own smoke is a
     * different kind of harness, and the interesting logic is all in the store, which this
     * drives directly. What the relaunch would add is confidence in `restoreSession`'s window
     * construction, which the unit tests cannot reach — that gap is real and stated here
     * rather than papered over.
     */
    {
      const { rememberWindow, forgetWindow, restorableWindows, saveWorkspaceState, loadWorkspaceState } =
        await import("./store/session.js");
      const { sessionIdFor } = await import("./windows.js");

      const liveId = sessionIdFor(window!.webContents);

      rememberWindow({
        id: "smoke-a",
        mode: "build",
        projectRoot: null,
        route: "/build",
        bounds: { x: 10, y: 20, width: 1200, height: 800 },
        maximised: false,
        fullScreen: false,
      });
      rememberWindow({
        id: "smoke-b",
        mode: "build",
        projectRoot: null,
        route: "/homepage",
        bounds: { x: 30, y: 40, width: 1000, height: 700 },
        maximised: true,
        fullScreen: false,
      });
      saveWorkspaceState("smoke-a", { version: 1, layout: { groups: [{ id: "g1", tabs: ["x.py"] }] } });

      const bothBack = restorableWindows().filter((w) => w.id.startsWith("smoke-"));
      forgetWindow("smoke-a");
      const afterClose = restorableWindows().filter((w) => w.id.startsWith("smoke-"));
      const state = loadWorkspaceState("smoke-a") as { version?: number } | undefined;

      if (liveId === undefined) {
        // Every live window must own a session row, or nothing about it can be restored.
        failures.push("session/the live window has no session id");
      } else if (bothBack.length !== 2) {
        failures.push(`session/expected both windows restorable, got ${bothBack.length}`);
      } else if (bothBack[0]?.bounds.width !== 1200 || bothBack[1]?.maximised !== true) {
        failures.push(`session/bounds or maximised did not round-trip: ${JSON.stringify(bothBack)}`);
      } else if (afterClose.map((w) => w.id).join(",") !== "smoke-b") {
        // The whole design: a deliberate close stays closed, everything else comes back.
        failures.push(`session/an explicitly closed window came back: ${JSON.stringify(afterClose)}`);
      } else if (state?.version !== 1) {
        failures.push("session/workspace state did not survive the close");
      } else {
        console.log(
          "[smoke] session: two windows remembered with geometry; a deliberate close stayed closed"
        );
      }
    }

    /**
     * Stopping a run, through the real transport.
     *
     * `exec:cancel` was registered and unreachable for three phases: it took the runId
     * `gradeSubmission` mints internally, so nothing in the renderer could name a run and
     * Run ▸ Stop stayed greyed. The unit tests cover the attempt layer's decisions; what
     * only the real seam can show is that a renderer can start a run, name it, and end it.
     *
     * The ordering is deterministic rather than a race: the `exec:run` handler registers the
     * attempt synchronously, before its first await, so the cancel that follows on the next
     * message cannot arrive too early to be seen.
     */
    {
      const { recentSubmissions } = await import("./store/submissions.js");
      const COUNT_LIMIT = 200;
      const before = recentSubmissions("min-max-scale", COUNT_LIMIT).length;

      const stopped = (await window!.webContents.executeJavaScript(`
        (async () => {
          const attemptId = crypto.randomUUID();
          const running = window.host.exec.run({
            problemId: "min-max-scale",
            source: "def min_max_scale(v):\\n    return v\\n",
            tier: "pyodide",
            attemptId,
          });
          const ack = await window.host.exec.cancel({ attemptId });
          const grade = await running;
          const stale = await window.host.exec.cancel({ attemptId });
          return {
            acked: ack.cancelled,
            staleAcked: stale.cancelled,
            outcome: grade.outcome,
            verdicts: grade.verdicts.length,
          };
        })()
      `)) as Record<string, unknown>;

      const after = recentSubmissions("min-max-scale", COUNT_LIMIT).length;

      if (stopped.acked !== true) {
        failures.push("exec:cancel did not find the attempt the renderer had just started");
      } else if (stopped.outcome !== "cancelled") {
        failures.push(`a stopped run reported outcome=${String(stopped.outcome)}`);
      } else if (stopped.verdicts !== 0) {
        // Scoring the empty result of an interrupted run marks every case failed — a wrong
        // answer for code that never finished.
        failures.push(`a stopped run produced ${String(stopped.verdicts)} verdicts`);
      } else if (after !== before) {
        // The one that would hurt a real user: pressing Stop must not file a permanent
        // failure against them, cost an attempt, or be able to break a streak.
        failures.push(`a stopped run was recorded as a submission: ${before} -> ${after}`);
      } else if (stopped.staleAcked !== false) {
        // The race every Stop button has. A second cancel for a finished attempt must not
        // claim success — and must not reach the sandbox, which by then may be busy again.
        failures.push("a stale exec:cancel claimed it stopped something");
      } else {
        console.log(
          "[smoke] stop: cancelled a run through the seam, reached no verdict, recorded no submission"
        );
      }
    }

    // Design review needs a picture, and the Build window is not reachable from a browser —
    // `window.host` is absent outside Electron, so serving the static export shows the
    // "not available here" state instead of the IDE. Opt-in, so CI does not write files.
    if (process.env.VOIDCODE_SMOKE_SHOTS !== undefined) {
      const directory = process.env.VOIDCODE_SMOKE_SHOTS;

      // Both destinations, because the claim being reviewed is that they are one product.
      // A screenshot of either alone cannot show that.
      for (const [name, route] of [
        ["code", "/build"],
        ["prep", "/homepage"],
        ["projects", "/projects"],
        ["workspace", "/problems/1"],
        ["interviews", "/interviews"],
        // A real slug, not the `generateStaticParams` placeholder. `placeholder` is a
        // build-time artefact — Next needs one static param for a dynamic segment — and
        // pointing the capture at it photographed a 404 for a question that does not
        // exist, which looks exactly like a broken route.
        ["interview-question", "/interviews/why-cross-entropy-not-mse"],
        // The optional account's two surfaces, signed out: the Models card's call to action and
        // the Account page's empty state.
        ["models", "/models"],
        ["account", "/account"],
      ] as const) {
        // Renderer errors are otherwise invisible here: a component that throws during
        // render unmounts the whole tree, and `capturePage` happily photographs the empty
        // window. Electron 43 passes a single event object to this listener — the old
        // `(e, level, message)` signature silently reports nothing, which has already
        // cost a wrong diagnosis in this project once.
        const consoleErrors: string[] = [];
        const onConsole = (event: { level: string; message: string }) => {
          if (event.level === "error") consoleErrors.push(event.message);
        };
        window.webContents.on("console-message", onConsole);

        await window.loadURL(`${APP_ORIGIN}${route}`);
        // Wait on `<main>`, not on the body. The menu bar is prerendered static HTML and
        // satisfies "body has text" the instant the document loads, so waiting on that
        // captured the frame with an empty workbench and reported it as a successful
        // screenshot — twice.
        const painted = await waitFor(
          window,
          `(document.querySelector("main")?.innerText.trim().length ?? 0) > 0`
        );
        // Give a crash that happens *after* first paint — data arrives, a component throws,
        // React unmounts everything — a moment to surface before we photograph the result.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        window.webContents.off("console-message", onConsole);

        if (!painted) failures.push(`build/${name} did not render within 10s`);
        for (const message of consoleErrors.slice(0, 3)) {
          failures.push(`build/${name} console error: ${message}`);
        }

        // Content in the DOM is not content on screen. A zero-height container or an
        // un-fired reveal animation both photograph as an empty window while every text
        // assertion passes.
        const geometry = await window.webContents.executeJavaScript(`
          (() => {
            const main = document.querySelector("main");
            if (main === null) return { main: null };
            const rect = main.getBoundingClientRect();
            const hidden = Array.from(main.querySelectorAll("*")).filter((el) => {
              const style = getComputedStyle(el);
              return style.opacity === "0" || style.visibility === "hidden";
            }).length;
            return {
              main: { w: Math.round(rect.width), h: Math.round(rect.height) },
              children: main.childElementCount,
              hiddenDescendants: hidden,
              textLength: main.innerText.trim().length,
            };
          })()
        `);
        console.log(`[smoke] ${name} geometry: ${JSON.stringify(geometry)}`);

        await captureShot(window, directory, name);
      }

      // The sign-in dialog is not a route, so it is opened the way a person opens it — from the
      // Models card — and photographed in both of its entry views.
      await window.loadURL(`${APP_ORIGIN}/models`);
      await waitFor(window, `[...document.querySelectorAll("button")].some((b) => /sign in to use the voidcode model/i.test(b.textContent ?? ""))`);
      for (const [name, script] of [
        ["sign-in", `[...document.querySelectorAll("button")].find((b) => /sign in to use the voidcode model/i.test(b.textContent ?? ""))?.click()`],
        ["register", `[...document.querySelectorAll("dialog[open] button")].find((b) => /^create an account$/i.test((b.textContent ?? "").trim()))?.click()`],
      ] as const) {
        await window.webContents.executeJavaScript(script);
        const opened = await waitFor(window, `document.querySelector("dialog[open]") !== null`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (!opened) failures.push(`build/${name} dialog did not open`);
        await captureShot(window, directory, name);
      }
      console.log(`[smoke] captured shell screenshots -> ${directory}`);
    }
  } catch (err) {
    failures.push(`build/threw: ${(err as Error).message}`);
  } finally {
    window?.destroy();
  }

  return failures;
}

/**
 * Phase 2 exit criterion: a NumPy exercise runs, grades, and reports its compliance
 * with the exercise's stated 200 ms / 64 MB budget.
 *
 * Goes through the real `utilityProcess` sandbox rather than calling Pyodide inline,
 * because the process boundary, the bare environment and the wheel path are exactly
 * the parts unit tests cannot cover.
 *
 * Expected outputs are derived by executing a reference implementation, never typed
 * in (spec §2.6). An LLM — or a tired author — asked to predict `sigmoid([0,2,-2])`
 * will produce plausible wrong digits, so the reference is the only trustworthy
 * source and this asserts the pipeline works that way round.
 */
async function runExecSmoke(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem, toPublic } = await import("./content/problems.js");

  const problem = getProblem("sigmoid");
  if (problem === undefined) return ["problem 'sigmoid' missing from the store"];

  failures.push(...(await verifyStableSoftmax()));
  failures.push(...(await verifyCrossEntropy()));
  failures.push(...(await verifyLayerNorm()));
  failures.push(...(await verifyReformulatedCuda()));
  failures.push(...(await verifySgdMomentum()));
  failures.push(...(await verifyAttention()));
  const { verifyRemainingCurriculum } = await import("./content/verify-curriculum.js");
  failures.push(...(await verifyRemainingCurriculum()));

  /**
   * Every interview problem, by whichever gate covers it.
   *
   * The expensive assertion in this file and worth it: it executes every reference in
   * Pyodide — a different interpreter from the CPython that produced the key — and checks
   * the whole conversion at once against an oracle that was never ours to get wrong.
   *
   * "The 38 interview problems" is what this said, and the number was doing two jobs badly. The
   * legacy items are compared against the frozen Judge0 key; anything authored after the freeze has
   * no key to compare to and is covered by a spec instead (`verify-interviews.ts` keys that on the
   * oracle, not on a count). So the step verifies all of them and the split is what matters, not
   * either figure — and the figure that was written down was the one that moved.
   */
  const { verifyInterviewProblems } = await import("./content/verify-interviews.js");
  const interviewKeys = await verifyInterviewProblems();
  failures.push(...interviewKeys.failures);
  if (interviewKeys.failures.length === 0) {
    console.log(
      `[smoke] interview problems: ${interviewKeys.problems} references executed; ` +
        `${interviewKeys.matched}/${interviewKeys.cases} cases re-derive the frozen answer key, ` +
        `${interviewKeys.uncovered} authored after the freeze, ${interviewKeys.gated} gated by spec ` +
        `(slowest reference ${interviewKeys.slowestMs}ms, ${interviewKeys.totalMs}ms total)`
    );
  }

  /**
   * Which cases a stub already satisfies.
   *
   * Reported, never a failure — a vacuous case is an argument for the next authoring batch, the
   * same treatment `coverage()` and `gatedConcepts` get. The suite pins the count, which is where
   * the pressure belongs; this line is so the number is visible to whoever runs the gate.
   */
  const { censusVacuousCases } = await import("./content/verify-vacuity.js");
  const census = await censusVacuousCases();
  failures.push(...census.brokenTemplates);

  /**
   * A stub passing a case with a real expected value is a failure, not a note.
   *
   * It was a printed number, which meant the count could drift upward unnoticed — the thing this
   * census exists to prevent. Cases whose correct answer *is* a null result are reported separately
   * and are not failures: no authoring can make them reject a body-less function, because returning
   * nothing is the right answer.
   */
  for (const id of census.vacuous) {
    failures.push(`content/${id} passes a stub, so it rejects nothing`);
  }
  console.log(
    `[smoke] vacuity: ${census.vacuous.length} of ${census.cases} cases pass a stub` +
      ` (${census.unavoidable.length} unavoidable: ${census.unavoidable.join(", ") || "none"})`
  );

  // Correct, written differently: pure stdlib, returns lists rather than ndarrays, and
  // uses the numerically stable two-branch form so it survives the saturation case.
  // Must be accepted, or the grader is judging style instead of correctness.
  const CORRECT = `
import math

def _one(v):
    if v >= 0:
        return 1.0 / (1.0 + math.exp(-v))
    e = math.exp(v)
    return e / (1.0 + e)

def sigmoid(x):
    if isinstance(x, (int, float)):
        return _one(x)
    if x and isinstance(x[0], list):
        return [[_one(v) for v in r] for r in x]
    return [_one(v) for v in x]
`;
  // Plausible and wrong. Without this the grader could be accepting everything.
  const WRONG = `
import numpy as np
def sigmoid(x):
    return np.tanh(np.asarray(x, dtype=float))
`;
  // Correct on every visible case and wrong on the hidden one: `math.exp(-v)` raises
  // OverflowError at v=800. This is precisely what the hidden saturation case is for,
  // and writing it this way is the most natural mistake to make.
  const NAIVE = `
import math
def sigmoid(x):
    if isinstance(x, (int, float)):
        return 1.0 / (1.0 + math.exp(-x))
    if x and isinstance(x[0], list):
        return [[1.0 / (1.0 + math.exp(-v)) for v in r] for r in x]
    return [1.0 / (1.0 + math.exp(-v)) for v in x]
`;

  const good = await gradeSubmission(problem, CORRECT);
  if (good.referenceBroken !== undefined) return [good.referenceBroken];

  console.log(
    `[smoke] graded ${good.verdicts.length} cases ` +
      `(${good.verdicts.filter((v) => v.visible).length} visible): ` +
      good.verdicts.map((v) => `${v.id}=${v.passed ? "pass" : "FAIL"}`).join(" ")
  );

  if (!good.solved) {
    failures.push(
      `correct-but-different solution rejected: ${good.verdicts
        .filter((v) => !v.passed)
        .map((v) => `${v.id} expected=${v.expected ?? "?"} actual=${v.actual ?? v.error ?? "?"}`)
        .join("; ")}`
    );
  }

  // Hidden verdicts must report pass/fail and nothing else — leaking `expected` would
  // hand over the answer key one submission at a time.
  for (const v of good.verdicts.filter((x) => !x.visible)) {
    if (v.expected !== undefined || v.actual !== undefined) {
      failures.push(`hidden case ${v.id} leaked its expected/actual value`);
    }
  }

  const wrong = await gradeSubmission(problem, WRONG);
  if (wrong.solved) failures.push("a wrong implementation was graded as solved");

  const naive = await gradeSubmission(problem, NAIVE);
  const hiddenFailed = naive.verdicts.some((v) => !v.visible && !v.passed);
  if (naive.solved || !hiddenFailed) {
    failures.push("the hidden saturation case did not catch the overflow-prone solution");
  } else {
    console.log("[smoke] hidden case caught the overflow-prone solution, as intended");
  }

  // The import allowlist comes from the problem, not the caller.
  const disallowed = await gradeSubmission(problem, `import os
def sigmoid(x): return os.name`);
  if (disallowed.outcome !== "compile_or_import") {
    failures.push(`disallowed import was not blocked: ${disallowed.outcome}`);
  }

  const { slowestCaseMs, pythonPeakBytes, wasmGrowthBytes } = good.measurements;
  const published = toPublic(problem);
  console.log(
    `[smoke] slowest case ${slowestCaseMs.toFixed(3)}ms / ${published.timeLimitMs}ms; ` +
      `python peak ${(pythonPeakBytes / 1024).toFixed(1)}KB, ` +
      `wasm growth ${(wasmGrowthBytes / 1024 / 1024).toFixed(2)}MB / ${published.memoryLimitMb}MB`
  );
  if (slowestCaseMs > published.timeLimitMs) failures.push("breached the stated time limit");

  return failures;
}

/**
 * Phase 3: report what this machine actually is, and what it can run.
 *
 * Deliberately prints rather than asserting specific hardware — it has to pass on a
 * CI runner with no GPU and on a workstation with one. What it *does* assert is that
 * the scan never invents data: an undetectable GPU must produce an empty list and a
 * stated unknown, not a plausible-looking guess, because the fit calculator turns
 * these numbers into promises about whether a multi-gigabyte download will work.
 */
async function runHardwareSmoke(): Promise<string[]> {
  const failures: string[] = [];
  const { scanHardware } = await import("./hardware/scan.js");
  const { CATALOGUE } = await import("./hardware/catalogue.js");
  const { recommend } = await import("./hardware/fit.js");

  const profile = await scanHardware();

  console.log(
    `[smoke] host: ${profile.cpu.model} | ${(profile.ramTotalMB / 1024).toFixed(1)}GB RAM | ` +
      `${profile.gpus.length} GPU(s)${profile.unifiedMemory ? " (unified)" : ""} | ` +
      `disk free ${(profile.diskFreeMB / 1024).toFixed(0)}GB`
  );
  for (const gpu of profile.gpus) {
    console.log(
      `[smoke]   ${gpu.vendor} ${gpu.name}: ${(gpu.vramTotalMB / 1024).toFixed(1)}GB VRAM` +
        (gpu.computeCapability !== undefined ? ` cc${gpu.computeCapability}` : "")
    );
  }
  for (const unknown of profile.unknowns) console.log(`[smoke]   unknown: ${unknown}`);
  console.log(
    `[smoke] backends: ${Object.keys(profile.backends).length === 0 ? "none detected" : JSON.stringify(profile.backends)}`
  );

  // No fabricated hardware. A GPU with 0 MB of VRAM would sail through the fit
  // calculator and produce a confident, wrong recommendation.
  for (const gpu of profile.gpus) {
    if (!Number.isFinite(gpu.vramTotalMB) || gpu.vramTotalMB <= 0) {
      failures.push(`GPU "${gpu.name}" reported a nonsense VRAM total: ${gpu.vramTotalMB}`);
    }
  }
  if (profile.gpus.length === 0 && profile.unknowns.length === 0) {
    failures.push("no GPU found and nothing recorded as unknown — silently implies none exists");
  }

  const { availableProviders } = await import("./inference/registry.js");
  const backends = await availableProviders();
  console.log(
    `[smoke] providers reachable: ${
      backends.length === 0
        ? "none (Study mode works without one; tutor and copilot are additive)"
        : backends.map((b) => `${b.label}${b.capabilities.remote ? " [remote]" : ""}`).join(", ")
    }`
  );
  // Local before remote, so a user chooses the cloud rather than landing on it.
  const firstRemote = backends.findIndex((b) => b.capabilities.remote);
  if (firstRemote !== -1 && backends.slice(firstRemote).some((b) => !b.capabilities.remote)) {
    failures.push("a remote provider was ordered ahead of a local one");
  }

  const ranked = recommend(CATALOGUE, profile, 8192);
  if (ranked.length === 0) {
    failures.push("recommender returned nothing at all");
    return failures;
  }

  const best = ranked[0]!;
  console.log(`[smoke] recommends ${best.model.label} [${best.model.licence}] -> ${best.fit.tier}`);
  console.log(`[smoke]   ${best.fit.explanation}`);

  // The app must stay usable with no model. If the best we can offer will not fit, that
  // has to be said plainly rather than presented as a recommendation.
  if (best.fit.tier === "wont-fit") {
    console.log("[smoke]   nothing fits this machine; Study mode still works without a model");
  }

  const OSI = new Set(["Apache-2.0", "MIT", "BSD-3-Clause"]);
  for (const { model } of ranked) {
    if (!OSI.has(model.licence)) {
      failures.push(`catalogue offers a non-OSI licence as a default: ${model.id} (${model.licence})`);
    }
  }

  return failures;
}

/**
 * Phase 2's missing half: does anything survive a restart?
 *
 * Writes to the real userData database, because the point is that the file works where
 * it will actually live.
 */
async function runStoreSmoke(): Promise<string[]> {
  const failures: string[] = [];
  const { openDatabase } = await import("./store/db.js");
  const { saveDraft, loadDraft, recentSubmissions, allProgress } = await import(
    "./store/submissions.js"
  );

  openDatabase();

  const marker = `# smoke ${new Date().toISOString()}`;
  saveDraft("sigmoid", marker);
  if (loadDraft("sigmoid") !== marker) {
    failures.push("draft did not round-trip through SQLite");
  }

  // The grading smoke calls the grader directly, so it persists nothing. Exercise the
  // write path explicitly instead of reporting a count that proves nothing either way.
  const { recordSubmission } = await import("./store/submissions.js");
  const { getProblem } = await import("./content/problems.js");
  const { gradeSubmission } = await import("./exec/grader.js");

  const problem = getProblem("min-max-scale");
  if (problem === undefined) return ["problem 'min-max-scale' missing"];

  // Explicit high limit: `recentSubmissions` defaults to 20, so comparing lengths through
  // the default silently starts failing on the twentieth smoke run — `before` and `after`
  // are both clamped to 20 and the check reports a persistence bug that is not there. Found
  // exactly that way.
  const COUNT_LIMIT = 200;
  const before = recentSubmissions("min-max-scale", COUNT_LIMIT).length;
  const failing = await gradeSubmission(problem, "def min_max_scale(v): return v");
  if (failing.referenceBroken !== undefined) return [failing.referenceBroken];
  recordSubmission("def min_max_scale(v): return v", failing);

  const after = recentSubmissions("min-max-scale", COUNT_LIMIT);
  if (after.length !== before + 1) {
    failures.push(`submission was not persisted: ${before} -> ${after.length}`);
  }
  if (after[0]?.solved !== false) {
    failures.push("a failing submission was recorded as solved");
  }

  const progress = allProgress().find((p) => p.problemId === "min-max-scale");
  if (progress === undefined || progress.attemptCount < 1) {
    failures.push("progress was not updated by a submission");
  }
  // A failed attempt must not claim a solve.
  if (progress?.solved !== false || progress.firstSolvedAt !== null) {
    failures.push("a failing attempt set firstSolvedAt");
  }

  console.log(
    `[smoke] store: persisted a failing submission ` +
      `(${after[0]?.passedCount}/${after[0]?.totalCount} cases), ` +
      `attempts=${progress?.attemptCount}, solved=${progress?.solved}, draft round-trip OK`
  );

  return failures;
}


/**
 * Gate for a newly ported problem (§2.8, applied to hand-authored content too).
 *
 * Porting content means importing someone's typed-in expected outputs unless something
 * stops you. This is that something: the reference is executed to produce the key, a
 * correct-but-different solution must be accepted, and a plausible wrong one must be
 * rejected — otherwise the cases are vacuous and would pass anything.
 */
async function verifyStableSoftmax(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem } = await import("./content/problems.js");

  const problem = getProblem("stable-softmax");
  if (problem === undefined) return ["problem 'stable-softmax' missing"];

  // Correct, and written differently: pure stdlib, and shifts by the max exactly as the
  // lesson requires. Must be accepted, or the grader is judging style.
  const CORRECT = `
import math

def softmax(logits):
    m = max(logits)
    e = [math.exp(v - m) for v in logits]
    total = sum(e)
    return [v / total for v in e]
`;
  // The textbook definition. Passes the small cases and overflows on 1000 — which is the
  // exercise, so this must fail.
  const NAIVE = `
import math

def softmax(logits):
    e = [math.exp(v) for v in logits]
    total = sum(e)
    return [v / total for v in e]
`;

  const good = await gradeSubmission(problem, CORRECT);
  if (good.referenceBroken !== undefined) return [good.referenceBroken];

  console.log(
    `[smoke] stable-softmax derived: ` +
      good.verdicts
        .filter((v) => v.visible)
        .map((v) => `${v.id}=${v.expected}`)
        .join("  ")
  );

  if (!good.solved) {
    failures.push(
      `correct stdlib solution rejected: ${good.verdicts
        .filter((v) => !v.passed)
        .map((v) => `${v.id} got=${v.actual ?? v.error} want=${v.expected ?? "hidden"}`)
        .join("; ")}`
    );
  }

  const naive = await gradeSubmission(problem, NAIVE);
  if (naive.solved) {
    failures.push("the naive textbook softmax was accepted — the overflow case is vacuous");
  } else {
    const overflowFailed = naive.verdicts.some((v) => v.id === "overflow" && !v.passed);
    console.log(
      `[smoke] naive softmax rejected${overflowFailed ? " by the overflow case, as intended" : ""}`
    );
  }

  return failures;
}


/** Same gate as stable-softmax: derive the key, accept a correct variant, reject a wrong one. */
async function verifyCrossEntropy(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem } = await import("./content/problems.js");

  const problem = getProblem("cross-entropy-loss");
  if (problem === undefined) return ["problem 'cross-entropy-loss' missing"];

  // Correct, pure stdlib, clamps as the lesson requires.
  const CORRECT = `
import math

def cross_entropy(probs, targets):
    total = 0.0
    for row, t in zip(probs, targets):
        total += -math.log(max(row[t], 1e-12))
    return total / len(targets)
`;
  // No clamp. Passes every visible case and returns infinity on a zero probability, which
  // is exactly what the hidden case exists to catch.
  const UNCLAMPED = `
import math

def cross_entropy(probs, targets):
    total = 0.0
    for row, t in zip(probs, targets):
        total += -math.log(row[t])
    return total / len(targets)
`;

  const good = await gradeSubmission(problem, CORRECT);
  if (good.referenceBroken !== undefined) return [good.referenceBroken];

  console.log(
    `[smoke] cross-entropy derived: ` +
      good.verdicts.filter((v) => v.visible).map((v) => `${v.id}=${v.expected}`).join("  ")
  );
  if (!good.solved) {
    failures.push(
      `correct stdlib solution rejected: ${good.verdicts
        .filter((v) => !v.passed)
        .map((v) => `${v.id} got=${v.actual ?? v.error}`)
        .join("; ")}`
    );
  }

  const unclamped = await gradeSubmission(problem, UNCLAMPED);
  const visiblePassed = unclamped.verdicts.filter((v) => v.visible).every((v) => v.passed);
  const hiddenCaught = unclamped.verdicts.some((v) => !v.visible && !v.passed);

  if (unclamped.solved || !hiddenCaught) {
    failures.push("the unclamped implementation was accepted — the zero-probability case is vacuous");
  } else {
    console.log(
      `[smoke] unclamped rejected by a hidden case` +
        (visiblePassed ? ", after passing every visible one — which is why it is hidden" : "")
    );
  }

  return failures;
}


/**
 * Layer norm's gate carries one mutant per named trap, rather than a single wrong answer.
 *
 * The statement calls out biased variance and eps placement specifically, so each needs to
 * be shown caught. A single mutant would leave the other trap's case unproven — and an
 * unproven case is one nobody finds out is vacuous until a learner is passed by it.
 */
async function verifyLayerNorm(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem } = await import("./content/problems.js");

  const problem = getProblem("layer-norm");
  if (problem === undefined) return ["problem 'layer-norm' missing"];

  const CORRECT = `
import math

def layer_norm(x, gamma, beta, eps):
    n = len(x)
    mean = sum(x) / n
    var = sum((v - mean) ** 2 for v in x) / n
    denom = math.sqrt(var + eps)
    return [(v - mean) / denom * g + b for v, g, b in zip(x, gamma, beta)]
`;
  // ddof=1. The classic reflex from statistics, wrong for LayerNorm.
  const SAMPLE_VARIANCE = `
import math

def layer_norm(x, gamma, beta, eps):
    n = len(x)
    mean = sum(x) / n
    var = sum((v - mean) ** 2 for v in x) / (n - 1)
    denom = math.sqrt(var + eps)
    return [(v - mean) / denom * g + b for v, g, b in zip(x, gamma, beta)]
`;
  // eps outside the root. Reads almost identically and is wrong everywhere.
  const EPS_OUTSIDE = `
import math

def layer_norm(x, gamma, beta, eps):
    n = len(x)
    mean = sum(x) / n
    var = sum((v - mean) ** 2 for v in x) / n
    denom = math.sqrt(var) + eps
    return [(v - mean) / denom * g + b for v, g, b in zip(x, gamma, beta)]
`;

  const good = await gradeSubmission(problem, CORRECT);
  if (good.referenceBroken !== undefined) return [good.referenceBroken];

  console.log(
    `[smoke] layer-norm derived: ` +
      good.verdicts.filter((v) => v.visible).map((v) => `${v.id}=${v.expected}`).join("  ")
  );
  if (!good.solved) {
    failures.push(
      `correct stdlib solution rejected: ${good.verdicts
        .filter((v) => !v.passed)
        .map((v) => `${v.id} got=${v.actual ?? v.error}`)
        .join("; ")}`
    );
  }

  for (const [label, source, caseId] of [
    ["sample variance", SAMPLE_VARIANCE, undefined],
    ["eps outside the root", EPS_OUTSIDE, "eps-placement"],
  ] as const) {
    const bad = await gradeSubmission(problem, source);
    if (bad.solved) {
      failures.push(`"${label}" was accepted — the case meant to catch it is vacuous`);
      continue;
    }
    const byTarget =
      caseId === undefined || bad.verdicts.some((v) => v.id === caseId && !v.passed);
    if (!byTarget) {
      failures.push(`"${label}" failed, but not on the ${caseId} case that exists for it`);
    } else {
      console.log(`[smoke] layer-norm rejected "${label}"`);
    }
  }

  return failures;
}


/**
 * The two reformulated CUDA problems.
 *
 * These are the ones most at risk of being quietly wrong, because the translation from a
 * kernel to a loop is where the lesson could be lost without anything failing. So the gate
 * checks the derived values against the numbers the original GPU content shipped — if the
 * reformulation changed the semantics, those would disagree.
 */
async function verifyReformulatedCuda(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem } = await import("./content/problems.js");

  // Straight from problem_content_gpu.py. Used as a cross-check on the reformulation, not
  // as the answer key — the key is still derived by executing the reference.
  const FROM_GPU_SEED: Record<string, Record<string, string>> = {
    "parallel-reduction": {
      "power-of-two": "[[6, 8, 10, 12], [16, 20], [36]]",
      "odd-length": "[[5, 7, 3], [8, 7], [15]]",
      six: "[[4, 6, 13], [17, 6], [23]]",
    },
    "thread-index-mapping": {
      exact: "[[0, 1, 2, 3], [4, 5, 6, 7]]",
      ragged: "[[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, -1, -1]]",
      "mostly-idle": "[[0, 1, 2, -1, -1, -1, -1, -1]]",
    },
  };

  const MUTANTS: Record<string, Array<[string, string, string]>> = {
    "parallel-reduction": [
      // Rounds down. Drops the unpaired tail element on any odd length.
      [
        "stride rounding down",
        `
def reduce_steps(values):
    active = list(values)
    steps = []
    while len(active) > 1:
        stride = len(active) // 2
        nxt = [active[i] + active[i + stride] for i in range(stride)]
        active = nxt
        steps.append(active)
    return steps
`,
        "odd-length",
      ],
    ],
    "thread-index-mapping": [
      // No bounds guard — the failure the exercise exists to teach.
      [
        "missing bounds guard",
        `
def map_threads(num_blocks, block_dim, n):
    return [[b * block_dim + t for t in range(block_dim)] for b in range(num_blocks)]
`,
        "ragged",
      ],
    ],
  };

  for (const id of ["parallel-reduction", "thread-index-mapping"]) {
    const problem = getProblem(id);
    if (problem === undefined) {
      failures.push(`problem '${id}' missing`);
      continue;
    }

    const good = await gradeSubmission(problem, problem.reference);
    if (good.referenceBroken !== undefined) {
      failures.push(good.referenceBroken);
      continue;
    }

    // Does the reformulation still compute what the GPU version did?
    for (const [caseId, expected] of Object.entries(FROM_GPU_SEED[id] ?? {})) {
      const got = good.verdicts.find((v) => v.id === caseId)?.expected;
      if (got !== expected) {
        failures.push(
          `${id}/${caseId}: reformulation disagrees with the original GPU content — derived ${got}, was ${expected}`
        );
      }
    }
    console.log(`[smoke] ${id}: derived values agree with the original GPU content`);

    for (const [label, source, caseId] of MUTANTS[id] ?? []) {
      const bad = await gradeSubmission(problem, source);
      const caught = bad.verdicts.some((v) => v.id === caseId && !v.passed);
      if (bad.solved || !caught) {
        failures.push(`${id}: "${label}" not caught by the ${caseId} case`);
      } else {
        console.log(`[smoke] ${id}: rejected "${label}"`);
      }
    }
  }

  return failures;
}


/**
 * SGD's gate carries two mutants because the statement names one trap and the return shape
 * implies a second.
 *
 * Decoupled decay is the named one. The other is folding `lr` into the buffer: that
 * produces *identical parameters* and a different velocity, so it is invisible unless the
 * buffer is checked — which is the reason the exercise returns it.
 */
async function verifySgdMomentum(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem } = await import("./content/problems.js");

  const problem = getProblem("sgd-momentum-step");
  if (problem === undefined) return ["problem 'sgd-momentum-step' missing"];

  const CORRECT = `
import numpy as np

def sgd_step(params, grads, velocity, lr, momentum, weight_decay):
    p = np.asarray(params, dtype=float)
    g = np.asarray(grads, dtype=float) + weight_decay * p
    v = momentum * np.asarray(velocity, dtype=float) + g
    return [(p - lr * v).tolist(), v.tolist()]
`;
  // AdamW-style: decay applied to the parameter after the step, never entering the buffer.
  const DECOUPLED_DECAY = `
def sgd_step(params, grads, velocity, lr, momentum, weight_decay):
    new_p, new_v = [], []
    for p, g, v in zip(params, grads, velocity):
        v = momentum * v + g
        new_p.append(p - lr * v - lr * weight_decay * p)
        new_v.append(v)
    return [new_p, new_v]
`;
  // lr inside the buffer. Same parameters, different velocity.
  const LR_IN_BUFFER = `
def sgd_step(params, grads, velocity, lr, momentum, weight_decay):
    new_p, new_v = [], []
    for p, g, v in zip(params, grads, velocity):
        g = g + weight_decay * p
        v = momentum * v + lr * g
        new_p.append(p - v)
        new_v.append(v)
    return [new_p, new_v]
`;

  const good = await gradeSubmission(problem, CORRECT);
  if (good.referenceBroken !== undefined) return [good.referenceBroken];

  console.log(
    `[smoke] sgd-momentum derived: ` +
      good.verdicts.filter((v) => v.visible).map((v) => `${v.id}=${v.expected}`).join("  ")
  );
  if (!good.solved) {
    failures.push(
      `correct numpy solution rejected: ${good.verdicts
        .filter((v) => !v.passed)
        .map((v) => `${v.id} got=${v.actual ?? v.error}`)
        .join("; ")}`
    );
  }

  for (const [label, source] of [
    ["decoupled weight decay", DECOUPLED_DECAY],
    ["lr folded into the buffer", LR_IN_BUFFER],
  ] as const) {
    const bad = await gradeSubmission(problem, source);
    if (bad.solved) failures.push(`"${label}" was accepted`);
    else console.log(`[smoke] sgd-momentum rejected "${label}"`);
  }

  return failures;
}


/** Attention: one mutant per named trap, each asserted against the case built for it. */
async function verifyAttention(): Promise<string[]> {
  const failures: string[] = [];
  const { gradeSubmission } = await import("./exec/grader.js");
  const { getProblem } = await import("./content/problems.js");

  const problem = getProblem("scaled-dot-product-attention");
  if (problem === undefined) return ["problem 'scaled-dot-product-attention' missing"];

  const CORRECT = `
import math

def attention(queries, keys, values, causal):
    d = len(keys[0])
    out = []
    for i, qi in enumerate(queries):
        logits = []
        for j, kj in enumerate(keys):
            if causal and j > i:
                logits.append(None)
            else:
                logits.append(sum(a * b for a, b in zip(qi, kj)) / math.sqrt(d))
        live = [x for x in logits if x is not None]
        m = max(live)
        exps = [0.0 if x is None else math.exp(x - m) for x in logits]
        total = sum(exps)
        row = [0.0] * len(values[0])
        for w, vj in zip(exps, values):
            for c, val in enumerate(vj):
                row[c] += (w / total) * val
        out.append(row)
    return out
`;
  // No scale. Saturates once the scores are large.
  const NO_SCALE = `
import numpy as np

def attention(queries, keys, values, causal):
    q, k, v = map(lambda a: np.asarray(a, dtype=float), (queries, keys, values))
    logits = q @ k.T
    if causal:
        logits = np.where(np.triu(np.ones(logits.shape, dtype=bool), k=1), -np.inf, logits)
    e = np.exp(logits - logits.max(axis=-1, keepdims=True))
    return ((e / e.sum(axis=-1, keepdims=True)) @ v).tolist()
`;
  // Masks after the softmax. Rows no longer sum to one.
  const MASK_AFTER = `
import numpy as np

def attention(queries, keys, values, causal):
    q, k, v = map(lambda a: np.asarray(a, dtype=float), (queries, keys, values))
    logits = q @ k.T / np.sqrt(k.shape[-1])
    e = np.exp(logits - logits.max(axis=-1, keepdims=True))
    w = e / e.sum(axis=-1, keepdims=True)
    if causal:
        w = np.where(np.triu(np.ones(w.shape, dtype=bool), k=1), 0.0, w)
    return (w @ v).tolist()
`;

  const good = await gradeSubmission(problem, CORRECT);
  if (good.referenceBroken !== undefined) return [good.referenceBroken];

  console.log(
    `[smoke] attention derived: ` +
      good.verdicts.filter((v) => v.visible).map((v) => `${v.id}=${v.expected}`).join("  ")
  );
  if (!good.solved) {
    failures.push(
      `correct stdlib solution rejected: ${good.verdicts
        .filter((v) => !v.passed)
        .map((v) => `${v.id} got=${v.actual ?? v.error}`)
        .join("; ")}`
    );
  }

  for (const [label, source, caseId] of [
    ["missing sqrt(d_k) scale", NO_SCALE, "scale-matters"],
    ["mask applied after softmax", MASK_AFTER, "causal"],
  ] as const) {
    const bad = await gradeSubmission(problem, source);
    const caught = bad.verdicts.some((v) => v.id === caseId && !v.passed);
    if (bad.solved || !caught) {
      failures.push(`"${label}" not caught by the ${caseId} case`);
    } else {
      console.log(`[smoke] attention rejected "${label}"`);
    }
  }

  return failures;
}
