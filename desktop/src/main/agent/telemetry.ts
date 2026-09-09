/**
 * Shutting off LangSmith before it can start.
 *
 * `@langchain/core` depends on `langsmith`, a tracing client that POSTs run contents — prompts,
 * file contents, tool results — to LangChain's servers. It is inert unless an environment
 * variable turns it on, and that is exactly the problem worth taking seriously rather than
 * waving away: **the app inherits the user's environment.**
 *
 * `LANGSMITH_TRACING=true` in a shell profile is normal for anyone who works on LangChain
 * projects, which describes a plausible VoidCode user precisely. On such a machine, taking this
 * dependency would silently add an outbound path carrying the contents of the user's private
 * repository to a third party, with no prompt and nothing in the UI to notice. Nobody would
 * have chosen that; they would have inherited it.
 *
 * The plan's rule was that outbound HTTP stays at exactly three call sites, and that is why it
 * refuses `@langchain/ollama` and `@langchain/openai`. Tracing is the same hole arriving
 * through a transitive dependency instead of a direct one, so it gets closed the same way.
 *
 * Deleting the variables rather than setting them to `"false"`: `isEnvTracingEnabled` tests for
 * the string `"true"`, but the surrounding library reads several of these keys for other
 * purposes, and absent is unambiguous in a way that a particular falsy spelling is not.
 */

/**
 * Every environment variable that can switch tracing on or point it somewhere.
 *
 * Both the `LANGSMITH_` and legacy `LANGCHAIN_` prefixes, because the library accepts either
 * and honouring only the modern spelling would leave the old one working.
 */
export const TELEMETRY_VARS: readonly string[] = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGSMITH_ENDPOINT",
  "LANGCHAIN_ENDPOINT",
  "LANGSMITH_PROJECT",
  "LANGCHAIN_PROJECT",
  "LANGSMITH_OTEL_ENABLED",
  "LANGSMITH_RUNS_ENDPOINTS",
];

/** What was removed, so startup can say so rather than doing it silently. */
export function sealTelemetry(env: Record<string, string | undefined> = process.env): string[] {
  const removed: string[] = [];
  for (const name of TELEMETRY_VARS) {
    if (env[name] === undefined) continue;
    removed.push(name);
    delete env[name];
  }

  // Belt and braces: even with the keys gone, this is the flag the library checks first, and
  // an explicit `false` survives anything that repopulates the environment later.
  env["LANGSMITH_TRACING"] = "false";
  env["LANGCHAIN_TRACING_V2"] = "false";

  return removed;
}

/** For tests and the smoke: the list this module claims to cover. */
export const __TELEMETRY_VARS = TELEMETRY_VARS;
