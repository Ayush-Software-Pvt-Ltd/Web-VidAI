/**
 * The folders of one folder: a listbox of fixed-height rows of which only the visible ones are in
 * the page (a folder can hold thousands of entries). Keyboard: arrows, Home, End, Page Up and
 * Down move the selection, letters jump by the first letters of a name, Enter opens the selected
 * folder, Backspace and Cmd/Ctrl+Up go up. A folder that belongs to a channel is dimmed and
 * labelled; it can be selected and opened (it may hold folders that are free) but not chosen.
 */
import { Folder } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
} from "react";
import { ScrollArea } from "@/components/ui/ScrollArea";
import { cn } from "@/lib/cn";
import type { FsEntry } from "@/lib/types";

const ROW_HEIGHT = 28;
const PADDING = 6;
const OVERSCAN = 8;
/** Used before the viewport has a size (first paint, and jsdom). */
const FALLBACK_HEIGHT = 560;
const TYPE_AHEAD_MS = 800;

/** The sentence for a folder of a channel (the server's own). */
export const TAKEN_HINT = "This folder already belongs to a channel.";

export interface FolderListProps {
  id: string;
  label: string;
  entries: readonly FsEntry[];
  selected: string | null;
  busy: boolean;
  onSelect: (path: string | null) => void;
  /** Double click and Enter on the selected folder. */
  onOpen: (entry: FsEntry) => void;
  onUp: () => void;
  /** Enter with nothing selected. */
  onDefault: () => void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

export function FolderList({
  ref,
  id,
  label,
  entries,
  selected,
  busy,
  onSelect,
  onOpen,
  onUp,
  onDefault,
  className,
}: FolderListProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const typed = useRef({ text: "", at: 0 });

  const setViewport = useCallback((element: HTMLDivElement | null) => {
    viewportRef.current = element;
  }, []);

  /** Scrolls the list; the `scroll` event (also sent by hand, jsdom has none) updates the window. */
  const scrollTo = useCallback((top: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = top;
    viewport.dispatchEvent(new Event("scroll"));
  }, []);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      if (viewport.clientHeight > 0) setHeight(viewport.clientHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, []);

  const indexOfPath = useMemo(() => {
    const map = new Map<string, number>();
    entries.forEach((entry, index) => map.set(entry.path, index));
    return map;
  }, [entries]);
  const selectedIndex = selected === null ? -1 : (indexOfPath.get(selected) ?? -1);

  // Another folder starts at the top.
  useLayoutEffect(() => {
    scrollTo(0);
  }, [entries, scrollTo]);

  // The selection, moved by a key or by typing, is in view.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || selectedIndex < 0) return;
    const top = PADDING + selectedIndex * ROW_HEIGHT;
    const visible = viewport.clientHeight > 0 ? viewport.clientHeight : FALLBACK_HEIGHT;
    if (top - PADDING < viewport.scrollTop) scrollTo(top - PADDING);
    else if (top + ROW_HEIGHT + PADDING > viewport.scrollTop + visible) {
      scrollTo(top + ROW_HEIGHT + PADDING - visible);
    }
  }, [selectedIndex, entries, scrollTo]);

  useEffect(() => {
    typed.current = { text: "", at: 0 };
  }, [entries]);

  const first = Math.max(0, Math.floor((scrollTop - PADDING) / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(entries.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);

  const selectIndex = (index: number) => {
    const entry = entries[index];
    if (entry) onSelect(entry.path);
  };

  /** Moves the selection `step` entries. */
  const move = (step: number) => {
    if (entries.length === 0) return;
    if (selectedIndex < 0) selectIndex(step > 0 ? 0 : entries.length - 1);
    else selectIndex(Math.min(entries.length - 1, Math.max(0, selectedIndex + step)));
  };

  const typeAhead = (key: string) => {
    const now = Date.now();
    const state = typed.current;
    state.text = now - state.at > TYPE_AHEAD_MS ? key : state.text + key;
    state.at = now;
    const text = state.text.toLowerCase();
    // The same letter again goes on to the next name that starts with it.
    const again = text.length > 1 && text.replaceAll(text.slice(0, 1), "") === "";
    const prefix = again ? text.slice(0, 1) : text;
    const from = again ? selectedIndex + 1 : 0;
    const indices = entries.map((_entry, i) => i);
    const order = [...indices.filter((i) => i >= from), ...indices.filter((i) => i < from)];
    const found = order.find((i) => entries[i]?.name.toLowerCase().startsWith(prefix));
    if (found !== undefined) selectIndex(found);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
    const modified = event.metaKey || event.ctrlKey || event.altKey;
    switch (event.key) {
      case "ArrowDown":
        if (modified) return;
        move(1);
        break;
      case "ArrowUp":
        if (modified) onUp();
        else move(-1);
        break;
      case "Home":
        selectIndex(0);
        break;
      case "End":
        selectIndex(entries.length - 1);
        break;
      case "PageDown":
        move(page);
        break;
      case "PageUp":
        move(-page);
        break;
      case "Backspace":
        onUp();
        break;
      case "Enter": {
        const entry = selectedIndex >= 0 ? entries[selectedIndex] : undefined;
        if (entry) onOpen(entry);
        else onDefault();
        break;
      }
      default:
        if (event.key.length !== 1 || modified || event.key === " ") return;
        typeAhead(event.key);
    }
    event.preventDefault();
  };

  return (
    <div
      ref={ref}
      id={id}
      role="listbox"
      aria-label={label}
      aria-activedescendant={selectedIndex >= 0 ? `${id}-row-${String(selectedIndex)}` : undefined}
      aria-busy={busy || undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={cn(
        "min-h-0 outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--c-focus)]",
        className,
      )}
    >
      <ScrollArea
        className="size-full"
        viewportRef={setViewport}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
      >
        <div
          className={cn("relative transition-opacity duration-100", busy && "opacity-60")}
          style={{ height: entries.length * ROW_HEIGHT + PADDING * 2 }}
          onClick={(event) => {
            if (event.target === event.currentTarget) onSelect(null);
          }}
        >
          {entries.slice(first, last).map((entry, offset) => {
            const index = first + offset;
            const isSelected = index === selectedIndex;
            return (
              <div
                key={entry.path}
                id={`${id}-row-${String(index)}`}
                role="option"
                aria-selected={isSelected}
                aria-posinset={index + 1}
                aria-setsize={entries.length}
                title={entry.taken ? `${entry.name} - ${TAKEN_HINT}` : entry.name}
                className={cn(
                  "absolute inset-x-1.5 flex items-center gap-2 rounded-md px-2 text-base select-none",
                  isSelected
                    ? "bg-selected text-fg"
                    : entry.taken
                      ? "text-fg-subtle hover:bg-hover"
                      : "text-fg hover:bg-hover",
                )}
                style={{ top: PADDING + index * ROW_HEIGHT, height: ROW_HEIGHT }}
                onClick={(event) => {
                  onSelect(isSelected && (event.metaKey || event.ctrlKey) ? null : entry.path);
                }}
                onDoubleClick={() => {
                  onOpen(entry);
                }}
              >
                <Folder
                  className={cn(
                    "size-4 shrink-0",
                    entry.taken ? "text-fg-subtle" : "text-accent-text",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                {entry.taken && (
                  <span className="shrink-0 text-sm text-fg-subtle">Used by a channel</span>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
