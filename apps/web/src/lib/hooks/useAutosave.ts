import { useEffect, useRef, useState } from "react";
import { saveDraft } from "@/lib/api/drafts";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export function useAutosave(
  problemId: string | undefined,
  language: string,
  code: string,
  userId?: string,
  debounceMs = 800,
) {
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef<string>("");
  // Track the previous problem+language combo so we can reset lastSavedRef
  // whenever the user switches problem or language. Without this, the hook
  // would skip saving the freshly-loaded draft code if it happens to equal
  // what was last saved for a different problem/language.
  const lastContextRef = useRef<string>("");

  useEffect(() => {
    if (!problemId) return;

    // Reset the "already saved" baseline whenever problem or language changes
    const context = `${problemId}::${language}`;
    if (context !== lastContextRef.current) {
      lastContextRef.current = context;
      lastSavedRef.current = "";
    }

    // Don't save if code hasn't changed since last save for this context
    if (code === lastSavedRef.current) return;

    // Don't save empty code
    if (!code.trim()) return;

    // Clear existing debounce timer
    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    timeoutRef.current = setTimeout(async () => {
      setSaveStatus("saving");
      try {
        await saveDraft(problemId, language, code, userId);
        lastSavedRef.current = code;
        setSaveStatus("saved");
        // Reset to idle after 2 s
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch {
        setSaveStatus("error");
        setTimeout(() => setSaveStatus("idle"), 3000);
      }
    }, debounceMs);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [code, problemId, language, userId, debounceMs]);

  return saveStatus;
}
