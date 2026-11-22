/**
 * The video list of the main window (SPEC section 9): one flat list sorted as a whole; with All
 * Channels selected every row is labeled "Channel / Video".
 *
 * Rendering: rows have a known height and only the rows inside the visible window are mounted, so
 * hundreds of videos scroll smoothly.
 * Keyboard: the list has a single tab stop (the active row); Up / Down / Home / End / Page keys
 * move between rows, Tab reaches the row's type badge, action buttons and menu, and Enter opens the
 * activity panel (Esc closes it; the panel handles that for the whole window).
 */
import {
  CircleAlert,
  FolderOpen,
  FolderPlus,
  FolderX,
  ListFilter,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, EmptyState, ScrollArea } from "@/components/ui";
import { useAppState } from "@/lib/appEnv";
import { findChannel, selectChannels } from "@/lib/store";
import type { Library } from "@/lib/types";
import { buildListModel, FILTER_OPTIONS, type LibraryFilter, type ListModel } from "./model";
import { useNewVideoHandler } from "./newVideoContext";
import { unavailableText } from "./presentation";
import { ROW_HEIGHT, SkeletonRow, VideoRow } from "./VideoRow";
import { useLibraryView } from "./viewStore";

/** Rows rendered above and below the visible window. */
const OVERSCAN_PX = 6 * ROW_HEIGHT;
/** Used before the viewport is measured (and in jsdom, which has no layout). */
const FALLBACK_VIEWPORT = 1000;
/** Below this list width the action buttons show icons only. */
const COMPACT_WIDTH = 620;

// ---------------------------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------------------------

function LoadingList() {
  const widths = [62, 48, 70, 40, 56, 66, 44, 52, 60];
  return (
    <div className="h-full overflow-hidden" role="status" aria-label="Loading videos">
      <div className="flex h-[30px] items-center border-b border-separator px-4">
        <span className="h-2.5 w-28 animate-pulse rounded-full bg-muted" />
      </div>
      {widths.map((w, i) => (
        <SkeletonRow key={i} nameWidth={w} style={{ height: ROW_HEIGHT }} />
      ))}
    </div>
  );
}

function CenteredState(props: Parameters<typeof EmptyState>[0]) {
  return <EmptyState className="h-full pb-16" {...props} />;
}

function RetryButton({ small = false }: { small?: boolean }) {
  const loading = useAppState((s) => s.library.status === "loading");
  const refresh = useAppState((s) => s.refreshLibrary);
  return (
    <Button
      size={small ? "sm" : "md"}
      variant={small ? "ghost" : "secondary"}
      icon={small ? undefined : <RefreshCw />}
      loading={loading}
      onClick={() => void refresh()}
    >
      Try Again
    </Button>
  );
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

/** The button that starts a new video, only where the uploads feature provides its handler. */
function NewVideoButton({ channelId }: { channelId: string | null }) {
  const onNewVideo = useNewVideoHandler();
  if (!onNewVideo) return null;
  return (
    <Button
      icon={<Plus />}
      onClick={() => {
        onNewVideo(channelId);
      }}
    >
      New Video
    </Button>
  );
}

const FILTER_EMPTY: Record<Exclude<LibraryFilter, "all">, string> = {
  toEdit: "Nothing left to edit",
  inProgress: "Nothing in progress",
  edited: "No edited videos yet",
};

function NoMatches({ query, filter }: { query: string; filter: LibraryFilter }) {
  const setQuery = useLibraryView((s) => s.setQuery);
  const setFilter = useLibraryView((s) => s.setFilter);
  const filterName = FILTER_OPTIONS.find((o) => o.value === filter)?.label ?? "";
  const trimmed = query.trim();
  if (trimmed !== "") {
    return (
      <CenteredState
        icon={<Search />}
        title="No matching videos"
        description={
          filter === "all"
            ? `No video folder name contains "${trimmed}".`
            : `No video in "${filterName}" contains "${trimmed}".`
        }
        action={
          <>
            <Button
              onClick={() => {
                setQuery("");
              }}
            >
              Clear Search
            </Button>
            {filter !== "all" && (
              <Button
                variant="ghost"
                onClick={() => {
                  setFilter("all");
                }}
              >
                Search All Videos
              </Button>
            )}
          </>
        }
      />
    );
  }
  return (
    <CenteredState
      icon={<ListFilter />}
      title={filter === "all" ? "No videos" : FILTER_EMPTY[filter]}
      description={`No video matches the "${filterName}" filter here.`}
      action={
        <Button
          onClick={() => {
            setFilter("all");
          }}
        >
          Show All Videos
        </Button>
      }
    />
  );
}

/** A slim notice above the list when a refresh failed but older data is still shown. */
function RefreshErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-separator bg-warning-soft py-1.5 pr-3 pl-4 text-sm text-warning"
    >
      <CircleAlert className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Could not refresh the videos: {message}</span>
      <RetryButton small />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

function useViewportSize(viewportRef: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      setSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    measure();
    return () => {
      observer.disconnect();
    };
  }, [viewportRef]);
  return size;
}

