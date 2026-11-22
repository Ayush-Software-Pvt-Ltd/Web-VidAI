/**
 * Edit Log (main window, sidebar): what happened to each video (started, finished, stopped,
 * archived, cleaned up, ...), newest first, for the signed-in user. An admin can also choose
 * "Everybody" or one other user from the user list; the user's email shows on the lines whenever
 * they are not just the admin's own. The list is virtualized and shows the newest page first;
 * "Show older entries" asks the server for the next older page (SPEC section 15).
 */
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Badge,
  Button,
  EmptyState,
  ScrollArea,
  Select,
  useVirtualList,
  type BadgeTone,
  type SelectOption,
} from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { formatLocalDateTime } from "@/lib/format";
import type { EditLogFilter } from "@/lib/store";
import type { EditLogEntry } from "@/lib/types";
import { Callout } from "@/features/settings/layout";
import { useAction } from "@/features/settings/useAction";

/** The words and colours of the kinds the server knows; any other kind is shown as it is. */
const EVENTS: Record<string, { label: string; tone: BadgeTone }> = {
  started: { label: "Started", tone: "info" },
  completed: { label: "Finished", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
  paused: { label: "Paused", tone: "warning" },
  continued: { label: "Continued", tone: "info" },
  reEdit: { label: "Re-Edit", tone: "info" },
  changeRequest: { label: "Change requests", tone: "info" },
  render: { label: "Render", tone: "info" },
  archived: { label: "Archived", tone: "neutral" },
  unarchived: { label: "Unarchived", tone: "neutral" },
  diskCleanup: { label: "Disk Cleanup", tone: "neutral" },
};

const ROW_HEIGHT = 68;

const MINE = "mine";
const EVERYBODY = "all";
const USER_PREFIX = "user:";

const filterValue = (filter: EditLogFilter): string =>
  filter.kind === "user" ? `${USER_PREFIX}${filter.userId}` : filter.kind;

const filterOf = (value: string): EditLogFilter =>
  value === EVERYBODY
    ? { kind: "all" }
    : value.startsWith(USER_PREFIX)
      ? { kind: "user", userId: value.slice(USER_PREFIX.length) }
      : { kind: "mine" };

export function EditLogList() {
  const store = useAppStoreApi();
  const log = useAppState((s) => s.editLog);
  const filter = useAppState((s) => s.editLogFilter);
  const me = useAppState((s) => s.session.data?.user);
  const users = useAppState((s) => s.adminUsers.data);
  const isAdmin = me?.role === "admin";
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void store.getState().loadEditLog();
  }, [store]);
  useEffect(() => {
    if (isAdmin) void store.getState().loadAdminUsers();
  }, [store, isAdmin]);

  const choices = useMemo<SelectOption[]>(() => {
    const others = (users ?? []).filter((user) => user.id !== me?.id);
    const options: SelectOption[] = [
      { value: MINE, label: "My edits" },
      { value: EVERYBODY, label: "Everybody" },
      ...others.map((user) => ({ value: `${USER_PREFIX}${user.id}`, label: user.email })),
    ];
    // The user chosen may have been removed since: keep the choice visible until another is made.
    const chosen = filterValue(filter);
    if (!options.some((option) => option.value === chosen)) {
      options.push({ value: chosen, label: "A removed user" });
    }
    return options;
  }, [users, me?.id, filter]);

  const refresh = useAction(async () => {
    await store.getState().loadEditLog();
  });
  const older = useAction(async () => {
    await store.getState().loadMoreEditLog();
  });

  const entries = useMemo(() => log.data?.entries ?? [], [log.data]);
  const getKey = useCallback((index: number) => entries[index]?.id ?? index, [entries]);
  const estimate = useCallback(() => ROW_HEIGHT, []);
  const { rows, totalSize, measure } = useVirtualList({
    count: entries.length,
    getKey,
    estimateSize: estimate,
    viewportRef,
    atEnd: false,
  });

  const error = log.error ?? refresh.error ?? older.error;
  // The lines of other people carry their user's email.
  const showUser = isAdmin && filter.kind !== "mine";
  const loading = log.status === "loading" && entries.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-window">
      <div className="mx-auto flex w-full max-w-[680px] shrink-0 items-end justify-between gap-4 px-8 pt-6 pb-3">
        <div className="min-w-0">
          <h2 className="text-md font-semibold text-fg">Edit log</h2>
          <p className="mt-0.5 text-sm text-fg-muted">What happened to each video, newest first.</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isAdmin && (
            <Select
              aria-label="Whose edits"
              value={filterValue(filter)}
              onValueChange={(value) => void store.getState().setEditLogFilter(filterOf(value))}
              options={choices}
              className="max-w-[240px]"
            />
          )}
          <Button
            icon={<RefreshCw />}
            loading={refresh.pending || log.status === "loading"}
            onClick={() => void refresh.run()}
          >
            Refresh
          </Button>
        </div>
      </div>
      {error && (
        <div className="mx-auto w-full max-w-[680px] shrink-0 px-8 pb-3">
          <Callout tone="danger" live title="Could not read the edit log">
            {error.message}
          </Callout>
        </div>
      )}
      {loading ? (
        <p className="mx-auto w-full max-w-[680px] px-9 py-3 text-sm text-fg-muted">
          Loading the edit log…
        </p>
      ) : entries.length === 0 ? (
        !error && (
          <EmptyState
            title="Nothing logged yet"
            description="Start an edit and it shows up here."
          />
        )
      ) : (
        <ScrollArea className="min-h-0 flex-1" viewportRef={viewportRef} viewportClassName="px-8">
          <div className="mx-auto max-w-[680px] pb-8">
            <ul
              aria-label="Edit log entries"
              className="relative rounded-lg border border-border-container bg-surface"
              style={{ height: totalSize }}
            >
              {rows.map((row) => {
                const entry = entries[row.index];
                if (!entry) return null;
                return (
                  <li
                    key={row.key}
                    ref={measure}
                    data-key={String(row.key)}
                    data-start={row.start}
                    data-size={row.size}
                    className="absolute inset-x-0 top-0"
                    style={{ transform: `translateY(${row.start}px)` }}
                  >
                    <EntryRow entry={entry} showUser={showUser} first={row.index === 0} />
                  </li>
                );
              })}
            </ul>
            {log.data?.more && (
              <div className="flex justify-center pt-4">
                <Button loading={older.pending} onClick={() => void older.run()}>
                  Show older entries
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  showUser,
  first,
}: {
  entry: EditLogEntry;
  showUser: boolean;
  first: boolean;
}) {
  const kind = EVENTS[entry.event];
  return (
    <div
      className={
        first
          ? "flex flex-col gap-1 px-4 py-3"
          : "flex flex-col gap-1 border-t border-separator px-4 py-3"
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-base font-medium text-fg">
          {entry.videoLabel}
        </span>
        <Badge tone={kind?.tone ?? "neutral"} variant="outline">
          {kind?.label ?? entry.event}
        </Badge>
      </div>
      <div className="text-sm text-fg">{entry.message}</div>
      <div className="flex min-w-0 items-center gap-2 text-sm text-fg-subtle">
        <span>{formatLocalDateTime(entry.at)}</span>
        {showUser && (
          <>
            <span aria-hidden>-</span>
            <span className="min-w-0 truncate">{entry.userEmail}</span>
          </>
        )}
      </div>
    </div>
  );
}
