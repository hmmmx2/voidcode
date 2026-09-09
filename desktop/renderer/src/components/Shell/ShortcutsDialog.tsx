"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/app";
import { MENU_IDS, MENU_LABELS, MENU_STRUCTURE, type CommandId } from "@shared/commands";
import { useCommands } from "@/lib/shell/commands";
import { formatAccelerator } from "@/lib/shell/keybindings";

/**
 * Every shortcut, grouped by the menu it lives in.
 *
 * Almost free once the command table exists — the registry already knows every id, its label,
 * its accelerator and whether it is available right now. Writing this list by hand would have
 * been a fourth place for the same facts to drift.
 *
 * Grouped by menu rather than alphabetically, because that is how you look one up: you
 * remember roughly where the thing lives before you remember what it is called.
 *
 * Unavailable commands are shown greyed rather than hidden. "Save is Ctrl+S but only in the
 * IDE" is exactly what someone opens this dialog to find out; hiding it would answer "there
 * is no Save shortcut", which is false.
 */
export default function ShortcutsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { list } = useCommands();
  const [isMac] = useState(
    () => typeof window !== "undefined" && /Mac/i.test(window.navigator.userAgent)
  );

  const byId = useMemo(() => new Map(list.map((c) => [c.id, c])), [list]);

  const groups = useMemo(
    () =>
      MENU_IDS.map((menu) => ({
        menu,
        label: MENU_LABELS[menu],
        rows: MENU_STRUCTURE[menu]
          .filter((entry): entry is CommandId => typeof entry === "string" && entry !== "-")
          .map((id) => byId.get(id))
          // The narrowing predicate matters: without it TypeScript keeps `undefined` in the
          // element type and every field access below becomes an error.
          .filter(
            (command): command is NonNullable<typeof command> =>
              command !== undefined && command.accelerator !== null
          ),
      })).filter((group) => group.rows.length > 0),
    [byId]
  );

  return (
    <Modal open={open} onClose={onClose} labelledBy="shortcuts-title" className="w-[36rem]">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id="shortcuts-title" className="text-sm font-medium text-ink">
          Keyboard Shortcuts
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:text-ink"
        >
          Close
        </button>
      </div>

      <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
        {groups.map((group) => (
          <section key={group.menu} className="mb-5 last:mb-0">
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">
              {group.label}
            </h3>
            <dl className="space-y-1">
              {group.rows.map((command) => (
                <div key={command.id} className="flex items-baseline justify-between gap-4">
                  <dt className={command.enabled ? "text-[13px] text-ink-2" : "text-[13px] text-ink-3"}>
                    {command.label}
                    {!command.enabled && (
                      // Says why it is greyed rather than leaving the user to guess.
                      <span className="ml-2 text-[11px] text-ink-3">unavailable here</span>
                    )}
                  </dt>
                  <dd>
                    <kbd className="rounded border border-line bg-ide-code px-1.5 py-0.5 font-mono text-[11px] text-ink-3">
                      {formatAccelerator(command.accelerator ?? "", isMac)}
                    </kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
