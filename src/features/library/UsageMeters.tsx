/**
 * The usage panel at the bottom of the main sidebar, above Archive (SPEC section 16): one compact
 * row per usage limit, stacked ("5h", a thin bar, "20%"; "Week", ...), whose bar turns to warning
 * at 70 % and critical at 90 %.
 * Hovering or clicking opens a popover with the full label, the exact percentage, the reset time
 * (local time and "in 3h 12m"), when it was last refreshed, and Refresh. When the plan reports
 * no limits, nothing is shown at all.
 *
 * These are the limits of the account the SERVER runs on, shared by everybody who edits there,
 * so the popover says whose usage it is and every signed-in person sees it (the wire has no flag
 * that hides it). The store keeps them in `usage` and merges `usage-updated` into it.
 *
 * Which meters show follows the setup of the server (the public harness state and the usage
 * view): on the Claude subscription the Claude limits; on OpenCode Go (the view then carries the
 * `opencode` quota) the OpenCode Go windows as OpenCode reports them, or a quiet "not available"
 * element that says why; on the two compatible APIs nothing, because the plan behind them is not
 * known and the Claude subscription is not what edits run on.
 *
 * Usage is not kept across starts of the server, so right after it starts the meters wait for the
 * first answer. Until then they show as quiet placeholders of the same size, so the sidebar does
 * not look empty and nothing moves when the values arrive.
 */
import { CircleAlert, ExternalLink, RefreshCw } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Meter, meterTone, toast } from "@/components/ui";
import { buttonBase, buttonSizes, buttonVariants } from "@/components/ui/buttonStyles";
import { cn } from "@/lib/cn";
import { toApiError } from "@/lib/errors";
import { formatLocalDateTime, formatTimeAgo, formatTimeUntil } from "@/lib/format";
import { useApi, useAppState, useAppStoreApi } from "@/lib/appEnv";
import { OPENCODE_CONSOLE_URL } from "@/lib/setup";
import type { UsageLimit } from "@/lib/types";
import { usageShortLabel } from "./presentation";
import { useNow } from "./useNow";

/** Whole percent for the compact meter; never shows 100 % before the limit is really hit. */
function compactPercent(value: number): number {
  const clamped = Math.min(100, Math.max(0, value));
  return clamped < 100 ? Math.min(99, Math.round(clamped)) : 100;
}

/** "20.4 %" style exact value for the popover. */
function exactPercent(value: number): string {
  const clamped = Math.min(100, Math.max(0, value));
  return `${Number.isInteger(clamped) ? clamped : clamped.toFixed(1)}%`;
}

const toneText = { normal: "text-fg-muted", warning: "text-warning", critical: "text-danger" };

/** One limit as a row of the panel: its name, its bar and the whole percent. */
function CompactMeter({ limit }: { limit: UsageLimit }) {
  const tone = meterTone(limit.usedPercent);
  return (
    <span className="flex w-full items-center gap-2 text-xs leading-4 tabular">
      <span className="w-11 shrink-0 truncate text-fg-muted">{usageShortLabel(limit)}</span>
      <Meter value={limit.usedPercent} label={limit.label} className="min-w-0 flex-1 bg-border" />
      <span
        className={cn(
          "w-8 shrink-0 text-right font-medium",
          tone === "normal" ? "text-fg" : toneText[tone],
        )}
      >
        {compactPercent(limit.usedPercent)}%
      </span>
    </span>
  );
}

/** A row before the first answer: its label, a dash and an empty track. */
function PlaceholderMeter({ label }: { label: string }) {
  return (
    <span className="flex w-full items-center gap-2 text-xs leading-4 text-fg-subtle tabular">
      <span className="w-11 shrink-0">{label}</span>
      <span className="h-1 min-w-0 flex-1 animate-pulse rounded-full bg-border" />
      <span className="w-8 shrink-0 text-right">{"–"}</span>
    </span>
  );
}

/** The two placeholders that hold the meters' place until the first answer. */
function WaitingMeters() {
  return (
    <span
      role="status"
      aria-label="Loading the usage limits"
      className="flex shrink-0 flex-col gap-1.5 px-2 py-2"
    >
      <PlaceholderMeter label="5h" />
      <PlaceholderMeter label="Week" />
    </span>
  );
}

