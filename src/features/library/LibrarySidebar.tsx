/**
 * Sidebar of the main window (SPEC section 16): "All Channels" and one entry per channel of the
 * signed-in user with the counts [not edited / editing / edited], a live indicator while an agent
 * works on one of its videos and a light red background when one of them needs attention (a
 * failed job). A channel whose folder cannot be reached right now is marked and has no counts.
 * "New channel" opens the user's Settings at Channels.
 */
import { Folder, FolderPlus, FolderX, Layers } from "lucide-react";
import { type KeyboardEvent, type ReactNode } from "react";
import { Button, EmptyState, ScrollArea, Tooltip } from "@/components/ui";
import { cn } from "@/lib/cn";
import { useAppState } from "@/lib/appEnv";
import { findChannelLibrary, selectChannels } from "@/lib/store";
import type { Channel, ChannelLibrary } from "@/lib/types";
import { channelCounts, isChannelLive, type ChannelCounts } from "./model";
import { unavailableText } from "./presentation";

interface EntryProps {
  label: string;
  icon: ReactNode;
  /** `null` hides the counts (a missing folder). */
  counts: ChannelCounts | null;
  live: boolean;
  selected: boolean;
  onSelect: () => void;
  /** The channel folder cannot be reached right now. */
  unavailable?: boolean;
  /** The sentence of the tooltip of an unavailable channel. */
  unavailableText?: string;
}

/** "2 not edited, 4 editing, 1 edited, needs attention": the zero counts are left out. */
function entryDescription({
  counts,
  live,
  unavailable,
}: Pick<EntryProps, "counts" | "live" | "unavailable">) {
  const parts: string[] = [];
  if (unavailable) parts.push("folder not reachable");
  if (counts) {
    if (counts.notEdited > 0) parts.push(`${counts.notEdited} not edited`);
    if (counts.editing > 0) parts.push(`${counts.editing} editing`);
    if (counts.edited > 0) parts.push(`${counts.edited} edited`);
    if (counts.failed > 0) parts.push("needs attention");
  }
  if (live) parts.push("editing now");
  return parts.join(", ");
}

function LiveDot() {
  return (
    <span className="relative flex size-1.5 shrink-0" aria-hidden>
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
      <span className="relative inline-flex size-1.5 rounded-full bg-accent" />
    </span>
  );
}