/** Mounted with a `key` per channel, search, filter and sort, so every new view starts at the top. */
function List({ model }: { model: ListModel }) {
  const selectedVideoId = useAppState((s) => s.selectedVideoId);
  const selectVideo = useAppState((s) => s.selectVideo);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const { width, height: measured } = useViewportSize(viewportRef);
  const height = measured > 0 ? measured : FALLBACK_VIEWPORT;
  const compact = width > 0 && width < COMPACT_WIDTH;

  const videos = model.videos;

  // The row holding the list's tab stop: the selected video when shown, else the first row.
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = useMemo(() => {
    const byId = (id: string | null) => (id ? videos.findIndex((v) => v.id === id) : -1);
    const active = byId(activeId);
    if (active >= 0) return active;
    const selected = byId(selectedVideoId);
    return selected >= 0 ? selected : videos.length > 0 ? 0 : -1;
  }, [videos, activeId, selectedVideoId]);

  const pendingFocus = useRef<number | null>(null);
  const moveTo = (index: number) => {
    const target = videos[index];
    const viewport = viewportRef.current;
    if (!target || !viewport) return;
    setActiveId(target.id);
    const top = index * ROW_HEIGHT;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + ROW_HEIGHT > viewport.scrollTop + height) {
      viewport.scrollTop = top + ROW_HEIGHT - height;
    }
    setScrollTop(viewport.scrollTop);
    pendingFocus.current = index;
  };

  useEffect(() => {
    const index = pendingFocus.current;
    const viewport = viewportRef.current;
    if (index === null || !viewport) return;
    pendingFocus.current = null;
    viewport.querySelector<HTMLElement>(`[data-row-index="${index}"] [data-row-main]`)?.focus();
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row-index]");
    if (!row) return;
    const index = Number(row.dataset.rowIndex);
    const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);
    const last = videos.length - 1;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = Math.min(last, index + 1);
        break;
      case "ArrowUp":
        next = Math.max(0, index - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "PageDown":
        next = Math.min(last, index + page);
        break;
      case "PageUp":
        next = Math.max(0, index - page);
        break;
      default:
        return;
    }
    event.preventDefault();
    moveTo(next);
  };

  const onSelect = useCallback(
    (videoId: string) => {
      setActiveId(videoId);
      selectVideo(videoId);
    },
    [selectVideo],
  );
  const onFocusRow = useCallback((videoId: string) => {
    setActiveId(videoId);
  }, []);

  const first = Math.max(0, Math.floor((scrollTop - OVERSCAN_PX) / ROW_HEIGHT));
  const last = Math.min(
    videos.length - 1,
    Math.floor((scrollTop + height + OVERSCAN_PX) / ROW_HEIGHT),
  );
  const visible: number[] = [];
  for (let i = first; i <= last; i++) visible.push(i);
  // The active row stays mounted so the list never loses its tab stop.
  if (activeIndex >= 0 && !visible.includes(activeIndex)) visible.push(activeIndex);

  return (
    <ScrollArea
      className="h-full"
      viewportRef={viewportRef}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <div
        data-video-list
        className="@container/list relative"
        style={{ height: videos.length * ROW_HEIGHT + 24 }}
        onKeyDown={onKeyDown}
      >
        <div
          role="list"
          aria-label={
            model.showChannel || model.scopeNames.length === 0
              ? "Videos"
              : `Videos in ${model.scopeNames.join(", ")}`
          }
          className="relative"
          style={{ height: videos.length * ROW_HEIGHT }}
        >
          {visible.map((index) => {
            const video = videos[index];
            if (!video) return null;
            return (
              <VideoRow
                key={video.id}
                video={video}
                channelName={
                  model.showChannel ? (model.channelNames.get(video.channelId) ?? "") : undefined
                }
                index={index}
                setSize={videos.length}
                selected={video.id === selectedVideoId}
                active={index === activeIndex}
                compact={compact}
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                onSelect={onSelect}
                onFocusRow={onFocusRow}
              />
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/** Drops optimistic type choices once the library reports them. */
function useSettlePendingTypes(library: Library | null) {
  const pending = useLibraryView((s) => s.pendingTypes);
  const clear = useLibraryView((s) => s.clearPendingType);
  useEffect(() => {
    if (!library) return;
    for (const [videoId, type] of Object.entries(pending)) {
      for (const channel of library.channels) {
        const video = channel.videos.find((v) => v.id === videoId);
        if (video && video.typeOverride === type) clear(videoId);
      }
    }
  }, [library, pending, clear]);
}

export function VideoList() {
  const library = useAppState((s) => s.library);
  const channels = useAppState(selectChannels);
  const workspaceLoaded = useAppState((s) => s.workspace.data !== null);
  const selectedChannelId = useAppState((s) => s.selectedChannelId);
  const query = useLibraryView((s) => s.query);
  const filter = useLibraryView((s) => s.filter);
  const sort = useLibraryView((s) => s.sort);
  const data = library.data;
  useSettlePendingTypes(data);

  const model = useMemo(
    () =>
      data && workspaceLoaded
        ? buildListModel(data, { channels, channelId: selectedChannelId, query, filter, sort })
        : null,
    [data, workspaceLoaded, channels, selectedChannelId, query, filter, sort],
  );

  if (!data || !model) {
    if (library.status === "error") {
      return (
        <CenteredState
          tone="error"
          icon={<CircleAlert />}
          title="Could not load your videos"
          description={library.error?.message}
          action={<RetryButton />}
        />
      );
    }
    return <LoadingList />;
  }

  const channel = findChannel(channels, selectedChannelId);
  const entry = data.channels.find((c) => c.channelId === selectedChannelId);
  const unreachable = channel !== null && (entry ? !entry.available : !channel.available);

  let body: ReactNode;
  if (channels.length === 0) {
    body = (
      <CenteredState
        icon={<FolderOpen />}
        title="No channels yet"
        description="A channel is a folder with one folder per video. Add one in Settings to see its videos here."
        action={<NewChannelButton />}
      />
    );
  } else if (channel && unreachable) {
    body = (
      <CenteredState
        icon={<FolderX />}
        title="Channel folder cannot be reached"
        description={unavailableText(channel.name)}
        action={<RetryButton />}
      />
    );
  } else if (model.total === 0) {
    body = (
      <CenteredState
        icon={<FolderOpen />}
        title={channel ? `No videos in ${channel.name}` : "No videos yet"}
        description="A video is a folder with its A-roll in it. New videos show up here as soon as they are in their channel."
        action={<NewVideoButton channelId={selectedChannelId} />}
      />
    );
  } else if (model.videos.length === 0) {
    body = <NoMatches query={query} filter={filter} />;
  } else {
    body = (
      <List
        key={`${selectedChannelId ?? "all"}|${filter}|${query}|${sort.key}|${sort.dir}`}
        model={model}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {library.status === "error" && library.error && (
        <RefreshErrorBanner message={library.error.message} />
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
}
