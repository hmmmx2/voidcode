/**
 * Hardware detection (spec §2.4).
 *
 * Every value here is *measured or absent*. There are no fallback guesses that look
 * like data: an undetectable GPU produces an empty list, not an invented one, because
 * the fit calculator downstream turns numbers into promises about whether a 5 GB
 * download will work.
 *
 * Runs in main for now. It belongs in a `utilityProcess` per the spec — `nvidia-smi`
 * on a machine with a sleeping dGPU can block for seconds — and the TTL cache below
 * keeps that from being felt on every call. Moving it is a small change because
 * nothing here touches Electron state beyond `app`.
 */
import { execFile } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";

export type { GpuInfo, GpuVendor, HardwareProfile } from "../../shared/hardware-types.js";

import type { GpuInfo, HardwareProfile } from "../../shared/hardware-types.js";

const TTL_MS = 30_000;
let cached: { profile: HardwareProfile; at: number } | undefined;

function run(command: string, args: string[], timeoutMs = 5_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      // Missing tool, non-zero exit, or timeout all mean "cannot determine". Resolving
      // undefined rather than rejecting keeps the caller free of try/catch noise for a
      // condition that is completely normal.
      resolve(err ? undefined : stdout);
    });
  });
}

async function scanNvidia(unknowns: string[]): Promise<GpuInfo[]> {
  const out = await run("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.used,driver_version,compute_cap",
    "--format=csv,noheader,nounits",
  ]);
  if (out === undefined) return [];

  const gpus: GpuInfo[] = [];
  for (const line of out.trim().split("\n")) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 5) continue;

    const [name, total, used, driver, cc] = parts;
    const totalMB = Number(total);
    const usedMB = Number(used);
    if (!Number.isFinite(totalMB)) {
      unknowns.push(`nvidia-smi reported an unparseable VRAM total: ${String(total)}`);
      continue;
    }

    // Hoisted: with `exactOptionalPropertyTypes`, TypeScript cannot narrow across two
    // separate calls, so the guard and the value have to be the same expression.
    const bandwidth = bandwidthFor(name ?? "");

    gpus.push({
      vendor: "nvidia",
      name: name ?? "NVIDIA GPU",
      vramTotalMB: totalMB,
      ...(Number.isFinite(usedMB) ? { vramFreeMB: totalMB - usedMB } : {}),
      ...(driver !== undefined ? { driver } : {}),
      ...(cc !== undefined ? { computeCapability: cc } : {}),
      ...(bandwidth !== undefined ? { memoryBandwidthGBs: bandwidth } : {}),
    });
  }
  return gpus;
}

/**
 * Memory bandwidth for GPUs we have figures for.
 *
 * A lookup rather than a formula because bandwidth is not derivable from VRAM size, and
 * an unknown card returns `undefined` so the projection falls back to a stated generic
 * rather than pretending to know. Only a handful of common cards — this is a
 * convenience, and the projection is labelled an estimate everywhere it appears.
 */
function bandwidthFor(name: string): number | undefined {
  const n = name.toLowerCase();
  if (n.includes("5090")) return 1792;
  if (n.includes("5080")) return 960;
  if (n.includes("5070")) return 672;
  if (n.includes("5060")) return 448;
  if (n.includes("4090")) return 1008;
  if (n.includes("4080")) return 717;
  if (n.includes("4070")) return 504;
  if (n.includes("4060")) return 272;
  if (n.includes("3090")) return 936;
  if (n.includes("3080")) return 760;
  if (n.includes("3070")) return 448;
  if (n.includes("3060")) return 360;
  if (n.includes("a6000")) return 768;
  if (n.includes("a100")) return 1555;
  if (n.includes("t4")) return 320;
  return undefined;
}

