/**
 * Ad-hoc sign the macOS app after electron-builder packs it.
 *
 * WHY AN UNSIGNED BUILD IS NOT AN OPTION ON APPLE SILICON
 *
 * On arm64 macOS the kernel refuses to execute a binary with no signature at all — not "warns",
 * refuses. An Apple silicon user opening a genuinely unsigned .app gets "VoidCode is damaged and
 * can't be opened. You should move it to the Bin.", with no Open Anyway anywhere, because the
 * failure happens before Gatekeeper's policy check. That message is indistinguishable from a
 * corrupted download, which is exactly the wrong thing for a first impression to be ambiguous
 * about.
 *
 * An AD-HOC signature (`codesign --sign -`) is a signature with no identity behind it. It satisfies
 * the kernel, so the app launches; it does not satisfy Gatekeeper, so the first launch still has to
 * be approved through System Settings › Privacy & Security — which is the prompt the download page
 * documents step by step. The difference is between a refusal a user cannot get past and a prompt
 * they can.
 *
 * WHY THIS IS A HOOK AND NOT `mac.identity: "-"`
 *
 * electron-builder's `identity` field selects a certificate from the keychain, and its handling of
 * `"-"` has changed across versions; `null` means "skip signing entirely", which is the thing being
 * avoided here. Doing it in a hook means the command is written out in full, in this file, where it
 * can be read and reproduced by hand — and `desktop.yml` verifies the result with `codesign
 * --verify --deep --strict` on the runner, so a silent failure fails the build rather than shipping.
 *
 * NO HARDENED RUNTIME FLAG, NO ENTITLEMENTS, NO TIMESTAMP. `--options runtime` and entitlements are
 * meaningful when a real identity signs and notarisation follows; on an ad-hoc signature they
 * change nothing a user can observe. `--timestamp=none` is deliberate: a trusted timestamp needs
 * Apple's server, and an offline or blocked runner would otherwise fail here for a property this
 * signature does not have anyway.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

/** electron-builder calls this with the packed app's directory and the target platform. */
exports.default = async function adHocSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productName = context.packager.appInfo.productFilename;
  const app = path.join(context.appOutDir, `${productName}.app`);

  if (!existsSync(app)) {
    throw new Error(`ad-hoc signing: ${app} does not exist, so nothing was signed`);
  }

  // `--deep` signs the nested helpers (the Electron framework, the crash reporter, the helper
  // apps). Without it the outer bundle is signed and the code that actually runs is not, which on
  // arm64 fails at launch in exactly the way this hook exists to prevent.
  //
  // `--force` replaces whatever electron-builder left behind rather than erroring on an existing
  // signature, so re-running a packaging step locally is idempotent.
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", app],
    { stdio: "inherit" },
  );

  // Verified here as well as in CI: a local `npm run package` on a Mac should fail at the point of
  // the mistake, not at install time on somebody else's machine.
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], {
    stdio: "inherit",
  });

  console.log(`ad-hoc signed ${path.basename(app)} (no identity; Gatekeeper will still prompt)`);
};
