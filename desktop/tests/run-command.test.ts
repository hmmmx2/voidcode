/**
 * The command runner.
 *
 * Real child processes, not a mock. Every property worth having here is a property of the
 * operating system's process handling — a killed tree, a closed stdin, a full pipe — and a
 * fake would only assert that the fake behaves as written.
 *
 * The commands are written for both shells: `cmd.exe` on Windows and `/bin/sh` elsewhere. That
 * is ugly and it is the point, because the implementation branches on platform in three places
 * and the branch that is not exercised is the one that will be wrong.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import fsp from "node:fs/promises";
import path from "node:path";
import { runCommand, MAX_STREAM_BYTES } from "../src/main/agent/run-command.js";

const WINDOWS = process.platform === "win32";
let root: string;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), "voidcode-cmd-"));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

/** The same intent in both shells, so one test covers the platform that is actually running. */
const say = (text: string): string => (WINDOWS ? `echo ${text}` : `printf '%s\\n' ${text}`);

describe("reporting what happened", () => {
  it("captures stdout and a zero exit", async () => {
    const result = await runCommand(root, say("hello"));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("returns a non-zero exit as a result, not a rejection", async () => {
    /**
     * The rule `dispatch.ts` already follows: a failure the model can act on is a value.
     *
     * "The build failed and here is why" is the single most useful thing this tool produces.
     * Throwing would turn it into an exception someone has to translate back into text.
     */
    const result = await runCommand(root, "exit 3");

    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it("keeps stderr separate from stdout", async () => {
    // A tty merges them, which is why this is not the PTY. "Printed to stderr and still
    // exited 0" is a warning; the same bytes on stdout with a non-zero exit is a failure.
    const command = WINDOWS ? "echo to-err 1>&2" : "printf 'to-err\\n' >&2";
    const result = await runCommand(root, command);

    expect(result.stderr.trim()).toBe("to-err");
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("runs in the project root", async () => {
    await fsp.writeFile(path.join(root, "marker.txt"), "x", "utf8");
    const result = await runCommand(root, WINDOWS ? "dir /b" : "ls");

    expect(result.stdout).toContain("marker.txt");
  });

  it("reports a command that does not exist rather than throwing", async () => {
    const result = await runCommand(root, "definitely-not-a-real-program-xyz");

    // The shell itself exits non-zero and explains. Either stream may carry the message
    // depending on the shell, so the assertion is on the exit code.
    expect(result.exitCode).not.toBe(0);
  });
});

describe("stdin is closed", () => {
  it("fails immediately instead of blocking on a prompt", async () => {
    /**
     * The reason this is not a PTY, asserted.
     *
     * A command that reads stdin — `git commit` opening an editor, `npm login`, `apt` asking
     * y/n — would block for the full 120s timeout with a tty attached and nobody to answer.
     * At EOF it returns at once, which is a result the model can read and correct.
     *
     * The assertion is on *time*: it must not have waited for the timeout.
     */
    const started = Date.now();
    const command = WINDOWS ? "set /p x=" : "read x";
    const result = await runCommand(root, command);

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.timedOut).toBe(false);
  }, 20_000);
});

describe("bounds", () => {
  it("caps a stream without losing the exit code", async () => {
    /**
     * The subtle half of the cap.
     *
     * Destroying the pipe once the cap is hit would stop the data — and give the child `EPIPE`
     * on its next write, killing it. The exit code, which is the whole reason for the call,
     * would be lost. So the implementation stops *appending* and keeps *reading*.
     *
     * `exitCode: 0` is therefore the assertion that matters here, more than the length.
     */
    const command = WINDOWS
      ? `for /L %i in (1,1,20000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
      : `for i in $(seq 1 20000); do printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done`;
    const result = await runCommand(root, command);

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(MAX_STREAM_BYTES);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("delivers every byte when the output fits", async () => {
    // The other side of the cap: nothing is dropped below it. Also the regression guard for
    // the settle path -- if resolution ever stopped waiting for the stdio to drain, this is
    // where a short read would show up.
    const command = WINDOWS
      ? `for /L %i in (1,1,2000) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
      : `for i in $(seq 1 2000); do printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done`;
    const result = await runCommand(root, command);

    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(2000);
    expect(result.truncated).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("says so when it truncated, rather than implying the output is whole", async () => {
    const small = await runCommand(root, say("short"));
    expect(small.truncated).toBe(false);
  });
});

describe("cancellation", () => {
  it("kills a running command when the signal aborts", async () => {
    const controller = new AbortController();
    const sleep = WINDOWS ? "ping -n 60 127.0.0.1 > nul" : "sleep 60";

    const started = Date.now();
    const pending = runCommand(root, sleep, controller.signal);
    setTimeout(() => controller.abort(), 500);
    const result = await pending;

    // Far short of both the sleep and the 120s timeout.
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(result.timedOut).toBe(false);
    // Killed, so no clean zero.
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true);
  }, 45_000);

  it("returns at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await runCommand(root, WINDOWS ? "ping -n 30 127.0.0.1 > nul" : "sleep 30", controller.signal);

    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it("kills the whole tree, not just the shell", async () => {
    /**
     * The property most likely to be wrong quietly.
     *
     * `sh -c "sleep 60"` makes the shell the child and `sleep` a grandchild. Killing only the
     * child leaves the grandchild running — it holds its port, its file handles and its CPU
     * after the app has gone, and the happy path looks identical either way.
     *
     * Checked by writing a marker file *after* the sleep: if the grandchild survived the kill
     * it goes on to create it. A test that only asserted the call returned quickly would pass
     * against a broken implementation, because the call returns as soon as the shell dies.
     */
    const marker = path.join(root, "survived.txt");
    /**
     * The writer runs in the BACKGROUND, which is what gives this test teeth.
     *
     * The first version was `sleep 5; write marker` on one foreground line. That passes
     * against a broken implementation: killing only the shell abandons the rest of the line,
     * so the marker is never written whether or not the descendants died. It reported success
     * while the property was untested — confirmed by a probe showing `taskkill` finding
     * nothing to kill.
     *
     * Backgrounded, the writer is a process in its own right. A single-process kill leaves it
     * running and it writes the marker on schedule; only a tree kill reaches it.
     */
    const command = WINDOWS
      ? `start /b "" cmd /d /c "ping -n 6 127.0.0.1 > nul & echo survived > ""${marker}""" & ping -n 30 127.0.0.1 > nul`
      : `( sleep 5; printf 'survived' > '${marker}' ) & sleep 30`;

    const controller = new AbortController();
    const pending = runCommand(root, command, controller.signal);
    setTimeout(() => controller.abort(), 700);
    await pending;

    // Well past when the grandchild would have written it had it lived.
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    const survived = await fsp
      .readFile(marker, "utf8")
      .then(() => true)
      .catch(() => false);
    expect(survived, "a grandchild outlived the kill").toBe(false);
  }, 45_000);
});

describe("the environment", () => {
  it("does not pass Electron's own variables to the child", async () => {
    // `ELECTRON_RUN_AS_NODE` in a child makes `node` behave strangely, and it is the kind of
    // thing that produces a bug report about the user's toolchain.
    process.env.ELECTRON_RUN_AS_NODE = "1";
    try {
      const command = WINDOWS ? "echo [%ELECTRON_RUN_AS_NODE%]" : "printf '[%s]' \"$ELECTRON_RUN_AS_NODE\"";
      const result = await runCommand(root, command);
      expect(result.stdout).not.toContain("[1]");
    } finally {
      delete process.env.ELECTRON_RUN_AS_NODE;
    }
  });

  it("does not pass tracing keys to the child", async () => {
    /**
     * `sealTelemetry` unsets these in this process so an inherited variable cannot switch on
     * run upload. A child that inherited them would be a second process with the tracer live —
     * and under Auto the children are commands the model chose.
     */
    process.env.LANGSMITH_API_KEY = "secret-value-xyz";
    try {
      const command = WINDOWS ? "echo [%LANGSMITH_API_KEY%]" : "printf '[%s]' \"$LANGSMITH_API_KEY\"";
      const result = await runCommand(root, command);
      expect(result.stdout).not.toContain("secret-value-xyz");
    } finally {
      delete process.env.LANGSMITH_API_KEY;
    }
  });
});