function LimitDetail({ limit, now }: { limit: UsageLimit; now: number }) {
  const tone = meterTone(limit.usedPercent);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-medium text-fg">{limit.label}</span>
        <span className={cn("text-base font-medium tabular", tone !== "normal" && toneText[tone])}>
          {exactPercent(limit.usedPercent)} used
        </span>
      </div>
      <Meter value={limit.usedPercent} label={limit.label} className="h-1.5" />
      <span className="text-sm text-fg-muted tabular">
        {limit.resetsAt
          ? `Resets ${formatLocalDateTime(limit.resetsAt)}, ${formatTimeUntil(limit.resetsAt, now)}`
          : "Reset time not reported"}
      </span>
    </div>
  );
}

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 180;

/**
 * The trigger and popover of the meters: hover opens it after a short delay and leaving closes
 * it; a click pins it open. `body` gets the current time (ticking while open).
 */
function MetersPopover({
  label,
  tone,
  trigger,
  body,
}: {
  /** Accessible name of the trigger. */
  label: string;
  tone?: string;
  trigger: ReactNode;
  body: (now: number) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);
  const hoverOpen = () => {
    clearTimer();
    if (!open) {
      timer.current = setTimeout(() => {
        setOpen(true);
      }, HOVER_OPEN_MS);
    }
  };
  const hoverClose = () => {
    clearTimer();
    if (pinned) return;
    timer.current = setTimeout(() => {
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };

  const now = useNow(30_000, open);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        clearTimer();
        setOpen(next);
        if (!next) setPinned(false);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          data-tone={tone}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") hoverOpen();
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") hoverClose();
          }}
          onClick={(e) => {
            // Radix toggles on click; a click while hover-opened pins instead of closing.
            if (open && !pinned) {
              e.preventDefault();
              clearTimer();
              setPinned(true);
            } else {
              setPinned(!open);
            }
          }}
          className="focus-ring relative flex w-full flex-col gap-1.5 rounded-md px-2 py-2 text-left hover:bg-hover data-[state=open]:bg-pressed"
        >
          {trigger}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={16}
          collisionPadding={8}
          aria-label="Usage limits"
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") clearTimer();
          }}
          onPointerLeave={(e) => {
            if (e.pointerType === "mouse") hoverClose();
          }}
          onOpenAutoFocus={(e) => {
            // Hover-opened popovers must not steal focus from wherever the user is typing.
            if (!pinned) e.preventDefault();
          }}
          className="z-50 w-[300px] animate-pop-in rounded-lg bg-elevated shadow-popover outline-none"
        >
          {body(now)}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The meters of `limits` and their popover. */
function LimitMeters({
  limits,
  title,
  note,
  fetchedAt,
  error,
  refreshing,
  onRefresh,
  footer,
}: {
  limits: UsageLimit[];
  title: string;
  /** A quiet line under the limits. */
  note?: ReactNode;
  fetchedAt: number | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  /** Extra controls next to Refresh. */
  footer?: ReactNode;
}) {
  const worst = Math.max(...limits.map((l) => l.usedPercent));
  return (
    <MetersPopover
      label={`Usage limits: ${limits
        .map((l) => `${l.label} ${compactPercent(l.usedPercent)}%`)
        .join(", ")}`}
      tone={meterTone(worst)}
      trigger={
        <>
          {limits.map((limit) => (
            <CompactMeter key={limit.key} limit={limit} />
          ))}
          {error && (
            <span
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-warning"
              aria-hidden
            />
          )}
        </>
      }
      body={(now) => (
        <>
          <div className="flex flex-col gap-3.5 p-3.5">
            <h3 className="text-xs font-medium text-fg-subtle">{title}</h3>
            {limits.map((limit) => (
              <LimitDetail key={limit.key} limit={limit} now={now} />
            ))}
            {note && <p className="-mt-1 text-sm text-fg-muted">{note}</p>}
          </div>
          {error && (
            <p className="mx-3.5 mb-3 flex gap-1.5 rounded-md bg-warning-soft px-2 py-1.5 text-sm text-warning">
              <CircleAlert className="mt-px size-3.5 shrink-0" />
              <span>Last refresh failed: {error}</span>
            </p>
          )}
          <UpdatedFooter
            fetchedAt={fetchedAt}
            now={now}
            refreshing={refreshing}
            onRefresh={onRefresh}
            extra={footer}
          />
        </>
      )}
    />
  );
}

function UpdatedFooter({
  fetchedAt,
  now,
  refreshing,
  onRefresh,
  extra,
}: {
  fetchedAt: number | null;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-separator px-3.5 py-2.5">
      <span className="min-w-0 truncate text-sm text-fg-subtle">
        {fetchedAt ? `Updated ${formatTimeAgo(fetchedAt, now)}` : "Not refreshed yet"}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {extra}
        <Button size="sm" icon={<RefreshCw />} loading={refreshing} onClick={onRefresh}>
          Refresh
        </Button>
      </span>
    </div>
  );
}

