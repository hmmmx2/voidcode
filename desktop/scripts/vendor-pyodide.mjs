/**
 * Download the Pyodide wheels this app needs into `vendor/pyodide-packages/`.
 *
 * Run at build time, never at runtime. The npm package ships the interpreter and the
 * stdlib but not the package wheels, so without this step the first `loadPackage`
 * silently reaches for a CDN — and an app whose headline promise is "works offline on
 * any laptop" (spec §4.4) cannot depend on the network to run its first exercise.
 *
 * Pyodide's own loader does the fetching, with `packageCacheDir` pointed at the
 * vendor directory, so the filenames and lockfile resolution stay its business
 * rather than something we reimplement and get subtly wrong.
 */
import { loadPyodide } from "pyodide";
import path from "node:path";
import fs from "node:fs/promises";

// Kept deliberately short. Every wheel here is install size for every user, and
// scipy plus pandas plus scikit-learn is well over 50 MB.
const PACKAGES = ["numpy"];

const root = path.resolve(import.meta.dirname, "..");
const vendor = path.join(root, "vendor", "pyodide-packages");

await fs.mkdir(vendor, { recursive: true });

const pyodide = await loadPyodide({
  indexURL: path.join(root, "node_modules", "pyodide"),
  packageCacheDir: vendor,
});

console.log(`vendoring: ${PACKAGES.join(", ")}`);
await pyodide.loadPackage(PACKAGES);

const files = (await fs.readdir(vendor)).filter((f) => f.endsWith(".whl"));
let total = 0;
for (const f of files) total += (await fs.stat(path.join(vendor, f))).size;

console.log(`vendored ${files.length} wheel(s), ${(total / 1024 / 1024).toFixed(1)} MB:`);
for (const f of files) console.log(`  ${f}`);

if (files.length === 0) {
  console.error("no wheels vendored — offline execution would fall back to the CDN");
  process.exit(1);
}
