/**
 * A language name to the Monaco mode that highlights it.
 *
 * It used to carry a `judge0Id` per language as well, and the whole field was dead: threaded from
 * here into `WorkspaceClient`, on into `executeCode` and `submitSolution` as `languageId`, and
 * serialised as `language_id` in a request body that the transport seam never read. Main emitted a
 * matching `judge0_language_id: 71` with a comment saying it was kept so this mapping would still
 * resolve — which was not true either; the dropdown keys off the `language` string.
 *
 * **Python only, and that is the grader's shape rather than an oversight.** A `Problem` names a
 * Python `entry` point, ships a Python `reference` and `template`, declares `allowedImports` against
 * Python modules, and is executed by Pyodide (`exec/sandbox.ts`). `CodeColumn` filters the dropdown
 * against these keys, so listing a language the sandbox cannot run would offer it, highlight it,
 * and then grade it as Python — a promise nothing can keep. JavaScript, C++ and Java were listed
 * here and unreachable, because main only ever emits a Python template.
 *
 * If a second runtime ever ships, this grows in the same change as the thing that can execute it.
 */
export const LANGUAGE_MAP: Record<string, { monacoId: string }> = {
  Python: { monacoId: "python" },
};
