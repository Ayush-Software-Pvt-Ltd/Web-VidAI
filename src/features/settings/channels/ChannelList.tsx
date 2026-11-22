/**
 * The reorderable channel list of Settings, Channels: each row has the name, the video type
 * setting, the directory and a warning when the directory cannot be reached. Reorder by dragging
 * the handle, or with the keyboard: Up / Down on the focused handle, or Alt+Up / Alt+Down
 * (Option on a Mac) on a channel.
 */
import { GripVertical, TriangleAlert } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PathText, Tooltip, TruncatedText } from "@/components/ui";
import { cn } from "@/lib/cn";
import { CHANNEL_TYPE_LABELS } from "@/lib/status";
import type { Channel } from "@/lib/types";
import { shiftFor } from "./reorder";

/** What the list shows of a channel. */
export type ChannelListItem = Pick<Channel, "id" | "name" | "dir" | "videoType" | "available">;

/** The server's sentence for a channel directory that cannot be reached now. */
export const UNREACHABLE_TEXT = "This channel's folder cannot be reached right now.";

interface Drag {
  id: string;
  from: number;
  to: number;
  startY: number;
  dy: number;
  rowHeight: number;
}

export function ChannelList({
  channels,
  selectedId,
  dirtyId,
  onSelect,
  onMove,
}: {
  channels: readonly ChannelListItem[];
  selectedId: string | null;
  /** The channel with unsaved changes, if any. */
  dirtyId: string | null;
  onSelect: (id: string) => void;
  /** Moves a channel to a new index. */
  onMove: (id: string, to: number) => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const focusAfterMove = useRef<{ id: string; part: "handle" | "row" } | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());

  // Moving a row re-inserts its DOM node, which drops focus: put it back.
  useEffect(() => {
    const target = focusAfterMove.current;
    if (!target) return;
    focusAfterMove.current = null;
    elements.current.get(`${target.part}:${target.id}`)?.focus();
  }, [channels]);

  const move = (id: string, from: number, to: number, part: "handle" | "row") => {
    const target = Math.max(0, Math.min(channels.length - 1, to));
    if (target === from) return;
    focusAfterMove.current = { id, part };
    onMove(id, target);
    const name = channels[from]?.name ?? "";
    setAnnouncement(`${name} moved to position ${target + 1} of ${channels.length}.`);
  };

  const onKeyDown = (event: KeyboardEvent, id: string, index: number, part: "handle" | "row") => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (part === "row" && !event.altKey) return;
    event.preventDefault();
    move(id, index, index + (event.key === "ArrowUp" ? -1 : 1), part);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, id: string, index: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const row = event.currentTarget.closest("li");
    setDrag({
      id,
      from: index,
      to: index,
      startY: event.clientY,
      dy: 0,
      rowHeight: row?.getBoundingClientRect().height ?? 32,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag) return;
    const min = -drag.from * drag.rowHeight;
    const max = (channels.length - 1 - drag.from) * drag.rowHeight;
    const dy = Math.max(min, Math.min(max, event.clientY - drag.startY));
    const to = Math.round(drag.from + dy / drag.rowHeight);
    setDrag({ ...drag, dy, to });
  };

  const onPointerUp = () => {
    if (!drag) return;
    setDrag(null);
    if (drag.to !== drag.from) move(drag.id, drag.from, drag.to, "handle");
  };

  // Esc cancels a drag (and must not close Settings: see `data-captures-escape`).
  useEffect(() => {
    if (!drag) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrag(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [drag]);

  const register = (key: string) => (el: HTMLElement | null) => {
    if (el) elements.current.set(key, el);
    else elements.current.delete(key);
  };

  return (
    <>
      <ul
        aria-label="Channels"
        aria-describedby="channel-reorder-help"
        data-captures-escape={drag ? "" : undefined}
        className={cn("flex flex-col", drag && "cursor-grabbing select-none")}
      >
        {channels.map((channel, index) => {
          const selected = channel.id === selectedId;
          const dragging = drag?.id === channel.id;
          const offset = drag
            ? dragging
              ? drag.dy
              : shiftFor(index, drag.from, drag.to, drag.rowHeight)
            : 0;
          return (
            <li
              key={channel.id}
              style={offset !== 0 ? { transform: `translateY(${offset}px)` } : undefined}
              className={cn(
                "group relative flex h-[46px] items-center rounded-md",
                dragging
                  ? "z-10 bg-elevated shadow-popover"
                  : drag && "transition-transform duration-150 ease-out",
                selected && !dragging && "bg-selected",
              )}
            >
              <button
                type="button"
                ref={register(`handle:${channel.id}`)}
                aria-label={`Reorder ${channel.name}`}
                onKeyDown={(event) => {
                  onKeyDown(event, channel.id, index, "handle");
                }}
                onPointerDown={(event) => {
                  onPointerDown(event, channel.id, index);
                }}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                  setDrag(null);
                }}
                className={cn(
                  "focus-ring ml-0.5 flex h-6 w-4 shrink-0 touch-none items-center justify-center rounded-sm text-fg-subtle opacity-60 group-hover:opacity-100 hover:text-fg-muted focus-visible:opacity-100 [&_svg]:size-3.5",
                  drag ? "cursor-grabbing" : "cursor-grab",
                  dragging && "opacity-100",
                )}
              >
                <GripVertical />
              </button>
              <button
                type="button"
                ref={register(`row:${channel.id}`)}
                aria-current={selected || undefined}
                onClick={() => {
                  onSelect(channel.id);
                }}
                onKeyDown={(event) => {
                  onKeyDown(event, channel.id, index, "row");
                }}
                className={cn(
                  "focus-ring flex h-full min-w-0 flex-1 flex-col justify-center gap-0.5 rounded-md pr-2 pl-1 text-left",
                  !selected && !dragging && "hover:bg-hover active:bg-pressed",
                )}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <TruncatedText
                    text={channel.name}
                    className={cn(
                      "flex-1 text-base text-fg",
                      !channel.available && "text-fg-muted",
                    )}
                    side="bottom"
                  />
                  {!channel.available && (
                    <Tooltip content={UNREACHABLE_TEXT}>
                      <span
                        className="flex shrink-0 text-warning [&_svg]:size-3.5"
                        aria-label="Folder cannot be reached"
                        role="img"
                      >
                        <TriangleAlert />
                      </span>
                    </Tooltip>
                  )}
                  {dirtyId === channel.id && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-accent"
                      role="img"
                      aria-label="Unsaved changes"
                    />
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
                  <span className="shrink-0">{CHANNEL_TYPE_LABELS[channel.videoType]}</span>
                  <PathText
                    path={channel.dir}
                    className="block min-w-0 flex-1 overflow-hidden text-xs text-ellipsis whitespace-nowrap text-fg-subtle"
                  />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p id="channel-reorder-help" className="sr-only">
        To reorder, drag the handle, or press Alt (Option on a Mac) and the up or down arrow on a
        channel.
      </p>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </>
  );
}