function Entry({
  label,
  icon,
  counts,
  live,
  selected,
  onSelect,
  unavailable = false,
  unavailableText,
}: EntryProps) {
  const description = entryDescription({ counts, live, unavailable });
  const attention = counts !== null && counts.failed > 0;
  const button = (
    <button
      type="button"
      data-sidebar-entry
      onClick={onSelect}
      aria-current={selected ? "page" : undefined}
      aria-label={description ? `${label}, ${description}` : label}
      className={cn(
        "focus-ring flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-base [&_svg]:size-4 [&_svg]:shrink-0",
        selected ? "bg-selected text-fg" : "text-fg hover:bg-hover active:bg-pressed",
        // A failed job tints the row; the selected row keeps its own background and a red outline.
        attention &&
          (selected
            ? "ring-1 ring-danger/40 ring-inset"
            : "bg-danger-soft hover:bg-[color-mix(in_srgb,var(--c-danger)_18%,transparent)] active:bg-[color-mix(in_srgb,var(--c-danger)_24%,transparent)]"),
      )}
    >
      <span
        className={cn(
          "flex",
          unavailable ? "text-warning" : selected ? "text-accent-text" : "text-fg-muted",
        )}
      >
        {icon}
      </span>
      <span dir="auto" className={cn("min-w-0 flex-1 truncate", unavailable && "text-fg-muted")}>
        {label}
      </span>
      {live && <LiveDot />}
      {counts && (
        <span className="shrink-0 text-right text-sm text-fg-subtle tabular" aria-hidden>
          [{counts.notEdited}/{counts.editing}/{counts.edited}]
        </span>
      )}
    </button>
  );
  if (unavailable) {
    return (
      <Tooltip side="right" content={unavailableText ?? description}>
        {button}
      </Tooltip>
    );
  }
  return counts ? (
    <Tooltip side="right" content={description || label}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}

/** Skeleton entries while the library loads for the first time. */
function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-px" aria-hidden>
      {[72, 56, 64, 48].map((width, i) => (
        <div key={i} className="flex h-7 items-center gap-2 px-2">
          <span className="size-4 rounded-sm bg-fg/[0.07]" />
          <span
            className="h-2.5 animate-pulse rounded-full bg-fg/[0.07]"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/** Arrow keys move between the sidebar entries (Tab still works too). */
function onNavKeyDown(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const entries = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-sidebar-entry]"),
  ];
  const index = entries.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? entries.length - 1
        : Math.min(entries.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
  entries[next]?.focus();
}

function NewChannelButton() {
  const openSettings = useAppState((s) => s.openSettings);
  return (
    <Button
      icon={<FolderPlus />}
      onClick={() => {
        openSettings({ section: "channels" });
      }}
    >
      New Channel
    </Button>
  );
}

export function LibrarySidebar() {
  const library = useAppState((s) => s.library.data);
  const channels: readonly Channel[] = useAppState(selectChannels);
  const workspaceLoaded = useAppState((s) => s.workspace.data !== null);
  const selected = useAppState((s) => s.selectedChannelId);
  // On the Archive and Edit Log pages the footer entry is the selected one.
  const onList = useAppState((s) => s.view === "main");
  const selectChannel = useAppState((s) => s.selectChannel);
  const openSettings = useAppState((s) => s.openSettings);

  const loaded = library !== null && workspaceLoaded;
  const entries: { channel: Channel; library: ChannelLibrary | null }[] = channels.map(
    (channel) => ({ channel, library: findChannelLibrary(library, channel.id) }),
  );

  // All Channels adds up every channel, and needs attention when any channel does.
  const listed = (library?.channels ?? []).filter((c) => c.available);
  const total = loaded ? channelCounts(listed.flatMap((c) => c.videos)) : null;

  return (
    <ScrollArea className="h-full" viewportClassName="px-2 pb-3">
      <nav aria-label="Channels" className="flex flex-col gap-px" onKeyDown={onNavKeyDown}>
        <Entry
          label="All Channels"
          icon={<Layers />}
          counts={total}
          live={listed.some(isChannelLive)}
          selected={onList && selected === null}
          onSelect={() => {
            selectChannel(null);
          }}
        />
        <h2 className="px-2 pt-4 pb-1 text-xs font-medium text-fg-subtle">Channels</h2>
        {!loaded ? (
          <SidebarSkeleton />
        ) : channels.length === 0 ? (
          <EmptyState
            className="px-2 py-3"
            title="No channels yet"
            description="A channel is a folder with one folder per video."
            action={<NewChannelButton />}
          />
        ) : (
          entries.map(({ channel, library: entry }) => {
            const available = entry?.available ?? channel.available;
            return (
              <Entry
                key={channel.id}
                label={channel.name}
                icon={available ? <Folder /> : <FolderX />}
                counts={available && entry ? channelCounts(entry.videos) : null}
                live={entry !== null && available && isChannelLive(entry)}
                unavailable={!available}
                unavailableText={unavailableText(channel.name)}
                selected={onList && selected === channel.id}
                onSelect={() => {
                  selectChannel(channel.id);
                }}
              />
            );
          })
        )}
        {loaded && channels.length > 0 && (
          <button
            type="button"
            data-sidebar-entry
            onClick={() => {
              openSettings({ section: "channels" });
            }}
            className="focus-ring mt-1 flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-fg-muted hover:bg-hover hover:text-fg active:bg-pressed [&_svg]:size-4 [&_svg]:shrink-0"
          >
            <FolderPlus className="text-fg-subtle" />
            <span className="min-w-0 flex-1 truncate">New channel</span>
          </button>
        )}
      </nav>
    </ScrollArea>
  );
}
