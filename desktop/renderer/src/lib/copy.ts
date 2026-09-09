/**
 * User-facing copy that more than one surface needs to say identically.
 *
 * It exists because of one message. Four pages and the tutor panel each carried their own version
 * of "The API didn't respond. If you're running this locally, check that the API server is up on
 * port 8000." — five copies of an instruction that **cannot be followed**, because this app has no
 * API server. `lib/api/client.ts` intercepts every `app://api` request and answers it over IPC from
 * the main process; bundling FastAPI was considered and rejected, and that decision is recorded in
 * that file's header.
 *
 * They were wrong together, which is the argument for one source. A message telling someone to start
 * a process that does not exist is worse than a vague one: it sends them looking for a problem they
 * cannot find, and it quietly says the product is something it is not.
 */

/**
 * Shown when a local route fails to answer.
 *
 * Deliberately does not name a remedy the user does not have. What actually goes wrong here is
 * internal — a handler throwing, the SQLite store failing to open, a route with no handler yet
 * (`PENDING_ROUTERS`) — and none of it is something to start or configure. Reloading is the one
 * useful action, and every caller already renders a button for it.
 */
export const LOCAL_LOAD_FAILURE =
  "Something inside the app failed to answer. Nothing here needs a server — it all runs on this " +
  "machine — so this is a bug rather than a setup step. Reloading usually clears it.";

/**
 * Shown when the tutor stream cannot start and the cause is not an `Error` with a message.
 *
 * Separate from the above because the remedy is different and real: the tutor needs a model, and
 * `usableProvider` returning nothing is by far the most likely cause. Naming Ollama is honest — it
 * is the default backend the app manages — without claiming it is the only option.
 */
export const TUTOR_UNREACHABLE =
  "Could not reach a model. Check that Ollama is running and has a model installed, or add an " +
  "OpenRouter key in the model manager.";

/**
 * Where to get a model, for someone who does not have one.
 *
 * THE ONE ONBOARDING GAP THIS APP ACTUALLY HAD. Everything else about a fresh install degrades
 * honestly: the status bar distinguishes "no backend" from "backend with no models", the model
 * manager keeps working with Ollama down, and `TUTOR_UNREACHABLE` above names Ollama when a send
 * fails. What none of them said is that **Ollama is a separate free download** — a search across
 * `src/` and `renderer/src/` for `ollama.com` returned nothing at all. The app named the product it
 * needs and never said where it comes from, which leaves a new user to guess whether it is something
 * they were supposed to have already.
 *
 * The second sentence matters as much as the first, and is easier to get wrong. Grading is local and
 * needs no model, so a message that reads as "install this before you can start" would be false and
 * would send someone away from the exercises before they had seen one. Spec §4.4 promises the app is
 * useful with no GPU and no model; this is where that promise gets said out loud.
 *
 * `ollama.com` rather than a deep link into a download page: the URL is stable, and it is short
 * enough to be read off the screen and typed by someone who does not want to click a link in an app.
 */
export const NO_MODEL_INSTALLED = {
  title: "No model installed",
  body:
    "The tutor and the coding assistant need a language model, which is a separate free download. " +
    "Install Ollama from ollama.com, then open the model manager to see what this machine can run.",
  /** The part that must survive any rewrite of the above. */
  reassurance: "Exercises and grading run without one, so you can start now and add a model later.",
  url: "https://ollama.com",
} as const;
