/**
 * Disk Cleanup (SPEC section 13): the user's videos that have working files, per channel, largest
 * first, each with the size of its working files and of its whole folder and when it was last
 * edited. The user ticks videos and deletes their working files after a confirmation; each video
 * answers on its own, so one refusal never hides the others' results. The sizes come from the
 * store (`loadDiskUse`, kept fresh by `disk-use-changed`); a folder the server is still measuring
 * says so. Whether a video can be cleaned now is the server's `diskCleanup` action of the video.
 */
import { RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { WindowFrame } from "@/app/WindowFrame";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Kbd,
  ScrollArea,
  Spinner,
  Tooltip,
} from "@/components/ui";
import { Callout, Group } from "@/features/settings/layout";
import { useAppState, useAppStoreApi } from "@/lib/appEnv";
import { toApiError } from "@/lib/errors";
import { formatBytes, formatLocalDateTime, formatTimeAgo, pluralize } from "@/lib/format";
import { hasOpenLayer, isEditableTarget } from "@/lib/keyboard";
import { DiskCleanupConfirm, type ConfirmVideo } from "./DiskCleanupConfirm";
import {
  channelRows,
  deleteLabel,
  outcomeText,
  selectable,
  summaryOf,
  type CleanOutcome,
  type DiskRow,
} from "./model";
import { takeRequestedDiskCleanup } from "./request";

const confirmVideoOf = (row: DiskRow): ConfirmVideo => ({
  videoId: row.videoId,
  channelName: row.channelName,
  folderName: row.folderName,
  bytes: row.working ?? 0,
});

export function DiskCleanupPage() {
  const store = useAppStoreApi();
  const diskUse = useAppState((s) => s.diskUse);
  const library = useAppState((s) => s.library.data);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, CleanOutcome>>>({});
  const [lastRun, setLastRun] = useState<readonly CleanOutcome[] | null>(null);
  const [confirming, setConfirming] = useState<readonly ConfirmVideo[]>([]);
  // The video the menu asked for, until the sizes are there and it has been handled.
  const [asked, setAsked] = useState<string | null>(takeRequestedDiskCleanup);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void store.getState().loadDiskUse();
  }, [store]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || hasOpenLayer()) return;
      if (isEditableTarget(event.target)) {
        event.target.blur();
        return;
      }
      event.preventDefault();
      store.getState().setView("main");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [store]);

  const groups = useMemo(
    () => (diskUse.data ? channelRows(diskUse.data, library, outcomes) : []),
    [diskUse.data, library, outcomes],
  );
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups]);
  const choosable = rows.filter(selectable);
  const chosen = choosable.filter((row) => selected.has(row.videoId));
  const allChosen = choosable.length > 0 && chosen.length === choosable.length;

  // A request from a video's menu: once the sizes are there, choose that video and ask the
  // confirmation for it (set during this render, like "adjusting state when a value changes").
  if (asked !== null && diskUse.data) {
    const row = rows.find((candidate) => candidate.videoId === asked);
    setAsked(null);
    if (row && selectable(row)) {
      setSelected(new Set([row.videoId]));
      setConfirming([confirmVideoOf(row)]);
    }
  }

  const toggle = (videoId: string, on: boolean) => {
    setSelected((now) => {
      const next = new Set(now);
      if (on) next.add(videoId);
      else next.delete(videoId);
      return next;
    });
  };

  const clean = async () => {
    const results: Record<string, CleanOutcome> = {};
    // One video after the other: every video has its own answer.
    for (const video of confirming) {
      try {
        const done = await store.getState().cleanWorkingFiles(video.videoId);
        results[video.videoId] = { ok: true, ...done };
      } catch (error) {
        results[video.videoId] = { ok: false, message: toApiError(error).message };
      }
    }
    setOutcomes((now) => ({ ...now, ...results }));
    setLastRun(Object.values(results));
    setSelected(new Set());
    // The dialog gives focus back to the Delete button, which is disabled by now.
    setTimeout(() => {
      contentRef.current?.focus({ preventScroll: true });
    }, 0);
  };

  const data = diskUse.data;
  const anyMeasured = data?.videos.some((video) => video.sizes !== null) ?? false;
  const summary = lastRun ? summaryOf(lastRun) : null;
  const hidden = data ? data.videos.length - rows.length : 0;

  return (
    <WindowFrame
      topBar={
        <>
          <h1 className="min-w-0 flex-1 truncate text-md font-semibold">Disk Cleanup</h1>
          <Tooltip
            content={
              <span className="flex items-center gap-1.5">
                Back to your videos <Kbd keys={["esc"]} />
              </span>
            }
            side="bottom"
          >
            <Button
              variant="primary"
              onClick={() => {
                store.getState().setView("main");
              }}
            >
              Done
            </Button>
          </Tooltip>
        </>
      }
    >
      <ScrollArea className="h-full" viewportClassName="px-8">
        <div
          ref={contentRef}
          tabIndex={-1}
          className="mx-auto flex max-w-[680px] flex-col gap-6 pt-6 pb-10 outline-none"
        >
          <section className="flex flex-col gap-3" aria-label="Disk use">
            <div className="flex min-h-7 items-end justify-between gap-4 px-1">
              <p className="min-w-0 text-sm text-fg-muted">
                Working files are what the editor makes along the way. Deleting them frees room and
                keeps the timeline, the project and the rendered videos.
              </p>
              <Button
                icon={<RefreshCw />}
                loading={diskUse.status === "loading" && data !== null}
                onClick={() => void store.getState().loadDiskUse()}
              >
                Refresh
              </Button>
            </div>
            <div className="grid grid-cols-2 divide-x divide-separator rounded-lg border border-border-container bg-surface">
              <Total
                label="Working files"
                value={data && anyMeasured ? formatBytes(data.totals.working) : null}
              />
              <Total
                label="All your videos"
                value={data && anyMeasured ? formatBytes(data.totals.total) : null}
              />
            </div>
            {data?.measuring && (
              <p className="flex items-center gap-2 px-1 text-sm text-fg-muted" role="status">
                <Spinner size={12} />
                Measuring your videos. The sizes fill in as they arrive.
              </p>
            )}
          </section>

          {diskUse.error && (
            <Callout
              tone="danger"
              live
              title="Could not read the sizes"
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    void store.getState().loadDiskUse();
                  }}
                >
                  Try again
                </Button>
              }
            >
              {diskUse.error.message}
            </Callout>
          )}

          {summary && (
            <Callout tone={summary.tone} live>
              {summary.text}
            </Callout>
          )}

          {data === null ? (
            diskUse.error ? null : (
              <p className="px-1 text-sm text-fg-muted">Loading the sizes…</p>
            )
          ) : rows.length === 0 ? (
            data.measuring ? null : (
              <div className="rounded-lg border border-border-container bg-surface">
                <EmptyState
                  icon={<Trash2 />}
                  title="No working files to delete"
                  description="Your videos have no working files right now. They appear here after an edit."
                />
              </div>
            )
          ) : (
            <>
              <div className="flex items-center justify-between gap-4 px-1">
                <Checkbox
                  checked={allChosen}
                  disabled={choosable.length === 0}
                  onCheckedChange={(on) => {
                    setSelected(on ? new Set(choosable.map((row) => row.videoId)) : new Set());
                  }}
                  className="text-base"
                >
                  Select all that can be cleaned
                </Checkbox>
                <Button
                  variant="danger"
                  icon={<Trash2 />}
                  disabled={chosen.length === 0}
                  onClick={() => {
                    setConfirming(chosen.map(confirmVideoOf));
                  }}
                >
                  {deleteLabel(chosen)}
                </Button>
              </div>
              {groups.map((group) => (
                <Group
                  key={group.channelId}
                  title={group.channelName}
                  aside={
                    <span className="text-sm text-fg-muted tabular-nums">
                      {formatBytes(group.working)}
                    </span>
                  }
                >
                  {group.rows.map((row) => (
                    <VideoRow
                      key={row.videoId}
                      row={row}
                      checked={selected.has(row.videoId)}
                      onCheckedChange={(on) => {
                        toggle(row.videoId, on);
                      }}
                    />
                  ))}
                </Group>
              ))}
              {hidden > 0 && (
                <p className="px-1 text-sm text-fg-muted">
                  {pluralize(hidden, "other video")} {hidden === 1 ? "has" : "have"} no working
                  files.
                </p>
              )}
            </>
          )}
        </div>
      </ScrollArea>
      <DiskCleanupConfirm
        videos={confirming}
        onOpenChange={(open) => {
          if (!open) setConfirming([]);
        }}
        onConfirm={clean}
      />
    </WindowFrame>
  );
}

