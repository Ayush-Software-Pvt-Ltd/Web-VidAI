import {
  Archive,
  HardDrive,
  RefreshCw,
  ScrollText,
  Settings as SettingsIcon,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { IconButton, Kbd, Spinner, Tooltip } from "@/components/ui";
import { AccountMenu } from "@/features/account";
import { UsageMeters } from "@/features/library";
import { cn } from "@/lib/cn";
import { useAppState, useAppStoreApi, useIsAdmin, useSession } from "@/lib/appEnv";
import { problemFix, problemMessage, problemTitle } from "@/lib/readiness";
import { lineTotals, ownJobCounts, type JobCounts } from "@/lib/store";

/** "2 editing, 3 waiting": the zero counts are left out, nothing at all when nothing runs. */
function countsText({ running, waiting }: JobCounts): string | null {
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} editing`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  return parts.length === 0 ? null : parts.join(", ");
}

/**
 * The footer entry that opened Settings, Admin or Disk Cleanup. Those pages replace the whole main
 * window, footer included, so the entry is remembered here, outside the component, and takes focus
 * again when the footer is back and the list shows (Done, Esc, the back button). A page opened
 * another way (an address, a shortcut) has no opener, and focus is left alone.
 */
let returnFocusTo: string | null = null;

const PAGE_VIEWS: readonly string[] = ["settings", "admin", "diskCleanup"];

type ServerState = "checking" | "ready" | "attention" | "unknown";

/**
 * Bottom of the main sidebar (SPEC sections 5 and 16), from the top: the status of the server
 * (can it start edits, and how many edits run and wait); the usage limits of the server's Claude
 * subscription; the entries Archive, Edit Log, Disk Cleanup, Settings and, for an admin, Admin;
 * and the account menu.
 *
 * The status is the server's own readiness check (`readiness`), worded by the server for the
 * audience: a problem shows its short title, the full sentence in the tooltip, and where it is
 * fixed: an admin gets a link to Admin, anyone else is told to ask their admin. The counts are
 * the person's own jobs; an admin also sees the totals of all users when the queue is loaded.
 */
export function SidebarFooter() {
  const store = useAppStoreApi();
  const session = useSession();
  const admin = useIsAdmin();
  const view = useAppState((s) => s.view);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    if (PAGE_VIEWS.includes(view) || returnFocusTo === null) return;
    const label = returnFocusTo;
    returnFocusTo = null;
    if (view !== "main") return;
    const entries = nav.current?.querySelectorAll<HTMLElement>("[data-footer-entry]") ?? [];
    [...entries].find((el) => el.dataset.footerEntry === label)?.focus();
  }, [view]);

  /** Opens one of the pages that replace the main window, remembering which entry did it. */
  const openPage = (label: string, open: () => void) => {
    returnFocusTo = label;
    open();
  };

  return (
    <div className="flex flex-col gap-0.5">
      <ServerStatus />
      <UsageMeters />
      <nav
        ref={nav}
        aria-label="Archive, Edit Log, Disk Cleanup, Settings and Admin"
        className="mt-1 flex flex-col gap-0.5"
      >
        <FooterEntry
          icon={<Archive />}
          label="Archive"
          current={view === "archive"}
          onClick={() => {
            store.getState().setView(view === "archive" ? "main" : "archive");
          }}
        />
        <FooterEntry
          icon={<ScrollText />}
          label="Edit Log"
          current={view === "editLog"}
          onClick={() => {
            store.getState().setView(view === "editLog" ? "main" : "editLog");
          }}
        />
        <FooterEntry
          icon={<HardDrive />}
          label="Disk Cleanup"
          current={view === "diskCleanup"}
          onClick={() => {
            openPage("Disk Cleanup", () => {
              store.getState().setView(view === "diskCleanup" ? "main" : "diskCleanup");
            });
          }}
        />
        <FooterEntry
          icon={<SettingsIcon />}
          label="Settings"
          current={view === "settings"}
          onClick={() => {
            openPage("Settings", () => {
              store.getState().openSettings();
            });
          }}
          trailing={<Kbd keys={["mod", ","]} />}
        />
        {admin && (
          <FooterEntry
            icon={<ShieldCheck />}
            label="Admin"
            current={view === "admin"}
            onClick={() => {
              openPage("Admin", () => {
                store.getState().openAdmin();
              });
            }}
          />
        )}
      </nav>
      {session && (
        <div className="mt-1 border-t border-separator pt-1.5">
          <AccountMenu />
        </div>
      )}
    </div>
  );
}

/** The server's readiness, the person's counts and, for an admin, everybody's. */
function ServerStatus() {
  const store = useAppStoreApi();
  const admin = useIsAdmin();
  const readiness = useAppState((s) => s.readiness.data);
  const status = useAppState((s) => s.readiness.status);
  const loadError = useAppState((s) => s.readiness.error);
  const own = useAppState((s) => countsText(ownJobCounts(s.queue.data)));
  // Only what the store already has: the totals of the lines come with the queue every user loads.
  const everybody = useAppState((s) =>
    s.queue.data === null ? null : countsText(lineTotals(s.queue.data)),
  );

  const state: ServerState = readiness
    ? readiness.problem === null
      ? "ready"
      : "attention"
    : status === "error"
      ? "unknown"
      : "checking";
  const problem = readiness?.problem ?? null;
  const sentence = problemMessage(readiness);

  const label =
    state === "ready"
      ? "Ready to edit"
      : state === "checking"
        ? "Checking the server"
        : state === "unknown"
          ? "Status unavailable"
          : (problemTitle(readiness) ?? "Cannot start edits");
  const tooltip =
    state === "ready"
      ? "This server can start new edits."
      : state === "unknown"
        ? (loadError?.message ?? "The status of the server could not be read.")
        : sentence;
  const showEverybody = admin && everybody !== null && everybody !== own;

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-1 pr-0.5">
        <Tooltip side="right" content={tooltip}>
          <div
            role="status"
            tabIndex={0}
            className="focus-ring flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm text-fg-muted"
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {state === "checking" ? (
                <Spinner size={11} />
              ) : (
                <span
                  className={cn(
                    "size-2 rounded-full",
                    state === "ready" ? "bg-success" : "bg-warning",
                  )}
                />
              )}
            </span>
            <span className="truncate">{label}</span>
            {state === "attention" && sentence && <span className="sr-only">{sentence}</span>}
          </div>
        </Tooltip>
        {(state === "attention" || state === "unknown") && (
          <IconButton
            label="Check Again"
            size="sm"
            icon={<RefreshCw />}
            onClick={() => void store.getState().loadReadiness()}
          />
        )}
      </div>
      {state === "attention" && problem !== null && (
        <p className="pr-2 pl-8 text-xs text-fg-subtle">
          {admin ? (
            <button
              type="button"
              className="focus-ring -mx-1 rounded-sm px-1 text-accent hover:underline"
              onClick={() => {
                store
                  .getState()
                  .openAdmin(problemFix(problem) === "settings" ? "harness" : "system");
              }}
            >
              Open Admin
            </button>
          ) : (
            "Ask your admin."
          )}
        </p>
      )}
      {(own !== null || showEverybody) && (
        <div className="flex flex-col pr-2 pl-8 text-xs text-fg-subtle tabular" aria-live="polite">
          {own !== null && <span>{own}</span>}
          {showEverybody && <span>Everybody: {everybody}</span>}
        </div>
      )}
    </div>
  );
}

/** A row of the footer that opens a screen; the open one is marked with `aria-current`. */
function FooterEntry({
  icon,
  label,
  current,
  trailing,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  current?: boolean;
  trailing?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-footer-entry={label}
      aria-current={current ? "page" : undefined}
      onClick={onClick}
      className={cn(
        "focus-ring flex h-7 items-center gap-2 rounded-md px-2 text-base text-fg [&_svg]:size-4",
        current ? "bg-selected" : "hover:bg-hover active:bg-pressed",
      )}
    >
      <span className="flex shrink-0 text-fg-muted">{icon}</span>
      <span className="flex-1 text-left">{label}</span>
      {trailing}
    </button>
  );
}
