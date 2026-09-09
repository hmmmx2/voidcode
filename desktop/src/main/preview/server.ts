/**
 * A dev server that outlives the turn that started it.
 *
 * `run_command` cannot do this and should not be made to. It kills at 120 seconds with a
 * process-tree kill, because its job is "run this and tell me what happened" — a bounded thing
 * with an exit code. A dev server has no exit code worth waiting for; the whole point is that it
 * keeps running. Raising that timeout would turn the one tool with a hard stop into one without,
 * for every command Auto mode runs, to serve a case that is not a command at all.
 *
 * So this is separate, and narrow: **one server per project root, started only by the user, and
 * killed on project close and on quit.**
 *
 * ## What this deliberately does not do
 *
 * **It does not take a command.** `detect.ts` reads the project's own `package.json` and decides;
 * see its header for why a renderer-supplied command would be arbitrary code execution routed
 * past the Auto-mode grant that exists to gate exactly that.
 *
 * **It does not reach the network.** The address comes from what the server printed on its own
 * stdout, filtered to loopback by `url.ts`. `net/allowlist.ts` — the agent's fetch defence — is
 * not involved and must not be: it blocks every loopback form on purpose, and routing a preview
 * through it would mean weakening the one thing standing between a hostile page and the
 * machine's own services.
 *
 * **It does not restart on its own.** A dev server that died deserves to be seen to have died.
 * Respawning would turn a crash loop into a spinner, and the log below is the thing that says
 * what actually happened.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { killTree, Capped } from "../proc/spawn.js";
import { sanitisedEnv } from "../terminal/shell.js";
import { parseDevServerUrl } from "./url.js";
import type { PreviewCommand } from "./detect.js";
// Declared in `src/shared` because the renderer draws it — see that file for why.
import type { PreviewState } from "../../shared/preview.js";
export type { PreviewState, PreviewStatus } from "../../shared/preview.js";

/**
 * How long to wait for an address before giving up.
 *
 * Generous, because a cold `next dev` on a large project genuinely takes this long — it compiles
 * before it listens. The failure this bounds is "started and never announced itself", which
 * without a bound is a spinner forever.
 */
const ANNOUNCE_TIMEOUT_MS = 90_000;

/** Between readiness probes. A dev server prints its address slightly before it can serve. */
const PROBE_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 20_000;

interface Preview {
  child: ChildProcess;
  state: PreviewState;
  log: Capped;
  /** Cleared on stop so a probe cannot resolve into a preview the user already closed. */
  cancelled: boolean;
  /**
   * One probe loop, ever.
   *
   * Without this, every later chunk containing an address starts another: `url` stays null while
   * the first probe is still running, so the guard on it does not hold. Vite alone prints Local
   * and Network on separate lines, and an HMR reconnect prints the address again — so this is
   * the normal case rather than a corner of one, and the symptom would be several loops all
   * hammering the same port and racing to publish.
   */
  probing: boolean;
}

/** One per project root. A second start for the same root replaces the first. */
const previews = new Map<string, Preview>();

const IDLE: PreviewState = {
  status: "idle",
  url: null,
  label: null,
  log: "",
  exitCode: null,
  error: null,
};

export function previewState(root: string): PreviewState {
  const preview = previews.get(root);
  if (preview === undefined) return IDLE;
  return { ...preview.state, log: preview.log.text() };
}

/**
 * Start one, replacing whatever was running for this root.
 *
 * Resolves as soon as the process is spawned, not when it is ready — readiness arrives through
 * `onChange`, because the caller is an IPC handler and a channel that blocked for ninety seconds
 * would be indistinguishable from a hung app.
 */