function Total({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <span className="text-sm text-fg-muted">{label}</span>
      <span className="text-xl font-semibold text-fg tabular-nums">
        {value ?? <span className="text-fg-subtle">Measuring…</span>}
      </span>
    </div>
  );
}

function VideoRow({
  row,
  checked,
  onCheckedChange,
}: {
  row: DiskRow;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
}) {
  const canChoose = selectable(row);
  const details = [
    row.editedAt !== null ? `Edited ${formatTimeAgo(row.editedAt)}` : null,
    row.total !== null ? `Whole folder ${formatBytes(row.total)}` : null,
  ].filter((part) => part !== null);
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3">
      <div className="flex min-h-7 items-center gap-3">
        <Checkbox
          checked={checked && canChoose}
          disabled={!canChoose}
          onCheckedChange={onCheckedChange}
          className="min-w-0 flex-1 text-base font-medium"
        >
          <span dir="auto">{row.folderName}</span>
        </Checkbox>
        {row.archived && <Badge>Archived</Badge>}
        <span className="shrink-0 text-base font-medium text-fg tabular-nums">
          {row.working === null ? (
            <span className="text-sm font-normal text-fg-subtle">Measuring…</span>
          ) : (
            formatBytes(row.working)
          )}
        </span>
      </div>
      {details.length > 0 && (
        <p
          className="pl-6 text-sm text-fg-muted"
          title={row.editedAt !== null ? formatLocalDateTime(row.editedAt) : undefined}
        >
          {details.join(" · ")}
        </p>
      )}
      {row.blocked !== null && row.outcome === null && (
        <p className="pl-6 text-sm text-warning">{row.blocked}</p>
      )}
      {row.outcome && (
        <p
          className={`pl-6 text-sm ${row.outcome.ok ? "text-success" : "text-danger"}`}
          role={row.outcome.ok ? undefined : "alert"}
        >
          {outcomeText(row.outcome)}
        </p>
      )}
    </div>
  );
}
