/**
 * Language configuration for Monaco editor <-> Judge0 mapping.
 *
 * Keys are the display names used in the UI dropdown.
 * `judge0Id` maps to Judge0 CE language IDs.
 * `monacoId` maps to Monaco Editor language identifiers.
 */
export const LANGUAGE_MAP: Record<
  string,
  { judge0Id: number; monacoId: string }
> = {
  Python: { judge0Id: 71, monacoId: "python" },
  JavaScript: { judge0Id: 63, monacoId: "javascript" },
  "C++": { judge0Id: 54, monacoId: "cpp" },
  Java: { judge0Id: 62, monacoId: "java" },
};
