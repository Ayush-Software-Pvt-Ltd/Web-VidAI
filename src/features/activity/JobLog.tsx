import { ArrowDown } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { ScrollArea, useVirtualList } from "@/components/ui";
import type { LogEntry } from "@/lib/types";
import { LogEntryRow } from "./LogEntryRow";
import { formatLogTime, isAtBottom } from "./logFormat";

function estimateSize(entry: LogEntry | undefined): number {
  if (!entry) return 24;
  // Roughly 42 characters per line at the narrowest panel width.
  const lines = Math.max(1, Math.ceil(entry.text.length / 42));
  return 8 + lines * 16 + (entry.kind === "user" ? 8 : 0);
}

export interface JobLogProps {
  entries: readonly LogEntry[];
}

/**
 * The live log of one job, virtualized. It follows new entries while the reader is at the end;
 * scrolling up stops that and offers "Jump to latest" (SPEC section 9).
 */
export function JobLog({ entries }: JobLogProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  /** How many entries there were when the reader scrolled away, for the "new" count. */
  const [seenCount, setSeenCount] = useState(entries.length);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());

  const getKey = useCallback((index: number) => entries[index]?.seq ?? index, [entries]);
  const estimate = useCallback((index: number) => estimateSize(entries[index]), [entries]);
  const { rows, totalSize, measure } = useVirtualList({
    count: entries.length,
    getKey,
    estimateSize: estimate,
    viewportRef,
    atEnd: following,
  });

  // Follow the end: after every change in size while following, show the bottom. Besides React
  // renders (new entries, measured rows), the scroll content can also change size on its own (the
  // scroll area lays out its wrapper late, the panel is resized), so sizes are observed too.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!following || !viewport) return;
    const pin = () => {
      viewport.scrollTop = viewport.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(viewport);
    if (viewport.firstElementChild) observer.observe(viewport.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [following, totalSize]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const atBottom = isAtBottom(event.currentTarget);
    if (atBottom !== following) {
      setFollowing(atBottom);
      if (!atBottom) setSeenCount(entries.length);
    }
  };

  const toggle = useCallback((seq: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });
  }, []);

  const newCount = following ? 0 : Math.max(0, entries.length - seenCount);

  return (
    <div className="relative h-full min-h-0">
      <ScrollArea
        className="h-full"
        viewportRef={viewportRef}
        onScroll={onScroll}
        viewportClassName="py-2"
      >
        <div
          role="log"
          aria-label="Activity log"
          aria-live="off"
          className="relative select-text"
          style={{ height: totalSize }}
        >
          {rows.map((row) => {
            const entry = entries[row.index];
            if (!entry) return null;
            const previous = entries[row.index - 1];
            const time = formatLogTime(entry.ts);
            const showTime = !previous || formatLogTime(previous.ts) !== time;
            return (
              <div
                key={row.key}
                ref={measure}
                data-key={String(row.key)}
                data-start={row.start}
                data-size={row.size}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <LogEntryRow
                  entry={entry}
                  time={showTime ? time : null}
                  expanded={expanded.has(entry.seq)}
                  onToggle={toggle}
                />
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {!following && (
        <button
          type="button"
          onClick={() => {
            setFollowing(true);
          }}
          className="focus-ring absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 animate-fade-in items-center gap-1.5 rounded-full bg-elevated pr-3 pl-2.5 text-sm font-medium whitespace-nowrap text-fg shadow-popover hover:bg-control-hover [&_svg]:size-3.5"
        >
          <ArrowDown />
          Jump to latest
          {newCount > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-2xs leading-4 font-semibold text-accent-fg tabular">
              {newCount > 999 ? "999+" : newCount} new
            </span>
          )}
        </button>
      )}
    </div>
  );
}
