/**
 * Admin, Queue (SPEC section 16): every active job of every user, grouped by line (edits,
 * timeline changes, renders) in the order the server gives (running first, then by position).
 * An admin can mark a waiting edit Urgent and let an edit held by the start delay start now. The
 * list is the store's `adminQueue`, loaded when the page opens and again on every `queue-changed`.
 *
 * Waiting jobs are not capped, so a line can grow to hundreds of rows. Each line is a window onto
 * its rows (`useVirtualList`) in a box of bounded height that scrolls by itself, and a row is
 * memoized (it redraws only when its own entry changes).
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  EmptyState,
  ScrollArea,
  Spinner,
  StatusPill,
  toast,
  useVirtualList,
} from "@/components/ui";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { formatStartsIn, pluralize } from "@/lib/format";
import { jobStatus, JOB_KIND_LABEL } from "@/lib/status";
import type { AdminQueueEntry, JobQueue, QueueSummary } from "@/lib/types";
import { Group, SettingsPage } from "@/features/settings";

const QUEUES: { queue: JobQueue; title: string; empty: string }[] = [
  { queue: "edits", title: "Edits", empty: "No edit is running or waiting." },
  {
    queue: "timeline",
    title: "Timeline changes",
    empty: "No timeline change is running or waiting.",
  },
  { queue: "renders", title: "Renders", empty: "No render is running or waiting." },
];

export function QueuePage() {
  const store = useAppStoreApi();
  const queue = useAppState((s) => s.adminQueue);

  useEffect(() => {
    void store.getState().loadAdminQueue();
  }, [store]);

  const reload = () => void store.getState().loadAdminQueue();

  if (!queue.data) {
    return (
      <div className="flex h-full items-center justify-center">
        {queue.status === "error" && queue.error ? (
          <EmptyState
            tone="error"
            title="The queue could not be loaded"
            description={queue.error.message}
            action={<Button onClick={reload}>Try Again</Button>}
          />
        ) : (
          <Spinner label="Loading the queue" />
        )}
      </div>
    );
  }

  const { queues, jobs } = queue.data;
  return (
    <SettingsPage>
      {QUEUES.map(({ queue: name, title, empty }) => {
        const summary = queues.find((q) => q.queue === name);
        const own = jobs.filter((job) => job.queue === name);
        return (
          <Group key={name} title={title} description={summary ? usage(summary) : undefined}>
            {own.length === 0 ? (
              <p className="px-4 py-4 text-base text-fg-muted">{empty}</p>
            ) : (
              <QueueLines entries={own} />
            )}
          </Group>
        );
      })}
    </SettingsPage>
  );
}

/** The height a line takes before it scrolls inside its box. */
const MAX_LIST_HEIGHT = 480;
/** A row with its two text lines and its divider (until it is measured). */
const ROW_HEIGHT = 57;

/** The rows of one line: only those near the visible part are in the page. */
function QueueLines({ entries }: { entries: readonly AdminQueueEntry[] }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const getKey = useCallback((index: number) => entries[index]?.jobId ?? index, [entries]);
  const estimate = useCallback(() => ROW_HEIGHT, []);
  const { rows, totalSize, measure } = useVirtualList({
    count: entries.length,
    getKey,
    estimateSize: estimate,
    viewportRef,
    atEnd: false,
  });
  return (
    <div style={{ height: Math.min(totalSize, MAX_LIST_HEIGHT) }}>
      <ScrollArea className="h-full" viewportRef={viewportRef}>
        <div className="relative" style={{ height: totalSize }}>
          {rows.map((row) => {
            const entry = entries[row.index];
            if (!entry) return null;
            return (
              <div
                key={row.key}
                ref={measure}
                data-key={String(row.key)}
                data-start={row.start}
                data-size={row.size}
                className={
                  row.index === 0
                    ? "absolute inset-x-0 top-0"
                    : "absolute inset-x-0 top-0 border-t border-separator"
                }
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <QueueRow entry={entry} />
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function usage(summary: QueueSummary): string {
  return `${String(summary.running)} of ${pluralize(summary.slots, "slot")} in use, ${String(summary.waiting)} waiting`;
}

const QueueRow = memo(function QueueRow({ entry }: { entry: AdminQueueEntry }) {
  const store = useAppStoreApi();
  const [pending, setPending] = useState<"urgent" | "start" | null>(null);
  const status = jobStatus(entry);
  const waiting = entry.state === "queued";
  const canMarkUrgent = waiting && entry.queue === "edits";
  const canStartNow = waiting && entry.queue === "edits" && entry.startsAt !== null;

  async function run(what: "urgent" | "start", call: () => Promise<unknown>) {
    setPending(what);
    try {
      await call();
    } catch (error) {
      toast.error(
        what === "urgent" ? "The edit was not changed" : "The edit was not started",
        toApiError(error).message,
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div data-testid="queue-row" className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-base font-medium text-fg">
            {entry.channelName} / {entry.folderName}
          </span>
          <StatusPill tone={status.tone} label={status.label} live={status.live} />
        </div>
        <div className="mt-0.5 truncate text-sm text-fg-muted">
          {entry.userEmail}
          {" - "}
          {JOB_KIND_LABEL[entry.kind]}
          {entry.position !== null && ` - position ${String(entry.position)}`}
          {entry.startsAt !== null && waiting && (
            <>
              {" - "}
              <StartsIn at={entry.startsAt} />
            </>
          )}
        </div>
      </div>
      {canMarkUrgent && (
        <Checkbox
          checked={entry.urgent}
          disabled={pending !== null}
          onCheckedChange={(urgent) =>
            void run("urgent", () => store.getState().adminSetJobUrgent(entry.jobId, urgent))
          }
          aria-label={`Urgent: ${entry.channelName} / ${entry.folderName}`}
        >
          <span className="text-sm">Urgent</span>
        </Checkbox>
      )}
      {canStartNow && (
        <Button
          loading={pending === "start"}
          disabled={pending !== null}
          aria-label={`Start now: ${entry.channelName} / ${entry.folderName}`}
          onClick={() => void run("start", () => store.getState().adminStartJobNow(entry.jobId))}
        >
          Start Now
        </Button>
      )}
    </div>
  );
});

/** The countdown to a start held by the delay; the only part of a row that ticks. */
function StartsIn({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 15_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);
  return <>{formatStartsIn(at, now) ?? "Starting"}</>;
}