export function startPreview(
  root: string,
  command: PreviewCommand,
  onChange: (state: PreviewState) => void
): PreviewState {
  stopPreview(root);

  const log = new Capped();
  const state: PreviewState = {
    status: "starting",
    url: null,
    label: command.label,
    log: "",
    exitCode: null,
    error: null,
  };

  /**
   * A shell only for the shims that cannot be launched without one.
   *
   * Node refuses to spawn a `.cmd` without a shell since the fix for CVE-2024-27980 — and on
   * Windows `npm`, `pnpm` and `yarn` are all `.cmd` shims. That is `spawn EINVAL`, which is what
   * this feature did on its first real run.
   *
   * Keyed on the file's suffix rather than on the platform, so the rule is the same everywhere
   * and the guard below is testable on any of them. `detect.ts` only ever appends `.cmd` on
   * Windows, so nothing else reaches this branch in practice.
   */
  const needsShell = /\.(cmd|bat)$/i.test(command.file);

  if (needsShell && (!isPlainToken(command.file) || !command.args.every(isPlainToken))) {
    /**
     * The check that replaces `shell: false` for this one case.
     *
     * With a shell, the file and arguments are joined into a string something else parses — so
     * the safety has to come from the contents instead: `npm run dev` is three bare words with
     * nothing for a shell to act on. Unreachable through `detect.ts`, which composes both halves
     * from closed sets, and asserted here anyway because this is where the shell is relied on.
     *
     * The non-shell path needs no such check: an argv is passed to the OS as an argv, and
     * nothing in it is ever interpreted.
     */
    return { ...state, status: "failed", error: "Refusing to run an unexpected command." };
  }

  let child: ChildProcess;
  try {
    child = spawn(command.file, [...command.args], {
      cwd: root,
      env: sanitisedEnv(),
      // See `needsShell` above: false for everything but a `.cmd`/`.bat` shim, which Node
      // cannot launch any other way.
      shell: needsShell,
      windowsHide: true,
      // Own process group on POSIX, so `killTree` can signal the whole tree: a dev server that
      // spawns a compiler leaves it holding the port otherwise.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // A spawn that throws synchronously — a malformed file name, most often. Reported as a
    // failed preview rather than thrown: the caller is an IPC handler and this is an outcome.
    return { ...state, status: "failed", error: describeSpawnError(err, command) };
  }

  const preview: Preview = { child, state, log, cancelled: false, probing: false };
  previews.set(root, preview);

  /**
   * The one place a stopped preview is made silent.
   *
   * Every other `cancelled` check below is a cheap early-out, not an independent guarantee —
   * mutation testing showed that removing any of them changes nothing observable, because this
   * check shadows them all. That is the design working (one chokepoint rather than five), and it
   * is written down because four un-killable mutants otherwise look like missing tests.
   */
  const publish = () => {
    if (!preview.cancelled) onChange({ ...preview.state, log: log.text() });
  };

  /**
   * Every line is looked at until an address is found, and none after.
   *
   * Not just the first few: `next dev` prints a banner, a version, and several blank lines
   * before its address, and Vite prints the address after its startup timing. Stopping early
   * would work on whichever server it was tested against.
   */
  const scan = (chunk: Buffer) => {
    log.push(chunk);
    if (preview.state.url === null && preview.state.status === "starting") {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        const url = parseDevServerUrl(line);
        if (url !== null) {
          void probe(preview, url, publish);
          break;
        }
      }
    }
    publish();
  };

  /*
    Both streams, scanned the same way and pooled into one log.

    stderr is not a failure here: Vite, Next and webpack all announce themselves on it at least
    some of the time, and a scanner watching only stdout would miss the address on whichever
    server the author did not test against. Keeping them separate — which `proc/spawn.ts` does
    deliberately, because "printed to stderr and exited 0" matters for a bounded command — buys
    nothing for a process that has no exit code worth reading.
  */
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);

  child.on("error", (err) => {
    preview.state.status = "failed";
    preview.state.error = describeSpawnError(err, command);
    publish();
  });

  child.on("exit", (code, signal) => {
    // A stop already reported itself; this is the process confirming. Reporting again would
    // overwrite "stopped" with "failed" for a server the user closed deliberately.
    if (preview.cancelled) return;
    preview.state.exitCode = code;
    preview.state.status = "failed";
    preview.state.url = null;
    preview.state.error =
      signal !== null
        ? `The dev server was killed by ${signal}.`
        : `The dev server exited with code ${String(code ?? -1)}.`;
    publish();
  });

  /** Announced nothing in a minute and a half: still running, still useless. */
  const announceTimer = setTimeout(() => {
    if (preview.cancelled || preview.state.status !== "starting") return;
    preview.state.status = "failed";
    preview.state.error =
      "The dev server did not print an address in 90 seconds. Its output is below.";
    publish();
  }, ANNOUNCE_TIMEOUT_MS);
  announceTimer.unref();
  child.once("exit", () => clearTimeout(announceTimer));

  return { ...state };
}

