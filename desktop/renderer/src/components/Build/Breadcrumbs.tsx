"use client";

/**
 * `src/main/index.ts` → `src › main › index.ts`.
 *
 * Segments are text, not links. A folder segment that does nothing when clicked is worse than
 * plain text — it advertises navigation the app cannot perform until the tree supports revealing
 * a directory.
 *
 * **Its own file because its only caller is the file tree, not the tabs.** It lived in
 * `EditorTabs.tsx` and was imported from `FileTree.tsx`, which meant deleting the editor's tab
 * strip would have taken the left pane's header with it — a component the chat-first layout keeps.
 */
export function Breadcrumbs({ path }: { path: string }) {
  const segments = path.split("/").filter(Boolean);

  return (
    <nav aria-label="File location" className="flex min-w-0 items-center gap-1 font-mono text-[11px]">
      {segments.map((segment, index) => {
        const last = index === segments.length - 1;
        return (
          <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && (
              <span aria-hidden className="text-ink-3">
                ›
              </span>
            )}
            <span className={last ? "truncate text-ink-2" : "truncate text-ink-3"}>{segment}</span>
          </span>
        );
      })}
    </nav>
  );
}