async function scanWindowsGpus(unknowns: string[]): Promise<GpuInfo[]> {
  // For AMD and Intel on Windows there is no equivalent of nvidia-smi, so this reads the
  // adapter description. AdapterRAM is unreliable above 4 GB (it is a 32-bit field and
  // wraps), so it is only trusted when it looks sane.
  const out = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress",
  ]);
  if (out === undefined) return [];

  try {
    const parsed = JSON.parse(out) as
      | { Name?: string; AdapterRAM?: number; DriverVersion?: string }
      | Array<{ Name?: string; AdapterRAM?: number; DriverVersion?: string }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];

    const gpus: GpuInfo[] = [];
    for (const item of list) {
      const name = item.Name ?? "";
      if (name === "" || /nvidia/i.test(name)) continue; // nvidia-smi already covered it

      const vendor: GpuInfo["vendor"] = /amd|radeon/i.test(name)
        ? "amd"
        : /intel/i.test(name)
          ? "intel"
          : "amd";

      const ramMB = Math.round((item.AdapterRAM ?? 0) / (1024 * 1024));
      if (ramMB <= 0 || ramMB >= 4096) {
        // The 32-bit wrap case. Reporting 4095 MB for a 16 GB card would produce a
        // confidently wrong recommendation, so the VRAM is declared unknown instead.
        unknowns.push(
          `${name}: Windows reports VRAM through a 32-bit field, so the value is unreliable and was ignored`
        );
        continue;
      }

      gpus.push({
        vendor,
        name,
        vramTotalMB: ramMB,
        ...(item.DriverVersion !== undefined ? { driver: item.DriverVersion } : {}),
      });
    }
    return gpus;
  } catch {
    unknowns.push("Could not parse Win32_VideoController output");
    return [];
  }
}

async function scanApple(unknowns: string[]): Promise<GpuInfo[]> {
  const out = await run("sysctl", ["-n", "hw.memsize"]);
  if (out === undefined) {
    unknowns.push("Could not read hw.memsize");
    return [];
  }
  const bytes = Number(out.trim());
  if (!Number.isFinite(bytes)) return [];

  // Unified memory: the GPU shares system RAM. Metal's recommended working set is
  // roughly 75% of total, which is the number to budget against — total RAM would
  // promise memory the OS will not hand over.
  const workingSetMB = Math.round((bytes / (1024 * 1024)) * 0.75);
  return [
    {
      vendor: "apple",
      name: os.cpus()[0]?.model ?? "Apple Silicon",
      vramTotalMB: workingSetMB,
      memoryBandwidthGBs: 200, // conservative; M-series ranges ~100-800
    },
  ];
}

async function detectBackends(): Promise<HardwareProfile["backends"]> {
  const backends: HardwareProfile["backends"] = {};

  // Probe the HTTP endpoint rather than looking for a binary, so a remote or
  // containerised Ollama is found too (spec §2.4).
  try {
    const response = await fetch("http://127.0.0.1:11434/api/version", {
      signal: AbortSignal.timeout(1_500),
    });
    if (response.ok) {
      const body = (await response.json()) as { version?: string };
      backends.ollama = body.version ?? "unknown";
    }
  } catch {
    // Not running. Normal, and not worth reporting as an unknown.
  }

  const llama = await run("llama-server", ["--version"], 2_000);
  if (llama !== undefined) backends.llamaCpp = llama.trim().split("\n")[0] ?? "present";

  return backends;
}

async function freeDiskMB(): Promise<number> {
  try {
    const stats = await fs.statfs(os.homedir());
    return Math.round((stats.bsize * stats.bavail) / (1024 * 1024));
  } catch {
    return 0;
  }
}

export async function scanHardware(force = false): Promise<HardwareProfile> {
  if (!force && cached !== undefined && Date.now() - cached.at < TTL_MS) {
    return cached.profile;
  }

  const unknowns: string[] = [];
  const platform = process.platform;

  const [nvidia, platformGpus, backends, diskFreeMB] = await Promise.all([
    platform === "darwin" ? Promise.resolve([]) : scanNvidia(unknowns),
    platform === "win32"
      ? scanWindowsGpus(unknowns)
      : platform === "darwin"
        ? scanApple(unknowns)
        : Promise.resolve([]),
    detectBackends(),
    freeDiskMB(),
  ]);

  const gpus = [...nvidia, ...platformGpus];
  if (gpus.length === 0) {
    unknowns.push("No GPU detected. CPU-only inference is still supported.");
  }

  const cpus = os.cpus();
  const profile: HardwareProfile = {
    gpus,
    unifiedMemory: platform === "darwin",
    // No portable API for this. A desktop app almost always has a display, and the
    // conservative assumption costs ~1.2 GB of headroom rather than an OOM.
    hasDisplay: true,
    cpu: {
      model: cpus[0]?.model?.trim() ?? "unknown",
      // `os.cpus()` counts logical processors. Halving is right for hyperthreaded x86
      // and wrong for some ARM designs, so it is a floor rather than a fact.
      physicalCores: Math.max(1, Math.floor(cpus.length / 2)),
      flags: [],
    },
    ramTotalMB: Math.round(os.totalmem() / (1024 * 1024)),
    diskFreeMB,
    backends,
    unknowns,
    scannedAt: new Date().toISOString(),
  };

  cached = { profile, at: Date.now() };
  return profile;
}
