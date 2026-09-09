/**
 * Attempts — the unit a user can stop.
 *
 * `exec:cancel` has existed since Phase 2 and was unreachable, because it took the runId that
 * `runInSandbox` mints internally. Nothing in the renderer could name a run, so Run ▸ Stop
 * stayed permanently greyed while the channel sat there registered and working.
 *
 * The obvious fix — drop the id and cancel whatever is running — is wrong, and wrong in a way
 * that is easy to miss. `gradeSubmission` makes TWO sandbox runs: the reference that derives
 * the answer key, then the learner's code. Cancelling "the current run" during the first one
 * kills the reference, and grading then proceeds straight into the second. The user presses
 * Stop, the run keeps going, and nothing reports a fault.
 *
 * So cancellation is modelled on the operation the user actually means. An attempt spans every
 * sandbox run a grade performs, and it is checked between phases as well as cancelled mid-run.
 *
 * The id comes from the renderer, generated before the call goes out. That is not a trust
 * decision — it grants nothing, since `exec:cancel` is already a channel any renderer may
 * call, and the worst a forged id achieves is cancelling a run that is not there. It is a
 * *timing* decision: an id minted in main and returned with the result arrives after the run
 * is over, and an id pushed back on an event leaves a window at the start where Stop does
 * nothing. Neither is a Stop button anyone would trust.
 */
import { cancelCurrentRun } from "./host.js";

interface Attempt {
  cancelled: boolean;
}

/**
 * In-flight attempts, by id.
 *
 * A map rather than a single slot even though the sandbox runs one job at a time, because an
 * attempt is registered before it reaches the sandbox and stays registered across the gap
 * between phases. Two attempts can legitimately overlap for the moment it takes the first to
 * notice it was superseded.
 */
const inFlight = new Map<string, Attempt>();

export function beginAttempt(id: string): void {
  inFlight.set(id, { cancelled: false });
}

/** Always in a `finally`. An attempt left behind would make a later cancel of a reused id act. */
export function endAttempt(id: string): void {
  inFlight.delete(id);
}

/**
 * Stop an attempt.
 *
 * Returns whether it was in flight, so the handler can answer honestly rather than always
 * claiming success. A Stop for an attempt that already finished is not an error — it is the
 * race the old runId guard existed to absorb, and the answer is simply "nothing to do".
 *
 * The order matters: mark first, then kill. `cancelCurrentRun` settles the pending promise
 * synchronously, so a grade can resume between the two calls — and if the flag were not
 * already set it would sail into the next phase.
 */
export function cancelAttempt(id: string): boolean {
  const attempt = inFlight.get(id);
  if (attempt === undefined) return false;

  attempt.cancelled = true;
  cancelCurrentRun();
  return true;
}

export function attemptCancelled(id: string | undefined): boolean {
  if (id === undefined) return false;
  return inFlight.get(id)?.cancelled === true;
}

/** Tests only. */
export function __clearAttempts(): void {
  inFlight.clear();
}