/**
 * Wait until something answers, then call it ready.
 *
 * A printed address is a promise, not a fact: every dev server prints before its first request
 * can be served, and an iframe pointed at it too early shows a connection error that never
 * retries. That error is indistinguishable from a broken project, which is why this waits.
 */
async function probe(
  preview: Preview,
  url: string,
  publish: () => void
): Promise<void> {
  const deadline = Date.now() + PROBE_TIMEOUT_MS;

  while (!preview.cancelled && Date.now() < deadline) {
    try {
      /**
       * `fetch` straight at loopback, and NOT through `net/allowlist.ts`.
       *
       * That module blocks every loopback form deliberately — it is the agent's SSRF defence,
       * guarding a fetch whose URL a model chose. This URL came from a process the user started,
       * in their own project, and was filtered to loopback before it got here. Routing this
       * through the allowlist would mean punching a loopback hole in the exact guard that exists
       * to keep one closed.
       */
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2_000),
      });
      // Any answer at all, including a 404 or a 500. The server is up; what it serves at `/` is
      // the project's business, and a dev server that 404s the root is a normal thing.
      void response;
      if (preview.cancelled) return;
      preview.state.status = "ready";
      preview.state.url = url;
      publish();
      return;
    } catch {
      // Not up yet, or not up ever. The loop's deadline decides which.
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
    }
  }

  if (preview.cancelled || preview.state.status !== "starting") return;
  preview.state.status = "failed";
  preview.state.error = `Nothing answered at ${url} after 20 seconds.`;
  publish();
}

/** Stop one, if there is one. Safe to call for a root that has none. */
export function stopPreview(root: string): void {
  const preview = previews.get(root);
  if (preview === undefined) return;
  /*
    Set before the kill, though not because of a race.

    An earlier comment here claimed the ordering prevented `exit` from reporting a deliberate
    stop as a crash. It does not: `exit` is an event, so it cannot run before this function
    returns whichever order these two lines are in. `publish` is what makes a stopped preview
    silent. The ordering is kept because reading it in this order is how anyone would expect it
    to work — not because reversing it would break anything.
  */
  preview.cancelled = true;
  previews.delete(root);
  killTree(preview.child);
}

/**
 * Every preview, for `will-quit`.
 *
 * The counterpart of `killAllTerminals` and `killAllCommands`, and it exists for the reason
 * `quit.ts` records: shutdown tears windows down without the close handshake completing, so
 * anything relying on a per-window teardown is left running after the app is gone. A dev server
 * holding port 3000 after VoidCode has exited is the most visible possible version of that.
 */
export function killAllPreviews(): void {
  for (const root of [...previews.keys()]) stopPreview(root);
}

/**
 * A bare word: a program name or a subcommand, and nothing a shell would act on.
 *
 * Deliberately an allowlist. A denylist of metacharacters is the wrong shape for this — the set
 * of things `cmd.exe` treats specially is long, version-dependent and includes `%VAR%` expansion
 * that no obvious blocklist catches. Everything this needs to pass is `[a-z0-9._-]`, so that is
 * what it permits.
 */
function isPlainToken(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function describeSpawnError(err: unknown, command: PreviewCommand): string {
  const code = (err as { code?: unknown }).code;
  if (code === "ENOENT") {
    // The overwhelmingly common one, and the message has to name the fix rather than the errno.
    return `${command.label.split(" ")[0] ?? "The package manager"} was not found on PATH.`;
  }
  return err instanceof Error ? err.message : String(err);
}