/** Whose usage the meters show: it is the server's, shared by everybody. */
const CLAUDE_TITLE = "Usage of the server's Claude subscription";
const CLAUDE_NOTE = "Shared by everybody who edits on this server.";
const GO_TITLE = "Usage of the server's OpenCode Go subscription";
const GO_NOTE = "As OpenCode reports it for the server's API key. Shared by everybody.";

/**
 * The panel of the server's setup: the Claude limits on the Claude subscription, the OpenCode Go
 * quota on OpenCode Go, nothing on the compatible APIs.
 */
export function UsageMeters() {
  // "claude", "go" or "none": a primitive, so the selector never builds a new object.
  const kind = useAppState((s) => {
    if (s.usage.data?.opencode != null) return "go";
    const setup = s.harness.data?.setup ?? null;
    if (setup === "opencodeGo") return "go";
    return setup === null || setup === "claudeSubscription" ? "claude" : "none";
  });
  if (kind === "claude") return <ClaudeMeters />;
  if (kind === "go") return <OpencodeMeters />;
  return null;
}

/** The Claude plan's limits of the server, from its Claude Code. */
function ClaudeMeters() {
  const usage = useAppState((s) => s.usage.data?.claude ?? null);
  const refreshing = useAppState((s) => s.usage.status === "loading");
  const loadError = useAppState((s) => s.usage.error);
  const loadUsage = useAppState((s) => s.loadUsage);

  // Not answered yet: neither values nor an error since the server started.
  const waiting =
    (usage === null || (usage.fetchedAt === null && usage.error === null)) && loadError === null;
  if (waiting) return <WaitingMeters />;
  if (!usage?.available || usage.limits.length === 0) return null;

  return (
    <LimitMeters
      limits={usage.limits}
      title={CLAUDE_TITLE}
      note={CLAUDE_NOTE}
      fetchedAt={usage.fetchedAt}
      error={usage.error ?? loadError?.message ?? null}
      refreshing={refreshing}
      onRefresh={() => void loadUsage(true)}
    />
  );
}

/** The link to the OpenCode console: a new tab, without telling the console where we came from. */
function ConsoleLink() {
  return (
    <a
      href={OPENCODE_CONSOLE_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonBase, buttonVariants.secondary, buttonSizes.sm)}
    >
      <ExternalLink />
      Console
    </a>
  );
}

/** The OpenCode Go windows of the server, or why there are none. */
function OpencodeMeters() {
  const api = useApi();
  const store = useAppStoreApi();
  const usage = useAppState((s) => s.usage.data?.opencode ?? null);
  const loadError = useAppState((s) => s.usage.error);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      store
        .getState()
        .applyUsageUpdate({ opencode: await api.getOpencodeUsage({ refresh: true }) });
    } catch (error) {
      toast.error("Could not refresh the usage", toApiError(error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const error = usage?.error ?? loadError?.message ?? null;
  const waiting =
    (usage === null ||
      (usage.fetchedAt === null &&
        usage.error === null &&
        usage.unavailable === null &&
        usage.limits.length === 0)) &&
    loadError === null;
  if (waiting) return <WaitingMeters />;

  if (usage && usage.limits.length > 0) {
    return (
      <LimitMeters
        limits={usage.limits}
        title={GO_TITLE}
        note={GO_NOTE}
        fetchedAt={usage.fetchedAt}
        error={error}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        footer={<ConsoleLink />}
      />
    );
  }

  const reason = usage?.unavailable ?? error ?? "OpenCode has not reported the usage of this key.";
  return (
    <MetersPopover
      label="OpenCode Go usage: not available"
      trigger={
        <span className="flex w-full items-center gap-2 text-xs leading-4 text-fg-subtle tabular">
          <span className="w-11 shrink-0">Usage</span>
          <span className="h-1 min-w-0 flex-1 rounded-full bg-muted" />
          <span className="w-8 shrink-0 text-right">{"–"}</span>
        </span>
      }
      body={(now) => (
        <>
          <div className="flex flex-col gap-2 p-3.5">
            <h3 className="text-xs font-medium text-fg-subtle">{GO_TITLE}</h3>
            <p className="text-base font-medium text-fg">Not available</p>
            <p className="text-sm text-fg-muted">{reason}</p>
            <p className="text-sm text-fg-muted">
              The OpenCode console shows the usage and limits.
            </p>
          </div>
          <UpdatedFooter
            fetchedAt={usage?.fetchedAt ?? null}
            now={now}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            extra={<ConsoleLink />}
          />
        </>
      )}
    />
  );
}
