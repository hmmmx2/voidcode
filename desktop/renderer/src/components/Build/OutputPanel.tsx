"use client";

import { useEffect, useRef } from "react";
import {
  CHANNEL_LABELS,
  MAX_OUTPUT_LINES,
  OUTPUT_CHANNELS,
  type OutputChannel,
  type OutputState,
} from "@/lib/build/output";

/**
 * One channel at a time, and the count of what fell off the start.
 *
 * The channel picker is a `<select>` rather than a row of tabs: five of them would crowd a strip
 * that already carries the dock's own tabs, and this is the control VS Code uses in the same
 * place for the same reason.
 *
 * **`dropped` is rendered.** A ring buffer that silently forgets is how a panel starts lying —
 * you scroll to the top of a long agent run, see its first visible line, and believe it was the
 * first line. Every other bounded thing in this app surfaces its bound; this is not the exception.
 */

export default function OutputPanel({
  output,
  channel,
  onChannelChange,
  onClear,
}: {
  output: OutputState;
  channel: OutputChannel;
  onChannelChange: (channel: OutputChannel) => void;
  onClear: () => void;
}) {
  const buffer = output[channel];
  const endRef = useRef<HTMLDivElement>(null);

  // Follow the tail, which is what a log pane is for. Only when the channel is already at the
  // bottom would be better; it is not worth a scroll listener until someone reads mid-buffer.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [buffer.lines.length, channel]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-line px-3 py-1.5">
        <label className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-ink-3">
          Channel
          <select
            value={channel}
            onChange={(event) => onChannelChange(event.target.value as OutputChannel)}
            className="rounded border border-line bg-ide-panel px-1.5 py-0.5 text-[12px] normal-case tracking-normal text-ink-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
          >
            {OUTPUT_CHANNELS.map((id) => (
              <option key={id} value={id}>
                {CHANNEL_LABELS[id]}
              </option>
            ))}
          </select>
        </label>

        {buffer.dropped > 0 && (
          <span
            className="text-[11px] text-ink-3"
            title={`This channel keeps the last ${MAX_OUTPUT_LINES} lines`}
          >
            {buffer.dropped.toLocaleString()} earlier {buffer.dropped === 1 ? "line" : "lines"}{" "}
            dropped
          </span>
        )}

        <button
          type="button"
          onClick={onClear}
          className="ml-auto rounded px-2 py-0.5 text-[11px] text-ink-3 transition-colors duration-150 ease-void hover:bg-ide-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink"
        >
          Clear
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {buffer.lines.length === 0 ? (
          <p className="text-ink-3">Nothing on this channel yet.</p>
        ) : (
          buffer.lines.map((line) => (
            <div key={line.seq} className="whitespace-pre-wrap break-words text-ink-2">
              {line.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
