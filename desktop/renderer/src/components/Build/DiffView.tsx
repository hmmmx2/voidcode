"use client";

/**
 * Review a proposed edit before it touches disk.
 *
 * This component is the user-facing half of the guarantee that makes an unrestricted
 * assistant safe to point at a real repository: `fs.writeWithDiff` computed this and wrote
 * nothing, and only Apply — `fs.commitDiff` — changes the file.
 *
 * Colour is never the sole carrier. Every line prints a `+`, `-` or space in the gutter, so
 * the diff still reads in greyscale and for anyone who cannot separate red from green.
 */

interface DiffViewProps {
  diff: BuildDiff;
  onApply: () => void;
  onReject: () => void;
  busy?: boolean;
  error?: string | undefined;
  /**
   * Show the change without offering to apply it.
   *
   * For agent-proposed diffs, where per-file Apply is not merely unnecessary but *wrong*: it
   * would call `fs.commitDiff`, which refuses agent-origin diffs by design, so the button
   * would be a dead control that returns an error every time. Approval for those is a batch
   * decision taken in a native dialog, which is the whole point of the split — this component
   * is where you *read* a change, not where you authorise it.
   */
  readOnly?: boolean;
}

export default function DiffView({
  diff,
  onApply,
  onReject,
  busy = false,
  error,
  readOnly = false,
}: DiffViewProps) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-ide-code">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-ide-bar px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-ink-2">{diff.displayPath}</p>
          <p className="text-xs text-ink-3">
            {diff.isNew ? "new file · " : ""}
            <span className="text-diff-add-ink">+{diff.added}</span>{" "}
            <span className="text-diff-remove-ink">−{diff.removed}</span>
          </p>
        </div>
        {readOnly ? (
          <span className="shrink-0 text-xs text-ink-3">proposed</span>
        ) : (
          <div className="flex shrink-0 gap-1.5">
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="rounded-md border border-line px-2 py-1 text-xs text-ink-2 transition-colors hover:bg-ide-raised disabled:opacity-50"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={onApply}
              disabled={busy}
              className="rounded-md bg-ide-raised px-2 py-1 text-xs text-ink transition-colors hover:bg-line-strong disabled:opacity-50"
            >
              {busy ? "Applying…" : "Apply"}
            </button>
          </div>
        )}
      </div>

      {error !== undefined && (
        // Most often `FileChangedError`: the file moved under the diff and the write was
        // refused rather than clobbering it. Worth stating plainly — it means their work
        // is intact, not that something broke.
        <p className="border-b border-line px-3 py-2 text-xs text-diff-remove-ink">{error}</p>
      )}

      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs">
          <tbody>
            {diff.lines.map((line, index) => (
              <tr
                key={index}
                className={
                  line.kind === "add"
                    ? "bg-diff-add-bg"
                    : line.kind === "remove"
                      ? "bg-diff-remove-bg"
                      : ""
                }
              >
                <td className="w-10 select-none px-2 text-right align-top text-ink-3">
                  {line.before ?? ""}
                </td>
                <td className="w-10 select-none px-2 text-right align-top text-ink-3">
                  {line.after ?? ""}
                </td>
                <td className="w-4 select-none text-center align-top text-ink-3">
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                </td>
                {/* `whitespace-pre` keeps indentation, which is the difference between a
                    reviewable Python diff and an unreadable one. */}
                <td className="whitespace-pre px-2 align-top text-ink-2">{line.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
